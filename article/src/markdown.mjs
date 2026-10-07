// Rendering and asset-reference extraction. GFM is the subset the drafts are
// written in (tables, fenced code, inline formatting) with raw HTML passing
// through marked unchanged, which is marked's default and is relied on: a
// body with an intentional <figure> must not lose it on the way to Ghost.
//
// Asset discovery and asset rewriting share ONE walk over the document
// (mapImageSrc), so they can never disagree about which references were
// published. That walk obeys two limits, both of which a plain `src=` regex
// gets wrong:
//
//   - It only ever looks at an actual <img> element. A `src` on any other
//     element (an <iframe>, a <script>, a <source>) is not an image this
//     pipeline can promise to serve: assets.mjs's content types are all
//     image types, and uploadImage sends an image part.
//   - It never looks inside a code region. marked escapes a fenced block's
//     HTML (`<img` becomes `&lt;img`), so a code EXAMPLE of an image is not
//     an <img> element at all — but a bare `src=` regex still matched the
//     escaped text and returned `&quot;assets/x.png&quot;&gt;` as an asset
//     reference, making a documentation example an upload and a rewrite
//     target. Code stays literal, both ways round.

import { marked } from "marked";
import { elementSpan } from "./normalize.mjs";

// References that never name a file next to the article. Everything else
// resolves against the article directory, so the set is the complement of
// these prefixes rather than an allowlist: an unusual-but-relative path
// (./img/x.png, img/x.png) still resolves.
const NON_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const ABSOLUTE_OR_ROOT = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * Render Markdown to HTML with GFM enabled.
 */
export function renderMarkdown(markdown) {
  return marked.parse(markdown, { gfm: true, async: false });
}

function relativeSrc(value) {
  if (typeof value !== "string" || !value) return false;
  if (ABSOLUTE_OR_ROOT.test(value)) return false;
  if (NON_RELATIVE.test(value)) return false;
  if (/^(?:data|mailto):/i.test(value)) return false;
  return true;
}

// --- code regions ---------------------------------------------------------------------

const CODE_OPENING = /<(pre|code)\b[^<>]*?(\/?)>/gi;

/**
 * Split rendered HTML into alternating non-code and code segments, in
 * document order: `{ code: boolean, text: string }`. A code segment is a
 * whole `<pre>` or `<code>` element, opening tag to its own matching closer,
 * so a `<pre>`'s inner `<code>` is part of the one segment and never scanned
 * twice. Joining the segments' text reproduces the input exactly.
 *
 * An opener that never closes runs to the end of the document, which is what
 * a browser does with it: the rest of the body IS that code element's
 * content, so none of it is a place to discover an asset. marked's own
 * output is always balanced; only hand-written raw HTML can reach this.
 */
export function splitCodeRegions(html) {
  const source = String(html ?? "");
  const segments = [];
  let index = 0;
  let plain = "";
  const push = (code, text) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.code === code) last.text += text;
    else segments.push({ code, text });
  };
  while (index < source.length) {
    CODE_OPENING.lastIndex = index;
    const match = CODE_OPENING.exec(source);
    if (!match) break;
    const start = match.index;
    const end =
      match[2] === "/"
        ? start + match[0].length // <code/>: a self-closing code element holds nothing
        : (elementSpan(source, start, match[1].toLowerCase()) ?? { end: source.length }).end;
    push(false, source.slice(index, start));
    push(true, source.slice(start, end));
    index = end;
  }
  push(false, source.slice(index));
  return segments;
}

// --- the shared image walk --------------------------------------------------------------

// One <img> element's opening tag. An <img> is void, so the tag is the whole
// element and there is no closer to balance.
const IMG_TAG = /<img\b[^<>]*>/gi;
// The src attribute inside that tag, keeping the ` src=` prefix (whitespace
// included) so a rewrite can put the tag back exactly as it found it, and
// keeping which quoting form the value used.
const SRC_ATTR = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;
// Characters that would end an unquoted attribute value early. A replacement
// carrying one upgrades the value to double quotes rather than corrupt the tag.
const UNSAFE_UNQUOTED = /[\s"'<>=`]/;

/**
 * Apply `transform` to the src value of every <img> element outside a code
 * region and return the rebuilt document. A transform that returns the value
 * it was given leaves that tag byte-for-byte alone.
 *
 * This is the single place asset references are found and the single place
 * they are replaced, so discovery and rewriting cannot drift apart: whatever
 * extractAssetRefs reported is exactly what rewriteRefs can rewrite, and
 * neither touches a code example.
 */
export function mapImageSrc(html, transform) {
  let out = "";
  for (const segment of splitCodeRegions(html)) {
    if (segment.code) {
      out += segment.text;
      continue;
    }
    out += segment.text.replace(IMG_TAG, (tag) => {
      const match = SRC_ATTR.exec(tag);
      if (!match) return tag;
      const value = match[2] ?? match[3] ?? match[4];
      const replaced = transform(value);
      if (typeof replaced !== "string" || replaced === value) return tag;
      // Keep the source's own quoting form, unless the replacement would not
      // survive it: an unquoted value ends at whitespace or ">", so one that
      // now carries either is quoted instead of truncated.
      const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : UNSAFE_UNQUOTED.test(replaced) ? '"' : "";
      return `${tag.slice(0, match.index)}${match[1]}${quote}${replaced}${quote}${tag.slice(match.index + match[0].length)}`;
    });
  }
  return out;
}

/**
 * Every <img> src value outside a code region, in document order, duplicates
 * kept: the occurrences a body carries, whatever their shape (relative or
 * absolute). Order matters to a caller comparing two bodies' images.
 */
export function collectImageSrc(html) {
  const values = [];
  mapImageSrc(html, (value) => {
    values.push(value);
    return value;
  });
  return values;
}

/**
 * The relative `src` values of the document's actual image elements, sorted
 * and unique, code regions excluded. These are the asset references a
 * candidate must resolve against the article directory; anything scheme-ful,
 * root-absolute, protocol-relative, a data URI, a mailto or an in-page anchor
 * is somebody else's to serve.
 */
export function extractAssetRefs(html) {
  const refs = new Set();
  mapImageSrc(html, (value) => {
    if (relativeSrc(value)) refs.add(value);
    return value;
  });
  return [...refs].sort();
}
