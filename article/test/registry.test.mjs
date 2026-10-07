// registry.mjs: the registry is the trust boundary for which article
// directories the pipeline will read, so every malformed shape is refused.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadRegistry, findArticle } from "../src/registry.mjs";
import { ValidationError } from "../src/errors.mjs";

const roots = [];
const repo = (registry) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "article-registry-"));
  roots.push(root);
  mkdirSync(path.join(root, "editorial/articles"), { recursive: true });
  if (registry !== undefined) {
    writeFileSync(path.join(root, "editorial/articles/registry.json"), JSON.stringify(registry));
  }
  return root;
};
after(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const good = {
  schema: "neumachen-article-registry/1",
  articles: [
    { id: "hello-world", path: "editorial/articles/hello-world" },
    { id: "second-one", path: "editorial/articles/second-one" },
  ],
};

describe("loadRegistry", () => {
  test("loads a good registry and exposes findArticle", async () => {
    const registry = await loadRegistry(repo(good));
    assert.equal(registry.schema, "neumachen-article-registry/1");
    assert.equal(registry.articles.length, 2);
    assert.deepEqual(registry.findArticle("hello-world"), { id: "hello-world", path: "editorial/articles/hello-world" });
    assert.equal(registry.findArticle("nope"), null);
    assert.deepEqual(findArticle(registry, "second-one"), { id: "second-one", path: "editorial/articles/second-one" });
  });

  test("refuses a wrong schema", async () => {
    await assert.rejects(
      () => loadRegistry(repo({ ...good, schema: "something-else/1" })),
      (error) => error instanceof ValidationError && /not a "neumachen-article-registry\/1"/.test(error.message),
    );
  });

  test("refuses a duplicate id", async () => {
    await assert.rejects(
      () =>
        loadRegistry(
          repo({
            ...good,
            articles: [
              { id: "hello-world", path: "editorial/articles/hello-world" },
              { id: "hello-world", path: "editorial/articles/other-dir" },
            ],
          }),
        ),
      (error) => error instanceof ValidationError && /more than once/.test(error.message),
    );
  });

  test("refuses a duplicate path", async () => {
    await assert.rejects(
      () =>
        loadRegistry(
          repo({
            ...good,
            articles: [
              { id: "one-a", path: "editorial/articles/same-dir" },
              { id: "two-b", path: "editorial/articles/same-dir" },
            ],
          }),
        ),
      (error) => error instanceof ValidationError && /path "editorial\/articles\/same-dir" more than once/.test(error.message),
    );
  });

  test("refuses a path with ..", async () => {
    await assert.rejects(
      () => loadRegistry(repo({ ...good, articles: [{ id: "escape", path: "editorial/../secrets" }] })),
      (error) => error instanceof ValidationError && /relative path inside the repository/.test(error.message),
    );
  });

  test("refuses an absolute path", async () => {
    await assert.rejects(
      () => loadRegistry(repo({ ...good, articles: [{ id: "escape", path: "/etc" }] })),
      (error) => error instanceof ValidationError && /relative path inside the repository/.test(error.message),
    );
  });

  test("refuses a bad id", async () => {
    for (const id of ["", "UPPER", "-leading", "with_underscore", "spaces in it", "x".repeat(65)]) {
      await assert.rejects(
        () => loadRegistry(repo({ ...good, articles: [{ id, path: `editorial/articles/${id || "x"}` }] })),
        (error) => error instanceof ValidationError && /does not match/.test(error.message),
        `id ${JSON.stringify(id)} should be refused`,
      );
    }
  });

  test("refuses a missing registry file", async () => {
    await assert.rejects(
      () => loadRegistry(repo(undefined)),
      (error) => error instanceof ValidationError && /cannot be read/.test(error.message),
    );
  });
});
