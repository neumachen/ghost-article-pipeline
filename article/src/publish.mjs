// The publish flow: turn a verified candidate into the right sequence of
// Admin API calls, or refuse before the first one that changes Ghost. The
// decision logic lives in decide(), pure on plain objects, so every branch
// is unit-testable without a Ghost; runPublish is thin around it: load and
// re-verify the candidate, read the live state, decide, then act.
//
// The order is deliberate: everything that can refuse happens before the
// first mutating request, and the record is rewritten before and after every
// request that can change Ghost, so a run that dies mid-request still says
// which request may have been sent. Nothing is retried.
//
// Ghost behaviour this relies on (observed live against 6.64.0):
//
//   - A tag write does not change the post's updated_at, so state can be
//     repaired after a post write without colliding with the post's own edit
//     history.
//   - A slug match is not identity (Ghost suffixes a duplicate instead of
//     refusing); a POST /tags/ a second time with a taken slug mints a
//     "-2"-suffixed tag, while referencing an existing slug from a post LINKS
//     it, never duplicating.
//   - Updating a post with tags replaces the whole tag set, so the identity
//     tag must travel with every post write, not be added afterwards, and an
//     unrelated internal tag is preserved only by sending it back.
//   - A `description` inside a post's `tags[]` array is SILENTLY IGNORED, on
//     create and on update. The identity tag's provisional state therefore
//     CANNOT ride along in the post payload (the old design did, and against
//     real Ghost that write was a no-op, so the provisional-state repair path
//     never fired); it is written through POST /tags/ or PUT /tags/:id/ as
//     its own step, BEFORE the post write. A tag write has no optimistic-
//     concurrency protection the client can rely on (a stale updated_at is
//     accepted), so the tag write is never retried blindly — its own
//     sequencing is the only protection.

import path from "node:path";
import { resolveAssetUrls, recordAssetUpload } from "./asset-store.mjs";
import { PipelineError, ConflictError, RefusedError, UncertainError, PublicCheckError, classifyError } from "./errors.mjs";
import { loadCandidate, verifyCandidateForPublish } from "./candidate.mjs";
import { loadGhostConfig } from "./config.mjs";
import { createGhostClient } from "./ghost-client.mjs";
import { decodeState, encodeState, identityTagName, identityTagSlug, stateSameContent } from "./identity.mjs";
import { ghostBodyHash, ownedFieldsHash, SOLE_BARE_IMAGE } from "./normalize.mjs";
import { collectImageSrc, mapImageSrc } from "./markdown.mjs";
import { verifySavedPost, checkPublicPage, publicTagNames, storedBodyEquals } from "./verify.mjs";
import { isAncestor } from "./git-source.mjs";
import { sha256 as sha256Hex } from "./assets.mjs";
import { RunRecord, baseRecord, finish } from "./record.mjs";

// Ghost preserves a raw-HTML segment verbatim when the segment arrives
// wrapped in Ghost's own kg-card html markers, and re-serialises it (dropping
// the element, keeping the text) when it does not — both observed live on
// 6.64.0. Wrapping every raw-HTML run the rendered body carries therefore
// makes the stored body a faithful copy of what was sent: the segment, not
// Ghost's paraphrase of it, is what gets stored, and a repeat run compares
// equal. A run is raw HTML when it mentions no element the Markdown renderer
// itself emits — the renderer emits p, h1..h6, ul, ol, li, a, em, strong,
// code, pre, blockquote, table parts, hr, img, figure (for images).
const MARKDOWN_ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "em", "strong",
  "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "hr", "img", "figure", "figcaption",
]);
function isRawHtmlRun(run) {
  const tags = new Set([...run.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b/g)].map((m) => m[1].toLowerCase()));
  if (!tags.size) return false;
  for (const tag of tags) if (!MARKDOWN_ELEMENTS.has(tag)) return true;
  // A figure the renderer could not have produced (no img, no figcaption
  // child) is raw HTML too: Ghost stores a plain image figure differently.
  if (tags.has("figure") && !/<(?:img|figcaption)\b/i.test(run)) return true;
  return false;
}

// Void elements: never paired, so an occurrence never starts a nesting depth
// the matching closer would have to end.
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/**
 * Whether Ghost would store this element faithfully as it is. This catches the
 * elements isRawHtmlRun cannot: ones built only from what the Markdown
 * renderer emits, which Ghost nonetheless changes. Observed live on 6.64.0
 * (article/test/integration.test.mjs, the representative-fixture scenarios):
 *
 *   - an <img> inside an <a> is DROPPED, leaving an empty link;
 *   - an <img> with anything else in its block is lifted out of it, so one
 *     paragraph is stored as paragraph / kg-image-card / paragraph;
 *   - an <a>'s title attribute is DROPPED.
 *
 * All three survive verbatim inside Ghost's own kg-card html markers, which is
 * the mechanism wrapRawHtmlSegments already uses for raw HTML, so an element
 * carrying one is wrapped too: the published page then holds what the author
 * wrote and reviewed, not Ghost's paraphrase of it.
 *
 * A block whose whole content is one bare <img> is deliberately left alone:
 * Ghost turns that into a proper kg-image-card (loading="lazy", the theme's
 * responsive image classes), which is what a publication wants for a block
 * image, and contentOutline already reads it as the image block it is. The
 * predicate is SOLE_BARE_IMAGE, the same one the outline's paragraph rule
 * uses, so the two can never disagree about which side an image is on.
 *
 * <del> is absent here on purpose: it is absent from MARKDOWN_ELEMENTS too, so
 * a block carrying a strikethrough is already a raw-HTML run and already
 * wrapped — which is what preserves it, Ghost dropping an unwrapped <del>.
 */
function ghostWouldNotStoreFaithfully(element) {
  if (/<a\b[^>]*\btitle\s*=/i.test(element)) return true;
  if (!/<img\b/i.test(element)) return false;
  const inner = element.replace(/^\s*<[a-zA-Z][^<>]*>/, "").replace(/<\/[a-zA-Z][^<>]*>\s*$/, "");
  return !SOLE_BARE_IMAGE.test(inner);
}

/**
 * The byte range of one complete top-level element: from its opening tag to
 * its own matching closing tag, counting only same-name elements (nesting
 * of other names inside it needs no counting: the first closing tag of the
 * opening tag's own name closes it). Self-closing (<x/>) and void elements
 * close themselves. Returns null when the element never closes — an
 * unbalanced fragment is never wrapped as if it were whole.
 */
function elementRange(html, start, name) {
  const depthPattern = new RegExp(`<(/?)${name}\\b`, "gi");
  depthPattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = depthPattern.exec(html)) !== null) {
    if (!match[1]) {
      // An opening tag: a self-closing form (<x/> or <x .../>) neither
      // opens nor closes, so the depth is unmoved.
      if (html.slice(depthPattern.lastIndex, depthPattern.lastIndex + 2).startsWith("/")) continue;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        // Include the closing tag's own end: optional whitespace, then ">".
        const close = /^\s*>/.exec(html.slice(depthPattern.lastIndex));
        return { start, end: depthPattern.lastIndex + (close ? close[0].length : 1) };
      }
    }
  }
  return null;
}

/**
 * Wrap every complete top-level element Ghost would not store faithfully in
 * Ghost's own kg-card html markers. Two kinds qualify: a raw-HTML ELEMENT —
 * one whose run mentions no element the Markdown renderer itself emits
 * (isRawHtmlRun), exactly the rule the segment splitter used — and one built
 * purely from renderer markup that Ghost nonetheless rewrites, drops or
 * reflows (ghostWouldNotStoreFaithfully). What changed is the unit: the whole
 * balanced element from its opening tag to its own matching closing tag —
 * inner opening tags (nested children, inline markup) are part of the element,
 * never split points — so a block with inline children stays one element and
 * keeps its nesting. Unbalanced raw-HTML fragments fall back to the balanced
 * prefix the scan found, preserving the old behaviour's refusal to let a
 * dangling fragment eat the rest of the document.
 */
export function wrapRawHtmlSegments(html) {
  const source = String(html ?? "");
  let out = "";
  let index = 0;
  const length = source.length;
  const OPENING = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*?(\/?)>/g;
  while (index < length) {
    const next = source.indexOf("<", index);
    if (next === -1) {
      out += source.slice(index);
      return out;
    }
    out += source.slice(index, next);
    // A candidate opening tag the scan then validates.
    OPENING.lastIndex = next;
    const match = OPENING.exec(source);
    if (!match || match.index !== next) {
      out += source[next];
      index = next + 1;
      continue;
    }
    const name = match[1].toLowerCase();
    if (!VOID_ELEMENTS.has(name) && match[2] !== "/") {
      const range = elementRange(source, next, name);
      const end = range ? range.end : balancedPrefixEnd(source, next);
      const element = source.slice(next, end);
      if (isRawHtmlRun(element) || ghostWouldNotStoreFaithfully(element)) {
        out += `\n<!--kg-card-begin: html-->\n${element.replace(/\s+$/, "")}\n<!--kg-card-end: html-->\n`;
        index = end;
        continue;
      }
      out += element;
      index = end;
      continue;
    }
    // A void/self-closing element: a one-tag unit.
    const tag = match[0];
    if (isRawHtmlRun(tag)) {
      out += `\n<!--kg-card-begin: html-->\n${tag.replace(/\s+$/, "")}\n<!--kg-card-end: html-->\n`;
    } else {
      out += tag;
    }
    index = match.index + tag.length;
  }
  return out;
}

/**
 * The conservative end of an unbalanced opening tag: the next closing tag of
 * the same name if one exists (the balanced prefix), else nothing but the
 * opening tag itself. Keeps a dangling raw-HTML fragment from consuming the
 * whole rest of the document as one "element".
 */
function balancedPrefixEnd(source, start) {
  const name = source.slice(start + 1).match(/^([a-zA-Z][a-zA-Z0-9-]*)/)?.[1];
  if (name) {
    const closer = new RegExp(`</${name}\\s*>`, "i").exec(source.slice(start));
    if (closer) return start + closer.index + closer[0].length;
  }
  return start + (source.slice(start).match(/^<[^<>]*>/)?.[0].length ?? 1);
}

/**
 * The image src values in an html body, whatever their shape (relative or
 * absolute), in document order. The same code-aware, <img>-only walk
 * discovery and rewriting use, so a code example in the stored body is not
 * read as an image Ghost is serving.
 */
function imageUrls(html) {
  return collectImageSrc(html);
}

// The identity tag as it appears on a post: by name, or null when the post
// carries none (a post found by tag always carries it; a slug match may not).
function identityTag(post, articleId) {
  const name = identityTagName(articleId);
  return Array.isArray(post?.tags) ? post.tags.find((tag) => tag?.name === name) ?? null : null;
}

/**
 * Whether the non-body owned fields the managed post carries are exactly the
 * ones the candidate asks for: title, slug, status, custom_excerpt (missing
 * and null read as equal), public tag names (set equality — order is Ghost's
 * to reorder), and authors — but authors only when the candidate names any:
 * an authors-less write leaves whatever author the post already carries
 * (Ghost pins the default author itself, observed live), so the live set is
 * the desired set then. Pure: plain objects in, boolean out.
 */
export function ownedFieldsMatch(managed, candidate) {
  if ((managed.title ?? null) !== (candidate.title ?? null)) return false;
  if ((managed.slug ?? null) !== (candidate.slug ?? null)) return false;
  if ((managed.status ?? null) !== (candidate.status ?? null)) return false;
  if ((managed.custom_excerpt ?? null) !== (candidate.excerpt ?? null)) return false;
  const heldTags = [...publicTagNames(managed)].sort().join("\u0000");
  const wantedTags = [...candidate.tags].sort().join("\u0000");
  if (heldTags !== wantedTags) return false;
  if (candidate.authors.length > 0) {
    const heldAuthors = (managed.authors ?? []).map((author) => author.slug).sort().join("\u0000");
    const wantedAuthors = [...candidate.authors].sort().join("\u0000");
    if (heldAuthors !== wantedAuthors) return false;
  }
  // The feature image too. The candidate carries a relative ref and the live
  // post an uploaded URL, so both go through the candidate-aware shape: it
  // resolves a stored URL to the one candidate ref that can own it, and
  // resolves nothing when two refs share a file name — a matching file NAME is
  // a hint about which upload a src came from, never proof of the bytes.
  const shape = candidateImageSrcShape(candidate);
  if (candidate.featureImage && shape(managed.feature_image ?? "") !== shape(candidate.featureImage)) return false;
  return true;
}

// Exact mappings are established from verified upload receipts or served bytes.
export function candidateImageSrcShape(candidate) {
  const refs = new Set([
    ...(Array.isArray(candidate?.assets) ? candidate.assets.map((asset) => asset?.ref) : []),
    ...(candidate?.featureImage ? [candidate.featureImage] : []),
  ]);
  refs.delete(undefined);
  refs.delete(null);
  return (src) => {
    const value = String(src ?? "");
    if (refs.has(value)) return value;
    return Object.entries(candidate.assetUrls ?? {}).find(([, url]) => url === value)?.[0] ?? value;
  };
}

/**
 * Whether the live post provably holds this candidate's content: the stored
 * body's outline IS the candidate's outline (same blocks, same order, none
 * missing, none extra, none duplicated — not the one-sided marker
 * containment an unapplied update whose old body contains the candidate's
 * fragments would pass), the owned fields match, and the status matches.
 * This is the one proof that says "the live post is this candidate's" — the
 * proof --repair-state requires, and the proof decide() uses to route a
 * provisional recorded state to the repair path, so the two cannot diverge.
 * The proof never authorises a post write: a body that fails it stays a
 * conflict or an uncertainty, never a blind rewrite. Pure: plain objects
 * in, boolean out.
 */
export function liveContentMatchesCandidate(managed, candidate) {
  if (managed === null) return false;
  const proof = liveContentProof(managed, candidate);
  return proof.ok && ownedFieldsMatch(managed, candidate) && managed.status === candidate.status;
}

/**
 * The body half of liveContentMatchesCandidate, as its problems: the strict
 * outline comparison of the candidate's body against the stored body, with
 * the candidate-aware image-src shape (the caller paths here hold the
 * candidate as loaded, before any ref was rewritten to an uploaded URL, so
 * an exact src compare could never be satisfied).
 */
function liveContentProof(managed, candidate) {
  return storedBodyEquals(candidate.bodyHtml, managed.html, { imageSrcShape: candidateImageSrcShape(candidate) });
}

/**
 * What Ghost holds versus what the candidate wants, as one decision.
 * Pure: no client, no clock, no git. The decision is based on the RECORDED
 * state, never on comparing the candidate's rendered HTML with Ghost's
 * stored HTML — Ghost rewrites stored HTML deterministically (heading ids,
 * kg-card wrapping, loading="lazy", its own comments, entity decoding), so
 * a byte-ish comparison of the two always reads "changed". The recorded state
 * binds the candidate (candidateHash), the stored body (ghostBodyHash), the
 * post's own updated_at (ghostUpdatedAt) and the owned fields on the live
 * post, which is enough to say "unchanged" reliably.
 *
 * An unexpected Ghost-side edit is a conflict even when updated_at does not
 * say so: Ghost stores updated_at with SECOND granularity, so a live edit
 * that lands within the same second as the recorded write is invisible to
 * the timestamp. The live post's content fingerprints (liveGhostBodyHash,
 * liveOwnedHash — the live post's own NON-BODY owned fingerprint, hashed the
 * way desiredOwnedHash hashed the recorded one) are therefore compared
 * against the recorded ones as well: a live post that differs from the
 * recorded published state in its stored body or its non-body owned fields
 * is an edit this pipeline did not make, and updating over it would
 * overwrite it. The body is compared only through the two ghostBodyHash
 * values (both computed from Ghost's stored HTML), never through the owned
 * fingerprint: the candidate's rendered body and Ghost's stored rewrite are
 * structurally different text and can never match.
 *
 * managed: the post carrying this article's identity tag, or null.
 * priorState: decodeState of that post's identity tag description, or null.
 * candidate: the loaded candidate.
 * candidateHash16: candidate.candidateHash.slice(0, 16).
 * liveGhostBodyHash: ghostBodyHash(managed.html), or null without a managed post.
 * ownedFieldsMatch: ownedFieldsMatch(managed, candidate), or false without a managed post.
 * liveOwnedHash: the live post's non-body owned-field fingerprint, the way
 *   desiredOwnedHash produced priorState.ownedHash (runPublish passes
 *   liveOwnedHash(managed);
 *   the recorded state stores it truncated to 16 hex, so the comparison is
 *   16-hex against 16-hex — see identity.mjs encodeState). Optional for
 *   direct unit tests: absent, the owned fingerprint is not a decision input.
 * liveContentMatchesCandidate: liveContentMatchesCandidate(managed, candidate)
 *   — the same proof --repair-state requires. The discriminator between a
 *   recorded state that is merely incomplete and a genuine Ghost-side edit:
 *   a provisional recorded state (see below) whose live content provably
 *   matches the candidate is the pipeline's own write that never finished,
 *   not somebody else's edit.
 * repoRoot: for the revision ancestry check.
 *
 * A recorded state written by THIS pipeline can be incomplete, in two ways
 * that both leave the same observable provisional tag state:
 *   (a) the post write lands, but the state-tag write that would finalise it
 *       (the read-back hashes, the post's new updated_at) is rejected or
 *       lost; or
 *   (b) the run dies BETWEEN the tag-state step and the post write — the
 *       literal gap the two-step sequence introduces — so the tag carries
 *       this candidate's provisional state but the post was never written.
 * In both cases the tag holds the provisional state the tag-state step wrote
 * through the tag route (NOT the post payload, which real Ghost ignores):
 * same article id, same candidateHash as the candidate being published, but
 * ghostUpdatedAt and ghostBodyHash still null. The next run's live updated_at
 * then differs from that null, which the timestamp check below would read as
 * a Ghost-side edit. It is not: the live content is the authority, so when
 * the recorded state is incomplete AND the live post provably holds this
 * candidate's content (liveContentMatchesCandidate), the decision is the
 * repair path (unchanged), never a conflict. An incomplete recorded state
 * whose live content does NOT match stays a conflict (or, for a create, the
 * plain create below) — the post cannot be accounted for. The completeness
 * test is only about the recorded state being this run's own, never a
 * bypass: a complete recorded state goes through the full conflict checks
 * below unchanged.
 *
 * Case (b) is handled by the existing inputs without any extra parameter: a
 * provisional tag state with NO managed post (managed === null) falls
 * straight through to the plain create at the bottom — decide() never
 * inspects the tag when there is no managed post, so a create simply proceeds
 * and the post write LINKS the already-existing tag by its exact slug (real
 * Ghost never duplicates it). A provisional tag state with a managed post
 * whose live content does NOT match the candidate fails
 * liveContentMatchesCandidate, so the ordinary timestamp/body conflict checks
 * below apply unchanged — the provisional tag is never taken as proof the
 * write completed.
 *
 * @returns {{ action: "create"|"update"|"unchanged"|"conflict"|"refused", reason: string }}
 */
export function decide({
  managed,
  priorState,
  candidate,
  candidateHash16,
  liveGhostBodyHash,
  ownedFieldsMatch,
  liveOwnedHash = undefined,
  liveContentMatchesCandidate = undefined,
  repoRoot,
}) {
  if (managed) {
    if (priorState === null) {
      return {
        action: "refused",
        reason:
          `a managed post exists (id ${managed.id}) but carries no readable state, ` +
          "so its edit history cannot be accounted for; refusing to overwrite something we cannot account for",
      };
    }
    // The recorded state is OUR OWN state, keyed to the candidate being
    // published, whose finalising hashes were never written — the post write
    // landed but the state-tag write did not, or the run died between the
    // tag-state step and the post write. That is evidence of an incomplete
    // write of ours, not of a Ghost-side edit: the live content is the
    // authority. When it provably holds the candidate, the repair path
    // re-establishes the state without a post write; when it does not, the
    // post cannot be accounted for and the conflict below stands.
    const provisionalOwnState =
      priorState.candidateHash !== null &&
      priorState.candidateHash === candidateHash16 &&
      priorState.ghostUpdatedAt === null &&
      priorState.ghostBodyHash === null;
    const pendingOwnState = priorState.pending?.candidateHash === candidateHash16 &&
      priorState.pending.revision === candidate.source.revision;
    if ((provisionalOwnState || pendingOwnState) && liveContentMatchesCandidate) {
      return {
        action: "unchanged",
        reason:
          "the recorded state is this pipeline's own incomplete write for this candidate (its stored-body hash and updated_at " +
          "were never finalised), and the live post provably holds the candidate's content; the state tag is repaired from the " +
          "live post without a post write",
      };
    }
    if (managed.updated_at !== priorState.ghostUpdatedAt) {
      return {
        action: "conflict",
        reason:
          `the post was edited in Ghost after this pipeline's last publish ` +
          `(updated_at ${managed.updated_at}, recorded ${priorState.ghostUpdatedAt}); ` +
          "re-publishing would overwrite that edit",
      };
    }
    if (liveOwnedHash !== undefined && priorState.ownedHash !== null && liveOwnedHash.slice(0, 16) !== priorState.ownedHash) {
      return {
        action: "conflict",
        reason:
          "the live post differs from the recorded published state on its owned-field fingerprint " +
          `(recorded ${priorState.ownedHash}, live ${liveOwnedHash.slice(0, 16)}), so it was edited in Ghost after this pipeline's last publish; ` +
          "re-publishing would overwrite that edit",
      };
    }
    if (priorState.ghostBodyHash !== null && liveGhostBodyHash !== priorState.ghostBodyHash) {
      return {
        action: "conflict",
        reason:
          "the live post's stored body differs from the recorded published body, so it was edited in Ghost after " +
          "this pipeline's last publish; re-publishing would overwrite that edit",
      };
    }
    if (
      priorState.candidateHash === candidateHash16 &&
      priorState.ghostBodyHash === liveGhostBodyHash &&
      ownedFieldsMatch
    ) {
      return {
        action: "unchanged",
        reason:
          "the recorded state matches this candidate exactly (candidate hash, stored body hash and owned fields); " +
          "nothing is sent.",
      };
    }
    if (priorState.revision && priorState.revision !== candidate.source.revision) {
      if (!isAncestor(repoRoot, priorState.revision, candidate.source.revision)) {
        return {
          action: "refused",
          reason:
            `the live revision ${priorState.revision} is not an ancestor of the candidate's revision ` +
            `${candidate.source.revision}: a stale or competing attempt; refusing to move live content backwards`,
        };
      }
    }
    return {
      action: "update",
      reason: `the managed post (id ${managed.id}) is behind the candidate on the pipeline's owned fields`,
    };
  }
  return {
    action: "create",
    reason: `no post carries the identity tag ${identityTagName(candidate.article.id)}; a new post is created`,
  };
}

/**
 * The internal tags on a live post that are NOT this pipeline's identity tag:
 * unrelated internal tags a human added in Ghost (e.g. #featured-series).
 * They are outside the pipeline's declared ownership, so an update preserves
 * them — and the only reliable way to preserve a tag through a PUT that sends
 * the tag set at all is to send it back with the set.
 */
export function unrelatedInternalTags(post, articleId) {
  const excluded = identityTagName(articleId);
  return Array.isArray(post?.tags)
    ? post.tags.filter((tag) => typeof tag?.name === "string" && tag.name.startsWith("#") && tag.name !== excluded && typeof tag.slug === "string")
    : [];
}

/**
 * The fields this pipeline owns on a Ghost post. The ONLY ones it ever sends.
 * On an update, the live post's unrelated internal tags travel along too: a
 * PUT replaces the whole tag set, so omitting them would delete a human's
 * internal tag as a side effect of an ordinary update. On a create there is
 * nothing to preserve, and the caller passes no live post.
 *
 * The identity tag's entry carries NO description: real Ghost 6.64.0 ignores
 * a description inside a post's tags[] array entirely (on create and on
 * update), so sending one here would be a silent no-op that looks like a
 * state write. The identity tag's state is written as its own step, before
 * the post write (see ensureIdentityTagState), and omitting the description
 * here means the post write leaves whatever that step just set intact.
 */
export function postPayload(candidate, { featureImage, updatedAt = undefined, preserveInternalTags = [] }) {
  const payload = {
    title: candidate.title,
    slug: candidate.slug,
    status: candidate.status,
    html: candidate.bodyHtml,
    custom_excerpt: candidate.excerpt ?? null,
    tags: [
      // Omitting tags in a PUT preserves the existing set, but the pipeline
      // OWNS the public tags, so it always sends the whole set: candidate
      // tags plus the identity tag that carries this pipeline's state.
      // The live post's unrelated internal tags ride along (an update): they
      // are outside the declared ownership, and the only way a PUT that sends
      // tags can keep them is to send them back.
      ...candidate.tags.map((name) => ({ name })),
      ...preserveInternalTags.map((tag) => ({ name: tag.name, slug: tag.slug, visibility: "internal" })),
      // The identity tag, referenced by name+slug+visibility ONLY. Ghost links
      // the existing tag by slug (never a duplicate) and preserves its current
      // description; a brand-new tag is auto-created empty, which the
      // tag-state step then fills via its own tag write.
      { name: identityTagName(candidate.article.id), slug: identityTagSlug(candidate.article.id), visibility: "internal" },
    ],
  };
  // authors are only sent when the candidate names any: Ghost accepts an
  // unknown author slug without error, so an empty list would strip
  // authors we cannot verify, and omitting them preserves whatever is set.
  if (candidate.authors.length > 0) payload.authors = candidate.authors.map((slug) => ({ slug }));
  if (featureImage) payload.feature_image = featureImage;
  if (updatedAt !== undefined) payload.updated_at = updatedAt;
  return payload;
}

/**
 * runPublish: load and verify the candidate, read Ghost, decide, act.
 * mode "plan" decides and reports without sending anything mutating.
 * client is injectable for tests; the default is built from loadGhostConfig().
 */
export async function runPublish({
  repoRoot,
  candidateDir,
  articleId,
  revision = null,
  mode = "publish",
  recordPath,
  env = process.env,
  log = console.log,
  client = null,
  repairState = false,
}) {
  const record = new RunRecord(recordPath, baseRecord("publish", mode, env));
  try {
    // 1-2. The candidate: integrity on load, publish gates after.
    record.step("load-candidate", "started");
    const { candidate, assetBytes } = await loadCandidate(candidateDir);
    record.step("load-candidate", "ok", { candidate_hash: candidate.candidateHash });
    record.set({
      article: { id: candidate.article.id, path: candidate.article.path },
      revision: candidate.source.revision,
      candidate_hash: candidate.candidateHash,
    });
    verifyCandidateForPublish(candidate, { repoRoot });

    // 3. The candidate must be the one this run was asked to publish.
    if (candidate.article.id !== articleId) {
      throw new RefusedError(
        [
          `Refusing to publish: the candidate in ${candidateDir} is for article "${candidate.article.id}", not "${articleId}".`,
          "Nothing was sent.",
        ].join("\n"),
      );
    }
    if (revision !== null && revision !== undefined && revision !== "" && candidate.source.revision !== revision) {
      throw new RefusedError(
        [
          `Refusing to publish article "${articleId}": the candidate was built from ${candidate.source.revision}, not the requested ${revision}.`,
          "Nothing was sent.",
        ].join("\n"),
      );
    }

    // 4. Ghost: an injected client for tests, the configured one otherwise.
    const ghost = client ?? createGhostClient(loadGhostConfig(), { log });
    if (!client) record.set({ ghost_origin: ghost.origin });

    // 5. The live state, read before anything is sent.
    record.step("read-state", "started");
    const byTag = await ghost.findPostsByTag(identityTagSlug(articleId));
    if (byTag.length > 1) {
      throw new RefusedError(
        [
          `Refusing to publish article "${articleId}": ${byTag.length} posts carry the identity tag ${identityTagName(articleId)}.`,
          "The managed post is ambiguous; resolve the duplicates in Ghost Admin by hand. Nothing was sent.",
        ].join("\n"),
      );
    }
    const managed = byTag[0] ?? null;
    if (managed === null) {
      const bySlug = await ghost.findPostsBySlug(candidate.slug);
      const foreign = bySlug.find((post) => identityTag(post, articleId) === null);
      if (foreign) {
        throw new RefusedError(
          [
            `Refusing to publish article "${articleId}": an unrelated post already uses this slug.`,
            `  post id ${foreign.id} (slug ${foreign.slug}) has no identity tag ${identityTagName(articleId)}.`,
            "Refusing to adopt it; the pipeline only ever manages posts it created. Nothing was sent.",
          ].join("\n"),
        );
      }
    }
    record.step("read-state", "ok", { managed_post_id: managed?.id ?? null });

    const priorState = managed ? decodeState(identityTag(managed, articleId)?.description) : null;
    candidate.assetUrls = await resolveAssetUrls(ghost, candidate, managed);
    // The decision inputs, all from recorded state and the live post — never
    // from comparing the candidate's rendered HTML with Ghost's stored HTML:
    // Ghost rewrites stored HTML deterministically (heading ids, kg-card
    // wrapping, loading="lazy", its own comments, entity decoding), so such a
    // comparison would read "changed" forever. The identity tag's recorded
    // state binds the candidate (candidateHash) and the stored body
    // (ghostBodyHash); the live post supplies its own updated_at and owned
    // fields. Together they say "unchanged" reliably.
    const candidateHash16 = candidate.candidateHash.slice(0, 16);
    const liveGhostBodyHash = managed ? ghostBodyHash(managed.html) : null;
    const ownedMatch = managed ? ownedFieldsMatch(managed, candidate) : false;
    // The same content proof --repair-state requires: decide() uses it to
    // route a provisional recorded state (our own write, never finalised)
    // to the repair path, so the two paths share one definition.
    const contentMatches = liveContentMatchesCandidate(managed, candidate);
    const decision = decide({
      managed,
      priorState,
      candidate,
      candidateHash16,
      liveGhostBodyHash,
      ownedFieldsMatch: ownedMatch,
      liveOwnedHash: managed ? liveOwnedHash(managed) : undefined,
      liveContentMatchesCandidate: contentMatches,
      repoRoot,
    });
    // The candidate as a whole, hashed for the state tag's records. Purely
    // informational state: the decision above never reads it.
    const desiredOwned = desiredOwnedHash(candidate, managed, candidateImageSrcShape(candidate));

    // 7. Plan mode: the decision, not the change. A plan reports the
    // decision exactly as a publish would take it from the same live read,
    // before any asset is uploaded (an upload is itself a change to the
    // content store, so plan mode never does one).
    if (mode === "plan" && repairState) {
      if (!contentMatches || (priorState?.revision && priorState.revision !== candidate.source.revision &&
          !isAncestor(repoRoot, priorState.revision, candidate.source.revision))) {
        throw new RefusedError("State-repair plan refused: live content or revision ancestry does not match the candidate.");
      }
      return finish(record, {
        outcome: "planned", exit_code: 0, live_changed: "no", status: managed.status,
        message: "Plan only: the live post matches this candidate. State reconciliation may update its internal tag; no post write or asset upload would be sent.",
      }, log);
    }
    if (mode === "plan") {
      const wouldChange =
        decision.action === "update" || decision.action === "create"
          ? diffOwned(managed, candidate, priorState, liveGhostBodyHash)
          : null;
      return finish(
        record,
        {
          outcome: decision.action === "refused" || decision.action === "conflict" ? decision.action : "planned",
          exit_code: decision.action === "refused" || decision.action === "conflict" ? classifyDecisionExit(decision.action) : 0,
          live_changed: "no",
          status: candidate.status,
          message: [
            `Plan only; nothing that changes Ghost was sent. Decision: ${decision.action}.`,
            decision.action === "create" ? "  - a new post would be created for this article." : null,
            decision.action === "update" && managed
              ? `  - post id ${managed.id} would be updated (fields that would change: ${wouldChange?.join(", ") || "owned fields"}).`
              : null,
            decision.action === "unchanged"
              ? "  - Ghost already holds what the candidate asks for; nothing would be sent."
              : null,
            decision.action === "conflict" || decision.action === "refused" ? `  - ${decision.reason}.` : null,
          ]
            .filter((line) => line !== null)
            .join("\n"),
        },
        log,
      );
    }

    // 6b. Repair mode FIRST, before the decision's refusals: the recorded
    //     state is exactly what a repair exists to re-establish, so a stale
    //     or missing state after a run whose state write never landed reads
    //     as a conflict and would otherwise refuse the repair. The proof is
    //     the live content itself — markers over the stored body (paragraph
    //     text included) and the owned fields against the candidate, plus
    //     the status — never the recorded state. Nothing else is sent: no
    //     post write, no asset upload, only the state tag.
    if (repairState) {
      if (priorState?.revision && priorState.revision !== candidate.source.revision &&
          !isAncestor(repoRoot, priorState.revision, candidate.source.revision)) {
        throw new RefusedError("State repair cannot move the recorded revision backwards or across competing history.");
      }
      // The one content proof: the same helper decide() uses for the
      // provisional-state discriminator, so the explicit --repair-state path
      // and the automatic repair path can never diverge on what "the live
      // post holds this candidate" means.
      const contentOk = liveContentMatchesCandidate(managed, candidate);
      if (!contentOk) {
        throw new RefusedError(
          [
            `Refusing to repair state for article "${articleId}": the live post does not hold the candidate's content.`,
            "Repair only re-writes the state tag of a post that already matches the candidate; publish without --repair-state instead. Nothing was sent.",
          ].join("\n"),
        );
      }
      return await repairStateIfStale({ ghost, articleId, candidate, managed, record, log });
    }

    // 6. A refused or conflicting decision stops here in publish mode too:
    //    nothing is sent, and the operator reconciles by hand. A refusal or a
    //    conflict never publishes anything, so no asset is uploaded first.
    if (decision.action === "refused") {
      throw new RefusedError(`Refusing to publish article "${articleId}": ${decision.reason}. Nothing was sent.`);
    }
    if (decision.action === "conflict") {
      throw new ConflictError(
        [
          `Conflicting state for article "${articleId}": ${decision.reason}.`,
          "The live edit is NOT overwritten. Reconcile the edit in Ghost Admin by hand before re-publishing.",
          "If the live content is provably this candidate's (the recorded state tag is merely stale), re-run with --repair-state to re-establish the recorded state without any post write.",
        ].join("\n"),
      );
    }

    // 6. Unchanged: a true no-op. The match that got here (recorded
    //    candidate hash, recorded stored-body hash, owned fields) is by
    //    definition the state this publish would leave behind, so nothing is
    //    sent that changes the post — no asset upload, no post write. The
    //    state tag is re-read and written only when it does not already say
    //    exactly that: a state tag that is missing or stale after a previous
    //    run whose state write never landed is repaired here, from the live
    //    post itself, which is the authority on what was published. An
    //    explicit --repair-state publish takes the same path without sending
    //    anything else; a plain publish of the same candidate reaches it too.
    if (decision.action === "unchanged") {
      return await repairStateIfStale({ ghost, articleId, candidate, managed, record, log });
    }

    // 8. Publish: state tag, assets, post, verification, public page.
    // a. The identity tag's provisional state FIRST, as its own mutation and
    //    its own step. Real Ghost 6.64.0 IGNORES a description inside a post's
    //    tags[] array (observed live, on create and on update), so the old
    //    design — which rode the provisional state along in the post payload
    //    hoping it landed on the tag — was a silent no-op against real Ghost:
    //    the provisional-state repair path could never fire. The tag write is
    //    therefore a real, separate, sequenced request BEFORE the post write.
    //    It is placed here, after refusal/conflict/unchanged are all ruled
    //    out, so a genuine conflict is refused BEFORE any tag write is sent,
    //    and a tag whose current description is a complete, different
    //    candidate's state is never clobbered without that check.
    await ensureIdentityTagState({ ghost, articleId, candidate, managed, desiredOwned, record });

    // b. Assets: every ref uploaded, every occurrence rewritten. An
    //    upload is a real mutation of Ghost's content store, so every attempt
    //    and every outcome is recorded per asset, and reuse is decided
    //    BEFORE uploading wherever the evidence already exists: Ghost does
    //    not deduplicate uploads, so a genuine update would otherwise mint a
    //    new copy and a new URL for every image even when the live post
    //    already serves the same one, and the post would read as changed
    //    forever. The check is bytes, not names: a live URL is fetched and
    //    hashed against the asset's sha256.
    record.step("assets", "started", { count: candidate.assets.length });
    // Receipts bind source bytes to verified stored bytes, including re-encoded images.
    const uploaded = new Map(); // ref -> url
    for (const asset of candidate.assets) {
      const bytes = assetBytes.get(asset.path);
      if (!bytes) {
        throw new RefusedError(`The candidate records asset "${asset.ref}" but the directory holds no bytes for it. Nothing was sent.`);
      }
      // Reuse first: a live URL already serving exactly this asset's stored
      // bytes is the one to keep, decided without uploading anything.
      const matching = candidate.assetUrls[asset.ref];
      if (matching) {
        uploaded.set(asset.ref, matching);
        record.step("assets", "ok", { asset: asset.ref, outcome: "reused", url: matching });
        record.mutate("assets_reused");
        continue;
      }
      // No reusable live copy: upload. Recorded as an attempt before it is
      // sent, so a run that dies mid-upload still says which asset was in
      // flight; recorded with its URL once the copy is confirmed stored.
      record.step("assets", "sending", { asset: asset.ref, outcome: "uploading" });
      let url;
      try {
        ({ url } = await ghost.uploadImage(bytes, path.posix.basename(asset.ref)));
      } catch (error) {
        if (error instanceof UncertainError) {
          // A lost upload reply is reported uncertain for this asset, never
          // retried into a possible duplicate: Ghost does not deduplicate,
          // so a blind retry may store a second copy of the same bytes.
          record.step("assets", "uncertain", { asset: asset.ref, outcome: "uncertain", error: error.message, uploads_completed: [...uploaded.keys()] });
          record.mutate("assets_uncertain");
          record.set({ live_changed: "unknown" });
          throw new UncertainError(
            [
              `The upload of asset "${asset.ref}" was sent, but its reply was lost: ${error.message}`,
              "The upload may have been applied; its effect is unknown. Do not simply re-run.",
              ...(uploaded.size > 0
                ? [`Before doing anything else: ${uploaded.size} earlier asset upload(s) already completed (${[...uploaded.keys()].join(", ")}); the run did NOT change nothing.`]
                : []),
            ].join("\n"),
          );
        }
        // A rejected upload is a definite non-change for this asset, but an
        // earlier upload that completed stands: the record says so, and the
        // operator is told rather than the run reading "nothing changed".
        // The message says both facts: the rejection itself, and the earlier
        // uploads that DID mutate the content store.
        record.step("assets", "failed", { asset: asset.ref, outcome: "failed", error: error.message, uploads_completed: [...uploaded.keys()] });
        if (uploaded.size > 0) record.set({ live_changed: "unknown" });
        throw new (Object.getPrototypeOf(error).constructor)(
          uploaded.size > 0
            ? [
                `${error.message}`,
                "",
                `Before doing anything else: an earlier asset upload already completed (${[...uploaded.keys()].join(", ")}) and changed Ghost's content store; this run did NOT change nothing. Read the record's asset steps, then decide the re-run.`,
              ].join("\n")
            : error.message,
        );
      }
      uploaded.set(asset.ref, url);
      record.step("assets", "ok", { asset: asset.ref, outcome: "uploaded", url });
      record.mutate("assets_uploaded");
      await recordAssetUpload(ghost, candidate, asset, url, record);
      candidate.assetUrls[asset.ref] = url;
    }
    record.step("assets", "done", { uploads: [...uploaded.keys()] });
    // The body as it will be stored: refs rewritten to the uploaded URLs, and
    // every raw-HTML element wrapped in Ghost's own kg-card html markers so
    // Ghost preserves it verbatim (see wrapRawHtmlSegments for the observed
    // behaviour behind this).
    const bodyHtml = wrapRawHtmlSegments(rewriteRefs(candidate.bodyHtml, uploaded));
    const featureImageUrl = candidate.featureImage ? uploaded.get(candidate.featureImage) ?? null : null;

    // The candidate as it will be sent: the same body with every original
    // relative ref replaced by the URL Ghost served for the uploaded copy.
    const uploadable = { ...candidate, bodyHtml, featureImageUrl };

    // c. The payload: owned fields only. published_at, featured, visibility,
    // codeinjection_*, meta_*, og_*, twitter_*, canonical_url, custom_template
    // and email_* are deliberately NOT sent: they are outside the pipeline's
    // declared ownership, and Ghost preserves what a PUT omits. The identity
    // tag's state is NOT in this payload: a description inside a post's
    // tags[] array is ignored by real Ghost, and the tag-state step above has
    // already written the provisional state through the tag route.
    const payload = postPayload(uploadable, {
      featureImage: featureImageUrl,
      updatedAt: managed?.updated_at,
      // An update carries the live post's unrelated internal tags along (a
      // PUT replaces the whole tag set); a create has nothing to preserve.
      preserveInternalTags: managed ? unrelatedInternalTags(managed, articleId) : [],
    });

    // d-e. The post write, recorded before it is sent. A transport failure
    // here is UncertainError: the request may have been applied even though
    // its reply was lost. Rather than leave the outcome unknown, read the
    // live state back and establish it from what Ghost holds
    // (reconcileAfterUncertain) — the write is either found applied, in
    // which case the normal post-write path continues, or the run reports
    // uncertain exactly as before. The identity tag's provisional state was
    // already written by the tag-state step above; this write references the
    // tag by name+slug+visibility only, so it links the same tag and leaves
    // that provisional state intact.
    const stepName = managed ? "update" : "create";
    record.step(stepName, "sending", { request_sent: true });
    let post;
    try {
      post = managed ? await ghost.updatePost(managed.id, payload) : await ghost.createPost(payload);
    } catch (error) {
      if (!(error instanceof UncertainError)) throw error;
      // 1. The reply was lost: record the uncertainty before the read-back.
      record.step(stepName, "uncertain", { error: error.message });
      record.mutate("post", "uncertain");
      // 2-5. Reconcile against the live state. reconcileAfterUncertain
      // returns only when the write APPLIED; every other outcome throws
      // UncertainError (exit 5) with a message saying what was found. The
      // candidate it proofs against is the UPLOADABLE one — the body this
      // run actually sent — so the strict comparison's exact image src
      // (the uploaded URL) is the right thing to compare, never the
      // pre-upload candidate's relative ref.
      const { post: found } = await reconcileAfterUncertain({ ghost, articleId, candidate: uploadable, record, stepName, error });
      post = found;
      record.step(stepName, "ok", { reconciled: true, post_id: post.id });
      record.mutate("post", stepName === "create" ? "created" : "updated");
      record.set({
        live_changed: "yes",
        post: { id: post.id, uuid: post.uuid, slug: post.slug, url: post.url },
        status: post.status,
        published_at: post.published_at ?? null,
      });
      // The write is confirmed applied: continue from the read-back exactly
      // as the normal path does, so the two cannot drift — against the
      // uploadable candidate, the body Ghost now holds.
      return await finishWrite({ ghost, articleId, candidate: uploadable, post, managed, record, log, reconciled: true });
    }
    record.step(stepName, "ok", { post_id: post.id });
    record.mutate("post", stepName === "create" ? "created" : "updated");
    record.set({
      live_changed: "yes",
      post: { id: post.id, uuid: post.uuid, slug: post.slug, url: post.url },
      status: post.status,
      published_at: post.published_at ?? null,
    });

    // f-i. Read back, verify, repair state, check the public page, report.
    // The tail is awaited INSIDE this try (return alone would hand its
    // rejection to the caller without ever entering the catch below, so a
    // finished failure would be left recorded as running — the defect this
    // awaits exists to close). The candidate the tail records its state
    // against is the uploadable one — the body actually sent — so the
    // recorded owned fingerprint is of what Ghost now holds, never of the
    // pre-upload body only this run saw.
    return await finishWrite({ ghost, articleId, candidate: uploadable, post, managed, record, log });
  } catch (error) {
    // 9-10. Typed errors carry their own outcome; anything unclassified is a
    // defect here, and whether a mutating request was sent decides how it is
    // reported — the same unexpected() tools/theme-release.mjs uses.
    const classified = classifyError(error);
    if (error instanceof PipelineError) {
      const message = /Before doing anything else/.test(error.message) ? error.message : addBeforeAnythingElse(error.message, classified.outcome);
      return finish(
        record,
        {
          outcome: classified.outcome,
          exit_code: classified.exitCode,
          message,
          live_changed: liveChanged(record, classified.outcome),
        },
        log,
      );
    }
    const sent = record.data.steps.some((step) => step.status === "sending" || step.request_sent === true);
    return finish(
      record,
      sent
        ? {
            outcome: "uncertain",
            exit_code: 5,
            // An upload that completed earlier in the assets step is a real
            // mutation of Ghost's content store: "unknown" still says the
            // outcome is not established, while the record's per-asset steps
            // keep the completed uploads visible for recovery.
            live_changed: liveChanged(record, "uncertain"),
            message: addBeforeAnythingElse(
              `An unexpected error occurred after a request that can change Ghost was sent:\n${error.stack}`,
              "uncertain",
            ),
          }
        : {
            outcome: "error",
            exit_code: 1,
            message: `An unexpected error occurred before anything that changes Ghost was sent:\n${error.stack}`,
          },
      log,
    );
  }
}

/**
 * The candidate as a whole, hashed for the state tag's records. Purely
 * informational state: the decision never reads it. When the candidate
 * declares no authors, Ghost pins the default author itself (observed live),
 * so an authors-less write keeps whatever author the post already carries:
 * the live set is the desired set then.
 */
function desiredOwnedHash(candidate, managed, shape = (src) => src) {
  return ownedFieldsHash({
    title: candidate.title,
    slug: candidate.slug,
    status: candidate.status,
    custom_excerpt: candidate.excerpt ?? null,
    tags: candidate.tags,
    authors: candidate.authors.length > 0 ? candidate.authors : (managed?.authors ?? []).map((author) => author.slug),
    feature_image: shape(candidate.featureImage ?? "") || null,
  });
}

/**
 * The live post's NON-BODY owned-field fingerprint, hashed the same way
 * desiredOwnedHash hashed the recorded one (tags/authors sorted, the same
 * author-pin rule — a candidate without authors pins whatever author the
 * post carries, observed live), so the two compare 16-hex against 16-hex and
 * a Ghost-side edit to a non-body owned field reads as a difference even
 * when updated_at still holds the recorded second.
 *
 * The body is deliberately not part of this fingerprint: both sides are
 * directly comparable field values here (the live post's title/slug/status/
 * excerpt/tags/authors versus the candidate's), whereas the bodies would be
 * the candidate's rendered HTML against Ghost's structurally rewritten
 * stored HTML — never equal. The body is compared like-for-like by
 * ghostBodyHash on both sides instead. Pure: plain objects in, hex out.
 */
export function liveOwnedHash(managed, shape = (src) => src) {
  return ownedFieldsHash({
    title: managed.title,
    slug: managed.slug,
    status: managed.status,
    custom_excerpt: managed.custom_excerpt ?? null,
    tags: publicTagNames(managed),
    authors: (managed.authors ?? []).map((author) => author.slug),
    feature_image: shape(managed.feature_image ?? "") || null,
  });
}

/** Preserve the last confirmed state while marking a pending attempt; verify every tag write. */
async function ensureIdentityTagState({ ghost, articleId, candidate, managed, desiredOwned, record }) {
  const slug = identityTagSlug(articleId);
  const provisionalState = {
    id: articleId,
    revision: candidate.source.revision,
    candidateHash: candidate.candidateHash,
    // Provisional: the real stored hashes are only known after the read-back,
    // and finishWrite's state-write finalises them — a tag write does not
    // change the post's updated_at, so that later repair is collision-free.
    ghostBodyHash: null,
    ownedHash: desiredOwned,
    publishedAt: managed?.published_at ?? null,
    status: candidate.status,
    ghostUpdatedAt: null,
  };
  const existing = await ghost.findTagBySlug(slug);
  if (existing && (existing.name !== identityTagName(articleId) || existing.visibility !== "internal")) {
    throw new RefusedError("The identity tag's name or visibility does not match this article.");
  }
  const previous = decodeState(existing?.description);
  if (managed && previous?.ghostBodyHash && previous.ghostUpdatedAt) {
    Object.assign(provisionalState, previous, {
      pending: { revision: candidate.source.revision, candidateHash: candidate.candidateHash },
    });
  }
  const provisional = encodeState(provisionalState);
  const tagAction = existing ? "update" : "create";
  record.step("tag-state", "sending", { request_sent: true, tag_action: tagAction });
  try {
    if (existing) {
      await ghost.updateTagDescription(existing.id, provisional, existing.updated_at);
    } else {
      const created = await ghost.createTag({ name: identityTagName(articleId), slug, visibility: "internal", description: provisional });
      if (created.slug !== slug || created.name !== identityTagName(articleId)) throw new UncertainError("Ghost created a different identity tag; refusing to link it.");
    }
    const confirmed = await ghost.findTagBySlug(slug);
    if (confirmed?.description !== provisional || confirmed?.name !== identityTagName(articleId) ||
        (existing && confirmed.id !== existing.id)) throw new UncertainError("Identity state write was not confirmed by readback.");
    record.step("tag-state", "ok", { tag_action: tagAction });
    record.mutate("tags", tagAction === "create" ? "created" : "updated");
  } catch (error) {
    if (!(error instanceof UncertainError)) {
      // A definite rejection changed nothing: the record says so and the run
      // stops before the post write and any upload.
      record.step("tag-state", "failed", { error: error.message, tag_action: tagAction });
      throw error;
    }
    // The reply was lost: what Ghost holds is the only authority on whether
    // the write applied. Re-read the tag by slug and check the provisional
    // state — the same way reconcileAfterUncertain establishes a lost post
    // write from what Ghost holds.
    record.step("tag-state", "uncertain", { error: error.message, tag_action: tagAction });
    record.mutate("tags", "uncertain");
    let reRead;
    try {
      reRead = await ghost.findTagBySlug(slug);
    } catch {
      reRead = undefined; // the re-read itself failed; the state stays unconfirmed
    }
    if (reRead?.description === provisional && reRead?.name === identityTagName(articleId) &&
        (!existing || reRead.id === existing.id)) {
      // Lost reply, applied write: the tag now holds exactly this candidate's
      // provisional state, so the run continues to the post write.
      record.step("tag-state", "ok", { reconciled: true, tag_action: tagAction });
    record.mutate("tags", tagAction === "create" ? "created" : "updated");
      return;
    }
    throw new UncertainError(
      [
        `The identity tag's provisional state write was sent, but its reply was lost: ${error.message}`,
        reRead === undefined
          ? "Re-reading the tag also failed, so whether the tag write applied is not established."
          : "The tag Ghost holds does not carry this candidate's provisional state, so the tag write did not apply.",
        "",
        "No post write and no asset upload followed, so the publication did not proceed.",
        "The tag write is NOT retried: a tag write has no optimistic-concurrency protection, so a blind retry could overwrite a concurrent edit.",
      ].join("\n"),
    );
  }
}

/**
 * The recorded state the live post is expected to carry after this publish:
 * the final hashes from the read-back, keyed to this candidate.
 */
function finalStateFor({ articleId, candidate, saved, ownedHash }) {
  return {
    id: articleId,
    revision: candidate.source.revision,
    candidateHash: candidate.candidateHash,
    ghostBodyHash: ghostBodyHash(saved.html),
    ownedHash,
    publishedAt: saved.published_at ?? null,
    status: candidate.status,
    ghostUpdatedAt: saved.updated_at,
  };
}

/**
 * The shared post-write tail: read the post back, verify it, write the state
 * tag, check the public page, and finish. Both the normal path and the
 * reconciliation path call this, so a reconciled write is verified and
 * recorded exactly like an ordinary one — the two cannot drift.
 *
 * The post-write tail re-uses the record's own finalisation (finish) for
 * every terminal outcome, so a failure after the confirmed write never
 * leaves the run recorded as running: finishWrite's own catch turns every
 * tail failure into a finished record whose exit code matches the outcome.
 *
 * reconciled marks a write whose reply was lost and whose outcome was then
 * established from the live state; the final message says so explicitly.
 */
async function finishWrite({ ghost, articleId, candidate, post, managed, record, log, reconciled = false }) {
  // The write this tail follows is confirmed, so the record says so for
  // every outcome from here on — a tail failure must never read as
  // "nothing changed".
  record.set({ live_changed: "yes" });

  // f. Read back what Ghost now holds and verify it. A read-back failure
  // after a confirmed write is a confirmed mutation whose verification
  // failed, never a "nothing changed" report.
  record.step("verify-saved", "started");
  let saved;
  try {
    saved = await ghost.getPost(post.id);
  } catch (error) {
    record.step("verify-saved", "uncertain", { error: error.message });
    throw new UncertainError(
      [
        `The write to post id ${post.id} is CONFIRMED (the reply was received${reconciled ? " and reconciled" : ""}), but reading the post back failed: ${error.message}`,
        "",
        "The Ghost mutation is confirmed, so do not simply re-run; read the post in Ghost Admin and compare with the candidate first.",
      ].join("\n"),
    );
  }
  const verification = verifySavedPost(saved, candidate);
  if (!verification.ok) {
    record.step("verify-saved", "uncertain", { problems: verification.problems });
    throw new UncertainError(
      [
        `The write is confirmed (post id ${post.id} was read back), but the saved content is not what this run intended:`,
        ...verification.problems.map((problem) => `  - ${problem}`),
        "",
        "The Ghost mutation is confirmed, so do not simply re-run; compare the post in Ghost Admin with the candidate first.",
      ].join("\n"),
    );
  }
  record.step("verify-saved", "ok");

  // The desired owned fingerprint as Ghost now holds it: the saved post's
  // own author set (Ghost pins a default author on an authors-less create,
  // observed live), so the recorded hash matches what the next run's
  // liveOwnedHash computes from the live post.
  const desiredOwned = liveOwnedHash(saved);

  // g. The state tag, now with the final hashes from the read-back.
  const stateTag = Array.isArray(saved.tags) ? saved.tags.find((tag) => tag?.name === identityTagName(articleId)) ?? null : null;
  if (!stateTag) {
    // The post write is confirmed; the state tag it must carry is not even
    // present on the saved post, and an absent tag has no Ghost id to
    // update, so the recorded state is left unconfirmed — never a clean
    // success, never a post re-write.
    record.step("state-write", "uncertain", { error: "the saved post carries no identity tag to update" });
    throw new UncertainError(
      [
        `The write to post id ${saved.id} is CONFIRMED, but the saved post carries no identity tag, so the pipeline's recorded state could not be written.`,
        "",
        "Before doing anything else: do not simply re-run; check the post's tags in Ghost Admin first.",
      ].join("\n"),
    );
  }
  record.step("state-write", "sending", { request_sent: true });
  try {
    await ghost.updateTagDescription(
      stateTag.id,
      encodeState(finalStateFor({ articleId, candidate, saved, ownedHash: desiredOwned })),
      stateTag.updated_at,
    );
    const confirmed = await ghost.findTagBySlug(identityTagSlug(articleId));
    if (confirmed?.id !== stateTag.id || confirmed.description !== encodeState(finalStateFor({ articleId, candidate, saved, ownedHash: desiredOwned }))) {
      throw new UncertainError("Final state write was not confirmed by readback.");
    }
    record.step("state-write", "ok");
    return continueAfterStateWrite({ saved, record, log, ghost, articleId, candidate, managed, reconciled });
  } catch (error) {
    if (error instanceof UncertainError) {
      // The post write is confirmed; the state write's reply was lost, so
      // what Ghost holds is the only authority on whether it applied. The
      // tag is re-read, and the record says what the re-read found; the
      // post is NOT re-written either way.
      record.step("state-write", "uncertain", { error: error.message });
      const expected = finalStateFor({ articleId, candidate, saved, ownedHash: desiredOwned });
      let reRead;
      try {
        const reReadPost = await ghost.getPost(post.id);
        reRead = Array.isArray(reReadPost?.tags)
          ? reReadPost.tags.find((tag) => tag?.name === identityTagName(articleId)) ?? null
          : null;
      } catch {
        reRead = undefined; // the re-read itself failed; the state stays unconfirmed
      }
      if (reRead !== undefined && stateSameContent(decodeState(reRead?.description), expected)) {
        // Lost reply, applied write: the tag now holds exactly the final
        // state, so the publication is complete and the run finishes clean.
        record.step("state-write", "ok", { reconciled: true });
        return continueAfterStateWrite({ saved, record, log, ghost, articleId, candidate, managed, reconciled });
      }
      throw new UncertainError(
        [
          `The write to post id ${saved.id} is CONFIRMED, but the reply to the state-tag write was lost: ${error.message}`,
          reRead === undefined
            ? "Re-reading the state tag also failed, so whether the state write applied is not established."
            : "The state tag Ghost holds does not record this publish's state, so the state write did not apply.",
          "",
          "The post itself was NOT re-written; its content is correct and verified.",
          "Re-run the publish of the same candidate: the live content matches it, so no post write is sent and the recorded state is repaired from what Ghost holds.",
        ].join("\n"),
      );
    }
    // The post write is confirmed applied; the state write was rejected and
    // changed nothing. Re-running the same candidate repairs the state
    // without a post write (the unchanged path), so the operator is told to
    // do exactly that, and nothing here is re-sent.
    record.step("state-write", "failed", { error: error.message });
    throw new UncertainError(
      [
        `The write to post id ${saved.id} is CONFIRMED, but the state-tag write was rejected: ${error.message}`,
        "",
        "The post itself was NOT re-written; its content is correct and verified.",
        "Re-run the publish of the same candidate to repair the state: the live content matches it, so no post write is sent.",
      ].join("\n"),
    );
  }
}

/**
 * The tail after the state write: the public page, then the finish. Split out
 * of finishWrite so both the ordinary state write (ok) and a reconciled
 * lost-reply state write (re-read, found applied) continue from the same
 * point — a reconciled state write is verified exactly like an ordinary one.
 */
async function continueAfterStateWrite({ saved, record, log, ghost, articleId, candidate, managed, reconciled }) {
  // h. The public page, when the post is live.
  if (saved.status === "published" && saved.url) {
    record.step("public-check", "started");
    let page;
    try {
      page = await ghost.fetchPublic(saved.url);
    } catch (error) {
      record.step("public-check", "failed", { error: error.message });
      throw new PublicCheckError(
        [
          `The Ghost mutation is CONFIRMED (post id ${saved.id} was written, read back and verified), but the public page could not be fetched: ${error.message}`,
          "",
          "Before doing anything else: do not simply re-run — re-running may publish a duplicate.",
          "Check the post and its public page in Ghost Admin, compare with the candidate, then decide.",
        ].join("\n"),
      );
    }
    const publicCheck = checkPublicPage(page, candidate);
    if (!publicCheck.ok) {
      record.step("public-check", "failed", { problems: publicCheck.problems });
      throw new PublicCheckError(
        [
          `The Ghost mutation is CONFIRMED (post id ${saved.id} was written and read back), but the public page check failed:`,
          ...publicCheck.problems.map((problem) => `  - ${problem}`),
          "",
          "Before doing anything else: do not simply re-run — re-running may publish a duplicate.",
          "Check the post and its public page in Ghost Admin, compare with the candidate, then decide.",
        ].join("\n"),
      );
    }
    record.step("public-check", "ok", { containment_only: publicCheck.containmentOnly });
  } else {
    record.step("public-check", "skipped", { reason: "drafts have no public URL" });
  }

  // i. Done. A reconciled write is a confirmed mutation: exit 0, and the
  //    message says the outcome was established after a lost reply.
  return finish(
    record,
    {
      outcome: managed ? "updated" : "created",
      exit_code: 0,
      live_changed: "yes",
      message: reconciled
        ? `${managed ? "Updated" : "Created"} post for article "${articleId}": id ${saved.id}, uuid ${saved.uuid}, url ${saved.url ?? "(none)"}, status ${saved.status}, published_at ${saved.published_at ?? "—"}. The reply to the write was lost; the post was found and verified, so the change is confirmed (reconciled).`
        : `${managed ? "Updated" : "Created"} post for article "${articleId}": id ${saved.id}, uuid ${saved.uuid}, url ${saved.url ?? "(none)"}, status ${saved.status}, published_at ${saved.published_at ?? "—"}.`,
    },
    log,
  );
}

/**
 * The unchanged path: the live post already holds exactly this candidate's
 * content, so no post write and no asset upload is ever sent. The state tag
 * is re-read and written only when it does not already say exactly that —
 * a state tag that is missing or stale after a previous run whose state
 * write never landed (see finishWrite's uncertain state-write outcomes) is
 * repaired here from the live post itself, which is the authority on what
 * was published. Repair writes only the tag's description, so the post and
 * its edit history are untouched. The run reports "unchanged" only when the
 * recorded state was already correct and nothing at all was written; a repair
 * that did write the tag reports "state-repaired", because a tag write is a
 * Ghost mutation and the report must not call it nothing.
 */
async function repairStateIfStale({ ghost, articleId, candidate, managed, record, log }) {
  const desiredOwned = liveOwnedHash(managed);
  const finishUnchanged = () =>
    finish(
      record,
      {
        outcome: "unchanged",
        exit_code: 0,
        live_changed: "no",
        status: managed.status,
        post: { id: managed.id, uuid: managed.uuid, slug: managed.slug, url: managed.url },
        published_at: managed.published_at ?? null,
        message: `Article "${articleId}" is already published as requested; nothing was sent that changes Ghost.`,
      },
      log,
    );

  // A true no-op: the recorded state already says exactly this published
  // content, so the state write is skipped too — the recorded state's
  // provenance fields (revision, publishedAt, ghostUpdatedAt) belong to the
  // run that wrote it, never to this one.
  const stateTag = Array.isArray(managed.tags) ? managed.tags.find((tag) => tag?.name === identityTagName(articleId)) ?? null : null;
  if (stateSameContent(decodeState(stateTag?.description), finalStateFor({ articleId, candidate, saved: managed, ownedHash: desiredOwned }))) {
    return finishUnchanged();
  }

  // The recorded state is missing or stale (a previous run's state write
  // never landed). Repair it from the live post: this re-reads the post —
  // the authority on what is published — so the written hashes are the
  // live ones, and a re-read that fails leaves the recorded state unconfirmed.
  record.step("state-repair", "started");
  let saved;
  try {
    saved = await ghost.getPost(managed.id);
  } catch (error) {
    record.step("state-repair", "uncertain", { error: error.message });
    return finish(
      record,
      {
        outcome: "state-uncertain",
        exit_code: 5,
        live_changed: "no",
        status: managed.status,
        post: { id: managed.id, uuid: managed.uuid, slug: managed.slug, url: managed.url },
        published_at: managed.published_at ?? null,
        message: addBeforeAnythingElse(
          `The live post (id ${managed.id}) already holds the candidate's content, but the recorded state could not be re-read for repair: ${error.message}`,
          "uncertain",
        ),
      },
      log,
    );
  }
  // The proof that routed this run to the repair was made against `managed`.
  // The state about to be recorded is derived from `saved` — the same post read
  // again, later — so the SAME proof is repeated against that fresh value:
  // body, intended assets, every owned field including the feature image, and
  // the status. A post that changed in between must not be certified as this
  // candidate: recording it would make every later stale-revision and
  // Ghost-edit check reason from a lie. Refusing costs a re-run.
  if (!liveContentMatchesCandidate(saved, candidate)) {
    const proof = liveContentProof(saved, candidate);
    const reason = proof.ok
      ? "its owned fields or its status no longer match the candidate"
      : `its body no longer matches the candidate (${proof.problems.slice(0, 3).join("; ")})`;
    record.step("state-repair", "refused", { error: `the re-read post (id ${saved.id}) differs from the candidate: ${reason}` });
    return finish(
      record,
      {
        outcome: "refused",
        exit_code: 2,
        live_changed: "no",
        status: saved.status,
        post: { id: saved.id, uuid: saved.uuid, slug: saved.slug, url: saved.url },
        published_at: saved.published_at ?? null,
        message: [
          `The state repair was REFUSED: the live post (id ${saved.id}) was re-read in order to repair the recorded state and no longer represents this candidate — ${reason}.`,
          "Nothing was written, so the recorded state is still stale and the live post is untouched.",
          "Do not force it. Establish what the live post actually holds (a plan run, or Ghost Admin), commit that content to Git if it is what you want, and publish the resulting revision.",
        ].join("\n"),
      },
      log,
    );
  }
  // The owned-field fingerprint that gets recorded is the FRESH post's, not the
  // one computed from the earlier read.
  candidate.assetUrls = await resolveAssetUrls(ghost, candidate, saved);
  if (!liveContentMatchesCandidate(saved, candidate)) throw new RefusedError("The freshly read post's assets no longer match this candidate.");
  const freshOwned = liveOwnedHash(saved);
  const repairTag = Array.isArray(saved.tags) ? saved.tags.find((tag) => tag?.name === identityTagName(articleId)) ?? null : null;
  if (!repairTag) {
    record.step("state-repair", "uncertain", { error: "the post carries no identity tag" });
    return finish(
      record,
      {
        outcome: "state-uncertain",
        exit_code: 5,
        live_changed: "no",
        status: managed.status,
        post: { id: managed.id, uuid: managed.uuid, slug: managed.slug, url: managed.url },
        published_at: managed.published_at ?? null,
        message: addBeforeAnythingElse(
          `The live post (id ${managed.id}) already holds the candidate's content, but it carries no identity tag, so the pipeline's recorded state could not be repaired. Nothing was sent that changes Ghost.`,
          "uncertain",
        ),
      },
      log,
    );
  }
  record.step("state-repair", "sending", { request_sent: true });
  try {
    await ghost.updateTagDescription(
      repairTag.id,
      encodeState(finalStateFor({ articleId, candidate, saved, ownedHash: freshOwned })),
      repairTag.updated_at,
    );
    const confirmed = await ghost.findTagBySlug(identityTagSlug(articleId));
    if (confirmed?.id !== repairTag.id || confirmed.description !== encodeState(finalStateFor({ articleId, candidate, saved, ownedHash: freshOwned }))) {
      throw new UncertainError("Repaired state was not confirmed by readback.");
    }
  } catch (error) {
    record.step("state-repair", "uncertain", { error: error.message });
    record.mutate("tags", "uncertain");
    return finish(
      record,
      {
        outcome: "state-uncertain",
        exit_code: 5,
        live_changed: "no",
        status: managed.status,
        post: { id: managed.id, uuid: managed.uuid, slug: managed.slug, url: managed.url },
        published_at: managed.published_at ?? null,
        message: addBeforeAnythingElse(
          `The live post (id ${managed.id}) already holds the candidate's content, but the state-tag repair write was not confirmed: ${error.message}`,
          "uncertain",
        ),
      },
      log,
    );
  }
  record.step("state-repair", "ok");
  record.mutate("tags", "repaired");
  return finish(
    record,
    {
      // NOT "unchanged": this run wrote to Ghost. The outcome names what it
      // wrote, and live_changed stays "no" because that field answers a
      // different question — did the LIVE SITE change — which a state tag, an
      // internal tag no reader can see, does not.
      outcome: "state-repaired",
      exit_code: 0,
      live_changed: "no",
      status: saved.status,
      post: { id: saved.id, uuid: saved.uuid, slug: saved.slug, url: saved.url },
      published_at: saved.published_at ?? null,
      message: `Article "${articleId}" is already published as requested, so the live site was NOT changed. The recorded state tag was stale, so this run rewrote its description from the live post after re-proving the post against the candidate. That is a real Ghost mutation — one tag write — and no post write and no asset upload; the run's mutation accounting says the same.`,
    },
    log,
  );
}

/**
 * Establish whether a post write whose reply was lost actually applied, by
 * reading the live state back. Called only after an UncertainError from the
 * create/update request.
 *
 * Returns { applied: true, post } only when exactly one managed post carries
 * the identity tag AND it matches this candidate on body markers, owned
 * fields and status. Every other outcome throws UncertainError (exit 5) with
 * a message stating what was found — the run never leaves the outcome
 * unknown, and never creates a second post to "make sure".
 */
async function reconcileAfterUncertain({ ghost, articleId, candidate, record, stepName, error }) {
  // 2. Re-read the live state. A read that also fails leaves the outcome
  //    unknown: report uncertain and stop, exactly as before reconciliation.
  record.step("reconcile", "started");
  let byTag;
  try {
    byTag = await ghost.findPostsByTag(identityTagSlug(articleId));
  } catch (readError) {
    record.step("reconcile", "uncertain", { error: readError.message });
    throw new UncertainError(
      [
        `The ${stepName} request's reply was lost, and the read-back to establish its outcome also failed: ${readError.message}`,
        "The outcome of the write is therefore not established.",
        "Before doing anything else: do not simply re-run; check the post in Ghost Admin and compare with the candidate.",
      ].join("\n"),
    );
  }

  // 3. No post carries the identity tag: the write did not apply. Report
  //    uncertain — the outcome was not established by the failed request —
  //    but say that re-running is likely safe, and create nothing.
  if (byTag.length === 0) {
    record.step("reconcile", "uncertain", { found: 0 });
    throw new UncertainError(
      [
        `The ${stepName} request's reply was lost; the post was NOT found after the failed reply (no post carries the identity tag ${identityTagName(articleId)}), so the write did not apply.`,
        "Re-running is likely safe, but the outcome was not established by the failed request itself.",
      ].join("\n"),
    );
  }

  // 4. More than one post carries the identity tag: ambiguous. Never guess.
  if (byTag.length > 1) {
    record.step("reconcile", "uncertain", { found: byTag.length });
    throw new UncertainError(
      [
        `The ${stepName} request's reply was lost, and ${byTag.length} posts now carry the identity tag ${identityTagName(articleId)}.`,
        "The managed post is ambiguous, so the outcome of the write is not established; resolve the duplicates in Ghost Admin by hand.",
        "Before doing anything else: do not simply re-run.",
      ].join("\n"),
    );
  }

  // 5. Exactly one managed post: is it this candidate's write, applied? The
  //    body proof is the strict outline equivalence (liveContentProof — the
  //    same proof --repair-state and decide() use), never marker containment:
  //    a lost reply whose write did not apply often leaves the OLD body,
  //    which contains the candidate's fragments whenever the edit was a
  //    deletion, a reorder or a rewording, and containment would confirm the
  //    write as applied. The candidate here is the uploadable body (refs
  //    rewritten to the uploaded URLs), so the image src compares exactly.
  const managed = byTag[0];
  const proof = liveContentProof(managed, candidate);
  const bodyOk = proof.ok;
  const fieldsOk = ownedFieldsMatch(managed, candidate);
  const statusOk = managed.status === candidate.status;
  if (bodyOk && fieldsOk && statusOk) {
    record.step("reconcile", "ok", { found: 1, post_id: managed.id });
    return { applied: true, post: managed };
  }

  // The post exists but does not match the candidate: the outcome is not
  // established. Do not re-write over something we cannot account for.
  record.step("reconcile", "uncertain", { found: 1, post_id: managed.id, ...(bodyOk ? {} : { body_problems: proof.problems.slice(0, 5) }) });
  throw new UncertainError(
    [
      `The ${stepName} request's reply was lost, and the post carrying the identity tag ${identityTagName(articleId)} (id ${managed.id}) does not match the candidate ` +
        `(body ${bodyOk ? "matches" : "differs"}, owned fields ${fieldsOk ? "match" : "differ"}, status ${statusOk ? "matches" : "differs"}).` +
        (bodyOk ? "" : ` The stored body is not the candidate's body: ${proof.problems.slice(0, 5).join(" ")}`),
      "The outcome of the write is therefore not established; the post is NOT re-written.",
      "Before doing anything else: compare the post in Ghost Admin with the candidate, then decide.",
    ].join("\n"),
  );
}

/**
 * The owned fields that would change between what Ghost holds and what the
 * candidate wants, for the plan report. The non-body fields are compared
 * field by field (the same comparison ownedFieldsMatch makes); the body is
 * reported as one entry when the recorded stored-body hash and the live
 * stored-body hash disagree — never by diffing rendered HTML against stored
 * HTML, which Ghost's deterministic rewrites would always read as changed.
 */
function diffOwned(managed, candidate, priorState, liveGhostBodyHash) {
  if (!managed) return ["(new post)"];
  const fields = [];
  if ((managed.title ?? null) !== (candidate.title ?? null)) fields.push("title");
  if ((managed.slug ?? null) !== (candidate.slug ?? null)) fields.push("slug");
  if ((managed.status ?? null) !== (candidate.status ?? null)) fields.push("status");
  if ((managed.custom_excerpt ?? null) !== (candidate.excerpt ?? null)) fields.push("custom_excerpt");
  const held = publicTagNames(managed).sort().join("\u0000");
  const wanted = [...candidate.tags].sort().join("\u0000");
  if (held !== wanted) fields.push("tags");
  if (candidate.authors.length > 0) {
    const heldAuthors = (managed.authors ?? []).map((author) => author.slug).sort().join("\u0000");
    const wantedAuthors = [...candidate.authors].sort().join("\u0000");
    if (heldAuthors !== wantedAuthors) fields.push("authors");
  }
  if (priorState?.ghostBodyHash !== liveGhostBodyHash) fields.push("body");
  return fields.length ? fields : ["(none)"];
}

/** What the record reports for live_changed, by outcome. */
function liveChanged(record, outcome) {
  if (outcome === "uncertain" || outcome === "public-check-failed") {
    return record.data.live_changed === "yes" ? "yes" : "unknown";
  }
  return record.data.live_changed;
}

/** The "before doing anything else" note the record message must carry for outcomes a repeat can worsen. */
function addBeforeAnythingElse(message, outcome) {
  const note = {
    uncertain: "Before doing anything else: do not simply re-run; a request that changes Ghost was sent and its effect is unknown.",
    conflict: "Before doing anything else: reconcile the Ghost-side edit by hand; re-running would overwrite it.",
    "public-check-failed":
      "Before doing anything else: the Ghost mutation is CONFIRMED and the public page check failed, so re-running may publish a duplicate.",
    "unauthorised-effects": "Before doing anything else: check the live site; an unauthorised change took effect.",
  }[outcome];
  return note ? `${message}\n\n${note}` : message;
}

/** Exit code for a decision that refuses or conflicts in plan mode. */
function classifyDecisionExit(action) {
  if (action === "refused") return 2;
  if (action === "conflict") return 3;
  return 0;
}

/**
 * Replace each uploaded asset ref with its URL, through the SAME code-aware,
 * <img>-only walk that discovered the refs (markdown.mjs's mapImageSrc), so
 * discovery and rewriting can never disagree about which references were
 * published. A whole attribute value is matched, never a substring of
 * another path, and a code example that happens to spell the same path stays
 * literal: it was never discovered, so it is never rewritten, and the
 * published post keeps showing the example rather than a live image.
 */
export function rewriteRefs(html, uploaded) {
  return mapImageSrc(html, (value) => (uploaded.has(value) ? uploaded.get(value) : value));
}
