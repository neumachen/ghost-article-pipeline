// frontmatter.mjs: splitting front matter from the Markdown body, with CRLF
// tolerance and a clear error for YAML that does not parse.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseArticle } from "../src/frontmatter.mjs";
import { ValidationError } from "../src/errors.mjs";

describe("parseArticle", () => {
  test("splits front matter from the body", () => {
    const { data, body, bodyOffset } = parseArticle("---\ntitle: One\nslug: one\n---\n\nBody text.\n");
    assert.deepEqual(data, { title: "One", slug: "one" });
    assert.equal(body, "\nBody text.\n");
    assert.equal(bodyOffset, 4);
  });

  test("no front matter yields empty data and the whole text", () => {
    const { data, body, bodyOffset } = parseArticle("# Just markdown\n");
    assert.deepEqual(data, {});
    assert.equal(body, "# Just markdown\n");
    assert.equal(bodyOffset, 1);
  });

  test("tolerates CRLF line endings", () => {
    const { data, body } = parseArticle("---\r\ntitle: One\r\n---\r\n\r\nBody.\r\n");
    assert.deepEqual(data, { title: "One" });
    assert.equal(body, "\r\nBody.\r\n");
  });

  test("invalid YAML throws a ValidationError naming the problem", () => {
    assert.throws(
      () => parseArticle("---\ntitle: [unclosed\n---\nBody.\n"),
      (error) => error instanceof ValidationError && /not valid YAML/.test(error.message),
    );
  });

  test("an unclosed front matter block is refused", () => {
    assert.throws(
      () => parseArticle("---\ntitle: One\n\nBody without a closing fence.\n"),
      (error) => error instanceof ValidationError && /never closed/.test(error.message),
    );
  });

  test("does not interpret or validate fields", () => {
    const { data } = parseArticle("---\nwhatever: {any: [yaml, value]}\n---\n");
    assert.deepEqual(data, { whatever: { any: ["yaml", "value"] } });
  });
});
