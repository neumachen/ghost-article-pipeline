// Front matter is split, not interpreted: fields are validated in
// candidate.mjs where the article shape is known. Splitting keeps this
// module usable for any Markdown the pipeline handles.
//
// CRLF input is tolerated the way git's text handling would normalise it:
// `git show` returns the committed bytes, and a file committed from Windows
// carries \r\n line endings even when checked out on Linux.

import YAML from "yaml";
import { ValidationError } from "./errors.mjs";

// The opening fence: "---" alone on the first line.
const OPENING = /^---[ \t]*\r?\n/;
// The closing fence: a line that is exactly "---", and whatever line
// terminator ends it (or the end of the file). Trailing spaces on a fence
// line are tolerated the way editors leave them.
const CLOSING = /\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Split optional leading "---" YAML front matter from the Markdown body.
 *
 * @returns {{ data: object, body: string, bodyOffset: number }}
 *   data is the parsed object ({} when there is no front matter), body the
 *   Markdown, bodyOffset the line in `text` the body starts on (1-based,
 *   useful for reporting errors against the author's file).
 */
export function parseArticle(text) {
  if (typeof text !== "string") {
    throw new ValidationError("The article is not text, so it cannot be split into front matter and body.");
  }
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text; // tolerate a stray BOM
  const opening = OPENING.exec(input);
  if (!opening) {
    return { data: {}, body: input, bodyOffset: 1 };
  }
  const afterOpening = opening[0].length;
  const closing = CLOSING.exec(input.slice(afterOpening));
  if (!closing) {
    throw new ValidationError('Front matter is opened with "---" but never closed with a "---" line.');
  }
  const source = input.slice(afterOpening, afterOpening + closing.index);
  const body = input.slice(afterOpening + closing.index + closing[0].length);
  // 1 for the opening line, the front matter's own lines, 1 for the closing.
  const bodyOffset = 2 + source.split(/\r?\n/).length - (source ? 0 : 1) + (source ? 0 : 1);

  let data;
  try {
    data = YAML.parse(source.replace(/\r\n/g, "\n"), { strict: false });
  } catch (error) {
    const at = error.linePos?.[0] ? ` (line ${error.linePos[0]})` : "";
    throw new ValidationError(`The front matter is not valid YAML${at}: ${error.message}`);
  }
  if (data == null) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError("The front matter must be a mapping of names to values, not a list or a plain string.");
  }
  return { data, body, bodyOffset };
}
