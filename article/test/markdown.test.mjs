// markdown.mjs: GFM rendering, raw HTML passthrough, and the extraction of
// the relative src values that must resolve against the article directory.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { extractAssetRefs, renderMarkdown, splitCodeRegions } from "../src/markdown.mjs";
import { wrapRawHtmlSegments, rewriteRefs } from "../src/publish.mjs";
import { buildCandidate } from "../src/candidate.mjs";

describe("renderMarkdown", () => {
  test("renders headings, code fences, links, tables, lists and blockquotes", () => {
    const html = renderMarkdown(
      [
        "# Title",
        "",
        "A `code` span and a [link](https://example.invalid/a).",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "- one",
        "- two",
        "",
        "> quoted",
      ].join("\n"),
    );
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<pre><code[^>]*>const x = 1;\n<\/code><\/pre>/);
    assert.match(html, /<a href="https:\/\/example.invalid\/a">/);
    assert.match(html, /<table>/);
    assert.match(html, /<li>one<\/li>/);
    assert.match(html, /<blockquote>\s*<p>quoted<\/p>/);
  });

  test("raw HTML passes through unchanged", () => {
    const raw = '<figure class="kg-card kg-image-card"><img src="hero.png" alt="hero"></figure>';
    const html = renderMarkdown(`Text.\n\n${raw}\n`);
    assert.ok(html.includes(raw));
  });
});

describe("extractAssetRefs", () => {
  test("collects sorted unique relative src values", () => {
    const refs = extractAssetRefs('<img src="b.png"><img src=\'a.png\'><img src="b.png"><img src="img/c.png">');
    assert.deepEqual(refs, ["a.png", "b.png", "img/c.png"]);
  });

  test("skips non-relative and non-file src values", () => {
    const html =
      '<img src="https://cdn.example.invalid/x.png">' +
      '<img src="//cdn.example.invalid/y.png">' +
      '<img src="/absolute.png">' +
      '<img src="data:image/png;base64,AAAA">' +
      '<img src="mailto:someone@example.invalid">' +
      '<img src="#anchor">' +
      '<a href="page.html"></a>';
    assert.deepEqual(extractAssetRefs(html), []);
  });

  test("href values are not asset refs; only src", () => {
    assert.deepEqual(extractAssetRefs('<a href="local.html"><img src="only.png"></a>'), ["only.png"]);
  });
});

// C9: raw-HTML wrapping and asset-reference rewriting. The tests below are
// regression tests for confirmed defects: nested raw HTML was torn apart at
// every inner opening tag, and unquoted src values were discovered but never
// rewritten. Both must fail against the pre-fix code.
describe("C9: wrapRawHtmlSegments / rewriteRefs", () => {
  test("nested raw HTML with block and inline children survives wrapping as ONE whole element", () => {
    const nested = '<figure class="callout"><p>text with <strong>bold</strong></p></figure>';
    const wrapped = wrapRawHtmlSegments(`<p>before</p>\n${nested}\n<p>after</p>\n`);
    // The whole element, nesting intact, appears exactly once between one
    // begin/end marker pair. Before the fix the inner <p> and <strong> were
    // split points, so the element was torn into fragments and each fragment
    // wrapped separately.
    const cards = wrapped.match(/<!--kg-card-begin: html-->[\s\S]*?<!--kg-card-end: html-->/g) ?? [];
    assert.equal(cards.length, 1, `exactly one kg-card: ${cards.join("\n---\n")}`);
    assert.ok(
      cards[0].includes('<figure class="callout"><p>text with <strong>bold</strong></p></figure>'),
      "the whole nested element is inside the card, intact",
    );
    // The renderer-emitted markup around it is untouched.
    assert.ok(wrapped.includes("<p>before</p>"));
    assert.ok(wrapped.includes("<p>after</p>"));
    // Balanced same-name nesting is matched to the RIGHT closer.
    const doublyNested = "<div><div>inner</div>outer</div>";
    const wrappedDouble = wrapRawHtmlSegments(doublyNested);
    assert.ok(
      wrappedDouble.replace(/<!--kg-card-(?:begin|end): html-->/g, "").trim().endsWith("outer</div>"),
      `the outer element runs to its own closing tag: ${wrappedDouble}`,
    );
    // Self-closing and void raw elements wrap alone without consuming a closer.
    const voidRaw = wrapRawHtmlSegments('<iframe src="https://example.invalid/embed"></iframe><hr>');
    assert.ok(voidRaw.includes("<!--kg-card-begin: html-->\n<iframe"));
    assert.ok(voidRaw.includes("<hr>"), "an <hr> stays renderer markup, not a raw card");
    // A plain renderer figure (img inside) is NOT raw HTML and is not wrapped.
    const rendererFigure = '<figure><img src="hero.png" alt="hero"></figure>';
    assert.ok(!wrapRawHtmlSegments(rendererFigure).includes("kg-card-begin: html"));
  });

  test("every quoting form is discovered AND rewritten: double, single, unquoted", () => {
    const html = [
      '<img src="assets/cover.png" alt="double">',
      "<img src='assets/diagram.png' alt='single'>",
      "<img src=assets/cover.png alt=unquoted>",
    ].join("\n");
    // Discovery: all three refs are found (the pre-fix code already did).
    assert.deepEqual(extractAssetRefs(html), ["assets/cover.png", "assets/diagram.png"]);
    // Rewriting: before the fix the unquoted form was never rewritten, so
    // the published post kept pointing at a path Ghost cannot serve.
    const uploaded = new Map([
      ["assets/cover.png", "https://ghost.example.invalid/content/images/cover.png"],
      ["assets/diagram.png", "https://ghost.example.invalid/content/images/diagram.png"],
    ]);
    const rewritten = rewriteRefs(html, uploaded);
    assert.ok(rewritten.includes('<img src="https://ghost.example.invalid/content/images/cover.png" alt="double">'));
    assert.ok(rewritten.includes("<img src='https://ghost.example.invalid/content/images/diagram.png' alt='single'>"));
    assert.ok(
      rewritten.includes("<img src=https://ghost.example.invalid/content/images/cover.png alt=unquoted>"),
      `the unquoted ref must be rewritten: ${rewritten}`,
    );
    assert.ok(!rewritten.includes("assets/cover.png"));
    assert.ok(!rewritten.includes("assets/diagram.png"));
  });

  test("a ref that is a substring of another path is not corrupted", () => {
    const uploaded = new Map([["assets/cover.png", "https://ghost.example.invalid/content/images/cover.png"]]);
    const html = '<img src="assets/cover.png"><img src="assets/cover.png.orig.png">';
    const rewritten = rewriteRefs(html, uploaded);
    assert.ok(rewritten.includes('<img src="https://ghost.example.invalid/content/images/cover.png">'));
    assert.ok(
      rewritten.includes('<img src="assets/cover.png.orig.png">'),
      "the longer path sharing the ref as a prefix is untouched",
    );
    // And an unquoted longer value sharing the ref as a prefix is untouched too.
    const unquoted = rewriteRefs("<img src=assets/cover.png.orig.png>", uploaded);
    assert.equal(unquoted, "<img src=assets/cover.png.orig.png>");
  });

  test("the raw-html fixture article renders, resolves and round-trips end to end", () => {
    // The real fixture under test/fixtures/raw-html: nested raw HTML plus
    // every quoting form. Discovery must find both refs; the body must keep
    // the whole nested figure; wrapRawHtmlSegments must wrap each raw
    // element exactly once.
    const fixture = buildCandidate({
      repoRoot: null,
      article: { id: "raw-html-fixture", path: "editorial/articles/raw-html-fixture" },
      revision: "0".repeat(40),
      kind: "commit",
      files: rawHtmlFixtureFiles(),
    });
    assert.deepEqual(
      fixture.assets.map((asset) => asset.ref),
      ["assets/cover.png", "assets/diagram.png"],
    );
    assert.equal(fixture.featureImage, "assets/cover.png");
    assert.ok(fixture.bodyHtml.includes('<figure class="callout"><p>text with <strong>bold</strong></p></figure>'));
    const wrapped = wrapRawHtmlSegments(fixture.bodyHtml);
    const cards = wrapped.match(/<!--kg-card-begin: html-->/g) ?? [];
    assert.equal(cards.length, 5, "five raw elements: callout, quoted, single, unquoted, prefix");
  });
});

/** The raw-html fixture's files as a repo-relative map, for buildCandidate. */
function rawHtmlFixtureFiles() {
  const articlePath = "editorial/articles/raw-html-fixture";
  return new Map([
    [`${articlePath}/article.md`, readFileSync(new URL("./fixtures/raw-html/article.md", import.meta.url))],
    [`${articlePath}/assets/cover.png`, readFileSync(new URL("./fixtures/raw-html/assets/cover.png", import.meta.url))],
    [`${articlePath}/assets/diagram.png`, readFileSync(new URL("./fixtures/raw-html/assets/diagram.png", import.meta.url))],
  ]);
}

// C9: a code example is literal text, never an asset dependency. Confirmed
// defect, reproduced by direct execution before the fix: extractAssetRefs
// matched a bare `src=` ANYWHERE in the document, including inside
// <pre><code> and <code>, where marked has already escaped the markup. A
// fenced ```html block documenting an image therefore produced the bogus refs
// `&quot;assets/inside-code.png&quot;` and `assets/also-in-code.png&gt;`,
// which resolveAssets then refused as "not a file in the article directory" —
// a documentation snippet could stop a publication — and rewriteRefs would
// have replaced the example with a live URL. Every test below fails against
// the pre-fix code.
describe("C9: code examples stay literal", () => {
  const FENCED = [
    "<p>Real image:</p>",
    '<p><img src="assets/real.png" alt="real"></p>',
    '<pre><code class="language-html">&lt;img src=&quot;assets/inside-code.png&quot;&gt;\n',
    "&lt;img src=assets/also-in-code.png&gt;\n",
    "</code></pre>",
    '<p>Inline <code>&lt;img src=&quot;assets/in-inline-code.png&quot;&gt;</code> example.</p>',
  ].join("");

  test("no asset ref is discovered inside a fenced or an inline code example", () => {
    assert.deepEqual(extractAssetRefs(FENCED), ["assets/real.png"]);
  });

  test("rendered Markdown carrying a literal HTML/image example discovers only the real asset", () => {
    const html = renderMarkdown(
      [
        "![real](assets/real.png)",
        "",
        "```html",
        '<img src="assets/inside-code.png">',
        "<img src=assets/also-in-code.png>",
        "```",
        "",
        'Inline `<img src="assets/in-inline-code.png">` too.',
      ].join("\n"),
    );
    assert.deepEqual(extractAssetRefs(html), ["assets/real.png"]);
  });

  test("raw HTML <pre><code> holding UNESCAPED image markup stays literal too", () => {
    const html = '<pre><code><img src="assets/raw-code.png"></code></pre><p><img src="assets/real.png"></p>';
    assert.deepEqual(extractAssetRefs(html), ["assets/real.png"]);
  });

  test("rewriting leaves a code example alone even when the same ref is a real asset", () => {
    const uploaded = new Map([["assets/real.png", "https://ghost.example.invalid/content/images/real.png"]]);
    const html =
      '<pre><code class="language-html">&lt;img src=&quot;assets/real.png&quot;&gt;</code></pre>' +
      '<p><img src="assets/real.png" alt="real"></p>';
    const rewritten = rewriteRefs(html, uploaded);
    assert.ok(
      rewritten.includes("&lt;img src=&quot;assets/real.png&quot;&gt;"),
      `the example keeps its literal text: ${rewritten}`,
    );
    assert.ok(rewritten.includes('<img src="https://ghost.example.invalid/content/images/real.png" alt="real">'));
  });

  test("discovery is limited to actual <img> elements", () => {
    // An <iframe>, <script> or <video> src is not an image this pipeline
    // uploads; treating it as one made a non-image file an asset dependency.
    const html =
      '<iframe src="assets/embed.png"></iframe>' +
      '<script src="assets/app.png"></script>' +
      '<img src="assets/real.png">';
    assert.deepEqual(extractAssetRefs(html), ["assets/real.png"]);
  });

  test("splitCodeRegions round-trips the document exactly and merges <pre> with its <code>", () => {
    for (const html of [FENCED, "<p>no code</p>", "<code>x</code>", "<pre><code>a</code></pre>", ""]) {
      assert.equal(
        splitCodeRegions(html).map((segment) => segment.text).join(""),
        html,
        "the segments reassemble to the input, byte for byte",
      );
    }
    // A <pre> swallows its inner <code> as ONE region, so the inner element is
    // not scanned a second time.
    const regions = splitCodeRegions("<p>a</p><pre><code>x</code></pre><p>b</p>");
    assert.deepEqual(
      regions.map((region) => region.code),
      [false, true, false],
    );
  });
});
