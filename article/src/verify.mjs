// Verification of what Ghost actually holds, without sending anything that
// could change it. Two checks: the saved post (read through the Admin API,
// which reports the html Ghost stored — formats=html is the caller's to
// request) against the candidate's content and owned fields, and the public
// page (what visitors are served) against the same content. Ghost rewrites
// stored HTML (heading ids, kg-card wrapping, loading="lazy", its own
// comments), so the check is never byte equality: the saved post must hold
// the candidate's whole content outline (same blocks, same order, none
// missing, none extra), and the public page must hold it inside its rendered
// article region, falling back to containment only when the region cannot be
// isolated — and saying so, so no record reads a containment pass as a proof.

import { checkMarkers, compareOutlines, contentOutline, elementSpan } from "./normalize.mjs";
import { identityTagName, identityTagSlug } from "./identity.mjs";

const tagNames = (post) =>
  Array.isArray(post?.tags)
    ? post.tags.map((tag) => tag?.name).filter((name) => typeof name === "string" && name)
    : [];

const tagSlugs = (post) =>
  Array.isArray(post?.tags)
    ? post.tags.map((tag) => tag?.slug).filter((slug) => typeof slug === "string" && slug)
    : [];

const authorSlugs = (post) =>
  Array.isArray(post?.authors)
    ? post.authors.map((author) => author?.slug).filter((slug) => typeof slug === "string" && slug)
    : [];

/** Public tag names: everything that is not an internal (hash-prefixed) tag. */
export function publicTagNames(post) {
  return tagNames(post).filter((name) => !name.startsWith("#"));
}

// Ghost's lexical serializer unescapes some entities marked escapes (a code
// block's &quot; comes back as "), so both sides are decoded before marker
// comparison. One pass, never recursive: &amp;quot; decodes to &quot; and
// stays that way, the same way a browser would read it.
const ENTITIES = { "&quot;": '"', "&#39;": "'", "&apos;": "'", "&gt;": ">", "&lt;": "<", "&nbsp;": " ", "&amp;": "&" };

/** Decode the common character entities, once, for marker comparison. */
export function decodeEntities(html) {
  return String(html).replace(/&(?:quot|#39|apos|gt|lt|nbsp|amp);/g, (entity) => ENTITIES[entity]);
}

/**
 * Whether the stored body IS the candidate's body: the same content blocks
 * in the same order, none missing, none extra, none duplicated — the
 * equivalence the marker check cannot establish (an unapplied update whose
 * old body merely contains the candidate's fragments passes containment).
 * Ghost's legitimate rewrites are absorbed by the outline itself (heading
 * ids, kg-card wrappers and comments, class and lazy-loading attributes,
 * entity decoding); both sides are decoded before comparison, so a
 * one-sided entity form never reads as a content difference. The image src
 * is compared by an alt-plus-shape tolerance when `imageSrcShape` is
 * given: the saved-post paths hold the uploadable body (refs rewritten to
 * the uploaded URLs), while other callers may hold only the pre-upload
 * candidate body, whose src a strict compare could never satisfy. A
 * content-null html (no post, no body) is refused as a comparison failure,
 * never silently equal.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function storedBodyEquals(expectedHtml, actualHtml, { imageSrcShape = null } = {}) {
  const decode = decodeEntities;
  // A null/undefined body is not an empty body: an absent stored body is a
  // comparison failure (no post to prove anything about), never a silent
  // equality with an empty candidate — and an outline that cannot be read
  // (unbalanced markup) is refused the same way, never guessed at.
  if (expectedHtml === null || expectedHtml === undefined) {
    return { ok: false, problems: ["the candidate's body is missing, so no content comparison is possible."] };
  }
  if (actualHtml === null || actualHtml === undefined) {
    return { ok: false, problems: ["the stored body is missing, so no content comparison is possible."] };
  }
  // The shape is applied while the outlines are built, not afterwards: an
  // image can sit inside a paragraph's inline structure as well as be a block
  // of its own, and only the extraction knows which src values are which.
  const shape = imageSrcShape ? (src) => imageSrcShape(String(src ?? "")) : undefined;
  const expected = contentOutline(String(expectedHtml), decode, shape);
  const actual = contentOutline(String(actualHtml), decode, shape);
  if (expected === null || actual === null) {
    return { ok: false, problems: ["the html to compare is not outlineable (an element never closes), so no content comparison is possible."] };
  }
  const compared = compareOutlines(expected, actual);
  return { ok: compared.ok, problems: compared.problems };
}

/**
 * The saved post against the candidate: the stored body holds the
 * candidate's whole content outline, and the owned fields match. Authors
 * are only compared when the candidate names any: Ghost accepts an unknown
 * author slug without error, so the comparison is only meaningful when the
 * candidate asked for authors.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifySavedPost(post, candidate) {
  if (!post || typeof post !== "object") {
    return { ok: false, problems: ["Ghost returned no post to verify."] };
  }
  const problems = [];
  const saved = storedBodyEquals(candidate.bodyHtml, post.html ?? "");
  if (post.title !== candidate.title) problems.push("title differs from the candidate");
  if ((post.custom_excerpt ?? null) !== (candidate.excerpt ?? null)) problems.push("excerpt differs from the candidate");
  if (candidate.featureImage && post.feature_image !== candidate.featureImageUrl) problems.push("feature image differs from the intended upload");
  if (!saved.ok) problems.push(...saved.problems.map((problem) => `the stored body is not the candidate's body: ${problem}`));
  if (post.status !== candidate.status) {
    problems.push(`status is "${post.status}", expected "${candidate.status}"`);
  }
  if (post.slug !== candidate.slug) {
    problems.push(`slug is "${post.slug}", expected "${candidate.slug}"`);
  }
  const expectedTags = [...candidate.tags].sort();
  const actualTags = publicTagNames(post).sort();
  if (expectedTags.join("\u0000") !== actualTags.join("\u0000")) {
    problems.push(`public tags are [${actualTags.join(", ")}], expected [${expectedTags.join(", ")}]`);
  }
  if (!tagSlugs(post).includes(identityTagSlug(candidate.article.id))) {
    problems.push(`the identity tag "${identityTagName(candidate.article.id)}" is not on the post`);
  }
  if (candidate.authors.length > 0) {
    const expectedAuthors = [...candidate.authors].sort();
    const actualAuthors = authorSlugs(post).sort();
    if (expectedAuthors.join("\u0000") !== actualAuthors.join("\u0000")) {
      problems.push(`authors are [${actualAuthors.join(", ")}], expected [${expectedAuthors.join(", ")}]`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The rendered article content region of a public page: Ghost's themes
 * wrap the article body in a `<section class="gh-content">` (this theme's
 * partials/article.hbs does, and Ghost's own Casper does the same), so the
 * strict outline comparison can run on the article's blocks alone, apart
 * from the page's nav, footer and related posts. Located defensively: the
 * first balanced element whose class attribute carries a `gh-content`
 * token, or null when the theme serves none — a null the caller treats as
 * "not isolatable", never as "no content".
 */
function contentRegion(pageHtml) {
  const source = String(pageHtml ?? "");
  const OPENING = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*>/g;
  for (const open of source.matchAll(OPENING)) {
    const classValue = /(?:^|\s)class\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i.exec(open[0]);
    const classes = (classValue ? classValue[2] ?? classValue[3] ?? classValue[4] ?? "" : "").split(/\s+/);
    if (!classes.includes("gh-content")) continue;
    const span = elementSpan(source, open.index, open[1].toLowerCase());
    if (span) return source.slice(span.start, span.end);
  }
  return null;
}

/**
 * The public page a visitor is served, against the candidate's content.
 * page is { status, body } as fetchPublic returns it. The page is a full
 * themed HTML document (nav, footer, related posts) whose outbound links
 * carry Ghost's `?ref=` parameter, so strict whole-page comparison is
 * wrong; the rendered article region is isolated (contentRegion) and the
 * strict outline comparison runs on that region. Ghost's click-tracking
 * rewrite is absorbed by the outline itself, which normalises every link
 * href and image src symmetrically on both sides (entities decoded, the
 * `ref` search parameter deleted from an absolute http(s) URL, URL.href —
 * see normalize.mjs's normalizeHref): both observed public-page forms
 * ('https://x.invalid/a?x=1&amp;y=2' -> 'https://x.invalid/a?x=1&y=2&ref=localhost'
 * and 'https://q.invalid' -> 'https://q.invalid/?ref=localhost') therefore
 * compare equal. When the region cannot be isolated the check falls back to
 * marker containment, and the result says so plainly in the problems when it
 * failed — a containment-only pass is reported as `containmentOnly: true`
 * so the operator and the record are never misled that the page was proven
 * equivalent. HTTP status problems are reported separately from content
 * problems.
 *
 * @returns {{ ok: boolean, problems: string[], containmentOnly: boolean }}
 */
export function checkPublicPage(page, candidate) {
  if (!page || typeof page !== "object") {
    return { ok: false, problems: ["No public page was fetched to check."], containmentOnly: false };
  }
  const problems = [];
  if (page.status !== 200) {
    problems.push(`the public page answered HTTP ${page.status}, expected 200`);
  }
  const body = String(page.body ?? "");
  const region = contentRegion(body);
  if (region === null) {
    // Not isolatable: containment only, said plainly. The containment
    // result still catches a page that lost the candidate's content
    // outright; it just cannot catch a reorder, a duplicate or an extra
    // block outside the candidate's fragments.
    const markers = checkMarkers(decodeEntities(candidate.bodyHtml), decodeEntities(body));
    if (!markers.ok) {
      problems.push(...markers.missing.map((missing) => `missing content on the public page: ${missing} (containment-only check: the article region could not be isolated)`));
    }
    if (problems.length > 0) {
      problems.push("the public page's article region could not be isolated, so the content check was containment-only, not a full equivalence proof.");
    }
    return { ok: problems.length === 0, problems, containmentOnly: true };
  }
  const compared = storedBodyEquals(candidate.bodyHtml, region);
  if (!compared.ok) {
    problems.push(...compared.problems.map((problem) => `the public page's article content is not the candidate's content: ${problem}`));
  }
  return { ok: problems.length === 0, problems, containmentOnly: false };
}
