// verify.mjs: the saved post and the public page against the candidate.
// The saved sample is what Ghost actually hands back for the candidate's
// body — heading ids, its own comments, figure wrapping, loading="lazy" —
// so the checks assert content equivalence, not byte equality: the stored
// body's outline must BE the candidate's outline (same blocks, same order,
// none missing, none extra), which is stronger than the marker containment
// an unapplied update whose old body contains the candidate's fragments
// would pass.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifySavedPost, checkPublicPage, storedBodyEquals } from "../src/verify.mjs";
import { contentOutline, compareOutlines, checkMarkers } from "../src/normalize.mjs";

const CANDIDATE = {
  article: { id: "hello-world", path: "editorial/articles/hello-world" },
  title: "Hello, world",
  slug: "hello-world",
  status: "published",
  authors: ["kareem"],
  excerpt: "A first article.",
  tags: ["tools", "ghost"],
  featureImage: null,
  bodyHtml: [
    "<h1>Hello, world</h1>",
    "<p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
    "<h2 id=\"setup\">Setup</h2>",
    "<pre><code class=\"language-js\">const x = 1;</code></pre>",
    "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>1</td></tr></tbody></table>",
    "<ul><li>first item</li><li>second item</li></ul>",
    "<blockquote><p>A quoted passage.</p></blockquote>",
  ].join("\n"),
};

// The old gate, kept as the oracle these tests hold up: subset containment.
// Every detection case below passes it and fails the new strict comparison —
// that gap is exactly the defect this change closes.
const checkMarkersPasses = (candidateHtml, storedHtml) => checkMarkers(candidateHtml, storedHtml).ok;

// What Ghost hands back after storing the candidate: ids added, comments
// inserted, code wrapped in a figure. Same content, different bytes.
const GHOST_SAVED_POST = {
  id: "p1",
  title: "Hello, world",
  uuid: "u-p1",
  slug: "hello-world",
  status: "published",
  custom_excerpt: "A first article.",
  html: [
    "<!--kg-card-begin: markdown--><h1 id=\"hello-world\">Hello, world</h1>",
    "<p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
    "<h2 id=\"setup\">Setup</h2>",
    '<figure class="kg-card kg-code-card"><pre><code class="language-js">const x = 1;</code></pre></figure>',
    '<figure class="kg-card kg-table-card"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>1</td></tr></tbody></table></figure>',
    "<ul><li>first item</li><li>second item</li></ul>",
    "<blockquote><p>A quoted passage.</p></blockquote><!--kg-card-end: markdown-->",
  ].join("\n"),
  published_at: "2026-09-20T10:00:00.000Z",
  updated_at: "2026-09-21T10:00:00.000Z",
  tags: [
    { name: "tools", slug: "tools", visibility: "public" },
    { name: "ghost", slug: "ghost", visibility: "public" },
    { name: "#nc-article-hello-world", slug: "hash-nc-article-hello-world", visibility: "internal" },
  ],
  authors: [{ slug: "kareem" }],
};

describe("verifySavedPost", () => {
  test("passes for a Ghost-rewritten sample of the candidate's body", () => {
    const result = verifySavedPost(GHOST_SAVED_POST, CANDIDATE);
    assert.deepEqual(result, { ok: true, problems: [] });
  });

  test("fails when a heading changed", () => {
    const changed = { ...GHOST_SAVED_POST, html: GHOST_SAVED_POST.html.replace("Setup", "Configuration") };
    const { ok, problems } = verifySavedPost(changed, CANDIDATE);
    assert.equal(ok, false);
    // The old assertion matched the marker-era message ("missing content
    // markers: Setup"); the outline-era proof reports the divergence
    // directly, so the stricter correct expectation is the outline message.
    assert.ok(problems.some((problem) => /stored body is not the candidate's body/.test(problem) && /Setup/.test(problem)), problems.join("\n"));
  });

  test("fails when the status differs", () => {
    const draft = { ...GHOST_SAVED_POST, status: "draft" };
    const { ok, problems } = verifySavedPost(draft, CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /status is "draft", expected "published"/.test(problem)), problems.join("\n"));
  });

  test("fails when the slug differs", () => {
    const renamed = { ...GHOST_SAVED_POST, slug: "hello-world-2" };
    const { ok, problems } = verifySavedPost(renamed, CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /slug is "hello-world-2"/.test(problem)), problems.join("\n"));
  });

  test("fails when a public tag is missing", () => {
    const untagged = {
      ...GHOST_SAVED_POST,
      tags: GHOST_SAVED_POST.tags.filter((tag) => tag.name !== "ghost"),
    };
    const { ok, problems } = verifySavedPost(untagged, CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /public tags/.test(problem)), problems.join("\n"));
  });

  test("fails when the identity tag is absent", () => {
    const anonymous = { ...GHOST_SAVED_POST, tags: GHOST_SAVED_POST.tags.filter((tag) => !tag.name.startsWith("#")) };
    const { ok, problems } = verifySavedPost(anonymous, CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /identity tag/.test(problem)), problems.join("\n"));
  });

  test("fails when authors differ, and only compares authors when the candidate names any", () => {
    const other = { ...GHOST_SAVED_POST, authors: [{ slug: "someone-else" }] };
    assert.equal(verifySavedPost(other, CANDIDATE).ok, false);
    // Ghost accepts an unknown author slug without error, so authors are
    // only meaningful when the candidate asked for them.
    const noCandidateAuthors = { ...CANDIDATE, authors: [] };
    assert.equal(verifySavedPost(GHOST_SAVED_POST, noCandidateAuthors).ok, true);
    // A post with no authors at all passes an author-less candidate.
    const noPostAuthors = { ...GHOST_SAVED_POST, authors: [] };
    assert.equal(verifySavedPost(noPostAuthors, noCandidateAuthors).ok, true);
  });

  // A saved post that keeps every heading, code block, table, list,
  // blockquote, link, image and tag but carries the OLD paragraph prose is
  // not the candidate's post: before paragraphs were markers, such a
  // saved post passed and a lost reply to a paragraph-only update was
  // falsely confirmed. The outline proof catches the same case more
  // directly: the stored body's block at that position is different prose.
  test("fails when the saved post keeps the headings but the OLD paragraph text", () => {
    const stale = {
      ...GHOST_SAVED_POST,
      html: GHOST_SAVED_POST.html.replace(
        '<p>Intro text with a <a href="https://example.invalid/post">link</a>.</p>',
        '<p>Intro text without the published edit.</p>',
      ),
    };
    const { ok, problems } = verifySavedPost(stale, CANDIDATE);
    assert.equal(ok, false);
    assert.ok(
      problems.some((problem) => /stored body is not the candidate's body/.test(problem) && /Intro text with a link\./.test(problem)),
      problems.join("\n"),
    );
  });

  // The cases the marker proof cannot catch at all: an unapplied update
  // whose OLD body still contains every candidate fragment. Containment
  // passes each of these; the outline proof must fail each of them, or a
  // lost reply to such an update would be falsely confirmed.
  test("a deletion the stored body still carries: not equivalent, containment alone would pass", () => {
    const candidate = { ...CANDIDATE, bodyHtml: "<h1>Hello, world</h1><p>Paragraph A.</p><p>Paragraph C.</p>" };
    const storedWithB = {
      ...GHOST_SAVED_POST,
      html: "<h1 id=\"hello-world\">Hello, world</h1><p>Paragraph A.</p><p>Paragraph B.</p><p>Paragraph C.</p>",
    };
    // The one-sided proof passes: every candidate fragment is in the body.
    assert.equal(checkMarkersPasses(candidate.bodyHtml, storedWithB.html), true);
    // The two-sided proof fails: the stored body has a block the candidate deleted.
    const { ok, problems } = verifySavedPost(storedWithB, candidate);
    assert.equal(ok, false);
    assert.ok(
      problems.some((problem) => /stored body has 4 content block\(s\), the candidate has 3/.test(problem)),
      problems.join("\n"),
    );
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /Paragraph B\./.test(problem)), problems.join("\n"));
  });

  test("a reorder the stored body never took: not equivalent, containment alone would pass", () => {
    const candidate = { ...CANDIDATE, bodyHtml: "<h1>Hello, world</h1><p>First.</p><p>Second.</p>" };
    const storedReordered = {
      ...GHOST_SAVED_POST,
      html: "<h1 id=\"hello-world\">Hello, world</h1><p>Second.</p><p>First.</p>",
    };
    assert.equal(checkMarkersPasses(candidate.bodyHtml, storedReordered.html), true);
    const { ok, problems } = verifySavedPost(storedReordered, candidate);
    assert.equal(ok, false);
    assert.ok(
      problems.some((problem) => /first divergence is at content block 1/.test(problem)),
      problems.join("\n"),
    );
    assert.ok(problems.some((problem) => /same blocks appear in a different order/.test(problem)), problems.join("\n"));
  });

  test("a duplication in the stored body: not equivalent, containment alone would pass", () => {
    const candidate = { ...CANDIDATE, bodyHtml: "<h1>Hello, world</h1><p>First.</p><p>Second.</p>" };
    const storedDuplicated = {
      ...GHOST_SAVED_POST,
      html: "<h1 id=\"hello-world\">Hello, world</h1><p>First.</p><p>First.</p><p>Second.</p>",
    };
    assert.equal(checkMarkersPasses(candidate.bodyHtml, storedDuplicated.html), true);
    const { ok, problems } = verifySavedPost(storedDuplicated, candidate);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /stored body has 4 content block\(s\), the candidate has 3/.test(problem)), problems.join("\n"));
  });

  test("an extra block in the stored body: not equivalent, containment alone would pass", () => {
    const candidate = { ...CANDIDATE, bodyHtml: "<h1>Hello, world</h1><p>First.</p><p>Second.</p>" };
    const storedExtra = {
      ...GHOST_SAVED_POST,
      html: "<h1 id=\"hello-world\">Hello, world</h1><p>First.</p><p>Second.</p><p>An extra block somebody left.</p>",
    };
    assert.equal(checkMarkersPasses(candidate.bodyHtml, storedExtra.html), true);
    const { ok, problems } = verifySavedPost(storedExtra, candidate);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /An extra block somebody left\./.test(problem)), problems.join("\n"));
  });

  test("a short paragraph spoofed by a substring of a different stored paragraph: not equivalent", () => {
    const candidate = { ...CANDIDATE, bodyHtml: "<h1>Hello, world</h1><p>Same text.</p>" };
    const storedSpoofed = {
      ...GHOST_SAVED_POST,
      html: "<h1 id=\"hello-world\">Hello, world</h1><p>A longer paragraph that contains Same text. inside it.</p>",
    };
    // Containment is spoofed: the candidate's paragraph is a substring of a
    // DIFFERENT stored paragraph.
    assert.equal(checkMarkersPasses(candidate.bodyHtml, storedSpoofed.html), true);
    const { ok, problems } = verifySavedPost(storedSpoofed, candidate);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /missing from the stored body/.test(problem) && /Same text\./.test(problem)), problems.join("\n"));
  });

  test("storedBodyEquals compares an image src exactly (both sides the uploadable body)", () => {
    const candidate = '<figure class="kg-card kg-image-card"><img src="https://ghost.invalid/content/images/upload.png" alt="A hero image"></figure>';
    const stored = '<figure class="kg-card kg-image-card"><img src="https://ghost.invalid/content/images/upload.png" class="kg-image" alt="A hero image" loading="lazy" width="640" height="480"></figure>';
    assert.deepEqual(storedBodyEquals(candidate, stored), { ok: true, problems: [] });
    const otherSrc = stored.replace("upload.png", "other.png");
    assert.equal(storedBodyEquals(candidate, otherSrc).ok, false);
  });

  test("storedBodyEquals tolerates entity decoding on either side", () => {
    const candidate = "<p>He said &quot;hi&quot; and it&#39;s fine.</p>";
    const stored = "<p>He said \"hi\" and it's fine.</p>";
    assert.deepEqual(storedBodyEquals(candidate, stored), { ok: true, problems: [] });
  });

  test("storedBodyEquals maps an image src through the caller's shape (the pre-upload candidate body)", () => {
    // The repair/reconcile paths hold the candidate as loaded, whose image
    // src is the article-relative ref; the stored body's src is the URL of
    // the uploaded copy. The basename shape matches the same image.
    const candidate = "<p><img src=\"assets/diagram.png\" alt=\"diagram\"></p>";
    const stored = '<figure class="kg-card kg-image-card"><img src="https://ghost.invalid/content/images/2026/10/diagram.png" class="kg-image" alt="diagram" loading="lazy" width="640" height="480"></figure>';
    const basename = (url) => String(url ?? "").split("/").filter(Boolean).pop() ?? "";
    const shape = (src) => basename(src.replace(/[?#].*$/, ""));
    assert.deepEqual(storedBodyEquals(candidate, stored, { imageSrcShape: shape }), { ok: true, problems: [] });
    // A genuinely different image is still caught: the alt differs.
    const storedOther = stored.replace('alt="diagram"', 'alt="a different diagram"');
    assert.equal(storedBodyEquals(candidate, storedOther, { imageSrcShape: shape }).ok, false);
  });

  test("compareOutlines reports the first divergence with its index and the missing/extra blocks", () => {
    const expected = contentOutline("<h1>Title</h1><p>One.</p><p>Two.</p>");
    const actual = contentOutline("<h1 id=\"title\">Title</h1><p>One.</p><p>Not two.</p>");
    const { ok, problems } = compareOutlines(expected, actual);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /first divergence is at content block 2/.test(problem)), problems.join("\n"));
    assert.ok(problems.some((problem) => /missing from the stored body/.test(problem) && /Two\./.test(problem)), problems.join("\n"));
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /Not two\./.test(problem)), problems.join("\n"));
  });

  test("compareOutlines passes an identical outline and a null-vs-present comparison fails", () => {
    const blocks = contentOutline("<h1>Title</h1><p>One.</p>");
    assert.deepEqual(compareOutlines(blocks, contentOutline("<h1 id=\"x\">Title</h1><p>One.</p>")), { ok: true, problems: [] });
    // A block beyond the end is reported against "(no block)", never a crash.
    const shorter = contentOutline("<h1>Title</h1>");
    const { ok, problems } = compareOutlines(blocks, shorter);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /candidate has a paragraph/.test(problem) && /\(no block\)/.test(problem)), problems.join("\n"));
  });

  // The old one-sided proof, for the tests that prove the outline proof
  // catches what it could not: containment passes each of those cases.

  test("passes when a paragraph's inline markup is re-wrapped by Ghost", () => {
    // The paragraph's visible text is the marker, so Ghost re-wrapping the
    // inline <a> (attributes, entity decoding) is not a mismatch.
    const rewrapped = {
      ...GHOST_SAVED_POST,
      html: GHOST_SAVED_POST.html.replace(
        '<a href="https://example.invalid/post">link</a>',
        '<a href="https://example.invalid/post" class="gh-link gh-external">link</a>',
      ),
    };
    assert.deepEqual(verifySavedPost(rewrapped, CANDIDATE), { ok: true, problems: [] });
  });
});

describe("checkPublicPage", () => {
  const page = (status, body) => ({ status, body, url: "https://example.invalid/hello-world" });

  // The public page a visitor is served is a full themed document (nav,
  // header, footer) whose article body sits in a gh-content region — the
  // shape this theme's partials/article.hbs renders, Ghost's ?ref= appended
  // to outbound links. The region is what the strict comparison runs on.
  const themed = (bodyHtml) => [
    "<!doctype html><html><body>",
    '<header class="gh-head">site navigation</header>',
    '<article class="post">',
    '<h1>Hello, world</h1>',
    `<div class="gh-content">${bodyHtml}</div>`,
    '<footer class="gh-foot">site footer</footer>',
    "</body></html>",
  ].join("\n");

  test("a 200 page whose gh-content region holds the body passes, and the check is not containment-only", () => {
    const result = checkPublicPage(page(200, themed(GHOST_SAVED_POST.html)), CANDIDATE);
    assert.deepEqual(result, { ok: true, problems: [], containmentOnly: false });
  });

  test("a <section class=\"gh-content\"> region (stock Casper) is isolated and its blocks compared, not read as one card", () => {
    // Ghost's own Casper theme serves the article body inside
    // `<section class="gh-content ...">` (this repo's theme uses a div, but
    // the integration suite runs against stock Ghost, whose default theme is
    // Casper). The region must be treated as a transparent container so its
    // heading and paragraph are compared as blocks; reading the section as an
    // opaque raw-HTML card collapsed the whole region into one card and failed
    // a correct page (integration scenario 13).
    const sectioned = [
      "<!doctype html><html><body>",
      '<header class="gh-head">site navigation</header>',
      '<main class="gh-main">',
      `<section class="gh-content gh-canvas is-body">${GHOST_SAVED_POST.html}</section>`,
      "</main>",
      '<footer class="gh-foot">site footer</footer>',
      "</body></html>",
    ].join("\n");
    const result = checkPublicPage(page(200, sectioned), CANDIDATE);
    assert.deepEqual(result, { ok: true, problems: [], containmentOnly: false });
    // And a sectioned region holding a DIFFERENT body still fails on content:
    // the section being transparent did not weaken the equivalence check.
    const wrong = checkPublicPage(page(200, sectioned.replace(/<h2[^>]*>Setup<\/h2>/, "<h2>Something else entirely</h2>")), CANDIDATE);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.containmentOnly, false);
    assert.ok(wrong.problems.some((problem) => /article content is not the candidate's content/.test(problem)), wrong.problems.join("\n"));
  });

  test("a ?ref= suffix on the region's links is tolerated, not read as a content change", () => {
    const withRef = GHOST_SAVED_POST.html.replace(
      '<a href="https://example.invalid/post">link</a>',
      '<a href="https://example.invalid/post?ref=ghost-kg-mailer">link</a>',
    );
    const result = checkPublicPage(page(200, themed(withRef)), CANDIDATE);
    assert.deepEqual(result, { ok: true, problems: [], containmentOnly: false });
  });

  test("a 200 page whose region holds a DIFFERENT body fails on the content, not the status", () => {
    const { ok, problems, containmentOnly } = checkPublicPage(page(200, themed("<h1>Something else entirely</h1>")), CANDIDATE);
    assert.equal(ok, false);
    assert.equal(containmentOnly, false);
    assert.ok(problems.some((problem) => /article content is not the candidate's content/.test(problem)), problems.join("\n"));
    assert.ok(!problems.some((problem) => /HTTP 200/.test(problem)));
  });

  test("a region holding extra or duplicated blocks fails: containment alone would pass", () => {
    const withExtra = `${GHOST_SAVED_POST.html}<p>An extra paragraph the candidate does not have.</p>`;
    assert.equal(checkMarkersPasses(CANDIDATE.bodyHtml, themed(withExtra)), true);
    const { ok, problems } = checkPublicPage(page(200, themed(withExtra)), CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /An extra paragraph/.test(problem)), problems.join("\n"));
  });

  test("a page with no isolatable region falls back to containment, and the result says so", () => {
    const result = checkPublicPage(page(200, GHOST_SAVED_POST.html), CANDIDATE);
    // The old assertion was a plain pass; the honest result states the
    // check was containment-only: the region could not be isolated.
    assert.deepEqual(result, { ok: true, problems: [], containmentOnly: true });
  });

  test("a containment-only fallback that LOSES the content still fails, and says it was containment-only", () => {
    const { ok, problems, containmentOnly } = checkPublicPage(page(200, "<h1>Something else entirely</h1>"), CANDIDATE);
    assert.equal(ok, false);
    assert.equal(containmentOnly, true);
    assert.ok(problems.some((problem) => /containment-only/.test(problem)), problems.join("\n"));
    assert.ok(!problems.some((problem) => /HTTP 200/.test(problem)));
  });

  test("a 404 is a status problem", () => {
    const { ok, problems } = checkPublicPage(page(404, "not found"), CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /answered HTTP 404, expected 200/.test(problem)), problems.join("\n"));
  });

  test("a 500 is a status problem, distinguished from a content problem", () => {
    const { ok, problems } = checkPublicPage(page(500, "server error"), CANDIDATE);
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /answered HTTP 500/.test(problem)), problems.join("\n"));
  });

  test("a missing page object is a failure, not a pass", () => {
    assert.equal(checkPublicPage(null, CANDIDATE).ok, false);
  });

  // The same paragraph oracle as the saved post's: a public page whose
  // region keeps every other block but serves the OLD paragraph text is a
  // failed check, not a pass — before paragraphs were markers, it passed.
  test("a 200 page whose region keeps the OLD paragraph text fails on the paragraph", () => {
    const staleBody = GHOST_SAVED_POST.html.replace(
      '<p>Intro text with a <a href="https://example.invalid/post">link</a>.</p>',
      '<p>Intro text without the published edit.</p>',
    );
    const { ok, problems } = checkPublicPage(page(200, themed(staleBody)), CANDIDATE);
    assert.equal(ok, false);
    assert.ok(
      problems.some((problem) => /article content is not the candidate's content/.test(problem) && /Intro text with a link\./.test(problem)),
      problems.join("\n"),
    );
  });
});

// The full real-Ghost observation this change is built on, labelled so the
// provenance travels with the tests. The Markdown below was rendered by the
// app's renderMarkdown and sent to a disposable Ghost 6.64.0; STORED is what
// the Admin API (formats=html) returned; PUBLIC is the article region of the
// public page (Ghost appends ?ref=localhost to outbound links).
const OBSERVED_SENT = [
  '<p>Text with <strong>bold <em>nested em</em> more</strong> and <del>gone</del> and <code>co&lt;de&gt;</code> and <a href="https://x.invalid/a?x=1&amp;y=2" title="title">a <strong>strong</strong> link</a>.</p>',
  '<p>Line one<br>line two after hard break.</p>',
  "<blockquote>",
  '<p>Quote with <em>em</em> and a <a href="https://q.invalid">link</a></p>',
  "<p>Second quote para</p>",
  "</blockquote>",
  "<ol>",
  "<li>one <strong>b</strong></li>",
  "<li>two<ul>",
  "<li>nested <em>x</em></li>",
  "</ul>",
  "</li>",
  "</ol>",
  "<table>",
  "<thead>",
  "<tr>",
  "<th>a</th>",
  "<th><strong>b</strong></th>",
  "</tr>",
  "</thead>",
  "<tbody><tr>",
  "<td><code>c</code></td>",
  '<td><a href="https://d.invalid">d</a></td>',
  "</tr>",
  "</tbody></table>",
  "<pre><code>  indented",
  "\ttab",
  "</code></pre>",
].join("\n");

const OBSERVED_STORED = [
  '<p>Text with <strong>bold <em>nested em</em> more</strong> and gone and <code>co&lt;de&gt;</code> and <a href="https://x.invalid/a?x=1&amp;y=2">a <strong>strong</strong> link</a>.</p><p>Line one<br>line two after hard break.</p><blockquote>Quote with <em>em</em> and a <a href="https://q.invalid">link</a><br><br>Second quote para</blockquote><ol><li>one <strong>b</strong></li><li>two<ul><li>nested <em>x</em></li></ul></li></ol>',
  "<!--kg-card-begin: html-->",
  "<table>",
  "<thead>",
  "<tr>",
  "<th>a</th>",
  "<th><strong>b</strong></th>",
  "</tr>",
  "</thead>",
  "<tbody><tr>",
  "<td><code>c</code></td>",
  '<td><a href="https://d.invalid">d</a></td>',
  "</tr>",
  "</tbody></table>",
  "<!--kg-card-end: html-->",
  "<pre><code>  indented",
  "\ttab",
  "</code></pre>",
].join("\n");

const OBSERVED_PUBLIC_REGION = OBSERVED_STORED
  .replace("https://x.invalid/a?x=1&amp;y=2", "https://x.invalid/a?x=1&y=2&ref=localhost")
  .replace("https://q.invalid", "https://q.invalid/?ref=localhost")
  .replace("https://d.invalid", "https://d.invalid/?ref=localhost");

describe("C2: the content-equivalence proof (observed on disposable Ghost 6.64.0, 2026-10-05)", () => {
  const observedCandidate = { bodyHtml: OBSERVED_SENT };
  const publicPage = (region) =>
    ({ status: 200, url: "https://example.invalid/x", body: `<!doctype html><html><body><section class="gh-content gh-canvas is-body">${region}</section></body></html>` });

  test("(a) the observed SENT equals the observed STORED, and the PUBLIC region via checkPublicPage (not containment-only)", () => {
    assert.deepEqual(storedBodyEquals(OBSERVED_SENT, OBSERVED_STORED), { ok: true, problems: [] });
    const result = checkPublicPage(publicPage(OBSERVED_PUBLIC_REGION), observedCandidate);
    assert.deepEqual(result, { ok: true, problems: [], containmentOnly: false });
  });

  // (b) Each of these differs from the sent body ONLY in a way the old
  // proof could not see (or in a structural way that must still be caught);
  // each must be NOT ok, with a problem that names what moved.
  const DETECTIONS = [
    ["link href changed only", '<p>See <a href="https://new.invalid/">the docs</a>.</p>', '<p>See <a href="https://old.invalid/">the docs</a>.</p>', /invalid/],
    ["inline code removed only", "<p>Use <code>rm</code> now.</p>", "<p>Use rm now.</p>", /inline structure/],
    ["emphasis removed only", "<p>Use <em>rm</em> now.</p>", "<p>Use rm now.</p>", /inline structure/],
    ["heading level changed", "<h2>Title</h2>", "<h3>Title</h3>", /level-3|level-2/],
    ["two paragraphs swapped", "<p>A.</p><p>B.</p>", "<p>B.</p><p>A.</p>", /different order|divergence/],
    ["a paragraph duplicated", "<p>A.</p><p>B.</p>", "<p>A.</p><p>A.</p><p>B.</p>", /stored body has 3|different order/],
    ["an extra retained paragraph", "<p>A.</p><p>B.</p>", "<p>A.</p><p>X.</p><p>B.</p>", /present only in the stored body/],
    ["a nested list item text changed", "<ul><li>two<ul><li>nested <em>x</em></li></ul></li></ul>", "<ul><li>two<ul><li>nested <em>y</em></li></ul></li></ul>", /inline structure|divergence/],
    ["blockquote second paragraph changed", "<blockquote><p>one</p><p>two</p></blockquote>", "<blockquote><p>one</p><p>three</p></blockquote>", /divergence|inline structure/],
  ];

  for (const [name, sent, stored, problemPattern] of DETECTIONS) {
    test(`(b) ${name}: not ok, with a problem`, () => {
      const result = storedBodyEquals(sent, stored);
      assert.equal(result.ok, false, `${name} must not read as equal`);
      assert.ok(result.problems.length > 0, `${name} must report a problem`);
      assert.ok(result.problems.some((problem) => problemPattern.test(problem)), result.problems.join("\n"));
    });
  }

  test("(b) the public page catches a changed href in its region, not just the saved post", () => {
    const region = OBSERVED_PUBLIC_REGION.replace("https://d.invalid/?ref=localhost", "https://e.invalid/?ref=localhost");
    const result = checkPublicPage(publicPage(region), observedCandidate);
    assert.equal(result.ok, false);
    assert.equal(result.containmentOnly, false);
    assert.ok(result.problems.some((problem) => /article content is not the candidate's content/.test(problem)), result.problems.join("\n"));
  });
});
