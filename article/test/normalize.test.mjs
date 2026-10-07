// normalize.mjs: markers assert content survival across Ghost's rewrites,
// not byte equality — the stored sample below mirrors what Ghost actually
// does (heading ids, kg-card comments, figure wrappers, loading="lazy").

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkMarkers,
  compareOutlines,
  contentMarkers,
  contentOutline,
  ghostBodyHash,
  normalizeGhostHtml,
  ownedFieldsHash,
} from "../src/normalize.mjs";
import { storedBodyEquals } from "../src/verify.mjs";

// The end-to-end proof over the outline, aliased so the observed-Ghost tests
// below read as the proof they assert.
const storedBodyEqualsForTest = storedBodyEquals;

const CANDIDATE_HTML = [
  "<h1>Working with Ghost</h1>",
  "<p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
  "<h2 id=\"setup\">Setup</h2>",
  "<pre><code class=\"language-js\">const x = 1;</code></pre>",
  "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>1</td></tr></tbody></table>",
  "<ul><li>first item</li><li>second item</li></ul>",
  "<blockquote><p>A quoted passage.</p></blockquote>",
  '<figure class="kg-card kg-image-card"><img src="hero.png" alt="A hero image"></figure>',
].join("\n");

// What Ghost actually hands back: heading ids added, its own comments
// inserted, images wrapped in figure.kg-card with loading="lazy", whitespace
// reflowed. Same content, different bytes.
const GHOST_STORED_HTML = [
  "<!--kg-card-begin: markdown--><h1 id=\"working-with-ghost\">Working with Ghost</h1>",
  "<p>Intro text with a <a href=\"https://example.invalid/post\">link</a>.</p>",
  "<h2 id=\"setup\">Setup</h2>",
  '<figure class="kg-card kg-code-card"><pre><code class="language-js">const x = 1;</code></pre></figure>',
  '<figure class="kg-card kg-table-card"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td>1</td></tr></tbody></table></figure>',
  "<ul><li>first item</li><li>second item</li></ul>",
  "<blockquote><p>A quoted passage.</p></blockquote>",
  '<figure class="kg-card kg-image-card"><img src="hero.png" class="kg-image" alt="A hero image" loading="lazy" width="640" height="480"></figure><!--kg-card-end: markdown-->',
].join("\n");

describe("normalizeGhostHtml", () => {
  test("removes comments, collapses whitespace, trims", () => {
    assert.equal(
      normalizeGhostHtml("  <!-- a comment --> <p>text   here</p>\n\n more <!-- x --> "),
      "<p>text here</p> more",
    );
  });

  test("is stable across the rewrites it is meant to absorb: comments and whitespace", () => {
    const commented = `<!--kg-card-begin: markdown--> ${CANDIDATE_HTML} <!--kg-card-end: markdown-->`;
    assert.equal(normalizeGhostHtml(CANDIDATE_HTML), normalizeGhostHtml(commented));
    const reflowed = CANDIDATE_HTML.replace(/\n/g, "   \n ");
    assert.equal(normalizeGhostHtml(CANDIDATE_HTML), normalizeGhostHtml(reflowed));
    // Structural rewrites (new ids, wrappers, attributes) are NOT absorbed:
    // that is what markers are for. Only comment/whitespace noise is.
    assert.notEqual(normalizeGhostHtml(CANDIDATE_HTML), normalizeGhostHtml(GHOST_STORED_HTML));
  });

  test("ghostBodyHash is a 16-hex digest of the normalised html", () => {
    assert.match(ghostBodyHash(CANDIDATE_HTML), /^[0-9a-f]{16}$/);
    assert.equal(ghostBodyHash(CANDIDATE_HTML), ghostBodyHash(CANDIDATE_HTML.replace(/\n/g, "  \n")));
    assert.notEqual(ghostBodyHash(CANDIDATE_HTML), ghostBodyHash("<h1>Different</h1>"));
    // The stored html's structural rewrites mean the normalised bodies differ,
    // so their hashes differ; marker checks are the layer that passes.
    assert.notEqual(ghostBodyHash(CANDIDATE_HTML), ghostBodyHash(GHOST_STORED_HTML));
  });

  test("ownedFieldsHash sorts tags and authors so reorders do not read as changes", () => {
    const base = {
      title: "T",
      slug: "t",
      status: "published",
      custom_excerpt: null,
      tags: ["b", "a"],
      authors: ["y", "x"],
    };
    const reordered = { ...base, tags: ["a", "b"], authors: ["x", "y"] };
    assert.equal(ownedFieldsHash(base), ownedFieldsHash(reordered));
    assert.notEqual(ownedFieldsHash(base), ownedFieldsHash({ ...base, title: "T2" }));
  });

  test("ownedFieldsHash covers only the non-body owned fields (the regression's fix)", () => {
    // The body must NOT be part of the owned fingerprint. Both call sites
    // (publish.mjs desiredOwnedHash and liveOwnedHash) feed it directly
    // comparable field values; the body is compared separately, like for
    // like, by ghostBodyHash over Ghost's stored HTML on both sides. A
    // body-inclusive fingerprint compared the candidate's rendered HTML
    // against Ghost's stored rewrite and could never be equal on a genuine
    // no-op — the repeat publish read as an unexpected Ghost-side edit.
    const fields = {
      title: "T",
      slug: "t",
      status: "published",
      custom_excerpt: null,
      tags: ["a"],
      authors: ["x"],
    };
    // No bodyHtml parameter at all: passing one (as the old ownedHash did)
    // must not change the result, because the body is not read.
    assert.equal(ownedFieldsHash(fields), ownedFieldsHash({ ...fields, bodyHtml: "<p>one</p>" }));
    assert.equal(ownedFieldsHash(fields), ownedFieldsHash({ ...fields, bodyHtml: "<p>two</p>" }));
    // A non-body field still moves it.
    assert.notEqual(ownedFieldsHash(fields), ownedFieldsHash({ ...fields, slug: "t2" }));
    assert.match(ownedFieldsHash(fields), /^[0-9a-f]{16}$/);
  });
});

describe("contentMarkers / checkMarkers", () => {
  test("extracts the marker kinds from candidate html", () => {
    const markers = contentMarkers(CANDIDATE_HTML);
    const values = markers.map((marker) => marker.value);
    const kinds = new Set(markers.map((marker) => marker.kind));
    assert.ok(values.includes("Working with Ghost"));
    assert.ok(values.includes("Setup"));
    assert.ok(values.includes("const x = 1;"));
    assert.ok(values.includes("Name"));
    assert.ok(values.includes("first item"));
    assert.ok(values.includes("A quoted passage."));
    assert.ok(values.includes("https://example.invalid/post"));
    assert.ok(values.includes("A hero image"));
    assert.ok(values.includes("kg-card kg-image-card"));
    for (const kind of ["heading", "code", "table-cell", "link", "list-item", "blockquote", "image-alt", "card"]) {
      assert.ok(kinds.has(kind), `expected a ${kind} marker`);
    }
    // Descriptions exist for the human report.
    for (const marker of markers) assert.ok(typeof marker.description === "string" && marker.description);
  });

  test("markers survive Ghost's known rewrites", () => {
    const result = checkMarkers(CANDIDATE_HTML, GHOST_STORED_HTML);
    assert.deepEqual(result, { ok: true, missing: [] });
  });

  test("a genuinely changed heading fails the check", () => {
    const changed = GHOST_STORED_HTML.replace("Working with Ghost", "Working with WordPress");
    const { ok, missing } = checkMarkers(CANDIDATE_HTML, changed);
    assert.equal(ok, false);
    assert.ok(missing.includes("Working with Ghost"));
  });

  test("a dropped link and a dropped cell each fail the check", () => {
    const noLink = GHOST_STORED_HTML.replace('<a href="https://example.invalid/post">link</a>', "link");
    assert.equal(checkMarkers(CANDIDATE_HTML, noLink).ok, false);
    const noCell = GHOST_STORED_HTML.replace("<td>one</td>", "<td>—</td>");
    assert.equal(checkMarkers(CANDIDATE_HTML, noCell).ok, false);
  });

  // A paragraph-only change is a change: the heading, code, table, list,
  // blockquote, link, image and card markers all survive while the prose is
  // the OLD text, so before paragraphs were markers such a change passed the
  // check — a lost reply to a paragraph-only update was falsely confirmed.
  test("a paragraph-only change fails the check (the old text is not the candidate's)", () => {
    const markerMissing = checkMarkers(
      "<h1>Title</h1><p>Original paragraph text.</p>",
      "<h1>Title</h1><p>Completely different paragraph.</p>",
    );
    assert.equal(markerMissing.ok, false);
    assert.ok(markerMissing.missing.includes("Original paragraph text."), markerMissing.missing.join("; "));

    // The same failure against the stored-sample shape: only the prose
    // moved — the link, its href, every heading, block and image stays, so
    // the paragraph text is the only thing the check can catch it on.
    const storedWithOldProse = GHOST_STORED_HTML.replace(
      '<p>Intro text with a <a href="https://example.invalid/post">link</a>.</p>',
      '<p>The prose an older publish left behind, with a <a href="https://example.invalid/post">link</a>.</p>',
    );
    const result = checkMarkers(CANDIDATE_HTML, storedWithOldProse);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["Intro text with a link."]);
  });

  test("paragraph markers are visible text, so inline markup re-wrapping survives", () => {
    // A paragraph with inline <a>/<strong>/<code> yields its concatenated
    // visible text, so Ghost re-wrapping the inline markup (attributes,
    // entity decoding, its own comments) does not read as a lost paragraph.
    const candidate = "<p>Prose with <a href=\"https://example.invalid/x\">a link</a>, <strong>bold</strong> and <code>inline code</code>.</p>";
    const stored = [
      "<!--kg-card-begin: markdown-->",
      "<p>Prose with <a href=\"https://example.invalid/x\" class=\"gh-gh-emoji-link\">a link</a>, <strong>bold</strong> and <code>inline code</code>.</p>",
      "<!--kg-card-end: markdown-->",
    ].join("\n");
    assert.deepEqual(checkMarkers(candidate, stored), { ok: true, missing: [] });
    // The inline markup itself never appears in the marker value.
    const markers = contentMarkers(candidate);
    const paragraph = markers.find((marker) => marker.kind === "paragraph");
    assert.equal(paragraph.value, "Prose with a link, bold and inline code.");
  });

  test("a paragraph wrapping only an image contributes no paragraph marker", () => {
    // The markdown renderer emits a standalone image as a bare <p><img></p>;
    // Ghost rewrites that into a <figure>, and the image markers cover it.
    // A text-empty paragraph must not become a bogus marker that the
    // stored <figure> can never satisfy.
    const candidate = '<p><img src="hero.png" alt="A hero image"></p><p>Real prose.</p>';
    const stored = '<figure class="kg-card kg-image-card"><img src="hero.png" class="kg-image" alt="A hero image" loading="lazy"></figure><p>Real prose.</p>';
    assert.deepEqual(checkMarkers(candidate, stored), { ok: true, missing: [] });
    const paragraphs = contentMarkers(candidate).filter((marker) => marker.kind === "paragraph");
    assert.deepEqual(paragraphs.map((marker) => marker.value), ["Real prose."]);
  });

  test("paragraph markers extract every top-level paragraph of the sample", () => {
    const markers = contentMarkers(CANDIDATE_HTML).filter((marker) => marker.kind === "paragraph");
    assert.deepEqual(markers.map((marker) => marker.value), ["Intro text with a link."]);
    // The blockquote's nested paragraph stays a blockquote marker, not a
    // paragraph one, and a nested list paragraph stays a list-item marker.
    const nested = '<blockquote><p>Quoted.</p></blockquote><ul><li><p>Item.</p></li></ul><p>Top-level.</p>';
    const nestedMarkers = contentMarkers(nested).filter((marker) => marker.kind === "paragraph");
    assert.deepEqual(nestedMarkers.map((marker) => marker.value), ["Top-level."]);
  });
});

describe("contentOutline / compareOutlines", () => {
  test("the outline is an ordered sequence of content blocks, the candidate's kinds in order", () => {
    const outline = contentOutline(CANDIDATE_HTML);
    assert.deepEqual(outline.map((block) => block.kind), [
      "heading",
      "paragraph",
      "heading",
      "code",
      "table-cell",
      "table-cell",
      "table-cell",
      "table-cell",
      "list-item",
      "list-item",
      "blockquote",
      "image",
    ]);
    assert.deepEqual(outline.map((block) => block.text), [
      "Working with Ghost",
      "Intro text with a link.",
      "Setup",
      "const x = 1;",
      "Name",
      "Value",
      "one",
      "1",
      "first item",
      "second item",
      "A quoted passage.",
      undefined,
    ]);
    // Kinds carry their specifics: heading level, list orderedness, image src.
    assert.deepEqual(
      outline.filter((block) => block.kind === "heading").map((block) => block.level),
      [1, 2],
    );
    assert.deepEqual(
      outline.filter((block) => block.kind === "list-item").map((block) => block.ordered),
      [false, false],
    );
    assert.equal(outline.find((block) => block.kind === "image").src, "hero.png");
    assert.equal(outline.find((block) => block.kind === "image").alt, "A hero image");
    // A horizontal rule is its own block.
    assert.equal(contentOutline("<hr>")[0].kind, "hr");
  });

  test("a section is a transparent container, not an opaque card (stock Casper's gh-content region)", () => {
    // Stock Ghost's Casper theme serves the article body inside
    // `<section class="gh-content gh-canvas is-body">`. The section must be
    // descended like a div so its blocks are compared individually; treating
    // it as one raw-HTML card collapsed the whole public-page region into a
    // single card and failed a correct page (integration scenario 13).
    const sectioned = '<section class="gh-content gh-canvas is-body"><h1>T</h1><p>Body.</p></section>';
    const outline = contentOutline(sectioned);
    assert.deepEqual(outline.map((block) => block.kind), ["heading", "paragraph"]);
    assert.equal(outline[0].text, "T");
    assert.equal(outline[1].text, "Body.");
    // The same blocks as the unwrapped body: the wrapper is transparent, so
    // the outline is unchanged by it.
    assert.deepEqual(outline, contentOutline("<h1>T</h1><p>Body.</p>"));
    // A section holding no liftable block still reads as a raw-HTML card
    // (identity from its classes), exactly as an empty div does.
    assert.deepEqual(contentOutline('<section class="callout"></section>'), [{ kind: "card", identity: "callout" }]);
  });

  test("the outline survives Ghost's rewrites: ids, kg-cards, comments, lazy images", () => {
    const { ok, problems } = compareOutlines(contentOutline(CANDIDATE_HTML), contentOutline(GHOST_STORED_HTML));
    assert.deepEqual({ ok, problems }, { ok: true, problems: [] });
  });

  // The four ways containment passes and equivalence fails. Each one keeps
  // every candidate block present somewhere in the stored body, so
  // checkMarkers says ok — and the ordered, multiplicity-aware comparison
  // must not.
  test("a deletion the stored body still carries fails equivalence, passes containment", () => {
    const candidate = "<p>Paragraph A.</p><p>Paragraph C.</p>";
    const stored = "<p>Paragraph A.</p><p>Paragraph B.</p><p>Paragraph C.</p>";
    assert.equal(checkMarkers(candidate, stored).ok, true);
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /stored body has 3 content block\(s\), the candidate has 2/.test(problem)), problems.join("\n"));
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /Paragraph B\./.test(problem)), problems.join("\n"));
  });

  test("a reorder the stored body never took fails equivalence, passes containment", () => {
    const candidate = "<h1>First.</h1><p>Second.</p>";
    const stored = "<p>Second.</p><h1>First.</h1>";
    assert.equal(checkMarkers(candidate, stored).ok, true);
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /first divergence is at content block 0/.test(problem)), problems.join("\n"));
    assert.ok(problems.some((problem) => /the same blocks appear in a different order/.test(problem)), problems.join("\n"));
    // A reorder never changes the counts and never loses a block.
    assert.ok(!problems.some((problem) => /present only in the stored body/.test(problem)), problems.join("\n"));
    assert.ok(!problems.some((problem) => /missing from the stored body/.test(problem)), problems.join("\n"));
  });

  test("a duplication in the stored body fails equivalence, passes containment", () => {
    const candidate = "<p>Paragraph A.</p><p>Paragraph C.</p>";
    const stored = "<p>Paragraph A.</p><p>Paragraph A.</p><p>Paragraph C.</p>";
    assert.equal(checkMarkers(candidate, stored).ok, true);
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.equal(ok, false);
    // A duplication is a multiset difference with no missing block: the
    // stored body carries one paragraph the candidate does not have a place
    // for, and every candidate block still survives somewhere in it.
    assert.ok(problems.some((problem) => /stored body has 3 content block\(s\), the candidate has 2/.test(problem)), problems.join("\n"));
    assert.ok(problems.some((problem) => /the same blocks appear in a different order/.test(problem)), problems.join("\n"));
    assert.ok(!problems.some((problem) => /missing from the stored body/.test(problem)), problems.join("\n"));
  });

  test("an extra block in the stored body fails equivalence, passes containment", () => {
    const candidate = "<p>Paragraph A.</p><p>Paragraph C.</p>";
    const stored = "<p>Paragraph A.</p><p>An extra paragraph.</p><p>Paragraph C.</p>";
    assert.equal(checkMarkers(candidate, stored).ok, true);
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /present only in the stored body/.test(problem) && /An extra paragraph\./.test(problem)), problems.join("\n"));
  });

  // A short marker that is a substring of unrelated stored text matches
  // spuriously under containment; block equality does not.
  test("a short paragraph spoofed by a substring of a different stored paragraph fails equivalence", () => {
    const candidate = "<p>Same text.</p>";
    const stored = "<p>A longer paragraph that contains Same text. inside it.</p>";
    assert.equal(checkMarkers(candidate, stored).ok, true);
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /missing from the stored body/.test(problem) && /Same text\./.test(problem)), problems.join("\n"));
  });

  test("an image-only paragraph is the image block, and Ghost's figure rewrite matches it", () => {
    const candidate = '<p><img src="hero.png" alt="A hero image"></p>';
    const stored = '<figure class="kg-card kg-image-card"><img src="hero.png" class="kg-image" alt="A hero image" loading="lazy" width="640" height="480"></figure>';
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.deepEqual({ ok, problems }, { ok: true, problems: [] });
    // The image block is the paragraph's content: alt + src, no empty paragraph.
    assert.deepEqual(contentOutline(candidate), [{ kind: "image", alt: "A hero image", src: "hero.png" }]);
    assert.deepEqual(contentOutline(stored), [{ kind: "image", alt: "A hero image", src: "hero.png" }]);
  });

  test("a paragraph's inline <a>/<strong>/<code> is visible text, so re-wrapping matches", () => {
    const candidate = "<p>Prose with <a href=\"https://example.invalid/x\">a link</a>, <strong>bold</strong> and <code>inline code</code>.</p>";
    const stored = "<p>Prose with <a href=\"https://example.invalid/x?ref=ghost\">a link</a>, <strong>bold</strong> and <code>inline code</code>.</p>";
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.deepEqual({ ok, problems }, { ok: true, problems: [] });
  });

  test("raw-HTML card content is a block, and Ghost's kg-card comments and wrappers match it", () => {
    const candidate = '<div class="raw-callout">text with <strong>bold</strong></div>';
    const stored = '<!--kg-card-begin: html--><div class="raw-callout">text with <strong>bold</strong></div><!--kg-card-end: html-->';
    const { ok, problems } = compareOutlines(contentOutline(candidate), contentOutline(stored));
    assert.deepEqual({ ok, problems }, { ok: true, problems: [] });
    const blocks = contentOutline(candidate);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "card");
    assert.equal(blocks[0].text, "text with bold");
    assert.equal(blocks[0].identity, "raw-callout");
    // A wrapper holding no content and carrying no identity holds no block:
    // transparent, so a stray wrapper never costs the body its other blocks.
    assert.deepEqual(contentOutline("<div><br></div>"), []);
  });

  test("compareOutlines reports a null outline as a refused comparison, not a silent pass", () => {
    const { ok, problems } = compareOutlines(null, contentOutline("<p>x</p>"));
    assert.equal(ok, false);
    assert.ok(problems.some((problem) => /not an outlineable sequence/.test(problem)), problems.join("\n"));
  });
});

// The full real-Ghost observation this change is built on, labelled so the
// provenance travels with the tests. The Markdown below was rendered by the
// app's renderMarkdown and sent to a disposable Ghost 6.64.0; STORED is what
// the Admin API (formats=html) returned; PUBLIC is the article region of the
// public page (Ghost appends ?ref=localhost to outbound links).
const GHOST_SENT = [
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

const GHOST_STORED = [
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

const GHOST_PUBLIC_REGION = GHOST_STORED
  .replace("https://x.invalid/a?x=1&amp;y=2", "https://x.invalid/a?x=1&y=2&ref=localhost")
  .replace("https://q.invalid", "https://q.invalid/?ref=localhost")
  .replace("https://d.invalid", "https://d.invalid/?ref=localhost");

describe("contentOutline visibleText block boundaries (observed on disposable Ghost 6.64.0, 2026-10-05)", () => {
  test("a blockquote whose two paragraphs Ghost joins with <br><br> is the same text as the two <p>s", () => {
    // SENT: <blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>
    // STORED: <blockquote>a<br><br>b</blockquote>
    // Concatenating without a space read "ab" against the sent "a b".
    const sent = "<blockquote>\n<p>Quote with <em>em</em> and a <a href=\"https://q.invalid\">link</a></p>\n<p>Second quote para</p>\n</blockquote>";
    const stored = '<blockquote>Quote with <em>em</em> and a <a href="https://q.invalid">link</a><br><br>Second quote para</blockquote>';
    assert.deepEqual(storedBodyEqualsForTest(sent, stored), { ok: true, problems: [] });
    assert.equal(contentOutline(sent)[0].text, "Quote with em and a link Second quote para");
    assert.equal(contentOutline(stored)[0].text, "Quote with em and a link Second quote para");
  });

  test("block-level tags become a space, inline tags are removed without one", () => {
    // A <br> is a word boundary; an inline <em> is not.
    assert.equal(contentOutline("<p>a<br>b</p>")[0].text, "a b");
    assert.equal(contentOutline("<p>a<em>b</em>c</p>")[0].text, "abc");
    // Every listed block-level tag is a boundary: two of them never fuse.
    assert.equal(contentOutline("<div><p>a</p><p>b</p></div>").map((b) => b.text).join(" "), "a b");
    assert.equal(contentOutline("<ul><li>a</li><li>b</li></ul>").map((b) => b.text).join(" "), "a b");
  });
});

describe("contentOutline inline-structure signature (observed on disposable Ghost 6.64.0, 2026-10-05)", () => {
  test("the full observed pair compares equal, and the public-page ?ref= rewrite too", () => {
    assert.deepEqual(storedBodyEqualsForTest(GHOST_SENT, GHOST_STORED), { ok: true, problems: [] });
    assert.deepEqual(storedBodyEqualsForTest(GHOST_SENT, GHOST_PUBLIC_REGION), { ok: true, problems: [] });
  });

  test("every text-bearing block carries a marks signature", () => {
    const outline = contentOutline(GHOST_SENT);
    for (const block of outline) {
      if (block.kind === "image" || block.kind === "hr") continue;
      assert.equal(typeof block.marks, "string", `${block.kind} must carry a marks signature`);
    }
    // The signature carries the inline structure, not the prose: emphasis as
    // "_", strong as "*", code as "`", a link as "[href|".
    assert.equal(contentOutline("<p>a <em>e</em> <strong>s</strong> <code>c</code></p>")[0].marks, "a_e_*s*`c`");
    assert.equal(contentOutline('<p><a href="https://x.invalid">l</a></p>')[0].marks, "[https://x.invalid/|l]");
    // Nesting reads in document order.
    assert.equal(contentOutline("<p><strong>a <em>b</em></strong></p>")[0].marks, "*a_b_*");
  });

  test("b normalises to strong and i to em (Ghost rewrites a raw <b> in a non-card paragraph)", () => {
    // Observed: a raw <b> in a plain paragraph is stored as <strong>.
    assert.deepEqual(storedBodyEqualsForTest("<p>x <b>b</b></p>", "<p>x <strong>b</strong></p>"), { ok: true, problems: [] });
    assert.deepEqual(storedBodyEqualsForTest("<p>x <i>i</i></p>", "<p>x <em>i</em></p>"), { ok: true, problems: [] });
    assert.equal(contentOutline("<p>x <b>b</b> <i>i</i></p>")[0].marks, "x*b*_i_");
  });

  test("inline elements Ghost drops or rewrites are ignored, so a legitimate rewrite is not a change", () => {
    // Observed: <del> is dropped, a <span style> is unwrapped, an <a>'s title
    // attribute is dropped.
    assert.deepEqual(storedBodyEqualsForTest("<p>x <del>gone</del> y</p>", "<p>x gone y</p>"), { ok: true, problems: [] });
    assert.deepEqual(storedBodyEqualsForTest('<p>x <span style="color:red">s</span> y</p>', "<p>x s y</p>"), { ok: true, problems: [] });
    assert.deepEqual(
      storedBodyEqualsForTest('<p><a href="https://x.invalid" title="t">l</a></p>', '<p><a href="https://x.invalid">l</a></p>'),
      { ok: true, problems: [] },
    );
  });

  test("a link href change is caught even though the visible text is identical", () => {
    const result = storedBodyEqualsForTest('<p>See <a href="https://new.invalid/">the docs</a>.</p>', '<p>See <a href="https://old.invalid/">the docs</a>.</p>');
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /new\.invalid/.test(problem)), result.problems.join("\n"));
    assert.ok(result.problems.some((problem) => /old\.invalid/.test(problem)), result.problems.join("\n"));
  });

  test("removed inline code and removed emphasis are each caught", () => {
    assert.equal(storedBodyEqualsForTest("<p>Use <code>rm</code> now.</p>", "<p>Use rm now.</p>").ok, false);
    assert.equal(storedBodyEqualsForTest("<p>Use <em>rm</em> now.</p>", "<p>Use rm now.</p>").ok, false);
    // The two are distinct signatures: code is not emphasis.
    assert.notEqual(contentOutline("<p><code>x</code></p>")[0].marks, contentOutline("<p><em>x</em></p>")[0].marks);
  });

  test("href normalisation deletes the ref parameter and normalises a bare host symmetrically", () => {
    // 'https://x.invalid/a?x=1&amp;y=2' -> 'https://x.invalid/a?x=1&y=2&ref=localhost'
    assert.deepEqual(
      storedBodyEqualsForTest('<p><a href="https://x.invalid/a?x=1&amp;y=2">l</a></p>', '<p><a href="https://x.invalid/a?x=1&y=2&ref=localhost">l</a></p>'),
      { ok: true, problems: [] },
    );
    // 'https://q.invalid' -> 'https://q.invalid/?ref=localhost'
    assert.deepEqual(
      storedBodyEqualsForTest('<p><a href="https://q.invalid">l</a></p>', '<p><a href="https://q.invalid/?ref=localhost">l</a></p>'),
      { ok: true, problems: [] },
    );
    // A genuinely different target is still caught.
    assert.equal(storedBodyEqualsForTest('<p><a href="https://a.invalid/">l</a></p>', '<p><a href="https://b.invalid/">l</a></p>').ok, false);
  });

  test("a nested list item is one leaf whose text includes the nested item, and a change to it is detected", () => {
    const sent = "<ol>\n<li>two<ul>\n<li>nested <em>x</em></li>\n</ul>\n</li>\n</ol>";
    const stored = "<ol><li>two<ul><li>nested <em>x</em></li></ul></li></ol>";
    assert.deepEqual(storedBodyEqualsForTest(sent, stored), { ok: true, problems: [] });
    // The nested item is part of the outer leaf's text on both sides.
    assert.equal(contentOutline(sent)[0].text, "two nested x");
    assert.equal(contentOutline(stored)[0].text, "two nested x");
    // A change to the nested item's text is a change.
    const changed = "<ol><li>two<ul><li>nested <em>y</em></li></ul></li></ol>";
    assert.equal(storedBodyEqualsForTest(sent, changed).ok, false);
  });

  test("a blockquote's second paragraph change is detected", () => {
    const sent = "<blockquote><p>one</p><p>two</p></blockquote>";
    const stored = "<blockquote><p>one</p><p>three</p></blockquote>";
    assert.equal(storedBodyEqualsForTest(sent, stored).ok, false);
  });

  test("the raw-HTML pair wrapped in kg-card markers is stored verbatim and compares equal", () => {
    const raw = "\n<!--kg-card-begin: html-->\n<div class=\"callout\" data-x=\"1\"><p>Inner <b>b</b> <span style=\"color:red\">s</span></p><ul><li>li</li></ul></div>\n<!--kg-card-end: html-->\n";
    assert.deepEqual(storedBodyEqualsForTest(raw, raw), { ok: true, problems: [] });
    const outline = contentOutline(raw);
    assert.deepEqual(outline.map((block) => block.kind), ["paragraph", "list-item"]);
    assert.equal(outline[0].marks, "Inner*b*s");
    assert.equal(outline[1].marks, "li");
  });

  test("a changed href deep in a table cell is detected", () => {
    const sent = '<table><tbody><tr><td><a href="https://d.invalid">d</a></td></tr></tbody></table>';
    const stored = '<table><tbody><tr><td><a href="https://e.invalid">d</a></td></tr></tbody></table>';
    assert.equal(storedBodyEqualsForTest(sent, stored).ok, false);
    assert.deepEqual(storedBodyEqualsForTest(sent, sent), { ok: true, problems: [] });
  });
});

// C2/C8: an image inside a paragraph is part of that paragraph's content.
// Confirmed defect, reproduced through the full path against Ghost 6.64.0: a
// paragraph's <img> contributed nothing to the outline — not to its text (tags
// are stripped) and not to its inline structure (there was no token for it) —
// so a paragraph holding only a linked image outlined to NOTHING on both
// sides. Ghost drops an image inside a link entirely (the stored body comes
// back as an empty <a>), and the comparison passed: the outline was blind to
// exactly the loss it exists to catch.
describe("C2: the outline does not lose an image inside a paragraph", () => {
  test("a linked image is a paragraph block carrying both the link and the image", () => {
    const blocks = contentOutline('<p><a href="https://example.invalid/t"><img src="assets/linked.png" alt="Linked"></a></p>');
    assert.equal(blocks.length, 1, "the paragraph is a block, not nothing");
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[0].text, "");
    assert.ok(blocks[0].marks.includes("[https://example.invalid/t|"), `the link target is in the marks: ${blocks[0].marks}`);
    assert.ok(blocks[0].marks.includes("![Linked|assets/linked.png]"), `the image is in the marks: ${blocks[0].marks}`);
  });

  test("an inline image with surrounding text stays ONE paragraph carrying the image in position", () => {
    const blocks = contentOutline('<p>Before <img src="assets/inline.png" alt="Inline"> after.</p>');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[0].text, "Before after.");
    assert.ok(blocks[0].marks.includes("![Inline|assets/inline.png]"), blocks[0].marks);
    // The image's position relative to the text is part of the signature, so
    // moving it is a change rather than a pass.
    const moved = contentOutline('<p><img src="assets/inline.png" alt="Inline"> Before after.</p>');
    assert.notEqual(moved[0].marks, blocks[0].marks);
  });

  test("a paragraph that is exactly one bare image is still that image block", () => {
    // Ghost stores it as its own kg-image-card, so the outline must hold the
    // image block, not an empty paragraph — the rule wrapRawHtmlSegments'
    // "leave a block image to Ghost" depends on.
    const blocks = contentOutline('<p><img src="assets/diagram.png" alt="Diagram"></p>');
    assert.deepEqual(blocks, [{ kind: "image", alt: "Diagram", src: "assets/diagram.png" }]);
  });

  test("Ghost dropping a linked image is DETECTED, not passed", () => {
    const sent = '<p><a href="https://example.invalid/t"><img src="assets/linked.png" alt="Linked"></a></p>';
    const stored = '<p><a href="https://example.invalid/t"></a></p>'; // what 6.64.0 actually stores
    const result = storedBodyEqualsForTest(sent, stored);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.join(" ").includes("Linked"),
      `the report names the lost image: ${result.problems.join(" ")}`,
    );
  });

  test("a substituted inline image is DETECTED even though the paragraph text is unchanged", () => {
    const sent = '<p>Before <img src="assets/inline.png" alt="Inline"> after.</p>';
    const stored = '<p>Before <img src="assets/other.png" alt="Inline"> after.</p>';
    assert.equal(storedBodyEqualsForTest(sent, stored).ok, false);
  });

  test("the src shape reaches an image INSIDE a paragraph, not only an image block", () => {
    const sent = '<p>Before <img src="assets/inline.png" alt="Inline"> after.</p>';
    const stored =
      '<p>Before <img src="https://ghost.example.invalid/content/images/2026/10/inline.png" alt="Inline"> after.</p>';
    assert.equal(storedBodyEqualsForTest(sent, stored).ok, false, "without a shape the two srcs differ");
    const shape = (src) => (String(src).endsWith("inline.png") ? "assets/inline.png" : src);
    assert.equal(storedBodyEqualsForTest(sent, stored, { imageSrcShape: shape }).ok, true);
  });
});
