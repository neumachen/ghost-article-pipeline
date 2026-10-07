// Ghost rewrites the HTML it stores: it adds heading ids, wraps images in
// <figure> with kg-card classes, adds loading="lazy", and inserts its own
// HTML comments. Byte equality with what we rendered is therefore never the
// test; the test is that the content survived. Normalisation strips what
// Ghost legitimately rewrites so hashes compare meaningfully, and markers
// assert the content itself.
//
// Marker comparison works on normalised text rather than DOM equality
// because the DOM shape is exactly what Ghost changes; a stable text
// representation (comments out, whitespace collapsed) is what both sides
// share no matter the wrapper elements.

import { createHash } from "node:crypto";
import { hash16 } from "./identity.mjs";

/**
 * Deterministic normalisation used only for hashing/comparison: HTML
 * comments out, whitespace runs collapsed to single spaces, ends trimmed.
 * Stable and deliberately simple — it must behave identically on the
 * candidate's HTML and on what Ghost hands back.
 */
export function normalizeGhostHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A 16-hex comparison hash of normalised HTML. */
export function ghostBodyHash(html) {
  const code = [...String(html).matchAll(/<pre\b[\s\S]*?<\/pre>/gi)].map((match) => match[0]);
  return hash16(createHash("sha256").update(JSON.stringify([normalizeGhostHtml(html), code])).digest("hex"));
}

/**
 * A 16-hex hash of the NON-BODY fields we own on a Ghost post: title, slug,
 * status, custom_excerpt, the public tag names and the authors. Tags and
 * authors are sorted so a reorder by Ghost does not read as a content change.
 *
 * The body is deliberately NOT part of this fingerprint, and there is
 * exactly one such helper: the two sides of the owned-field comparison are
 * the candidate's RENDERED body and Ghost's STORED body, and Ghost rewrites
 * the stored body structurally (heading ids, kg-card <figure> wrappers,
 * loading="lazy", its own kg-card comments, a <p> dropped inside
 * <blockquote>, entity decoding, image srcs pointing at uploaded URLs) in
 * ways normalizeGhostHtml does not absorb. A body-inclusive fingerprint
 * therefore compares rendered text against stored text and can never be
 * equal on a genuine no-op — a repeat publish would read as an unexpected
 * Ghost-side edit forever. The body is compared instead by the Ghost-aware
 * machinery that already exists: the recorded ghostBodyHash against the live
 * ghostBodyHash, BOTH computed from Ghost's stored HTML (see ghostBodyHash).
 */
export function ownedFieldsHash({ title, slug, status, custom_excerpt, tags = [], authors = [], feature_image = null }) {
  const payload = {
    title,
    slug,
    status,
    custom_excerpt,
    tags: [...tags].sort(),
    authors: [...authors].sort(),
    // The feature image is an owned field like any other: a post whose feature
    // image is a different picture is not this candidate. Both sides pass the
    // value through the SAME image-src shape before hashing, so the
    // candidate's relative ref and the live post's uploaded URL hash to the
    // same thing when they are the same asset — and to different things when
    // they are not.
    feature_image: feature_image ?? null,
  };
  return hash16(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
}

// --- markers -------------------------------------------------------------------------

const ATTRIBUTES = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g;

/** All values of one attribute across the tags in the document. */
function attributeValues(html, tagPattern, attribute) {
  const values = [];
  for (const match of String(html).matchAll(tagPattern)) {
    const tag = match[0];
    for (const attr of tag.matchAll(ATTRIBUTES)) {
      if (attr[1].toLowerCase() === attribute) {
        values.push(attr[2] ?? attr[3] ?? attr[4] ?? "");
      }
    }
  }
  return values;
}

// Paragraphs nested inside another block element are that element's own
// marker (list-item, blockquote, table-cell, code, card): only a paragraph
// the renderer emits at the top level of the body is a paragraph marker, so
// those whole elements are lifted out before paragraphs are read. The match
// is non-greedy and name-blind on its closing tag, so a nested list never
// survives half-open; lifting is deliberately conservative — content that
// MIGHT be nested simply is not a paragraph marker, and its own kind still
// covers it.
const NESTING_BLOCK = /<(?:ul|ol|li|blockquote|figure|table|thead|tbody|tr|th|td|pre)\b[^>]*>[\s\S]*?<\/(?:ul|ol|li|blockquote|figure|table|thead|tbody|tr|th|td|pre)>/gi;
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
const ANY_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/**
 * The visible text of the body's top-level paragraphs: inner tags stripped,
 * whitespace collapsed. A paragraph that wraps only an image (the markdown
 * renderer's output for a standalone image) strips to nothing and
 * contributes no text — Ghost rewrites those into <figure>, and the image
 * markers cover them.
 */
export function paragraphTexts(html) {
  const source = String(html).replace(NESTING_BLOCK, " ");
  const texts = [];
  for (const match of source.matchAll(PARAGRAPH)) {
    const text = normalizeGhostHtml(match[1].replace(ANY_TAG, ""));
    if (text) texts.push(text);
  }
  return texts;
}

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
// A code block is a <pre>; nested <code> is marked up in both the
// candidate and the stored HTML, so matching <pre> alone is enough.
const CODE_BLOCK = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
const CODE_TEXT = /<code\b[^>]*>([\s\S]*?)<\/code>/i;
// Blockquotes and list items carry a nested <p> in both the candidate and
// the stored HTML; the text inside is the content, the wrapper is not.
const INNER_PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/i;
const TABLE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const CELL = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
const LIST_ITEM = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const QUOTE = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;
const LINK_TAG = /<a\b[^>]*>/gi;
const IMAGE_TAG = /<img\b[^>]*>/gi;
const CARD_TAG = /<(?:figure|div|iframe|embed|gallery|video|audio)\b[^>]*>/gi;

/**
 * The content assertions taken from the candidate's HTML: heading texts,
 * code block texts, table cell texts, link hrefs, list item texts,
 * blockquote texts, paragraph texts, image alt texts, and the set of
 * raw-HTML card markers present. These must survive Ghost's rewrite.
 *
 * Each marker is `{ kind, description, value }`: `value` is the raw content
 * that must appear somewhere in the stored HTML (substring match on
 * normalised text — Ghost may wrap and annotate, but not drop), while
 * `description` is what a human reads when one goes missing.
 *
 * Paragraph markers are visible TEXT, not markup: the inner tags are
 * stripped, so Ghost re-wrapping a paragraph's inline <a>/<strong>/<code>
 * does not read as a lost paragraph, while genuinely different prose does.
 */
export function contentMarkers(html) {
  const source = String(html);
  const markers = new Map(); // value -> marker; deduplicated by value
  const add = (kind, value, description) => {
    if (value) markers.set(value, { kind, value, description: description ?? value });
  };
  for (const match of source.matchAll(HEADING)) add("heading", normalizeGhostHtml(match[2]));
  for (const text of paragraphTexts(source)) add("paragraph", text);
  for (const match of source.matchAll(CODE_BLOCK)) {
    // A code block's nested <code> element carries the language class in
    // both the candidate and the stored HTML, so the code TEXT is the
    // marker; the wrapper is markup Ghost may legitimately re-shape.
    const codeTag = CODE_TEXT.exec(match[1]);
    const text = codeTag ? codeTag[1] : match[1];
    add("code", normalizeGhostHtml(text));
  }
  for (const table of source.matchAll(TABLE)) {
    for (const cell of table[1].matchAll(CELL)) add("table-cell", normalizeGhostHtml(cell[1]));
  }
  for (const href of attributeValues(source, LINK_TAG, "href")) {
    add("link", href, `link href: ${href}`);
  }
  for (const match of source.matchAll(LIST_ITEM)) {
    const paragraph = INNER_PARAGRAPH.exec(match[1]);
    add("list-item", normalizeGhostHtml(paragraph ? paragraph[1] : match[1]));
  }
  for (const match of source.matchAll(QUOTE)) {
    const paragraph = INNER_PARAGRAPH.exec(match[1]);
    add("blockquote", normalizeGhostHtml(paragraph ? paragraph[1] : match[1]));
  }
  for (const alt of attributeValues(source, IMAGE_TAG, "alt")) {
    add("image-alt", alt, `image alt: ${alt}`);
  }
  for (const tag of source.matchAll(CARD_TAG)) {
    // A raw-HTML card is a figure/div/iframe Ghost preserves as an embedded
    // card; its identifying classes and data attributes are the marker, not
    // its text. (Indexed access, not destructuring: a match array's extra
    // properties confuse the destructured form of the same filter.)
    const attributes = [...tag[0].matchAll(ATTRIBUTES)];
    // The marker value is the raw class/data-attribute values, not the
    // "name=value" form: the stored HTML quotes the value, so the quoted
    // form never substring-matches. The values themselves appear verbatim.
    const id = attributes
      .filter((attribute) => /^(?:class|data-[\w-]+)$/i.test(attribute[1]))
      .map((attribute) => attribute[2] ?? attribute[3] ?? attribute[4] ?? "")
      .sort()
      .join(" ");
    add("card", id, `card: ${id}`);
  }
  return [...markers.values()];
}

/**
 * Check that every marker from the candidate's HTML survives in the HTML
 * Ghost reports as stored. Substring matching on normalised text: Ghost
 * may wrap or annotate, but it may not drop content.
 *
 * Paragraph markers are matched as text against text: the stored document
 * with its tags stripped, because a paragraph's marker is its visible text,
 * and the stored markup carries that text wrapped in Ghost's inline
 * elements — matching text against markup would read every inline link or
 * emphasis as a lost paragraph.
 *
 * @returns {{ ok: boolean, missing: string[] }}
 *   each missing marker is a short human description of what was lost.
 */
export function checkMarkers(candidateHtml, ghostStoredHtml) {
  const stored = normalizeGhostHtml(ghostStoredHtml);
  const storedText = normalizeGhostHtml(stored.replace(ANY_TAG, ""));
  const missing = [];
  for (const marker of contentMarkers(candidateHtml)) {
    const haystack = marker.kind === "paragraph" ? storedText : stored;
    if (!haystack.includes(marker.value)) missing.push(marker.description);
  }
  return { ok: missing.length === 0, missing };
}

// --- content outline -----------------------------------------------------------------
//
// A marker proof is one-sided: every candidate fragment appearing SOMEWHERE
// in the stored HTML says nothing about what else is there, so an unapplied
// update whose old body merely contains the candidate's blocks — a dropped
// paragraph, a reorder, a duplicate, a leftover fragment — passes it. The
// outline proof is two-sided: the stored body's blocks, in document order,
// must BE the candidate's blocks, in document order, none missing, none
// extra, none duplicated, each of the same kind. verify.mjs's
// storedBodyEquals wraps that comparison with the shape decision and the
// bodies it can honestly compare; a page whose content region could not be
// isolated keeps the containment proof only, labelled as such so no record
// reads it as more.

// Void elements: never paired, so an occurrence never opens a nesting depth a
// matching closer would have to end. The same set publish.mjs's wrapper uses.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

// Inline formatting elements: never a block of their own. A leaf's visible
// text strips them (visibleText), so a scan that meets one inside a
// container must skip the whole element — descending into it would lift the
// inline tag as a bogus card and shadow the container's own content.
const INLINE = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "i", "ins", "kbd", "mark",
  "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var",
]);

// An opening tag's own end (">" included) and lowercased name, or null where
// the position does not open one (an end tag, a "<" that is not a tag).
function openTagAt(html, index) {
  const match = /^<([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*?(\/?)>/.exec(html.slice(index));
  if (!match) return null;
  return { name: match[1].toLowerCase(), selfClosing: match[2] === "/", end: index + match[0].length };
}

/**
 * The byte range of one complete element: from an opening tag at `start` to
 * its own matching closing tag, counting same-name openings/closings so
 * nested same-name children stay inside the element. Returns null when the
 * element never closes (a name-blind closer would not, and must not, pair).
 * Exported for verify.mjs's public-page region isolation, which needs the
 * same balanced-element reach over theme markup this scanner uses.
 */
export function elementSpan(html, start, name) {
  const pattern = new RegExp(`<(/?)${name}\\b`, "gi");
  pattern.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (!match[1]) {
      if (html.slice(pattern.lastIndex, pattern.lastIndex + 2).startsWith("/")) continue;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        const close = /^\s*>/.exec(html.slice(pattern.lastIndex));
        return { start, end: pattern.lastIndex + (close ? close[0].length : 1) };
      }
    }
  }
  return null;
}

// Block-level elements (and the hard break) whose boundaries are word
// boundaries. Ghost collapses `<blockquote><p>a</p><p>b</p></blockquote>`
// into `<blockquote>a<br><br>b</blockquote>` (observed on 6.64.0), so a leaf
// whose inner blocks are concatenated without whitespace would read
// "ab" — and never match the sent "a b". Every one of these becomes a
// space, while inline tags (a, em, strong, code, del, span) are removed
// without adding one.
const BLOCK_BOUNDARY = /<\/?(?:br|p|div|li|ul|ol|blockquote|h[1-6]|pre|table|thead|tbody|tfoot|tr|th|td|figure|figcaption|section|hr)\b[^<>]*?>/gi;

/**
 * The visible text of some HTML: block boundaries become a space, inner
 * inline tags are stripped, whitespace collapsed, entities decoded by the
 * caller's decoder. Inline re-wrapping (a class, an attribute, entity form)
 * is therefore the same text, while different prose is not. The decode is
 * the caller's — both sides of a comparison run the same one, so a
 * one-sided decoding difference cannot read as a content difference.
 */
function visibleText(html, decode) {
  const spaced = String(html).replace(BLOCK_BOUNDARY, " ").replace(ANY_TAG, "");
  return decode(normalizeGhostHtml(spaced));
}

// --- inline-structure signature (marks) ---------------------------------------------
//
// Visible text says nothing about the inline structure inside a block: a
// link's target, an inline <code>, an <em> are all invisible once tags are
// stripped, so `<a href="https://new.invalid/">the docs</a>` and
// `<a href="https://old.invalid/">the docs</a>` — or `<code>rm</code>` and
// plain `rm` — read as the same text and a genuinely different body would
// pass. `marks` is the block's inline structure as a compact string: the
// open/close of strong/b ("*"), em/i ("_"), code ("`") and a
// ("[" + normalised href + "|" ... "]"), with the block's own text kept
// between them (whitespace stripped — the visible text already carries
// spacing). Every other inline element is ignored: Ghost drops <del>, a
// <span style>, and an <a>'s title attribute (observed on 6.64.0), so
// treating them as structure would read a legitimate rewrite as a change.
// b normalises to strong and i to em because Ghost rewrites a raw <b> to
// <strong> in a non-card paragraph (observed on 6.64.0).

const INLINE_MARK = { strong: "*", b: "*", em: "_", i: "_", code: "`" };
const INLINE_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*?>/g;

/** The default src comparison: the value itself, unchanged. */
const IDENTITY_SHAPE = (src) => src;

/**
 * A paragraph whose whole content is one bare <img> and nothing else. That
 * paragraph IS the image: Ghost stores it as its own kg-image-card, so the
 * outline descends and holds the image block rather than an empty paragraph.
 * Any other paragraph that carries an image — an image inside a link, an
 * image with text around it, two images — is a paragraph block whose inline
 * structure names its images, because that is how it is stored once
 * wrapRawHtmlSegments has kept Ghost from reflowing or dropping it.
 */
export const SOLE_BARE_IMAGE = /^\s*<img\b[^<>]*>\s*$/i;
const COMMENT = /<!--[\s\S]*?-->/g;

/** The value of one attribute on an opening tag, or "" when it is absent. */
function attributeValue(tagText, name) {
  for (const match of String(tagText).matchAll(ATTRIBUTES)) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return "";
}

/**
 * An href (or image src) in comparable form, applied symmetrically to both
 * sides: entities decoded, trimmed, and — for an absolute http(s) URL — the
 * `ref` search parameter deleted, then URL.href. Ghost's public page appends
 * `?ref=...` to outbound links and image srcs (observed on 6.64.0:
 * 'https://x.invalid/a?x=1&amp;y=2' becomes
 * 'https://x.invalid/a?x=1&y=2&ref=localhost', and 'https://q.invalid'
 * becomes 'https://q.invalid/?ref=localhost'), so both the parameter and the
 * slash a bare host gains under URL normalisation must compare equal. A
 * relative ref or a scheme we do not normalise is kept as it stands.
 */
function normalizeHref(value, decode) {
  const decoded = decode(String(value ?? "")).trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.searchParams.delete("ref");
      return url.href;
    }
  } catch {
    // Not an absolute URL: kept as-is, compared verbatim.
  }
  return decoded;
}

/** A run of text inside a block, as the signature carries it: decoded, all whitespace removed. */
function signatureText(text, decode) {
  return decode(String(text)).replace(/\s+/g, "");
}

/**
 * A block's inline-structure signature: its text with all whitespace
 * removed, interleaved with a token per strong/em/code/a open and close. The
 * order is the document order, so nesting reads correctly
 * (`<strong>a <em>b</em></strong>` is `*a_b_*`).
 */
function marksSignature(html, decode, shape = IDENTITY_SHAPE) {
  const source = String(html ?? "").replace(COMMENT, "");
  let signature = "";
  let cursor = 0;
  let match;
  INLINE_TAG.lastIndex = 0;
  while ((match = INLINE_TAG.exec(source)) !== null) {
    signature += signatureText(source.slice(cursor, match.index), decode);
    cursor = INLINE_TAG.lastIndex;
    const name = match[1].toLowerCase();
    const tagText = match[0];
    if (tagText.startsWith("</")) {
      // A closing tag: the matching token. b/i normalise to strong/em.
      if (name === "a") signature += "]";
      else if (INLINE_MARK[name] !== undefined) signature += INLINE_MARK[name];
      continue;
    }
    // An <img> is void, so it never has a closing tag and must be handled
    // before the self-closing skip below. It is part of the paragraph's
    // inline structure: without a token here an image inside a paragraph is
    // invisible to the comparison, and Ghost dropping it — observed on
    // 6.64.0 for an image inside a link, which comes back as an empty <a> —
    // would read as a pass. The src goes through the caller's shape so a
    // pre-upload candidate body and a stored body can be compared at all.
    if (name === "img") {
      const attributes = tagAttributes(tagText);
      signature += `![${decode(attributes.get("alt") ?? "")}|${shape(normalizeHref(attributes.get("src") ?? "", decode))}]`;
      continue;
    }
    if (/\/\s*>$/.test(tagText)) continue; // self-closing: holds no content
    if (name === "a") signature += `[${normalizeHref(attributeValue(tagText, "href"), decode)}|`;
    else if (INLINE_MARK[name] !== undefined) signature += INLINE_MARK[name];
  }
  signature += signatureText(source.slice(cursor), decode);
  return signature;
}

/**
 * A code block's signature: text only. A code block's content is literal —
 * no inline structure is rendered inside it — so its signature is the text
 * with tags and whitespace removed, which is all a change to it could move.
 */
function textOnlySignature(html, decode) {
  return signatureText(String(html ?? "").replace(COMMENT, "").replace(ANY_TAG, ""), decode);
}

/** The attributes of one opening tag, as name -> value. */
function tagAttributes(tagText) {
  const attributes = new Map();
  for (const match of String(tagText).matchAll(ATTRIBUTES)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * The identifying class/data-attribute values of an element's opening tag,
 * sorted and joined — the same identity the card marker carries, so a
 * marker-era record and an outline-era comparison agree on what a raw-HTML
 * card is.
 */
function cardIdentity(openingTag, decode) {
  return [...tagAttributes(openingTag)]
    .filter(([key]) => /^(?:class|data-[\w-]+)$/.test(key))
    .map(([, value]) => decode(value))
    .sort()
    .join(" ");
}

/**
 * The content blocks of an HTML byte range, in document order. Containers
 * are descended container-first (figure, table, blockquote, ul, ol) so a
 * block's outline position is that of the outermost element that holds it —
 * exactly the order a reflowed document keeps; a paragraph is descended
 * only when its visible text is empty (the renderer's wrapper for a
 * standalone image), so it contributes that image's block, never an empty
 * paragraph. A raw-HTML card is never descended into: its inner images are
 * parts of the card, the way Ghost stores the card itself.
 *
 * listParent carries the nearest enclosing list kind (ul/ol) so list items
 * distinguish ordered from unordered even nested inside a blockquote.
 *
 * Returns null where the scan meets an element that never closes: such a
 * body is not outlineable, and the caller falls back to containment rather
 * than guessing at unbalanced markup.
 */
function scanBlocks(source, start, end, listParent = "ul", decode = (text) => text, shape = IDENTITY_SHAPE) {
  const blocks = [];
  let index = start;
  while (index < end) {
    const next = source.indexOf("<", index);
    if (next === -1 || next >= end) break;
    const open = openTagAt(source, next);
    if (!open) {
      index = next + 1;
      continue;
    }
    if (open.end > end) return null;
    const { name } = open;
    if (name === "img") {
      const attributes = tagAttributes(source.slice(next, open.end));
      // The image src is normalised the way a link href is (entities decoded,
      // `ref` dropped from an absolute http(s) URL), so Ghost's public-page
      // click-tracking rewrite of an image URL is not read as a content change.
      blocks.push({ kind: "image", alt: decode(attributes.get("alt") ?? ""), src: shape(normalizeHref(attributes.get("src") ?? "", decode)) });
      index = open.end;
      continue;
    }
    if (name === "hr") {
      blocks.push({ kind: "hr" });
      index = open.end;
      continue;
    }
    if (INLINE.has(name) && !open.selfClosing) {
      // An inline formatting element is visible text, never a block: skip
      // its whole span so the leaf that contains it reads it as text.
      const span = elementSpan(source, next, name);
      if (!span || span.end > end) return null;
      index = span.end;
      continue;
    }
    if (VOID.has(name) || open.selfClosing) {
      index = open.end;
      continue;
    }
    const span = elementSpan(source, next, name);
    if (!span || span.end > end) return null;
    index = span.end;
    const inner = source.slice(open.end, span.end - closerLength(source, span, name));
    if (name === "thead" || name === "tbody" || name === "tfoot" || name === "tr" || name === "caption") {
      // Table structure is transparent scaffolding: it holds cells in
      // their document order and never contributes a block of its own.
      const contained = scanBlocks(source, open.end, span.end, listParent, decode, shape);
      if (contained === null) return null;
      for (const block of contained) blocks.push(block);
      continue;
    }
    if (name === "li") {
      // A list item is a leaf: its visible text is the item, so the
      // renderer's <li><p>item</p></li> and Ghost's unwrapped <li>item</li>
      // are the same block. Its `marks` carries the inline structure of the
      // item, the nested list included (the nested item is part of this
      // leaf's text on both sides).
      blocks.push({ kind: "list-item", ordered: listParent === "ol", text: visibleText(inner, decode), marks: marksSignature(inner, decode, shape) });
      continue;
    }
    if (name === "blockquote") {
      // A blockquote is a leaf too: Ghost drops the inner <p> entirely, and
      // visible text absorbs that drop — <blockquote><p>Quoted.</p></blockquote>
      // and <blockquote>Quoted.</blockquote> are the same block. Its inner
      // <br><br> (Ghost's rewrite of two quote paragraphs, observed on
      // 6.64.0) becomes a space in the visible text.
      blocks.push({ kind: "blockquote", text: visibleText(inner, decode), marks: marksSignature(inner, decode, shape) });
      continue;
    }
    if (name === "figure" || name === "div" || name === "section" || name === "table" || name === "ul" || name === "ol") {
      // A container is transparent to its liftable inner blocks, so a
      // block's outline position is that of the outermost element that
      // holds it — exactly the order a reflowed document keeps. Ghost wraps
      // code in kg-code-card and tables in kg-table-card figures, and none
      // of those rewrites move or reorder a single inner block. `section`
      // is a container on the same terms as `div`: Ghost's own Casper theme
      // (and any theme that renders the stock content partial) serves the
      // article body inside `<section class="gh-content ...">`, so the
      // public-page region IS a section — treating it as an opaque card
      // would read the whole region as one block and every public-page
      // content check would fail on a correct page. A section that holds no
      // liftable inner block still falls through to the raw-HTML card
      // branch below, exactly as a div does.
      const contained = scanBlocks(source, open.end, span.end, name === "ul" || name === "ol" ? name : listParent, decode, shape);
      if (contained === null) return null;
      if (contained.length > 0) {
        for (const block of contained) blocks.push(block);
        continue;
      }
      if (name === "ul" || name === "ol") continue; // an empty list holds no block
      if (name === "table") {
        blocks.push({ kind: "table", text: visibleText(inner, decode), marks: marksSignature(inner, decode, shape) });
      } else if (name === "figure") {
        // A figure with no liftable inner block: an image figure (kg-image-
        // card) whose image the inner HTML carries, or a raw-HTML figure
        // whose identifying values are the block.
        const image = /<img\b[^>]*>/i.exec(inner);
        if (image) {
          const attributes = tagAttributes(image[0]);
          blocks.push({ kind: "image", alt: decode(attributes.get("alt") ?? ""), src: shape(normalizeHref(attributes.get("src") ?? "", decode)) });
        } else {
          const identity = cardIdentity(source.slice(next, open.end), decode);
          if (identity) blocks.push({ kind: "card", identity });
          // else: an empty, identity-less figure holds no content at all.
        }
      } else {
        // A raw-HTML div/section card (class/data identity, with visible
        // text when it carries any): its inner images are parts of the card,
        // the way Ghost stores the card itself.
        const identity = cardIdentity(source.slice(next, open.end), decode);
        const visible = visibleText(inner, decode);
        // An empty, identity-less div/section holds no content: transparent,
        // so one stray wrapper can never cost the body its other blocks. A
        // card that carries text also carries its inline structure; one that
        // only carries an identity has no text for a signature to describe.
        if (identity || visible) blocks.push(visible ? { kind: "card", text: visible, identity, marks: marksSignature(inner, decode, shape) } : { kind: "card", identity });
      }
      continue;
    }
    if (name === "th" || name === "td") {
      blocks.push({ kind: "table-cell", text: visibleText(inner, decode), marks: marksSignature(inner, decode, shape) });
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      blocks.push({ kind: "heading", level: Number(name[1]), text: visibleText(inner, decode), marks: marksSignature(inner, decode, shape) });
      continue;
    }
    if (name === "pre") {
      // A code block's content is literal: its signature is text only.
      const text = decode(inner.replace(/^\s*<code\b[^>]*>/i, "").replace(/<\/code>\s*$/i, ""));
      blocks.push({ kind: "code", text, marks: text });
      continue;
    }
    if (name === "p") {
      const visible = visibleText(inner, decode);
      const carriesImage = /<img\b/i.test(inner);
      // A paragraph with no visible text and no image of its own wraps
      // something else (or is only markup): descend so whatever blocks are
      // inside say the content. A paragraph whose whole content is one bare
      // <img> is that image — Ghost stores it as its own kg-image-card, so
      // the outline must hold the image block, not an empty paragraph.
      if (!visible && (!carriesImage || SOLE_BARE_IMAGE.test(inner))) {
        const contained = scanBlocks(source, open.end, span.end, listParent, decode, shape);
        if (contained === null) return null;
        for (const block of contained) blocks.push(block);
        continue;
      }
      // Every other paragraph is a paragraph block, and its inline structure
      // carries its images. That includes a paragraph with no visible text at
      // all — an image inside a link — which would otherwise outline to
      // nothing on both sides and let Ghost's destruction of it pass.
      blocks.push({ kind: "paragraph", text: visible, marks: marksSignature(inner, decode, shape) });
      continue;
    }
    // Any other element is a raw-HTML card: its identifying class/data
    // values, plus its visible text when it carries any, are the block.
    const identity = cardIdentity(source.slice(next, open.end), decode);
    const visible = visibleText(inner, decode);
    // An empty, identity-less element holds no content: transparent, so one
    // stray wrapper can never cost the body its other blocks. A card that
    // carries text also carries its inline structure; one that only carries
    // an identity has no text for a signature to describe.
    if (identity || visible) blocks.push(visible ? { kind: "card", text: visible, identity, marks: marksSignature(inner, decode, shape) } : { kind: "card", identity });
  }
  return blocks;
}

/** The length of the closing tag that ends a balanced element span. */
function closerLength(source, span, name) {
  const closer = new RegExp(`</${name}\\s*>\\s*$`, "i").exec(source.slice(span.start, span.end));
  return closer ? closer[0].length : 0;
}

/**
 * The content blocks of an HTML body, in document order: an ordered array
 * of `{ kind, text, ... }` — headings with their `level`, paragraphs, code
 * blocks, list items (with `ordered` for their parent list kind),
 * blockquotes and table cells as visible `text`, images as `alt` and
 * `src`, horizontal rules, and raw-HTML cards as their identifying
 * class/data values (`identity`) with visible `text` when they carry any.
 * A paragraph that only wraps an image is that image's block, never an
 * empty paragraph.
 *
 * The same outline describes the rendered candidate and Ghost's stored
 * rewrite of it, so `compareOutlines` can demand full equivalence — same
 * blocks, same order, same kinds, same texts — instead of one-sided
 * containment. Ghost's legitimate rewrites (heading ids, figure wrappers,
 * kg-card markers and comments, class attributes, `loading="lazy"`,
 * computed width/height) never move a block; a genuinely different body
 * always does. `decode` defaults to the identity: the callers own the
 * decode decision (verify.mjs decodes both sides before comparing), and
 * the extraction needs no second pass over text it will not re-read.
 */
export function contentOutline(html, decode = (text) => text, shape = IDENTITY_SHAPE) {
  // Unbalanced markup (an element that never closes) is not outlineable:
  // null, so the caller can refuse to compare rather than guess at what
  // the truncated body was meant to hold.
  const source = String(html ?? "");
  return scanBlocks(source, 0, source.length, "ul", decode, shape);
}

/**
 * Whether two outlines are the same content: same number of blocks, same
 * kinds in the same order, same texts, same inline structure (`marks`), and
 * — for headings the level, for list items the ordered flag, for images the
 * alt, for cards the identity — the same block-identifying fields.
 * Comparison is by block-equality per position, never by edit distance: the
 * stored body must BE the intended one, so any divergence is a problem to
 * report, not to realign. The `marks` field is what makes a block's inline
 * structure (a link target, an inline code, an emphasis) part of the
 * comparison: visible text alone cannot tell two bodies apart when they
 * differ only there.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 *   each problem is short and specific: the first divergence with its
 *   index, blocks missing from the stored body, blocks present only in the
 *   stored body (unexpected retained or duplicated content), and an order
 *   difference when the same blocks appear in a different order.
 */
export function compareOutlines(expected, actual) {
  const problems = [];
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return { ok: false, problems: ["the content to compare is not an outlineable sequence of blocks."] };
  }
  // The same multiset of blocks in a different order is an order problem,
  // reported as such; a genuinely different multiset is a missing/extra
  // problem. Both reports name block positions, so an operator reads them.
  const shape = (block) =>
    [block?.kind, block?.text, block?.level, block?.ordered, block?.alt, block?.src, block?.identity, block?.marks]
      .map((value) => (value === undefined ? "" : String(value)))
      .join("\u0000");
  if (expected.length !== actual.length) {
    problems.push(
      `the stored body has ${actual.length} content block(s), the candidate has ${expected.length}.`,
    );
  }
  let firstDivergence = -1;
  for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
    if (shape(expected[index]) !== shape(actual[index])) {
      firstDivergence = index;
      break;
    }
  }
  if (firstDivergence !== -1) {
    problems.push(
      `the first divergence is at content block ${firstDivergence}: ` +
        `the candidate has ${describeBlock(expected[firstDivergence])}, ` +
        `the stored body has ${describeBlock(actual[firstDivergence])}.`,
    );
  }
  // The same blocks in a different order: report the reorder itself, or the
  // missing/extra content when the multisets differ.
  const expectedShapes = expected.map(shape);
  const actualShapes = actual.map(shape);
  if (expectedShapes.join("\u0001") !== actualShapes.join("\u0001")) {
    const missing = expectedShapes.filter((value) => !actualShapes.includes(value));
    const extra = actualShapes.filter((value) => !expectedShapes.includes(value));
    if (missing.length > 0) {
      problems.push(
        `missing from the stored body: ${missing.slice(0, 5).map((value) => describeShape(value)).join("; ")}` +
          `${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}.`,
      );
    }
    if (extra.length > 0) {
      problems.push(
        `present only in the stored body: ${extra.slice(0, 5).map((value) => describeShape(value)).join("; ")}` +
          `${extra.length > 5 ? ` (+${extra.length - 5} more)` : ""}.`,
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      problems.push("the same blocks appear in a different order.");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** One block, as a human reads it in a problem message. */
function describeBlock(block) {
  if (!block || typeof block !== "object") return "(no block)";
  // The inline structure, appended when the block carries one, so a
  // difference that visible text cannot express (a changed link target, a
  // dropped inline code or emphasis) still reads in the message.
  const marks = block.marks ? ` [inline structure ${JSON.stringify(block.marks)}]` : "";
  if (block.kind === "heading") return `a level-${block.level} heading (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "paragraph") return `a paragraph (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "code") return `a code block (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "list-item") return `an ${block.ordered ? "ordered" : "unordered"} list item (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "blockquote") return `a blockquote (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "table-cell") return `a table cell (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "table") return `a table (${JSON.stringify(block.text)})${marks}`;
  if (block.kind === "image") return `an image (alt ${JSON.stringify(block.alt)}, src ${JSON.stringify(block.src)})`;
  if (block.kind === "hr") return "a horizontal rule";
  if (block.kind === "card") {
    return block.text !== undefined
      ? `a raw-HTML card (${JSON.stringify(block.text)})${marks}`
      : `a raw-HTML card (identity ${JSON.stringify(block.identity)})${marks}`;
  }
  return `a ${block.kind} block`;
}

/** One shape string, as a human reads it in a missing/extra message. */
function describeShape(value) {
  const [kind, text, level, ordered, alt, src, identity, marks] = value.split("\u0000");
  return describeBlock({ kind, text: text || undefined, level: level || undefined, ordered: ordered || undefined, alt: alt || undefined, src: src || undefined, identity: identity || undefined, marks: marks || undefined });
}
