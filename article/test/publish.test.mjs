// publish.mjs: decide() for every branch, and the payload builder's shape —
// pure objects only, no Ghost, no client, no clock. The decision table is
// the contract runPublish acts on; the payload is the contract with Ghost
// about what the pipeline owns and never touches.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { decide, ownedFieldsMatch, postPayload, liveOwnedHash, unrelatedInternalTags, wrapRawHtmlSegments, rewriteRefs, candidateImageSrcShape } from "../src/publish.mjs";
import { encodeState, identityTagName } from "../src/identity.mjs";
import { ghostBodyHash, ownedFieldsHash } from "../src/normalize.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();

const dirs = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (dirs.length) dirs.pop()();
});

/** A throwaway repo with two commits: base, then head (an ancestor of head). */
function fixtureRepo() {
  const root = temp("article-decide-");
  git(root, "init", "--initial-branch", "main");
  const file = path.join(root, "file.txt");
  writeFileSync(file, "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  appendFileSync(file, "head\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "head");
  const head = git(root, "rev-parse", "HEAD");
  return { root, base, head };
}

const CANDIDATE = (revision) => ({
  article: { id: "hello-world", path: "editorial/articles/hello-world" },
  source: { revision, kind: "commit", repo: "repo" },
  title: "Hello, world",
  slug: "hello-world",
  status: "published",
  authors: ["kareem"],
  excerpt: "A first article.",
  tags: ["tools", "ghost"],
  featureImage: null,
  bodyHtml: "<h2 id=\"setup\">Setup</h2><p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
  bodyHash: "0".repeat(64),
  candidateHash: "1".repeat(64),
  assets: [],
  unknownKeys: [],
});

const MANAGED = (fields) => ({
  id: "p1",
  uuid: "u-p1",
  slug: "hello-world",
  title: "Hello, world",
  status: "published",
  custom_excerpt: "A first article.",
  html: "<h2 id=\"setup\">Setup</h2><p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
  published_at: "2026-09-20T10:00:00.000Z",
  updated_at: "2026-09-21T10:00:00.000Z",
  tags: [
    { name: "tools", slug: "tools", visibility: "public" },
    { name: "ghost", slug: "ghost", visibility: "public" },
    { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
  ],
  authors: [{ slug: "kareem" }],
  ...fields,
});

/** priorState as decodeState would return it, derived from a managed post's own fields. */
const state = (fields) => ({
  id: "hello-world",
  revision: null,
  candidateHash: null,
  ghostBodyHash: null,
  ownedHash: null,
  publishedAt: null,
  status: null,
  ghostUpdatedAt: null,
  ...fields,
});

describe("decide", () => {
  test("no managed post: create", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const decision = decide({ managed: null, priorState: null, candidate, candidateHash16: "c".repeat(16), liveGhostBodyHash: null, ownedFieldsMatch: false, repoRoot: root });
    assert.equal(decision.action, "create");
    assert.ok(decision.reason.length > 0);
  });

  test("managed post, no readable state: refused (cannot account for its history)", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED();
    const decision = decide({ managed, priorState: null, candidate, candidateHash16: "c".repeat(16), liveGhostBodyHash: ghostBodyHash(managed.html), ownedFieldsMatch: true, repoRoot: root });
    assert.equal(decision.action, "refused");
    assert.match(decision.reason, /no readable state/);
  });

  test("managed post edited in Ghost since the last publish (updated_at differs): conflict", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ title: "Edited in Ghost", updated_at: "2026-09-25T10:00:00.000Z" });
    const decision = decide({
      managed,
      priorState: state({ ghostUpdatedAt: "2026-09-21T10:00:00.000Z", revision: head }),
      candidate,
      candidateHash16: "c".repeat(16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      repoRoot: root,
    });
    assert.equal(decision.action, "conflict");
    assert.match(decision.reason, /edited in Ghost after this pipeline's last publish/);
    assert.match(decision.reason, /2026-09-25T10:00:00.000Z/);
  });

  test("managed post, recorded state matches the candidate exactly: unchanged", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED();
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(managed.html),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      repoRoot: root,
    });
    assert.equal(decision.action, "unchanged");
  });

  test("managed post, matching hashes but a changed owned field (title): update", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ title: "Edited outside the pipeline" });
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(managed.html),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: false,
      repoRoot: root,
    });
    assert.equal(decision.action, "update");
  });

  test("managed post, recorded candidate hash differs from the candidate: update", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED();
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: "9".repeat(16), // a different candidate was published last
        ghostBodyHash: ghostBodyHash(managed.html),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      repoRoot: root,
    });
    assert.equal(decision.action, "update");
  });

  // The OLD oracle here was "update": a live body that differs from the
  // recorded one was read as this pipeline's own content being behind, so
  // the publish updated over it. That oracle was wrong. Ghost stores
  // updated_at with SECOND granularity, so an unexpected Ghost-side edit
  // that lands within the same second as the recorded write is invisible to
  // the timestamp; the recorded body fingerprint is what distinguishes the
  // pipeline's own published body from somebody else's edit, and a live
  // body that differs from the recorded one is an edit this pipeline did
  // not make — updating over it would overwrite it.
  test("managed post, live stored body no longer the recorded one (same second): conflict", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ html: "<p>a different stored body</p>" });
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: "0".repeat(16), // the recorded body hash, not this one
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "conflict");
    assert.match(decision.reason, /stored body differs from the recorded published body/);
  });

  test("candidate revision not newer than the live one (a competing attempt): refused", () => {
    const { root, base, head } = fixtureRepo();
    // The candidate is the OLDER commit: live is head, candidate is base.
    const candidate = CANDIDATE(base);
    const managed = MANAGED();
    const decision = decide({
      managed,
      priorState: state({ ghostUpdatedAt: managed.updated_at, revision: head, candidateHash: "9".repeat(16) }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      repoRoot: root,
    });
    assert.equal(decision.action, "refused");
    assert.match(decision.reason, /stale or competing attempt/);
  });

  test("candidate revision newer (an ancestor of the live one): update", () => {
    const { root, base, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ title: "Old title" });
    const decision = decide({
      managed,
      priorState: state({ ghostUpdatedAt: managed.updated_at, revision: base }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: false,
      repoRoot: root,
    });
    assert.equal(decision.action, "update");
  });

  test("a paragraph-only Ghost-side edit with an unchanged recorded updated_at is a conflict", () => {
    // Ghost stores updated_at with SECOND granularity, so an unexpected
    // Ghost-side edit made within the same second as the recorded write is
    // invisible to the timestamp check. The recorded body fingerprint is
    // what catches it: a live body that differs from the recorded one is an
    // edit this pipeline did not make, and updating over it would overwrite
    // it. (Before the fix this returned "update", overwriting the edit.)
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ html: "<h2 id=\"setup\">Setup</h2><p>Edited in Ghost, same second.</p>" });
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at, // the same second: invisible to the timestamp
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash("<h2 id=\"setup\">Setup</h2><p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>"),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "conflict");
  });

  test("a Ghost-side TITLE edit with an unchanged recorded updated_at is a conflict", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED({ title: "Edited in Ghost, same second" });
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(managed.html),
        ownedHash: liveOwnedHash(MANAGED()), // the recorded owned fingerprint of the published state
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: false,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "conflict");
    assert.match(decision.reason, /owned-field fingerprint/);
  });

  test("a legitimate source update (live post still the recorded one) still updates", () => {
    const { root, base, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED(); // the live post is exactly the recorded published state
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: base, // an older revision was published last
        candidateHash: "9".repeat(16), // a different candidate was published last
        ghostBodyHash: ghostBodyHash(managed.html),
        ownedHash: liveOwnedHash(managed),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "update");
  });

  test("a true no-op still decides unchanged", () => {
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED();
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(managed.html),
        ownedHash: liveOwnedHash(managed),
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "unchanged");
  });

  test("a real-Ghost no-op repeat publish is unchanged (the C3 regression)", () => {
    // Ghost stores a structurally rewritten body: kg-card comments, reflowed
    // whitespace, entity decoding. The recorded state was written from the
    // SAME stored html, so the body comparison is like-for-like (ghostBodyHash
    // on both sides) and the non-body owned fingerprint is computed from
    // directly comparable values on both sides.
    //
    // Before the fix the owned fingerprint ALSO hashed the body: the
    // candidate's RENDERED html on the desired side, Ghost's STORED html on
    // the live side. Those two can never be equal, so this genuine no-op read
    // as an unexpected Ghost-side edit — the exact regression the
    // disposable-Ghost suite caught in scenario 5 (repeat publish unchanged).
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const storedHtml =
      "<!--kg-card-begin: markdown--><h2 id=\"setup\">Setup</h2>\n" +
      "<p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p><!--kg-card-end: markdown-->";
    const managed = MANAGED({ html: storedHtml });
    // The desired non-body fingerprint over the candidate's own fields is the
    // same digest the live post produces: that equality is what makes the
    // repeat publish a no-op.
    const desiredOwned = ownedFieldsHash({
      title: candidate.title,
      slug: candidate.slug,
      status: candidate.status,
      custom_excerpt: candidate.excerpt ?? null,
      tags: candidate.tags,
      authors: candidate.authors,
    });
    assert.equal(desiredOwned, liveOwnedHash(managed));
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(storedHtml),
        ownedHash: desiredOwned,
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(storedHtml),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "unchanged");
  });

  test("a state record written by the PREVIOUS code degrades to conflict, never a false unchanged", () => {
    // The stored fingerprint's semantics changed: it no longer covers the
    // body. The schema version (identity.mjs's `s: 1`) is deliberately
    // unchanged and the stored field name (`ow`) and shape (16 hex) are
    // unchanged, so an old record cannot be told apart structurally — but
    // its `ow` was computed over a body-inclusive payload, so it will not
    // equal the new non-body fingerprint. That mismatch is a conflict (the
    // operator reconciles, or re-runs --repair-state, which re-derives the
    // state from the live post), never a false "unchanged" that would leave
    // a stale record in place. This is the fail-safe direction: an
    // unrecognised record must never read as "unchanged".
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    const managed = MANAGED();
    // The OLD body-inclusive digest, reproduced exactly as the previous
    // ownedHash computed it: same payload fields, plus the normalised body.
    const legacyPayload = {
      title: candidate.title,
      slug: candidate.slug,
      status: candidate.status,
      custom_excerpt: candidate.excerpt ?? null,
      tags: [...candidate.tags].sort(),
      authors: [...candidate.authors].sort(),
      body: String(candidate.bodyHtml).replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim(),
    };
    const legacyOwned = createHash("sha256").update(JSON.stringify(legacyPayload)).digest("hex").slice(0, 16);
    assert.notEqual(legacyOwned, liveOwnedHash(managed)); // the new fingerprint differs
    const decision = decide({
      managed,
      priorState: state({
        ghostUpdatedAt: managed.updated_at,
        revision: head,
        candidateHash: candidate.candidateHash.slice(0, 16),
        ghostBodyHash: ghostBodyHash(managed.html),
        ownedHash: legacyOwned,
      }),
      candidate,
      candidateHash16: candidate.candidateHash.slice(0, 16),
      liveGhostBodyHash: ghostBodyHash(managed.html),
      ownedFieldsMatch: true,
      liveOwnedHash: liveOwnedHash(managed),
      repoRoot: root,
    });
    assert.equal(decision.action, "conflict");
    assert.match(decision.reason, /owned-field fingerprint/);
  });

  test("liveOwnedHash hashes the live post's non-body owned fields the way desiredOwnedHash hashed the recorded one", () => {
    // ownedFieldsHash's own digest is 16 hex (hash16 inside it), so the live
    // fingerprint is the like-for-like form of the recorded ownedHash: a
    // different NON-BODY owned field moves it; the tag order and the identity
    // tag never do. The body is NOT part of it — the two sides of the body
    // comparison are the candidate's rendered HTML against Ghost's stored
    // rewrite, which can never be equal, so the body is compared only through
    // ghostBodyHash on both sides (see the decide() tests).
    const managed = MANAGED();
    assert.match(liveOwnedHash(managed), /^[0-9a-f]{16}$/);
    assert.notEqual(liveOwnedHash(managed), liveOwnedHash(MANAGED({ title: "A different title" })));
    assert.notEqual(liveOwnedHash(managed), liveOwnedHash(MANAGED({ slug: "a-different-slug" })));
    assert.notEqual(liveOwnedHash(managed), liveOwnedHash(MANAGED({ custom_excerpt: "A different excerpt." })));
    const reorderedTags = MANAGED({ tags: [...managed.tags].reverse() });
    assert.equal(liveOwnedHash(managed), liveOwnedHash(reorderedTags));
    // A different stored body does NOT move the owned fingerprint: the body
    // is deliberately outside it (that was the regression — a body-inclusive
    // fingerprint compared rendered text against stored text and could never
    // match on a genuine no-op). The body's own ghostBodyHash catches it.
    assert.equal(liveOwnedHash(managed), liveOwnedHash(MANAGED({ html: "<p>a different body</p>" })));
    // The recorded form is the same digest as desiredOwnedHash over the
    // published candidate: a live post that holds the candidate's content
    // carries the fingerprint the state tag records.
    const candidate = CANDIDATE("a".repeat(40));
    const recordedLive = MANAGED({ html: "<h2 id=\"setup\">Setup</h2><p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>" });
    assert.equal(liveOwnedHash(recordedLive), liveOwnedHash(managed));
  });

  test("a slug collision with an unrelated post is a decision input, not decide's job", () => {
    // decide() never sees the slug search; runPublish refuses before it calls
    // decide. The unit basis for that refusal is the flow's, tested here only
    // in shape: decide has no branch for it, by design.
    const { root, head } = fixtureRepo();
    const candidate = CANDIDATE(head);
    assert.equal(
      decide({ managed: null, priorState: null, candidate, candidateHash16: "c".repeat(16), liveGhostBodyHash: null, ownedFieldsMatch: false, repoRoot: root }).action,
      "create",
    );
  });
});

describe("ownedFieldsMatch", () => {
  test("equal fields, tags in a different order: match", () => {
    const managed = MANAGED({ tags: [
      { name: "ghost", slug: "ghost", visibility: "public" },
      { name: "tools", slug: "tools", visibility: "public" },
      { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
    ] });
    assert.equal(ownedFieldsMatch(managed, CANDIDATE("a".repeat(40))), true);
  });

  test("a changed public tag set: no match", () => {
    const managed = MANAGED({ tags: [
      { name: "tools", slug: "tools", visibility: "public" },
      { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
    ] });
    assert.equal(ownedFieldsMatch(managed, CANDIDATE("a".repeat(40))), false);
  });

  test("a changed title, slug, status or excerpt: no match", () => {
    for (const fields of [{ title: "Another title" }, { slug: "another-slug" }, { status: "draft" }, { custom_excerpt: "Another excerpt." }]) {
      assert.equal(ownedFieldsMatch(MANAGED(fields), CANDIDATE("a".repeat(40))), false);
    }
  });

  test("custom_excerpt undefined on the post and null on the candidate read as equal", () => {
    const { title, slug, status, ...rest } = MANAGED({ custom_excerpt: undefined });
    assert.equal(ownedFieldsMatch({ ...rest, title, slug, status }, { ...CANDIDATE("a".repeat(40)), excerpt: null }), true);
  });

  test("authors are ignored when the candidate names none", () => {
    const managed = MANAGED({ authors: [{ slug: "someone-else" }] });
    const candidate = { ...CANDIDATE("a".repeat(40)), authors: [] };
    assert.equal(ownedFieldsMatch(managed, candidate), true);
  });

  test("authors are compared when the candidate names them", () => {
    assert.equal(ownedFieldsMatch(MANAGED({ authors: [{ slug: "kareem" }] }), CANDIDATE("a".repeat(40))), true);
    assert.equal(ownedFieldsMatch(MANAGED({ authors: [{ slug: "someone-else" }] }), CANDIDATE("a".repeat(40))), false);
    // order is not content: the same set in a different order matches
    assert.equal(
      ownedFieldsMatch(
        MANAGED({ authors: [{ slug: "second" }, { slug: "kareem" }] }),
        { ...CANDIDATE("a".repeat(40)), authors: ["kareem", "second"] },
      ),
      true,
    );
  });

  test("an internal (hash-prefixed) tag is not a public tag and never blocks a match", () => {
    const managed = MANAGED({ tags: [
      { name: "tools", slug: "tools", visibility: "public" },
      { name: "ghost", slug: "ghost", visibility: "public" },
      { name: "#private-tag", slug: "hash-private-tag", visibility: "internal" },
      { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
    ] });
    assert.equal(ownedFieldsMatch(managed, CANDIDATE("a".repeat(40))), true);
  });

  // C10: an unrelated internal tag is preserved by an update, so it must
  // also never make a no-op read as changed — the match stays true with it.
  test("an unrelated internal tag never makes a no-op read as changed (C10)", () => {
    const managed = MANAGED({ tags: [
      { name: "tools", slug: "tools", visibility: "public" },
      { name: "ghost", slug: "ghost", visibility: "public" },
      { name: "#featured-series", slug: "hash-featured-series", visibility: "internal" },
      { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
    ] });
    assert.equal(ownedFieldsMatch(managed, CANDIDATE("a".repeat(40))), true);
  });
});

describe("postPayload", () => {
  // NOTE (C6): the identity tag's entry carries NO `description`. Real Ghost
  // 6.64.0 SILENTLY IGNORES a description inside a post's tags[] array (on
  // create and on update), so the OLD oracle here — which asserted that the
  // payload's identity tag carried the provisional state JSON — was asserting
  // a write real Ghost never performs. The state is now written as its own
  // request, before the post write (see ensureIdentityTagState); the post
  // payload references the tag by name+slug+visibility only, which preserves
  // whatever that step set. These tests were corrected to the real behaviour.

  test("contains the owned fields and the identity tag, and no unowned field", () => {
    const payload = postPayload(CANDIDATE("a".repeat(40)), { featureImage: null });
    assert.deepEqual(Object.keys(payload).sort(), ["authors", "custom_excerpt", "html", "slug", "status", "tags", "title"]);
    assert.deepEqual(payload.authors, [{ slug: "kareem" }]);
    assert.equal(payload.title, "Hello, world");
    assert.equal(payload.slug, "hello-world");
    assert.equal(payload.status, "published");
    assert.equal(payload.custom_excerpt, "A first article.");
    const identityTag = payload.tags.find((tag) => tag.name === identityTagName("hello-world"));
    assert.ok(identityTag, "the identity tag must travel with every post write");
    assert.equal(identityTag.visibility, "internal");
    assert.equal(identityTag.slug, "hash-nc-article-hello-world");
    // No description: real Ghost ignores it, and sending one would masquerade
    // as a state write that never lands. The tag-state step writes the state.
    assert.equal("description" in identityTag, false, "the post payload must not carry the identity tag's state (real Ghost ignores it)");
    const publicTags = payload.tags.filter((tag) => tag !== identityTag);
    assert.deepEqual(publicTags, [{ name: "tools" }, { name: "ghost" }]);
  });

  test("never contains a field outside the pipeline's declared ownership", () => {
    const payload = postPayload(CANDIDATE("a".repeat(40)), { featureImage: "https://example.invalid/img.png" });
    // Ghost preserves what a PUT omits; sending these would claim ownership
    // the pipeline does not have.
    for (const forbidden of [
      "published_at",
      "featured",
      "visibility",
      "codeinjection_head",
      "codeinjection_foot",
      "meta_title",
      "meta_description",
      "og_image",
      "og_title",
      "og_description",
      "twitter_image",
      "twitter_title",
      "twitter_description",
      "canonical_url",
      "custom_template",
      "email_subject",
      "email_preview",
      "feature_image_alt",
    ]) {
      assert.ok(!(forbidden in payload), `payload must not carry ${forbidden}`);
    }
    assert.equal(payload.feature_image, "https://example.invalid/img.png");
    assert.deepEqual(payload.authors, [{ slug: "kareem" }]); // authors are sent: the candidate names one
  });

  test("authors are only present when the candidate names any", () => {
    const withAuthors = postPayload(CANDIDATE("a".repeat(40)), { featureImage: null });
    assert.deepEqual(withAuthors.authors, [{ slug: "kareem" }]);
    const withoutAuthors = postPayload({ ...CANDIDATE("a".repeat(40)), authors: [] }, { featureImage: null });
    assert.equal(withoutAuthors.authors, undefined);
  });

  test("excerpt null, not omitted, when the candidate has none", () => {
    const payload = postPayload({ ...CANDIDATE("a".repeat(40)), excerpt: null }, { featureImage: null });
    assert.ok("custom_excerpt" in payload);
    assert.equal(payload.custom_excerpt, null);
  });

  test("updated_at is only set when the caller passes one (an update, never a create)", () => {
    const create = postPayload(CANDIDATE("a".repeat(40)), { featureImage: null });
    assert.equal(create.updated_at, undefined);
    const update = postPayload(CANDIDATE("a".repeat(40)), { featureImage: null, updatedAt: "2026-09-21T10:00:00.000Z" });
    assert.equal(update.updated_at, "2026-09-21T10:00:00.000Z");
  });

  // C10: a PUT replaces the whole tag set, so an update that does not carry
  // the live post's unrelated internal tags deletes them. Before the fix,
  // postPayload sent candidate tags + the identity tag only, so a human's
  // #featured-series was silently dropped by an ordinary update.
  test("an update preserves the live post's unrelated internal tags; a create has none to preserve", () => {
    const internalTag = { name: "#featured-series", slug: "hash-featured-series", visibility: "internal", description: "a human's internal tag" };
    // An update with the live post passed in: the internal tag travels along.
    const update = postPayload(CANDIDATE("a".repeat(40)), {
      featureImage: null,
      preserveInternalTags: [internalTag],
    });
    const preserved = update.tags.find((tag) => tag.name === "#featured-series");
    assert.ok(preserved, "the unrelated internal tag must travel with the update");
    assert.equal(preserved.visibility, "internal");
    assert.equal(preserved.slug, "hash-featured-series");
    // The preserved tag is sent by name+slug+visibility only, never with its
    // description: a description in a post's tags[] is ignored by real Ghost
    // anyway, and the preserved tag's state is not this pipeline's to write.
    assert.equal("description" in preserved, false, "a preserved internal tag travels without its description");
    // The public tags stay fully owned: exactly the candidate's, plus the
    // identity tag, plus the preserved internal tag — nothing else.
    assert.deepEqual(
      update.tags.map((tag) => tag.name).sort(),
      ["#featured-series", "#nc-article-hello-world", "ghost", "tools"],
    );
    // A create (no live post) carries no preserved internal tags.
    const create = postPayload(CANDIDATE("a".repeat(40)), { featureImage: null });
    assert.deepEqual(
      create.tags.map((tag) => tag.name).sort(),
      ["#nc-article-hello-world", "ghost", "tools"],
    );
  });

  test("unrelatedInternalTags extracts exactly the non-identity internal tags of a live post", () => {
    const managed = MANAGED({ tags: [
      { name: "tools", slug: "tools", visibility: "public" },
      { name: "ghost", slug: "ghost", visibility: "public" },
      { name: "#featured-series", slug: "hash-featured-series", visibility: "internal" },
      { name: "#another-internal", slug: "hash-another-internal", visibility: "internal" },
      { name: identityTagName("hello-world"), slug: "hash-nc-article-hello-world", visibility: "internal", description: "" },
    ] });
    assert.deepEqual(
      unrelatedInternalTags(managed, "hello-world").map((tag) => tag.name),
      ["#featured-series", "#another-internal"],
    );
    // The identity tag itself is excluded (it is managed explicitly), and a
    // post without tags yields nothing.
    assert.deepEqual(unrelatedInternalTags({ tags: [] }, "hello-world"), []);
    assert.deepEqual(unrelatedInternalTags(null, "hello-world"), []);
  });
});

// C2: Ghost does not store every construct the Markdown renderer emits
// faithfully. Observed live on Ghost 6.64.0 through the FULL path (render ->
// wrap -> upload -> save -> read back), retained as integration scenarios in
// integration.test.mjs: an <img> inside an <a> is DROPPED, leaving an empty
// link; an <img> with text around it is lifted out of its paragraph, so one
// paragraph is stored as paragraph / kg-image-card / paragraph; and an <a>'s
// title attribute is DROPPED. All three survive verbatim inside Ghost's own
// kg-card html markers, so wrapRawHtmlSegments wraps them. A paragraph that is
// exactly one bare image is left alone on purpose: Ghost turns that into a
// proper kg-image-card (loading="lazy", the theme's responsive classes), which
// is what a publication wants for a block image.
describe("C2: wrapping what Ghost would otherwise lose", () => {
  const cards = (html) =>
    wrapRawHtmlSegments(html).match(/<!--kg-card-begin: html-->\n([\s\S]*?)\n<!--kg-card-end: html-->/g) ?? [];

  test("a linked image is wrapped, so Ghost cannot drop it", () => {
    const html = '<p><a href="https://example.invalid/t"><img src="assets/linked.png" alt="Linked"></a></p>';
    assert.equal(cards(html).length, 1);
    assert.ok(cards(html)[0].includes('<a href="https://example.invalid/t"><img src="assets/linked.png" alt="Linked"></a>'));
  });

  test("an inline image with surrounding text is wrapped as ONE paragraph", () => {
    const html = '<p>Before <img src="assets/inline.png" alt="Inline"> after.</p>';
    assert.equal(cards(html).length, 1);
    assert.ok(cards(html)[0].includes("Before <img"), `the text before survives: ${cards(html)[0]}`);
    assert.ok(cards(html)[0].includes("> after."), `the text after survives: ${cards(html)[0]}`);
  });

  test("a link carrying a title attribute is wrapped, so Ghost cannot drop the title", () => {
    const html = '<p>See <a href="https://example.invalid/x" title="The title">this</a>.</p>';
    assert.equal(cards(html).length, 1);
    assert.ok(cards(html)[0].includes('title="The title"'));
  });

  test("a strikethrough paragraph is wrapped, so Ghost cannot drop the <del>", () => {
    const html = "<p>A <del>struck</del> word.</p>";
    assert.equal(cards(html).length, 1);
    assert.ok(cards(html)[0].includes("<del>struck</del>"));
  });

  test("a paragraph that is exactly one bare image is NOT wrapped", () => {
    const html = '<p><img src="assets/diagram.png" alt="Diagram"></p>';
    assert.equal(cards(html).length, 0);
    assert.equal(wrapRawHtmlSegments(html), html);
  });

  test("an ordinary paragraph with ordinary inline formatting is NOT wrapped", () => {
    const html = "<p>A <strong>bold</strong> and <em>italic</em> word with <code>code</code> and a <a href=\"https://example.invalid/x\">plain link</a>.</p>";
    assert.equal(cards(html).length, 0);
  });

  test("a renderer figure holding one image is NOT wrapped", () => {
    const html = '<figure class="kg-image-card"><img src="assets/diagram.png" alt="Diagram"></figure>';
    assert.equal(cards(html).length, 0);
  });
});

// C8: two distinct assets whose file names collide must not be equated by the
// pre-upload content proof. Ghost flattens an upload into its own content
// directory under the file's basename, so the basename is the only token a
// stored URL and a candidate ref share — and it is used only when exactly one
// candidate ref has it.
describe("C8: the pre-upload image-src shape refuses an ambiguous basename", () => {
  const candidateWith = (refs) => ({ assets: refs.map((ref) => ({ ref })), featureImage: null });

  test("a stored URL requires an explicit verified binding", () => {
    const shape = candidateImageSrcShape({ ...candidateWith(["assets/diagram.png"]),
      assetUrls: { "assets/diagram.png": "https://ghost.example.invalid/content/images/2026/10/diagram.png" } });
    assert.equal(shape("assets/diagram.png"), "assets/diagram.png");
    assert.equal(shape("https://ghost.example.invalid/content/images/2026/10/diagram.png"), "assets/diagram.png");
  });

  test("two refs sharing a basename resolve to nothing, so the proof fails instead of guessing", () => {
    const shape = candidateImageSrcShape(candidateWith(["assets/cover.png", "extra/cover.png"]));
    assert.equal(shape("assets/cover.png"), "assets/cover.png", "a candidate ref still maps to itself");
    const resolved = shape("https://ghost.example.invalid/content/images/2026/10/cover.png");
    assert.notEqual(resolved, "assets/cover.png");
    assert.notEqual(resolved, "extra/cover.png");
  });

  test("a stored src that is no candidate's asset resolves to nothing, so the proof fails", () => {
    const shape = candidateImageSrcShape(candidateWith(["assets/diagram.png"]));
    const foreign = "https://ghost.example.invalid/content/images/2026/10/someone-elses.png";
    const resolved = shape(foreign);
    // Not the foreign URL itself and not any candidate ref: a value that
    // matches nothing, so a stored body holding an image this candidate does
    // not carry can never be certified as this candidate's.
    assert.notEqual(resolved, "assets/diagram.png");
    assert.notEqual(resolved, shape("assets/diagram.png"));
  });

  test("the feature image is part of the shape's ref set", () => {
    const shape = candidateImageSrcShape({ assets: [], featureImage: "assets/cover.png",
      assetUrls: { "assets/cover.png": "https://ghost.example.invalid/content/images/2026/10/cover.png" } });
    assert.equal(shape("https://ghost.example.invalid/content/images/2026/10/cover.png"), "assets/cover.png");
  });
});
