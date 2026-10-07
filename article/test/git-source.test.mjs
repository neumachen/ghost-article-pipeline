// git-source.mjs: reading the exact committed revision. Everything runs
// against a throwaway repository under the system temporary directory with
// the machine's git configuration switched off, the same isolation
// tools/test/helpers.mjs uses.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  commitExists,
  headCommit,
  isAncestor,
  listArticleDirsAtCommit,
  readArticleAtCommit,
  readArticleFromWorkingTree,
  resolveCommit,
} from "../src/git-source.mjs";
import { RefusedError } from "../src/errors.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const git = (root, ...args) =>
  sh(
    "git",
    ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { env: GIT_ENV },
  ).trim();

const roots = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (roots.length) roots.pop()();
});

/** A repository with two commits: the first adds the article, the second edits it. */
function fixtureRepo() {
  const root = temp("article-git-");
  git(root, "init", "--initial-branch", "main");
  mkdirSync(path.join(root, "editorial/articles/hello-world"), { recursive: true });
  writeFileSync(path.join(root, "editorial/articles/registry.json"), "{}\n");
  writeFileSync(path.join(root, "editorial/articles/hello-world/article.md"), "# v1\n");
  writeFileSync(path.join(root, "editorial/articles/hello-world/hero.png"), "fakepng1");
  git(root, "add", "-A");
  git(root, "commit", "-m", "one");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "editorial/articles/hello-world/article.md"), "# v2\n");
  mkdirSync(path.join(root, "editorial/articles/second-one"), { recursive: true });
  writeFileSync(path.join(root, "editorial/articles/second-one/article.md"), "# second\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "two");
  const second = git(root, "rev-parse", "HEAD");
  return { root, first, second };
}

describe("resolveCommit", () => {
  test("full sha, short sha and HEAD all resolve to the full 40-hex commit", () => {
    const { root, second } = fixtureRepo();
    assert.equal(resolveCommit(root, second), second);
    assert.equal(resolveCommit(root, second.slice(0, 7)), second);
    assert.equal(resolveCommit(root, "HEAD"), second);
  });

  test("a bad ref is refused", () => {
    const { root } = fixtureRepo();
    assert.throws(
      () => resolveCommit(root, "no-such-branch"),
      (error) => error instanceof RefusedError && /does not resolve to a commit/.test(error.message),
    );
  });

  test("a non-commit object is refused", () => {
    const { root, second } = fixtureRepo();
    // A tree ref names a tree, not a commit; ^{commit} must refuse it.
    const tree = git(root, "rev-parse", `${second}^{tree}`).trim();
    assert.throws(() => resolveCommit(root, tree), (error) => error instanceof RefusedError);
  });

  test("an empty ref is refused", () => {
    const { root } = fixtureRepo();
    assert.throws(() => resolveCommit(root, "  "), (error) => error instanceof RefusedError && /revision is required/.test(error.message));
  });
});

describe("readArticleAtCommit", () => {
  test("returns the article directory's file bytes at the exact commit", () => {
    const { root, first, second } = fixtureRepo();
    const atFirst = readArticleAtCommit(root, first, "editorial/articles/hello-world");
    assert.equal(atFirst.get("editorial/articles/hello-world/article.md").toString("utf8"), "# v1\n");
    const atSecond = readArticleAtCommit(root, second, "editorial/articles/hello-world");
    assert.equal(atSecond.get("editorial/articles/hello-world/article.md").toString("utf8"), "# v2\n");
    assert.ok(atSecond.has("editorial/articles/hello-world/hero.png"));
    // The other article's directory is not part of this one.
    assert.ok(!atSecond.has("editorial/articles/second-one/article.md"));
  });

  test("rejects a symlink in the article directory", () => {
    const root = temp("article-symlink-");
    git(root, "init", "--initial-branch", "main");
    mkdirSync(path.join(root, "editorial/articles/sym-one"), { recursive: true });
    writeFileSync(path.join(root, "target.txt"), "data");
    writeFileSync(path.join(root, "editorial/articles/sym-one/article.md"), "# x\n");
    symlinkSync("../../target.txt", path.join(root, "editorial/articles/sym-one/link.png"));
    git(root, "add", "-A");
    git(root, "commit", "-m", "symlink");
    const commit = git(root, "rev-parse", "HEAD");
    assert.throws(
      () => readArticleAtCommit(root, commit, "editorial/articles/sym-one"),
      (error) => error instanceof RefusedError && /not a regular file/.test(error.message),
    );
  });
});

describe("isAncestor / commitExists / headCommit", () => {
  test("first is an ancestor of second; second is not an ancestor of first", () => {
    const { root, first, second } = fixtureRepo();
    assert.equal(isAncestor(root, first, second), true);
    assert.equal(isAncestor(root, second, first), false);
    assert.equal(commitExists(root, first), true);
    assert.equal(commitExists(root, "0".repeat(40)), false);
    assert.equal(commitExists(root, "not-even-a-sha"), false);
    assert.equal(headCommit(root), second);
  });
});

describe("readArticleFromWorkingTree (non-authoritative)", () => {
  test("reads the working tree and refuses symlinks", () => {
    const { root } = fixtureRepo();
    const files = readArticleFromWorkingTree(root, "editorial/articles/hello-world");
    assert.equal(files.get("editorial/articles/hello-world/article.md").toString("utf8"), "# v2\n");

    const symRoot = temp("article-wt-symlink-");
    mkdirSync(path.join(symRoot, "editorial/articles/wt"), { recursive: true });
    writeFileSync(path.join(symRoot, "outside.txt"), "data");
    writeFileSync(path.join(symRoot, "editorial/articles/wt/article.md"), "# x\n");
    symlinkSync("../../../outside.txt", path.join(symRoot, "editorial/articles/wt/link.png"));
    assert.throws(
      () => readArticleFromWorkingTree(symRoot, "editorial/articles/wt"),
      (error) => error instanceof RefusedError && /symlink/.test(error.message),
    );
  });
});

describe("listArticleDirsAtCommit", () => {
  test("lists the article ids present at a commit", () => {
    const { root, first, second } = fixtureRepo();
    assert.deepEqual(listArticleDirsAtCommit(root, first, "editorial/articles"), ["hello-world"]);
    assert.deepEqual(listArticleDirsAtCommit(root, second, "editorial/articles"), ["hello-world", "second-one"]);
  });
});
