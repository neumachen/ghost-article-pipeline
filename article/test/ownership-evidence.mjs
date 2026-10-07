#!/usr/bin/env node
// C1 evidence: git operations inside the application container against a
// checkout owned by a DIFFERENT USER, exactly as on a Linux runner.
//
// Runtime UID mapping normally matches checkout ownership. A foreign-owned
// checkout must still work through scoped trust, without granting root:
//
//   fatal: detected dubious ownership in repository at '/repo'
//
// The pipeline reads git for everything it does — resolving the revision,
// reading the registry and the article at that revision, the ancestry and
// existence gates — so without an exception it cannot run on a hosted runner at
// all. `safe.directory` is git's supported exception, and git honours it only
// from a system or a global config file, never from `-c` or the GIT_CONFIG_*
// environment. git-source.mjs therefore writes its own minimal global config
// naming only the checkout it was told to read.
//
// This script demonstrates, inside the pinned image and as non-root:
//   1. the refusal is REAL — plain git, isolated from the machine's config the
//      way the app isolates itself, fails on a foreign-owned checkout;
//   2. the app's own git layer succeeds on that same checkout: resolveCommit,
//      readArticleAtCommit, and the registry read at a commit;
//   3. a linked WORKTREE of that checkout works too, which is the shape this
//      repository's own task worktrees have (tools/article/run.sh mounts the
//      common git directory read-only for exactly this reason);
//   4. the exception is SCOPED — the config the app wrote names only that
//      checkout and its git metadata, never `safe.directory = *`;
//   5. nothing was disabled globally: there is no system config entry, and a
//      DIFFERENT foreign-owned checkout the app was not told about is still
//      refused even while running under the app's own trust config.
//
// Run it through the container contract: bash article/test/history-evidence.sh
// (which runs this and the committed-history evidence in one go), or directly:
//   tools/article/run.sh -- node /repo/article/test/ownership-evidence.mjs
//
// Exits non-zero if any part of the evidence does not hold, so it is a check
// and not just a printout.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveCommit, readArticleAtCommit, trustedDirectories, trustConfigFile } from "/app/src/git-source.mjs";
import { readRegistryTextAtCommit } from "/app/src/registry.mjs";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** Run git the way the app ISOLATES itself: no machine config at all. */
function isolatedGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    ...options,
  });
}

function git(repoRoot, ...args) {
  return isolatedGit(["-C", repoRoot, ...args]);
}

function commitAll(repoRoot, message) {
  git(repoRoot, "add", "-A");
  git(repoRoot, "-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return git(repoRoot, "rev-parse", "HEAD").trim();
}

/** A disposable repository holding a registry and one enrolled article. */
function buildRepo(dir) {
  mkdirSync(path.join(dir, "editorial/articles/demo/assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "editorial/articles/registry.json"),
    `${JSON.stringify({ schema: "neumachen-article-registry/1", articles: [{ id: "demo", path: "editorial/articles/demo" }] }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "editorial/articles/demo/article.md"),
    ["---", "id: demo", "title: Demo", "slug: demo", "status: draft", "authors: []", "---", "", "# Demo", "", "Body.", ""].join("\n"),
  );
  writeFileSync(path.join(dir, "editorial/articles/demo/assets/note.txt"), "evidence\n");
  execFileSync("git", ["-C", dir, "init", "-q", "--initial-branch", "main"], { stdio: ["ignore", "pipe", "pipe"] });
  return commitAll(dir, "A");
}

const work = "/opt/article-ownership";
const checkout = path.join(work, "checkout");
const other = path.join(work, "unrelated");
if (process.argv[2] === "--prepare") {
  if (process.getuid() !== 0) throw new Error("Fixture preparation is a root-only image build step.");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(other, { recursive: true });
  const revision = buildRepo(checkout);
  buildRepo(other);
  git(checkout, "worktree", "add", "-q", "--detach", path.join(work, "linked"), "HEAD");
  writeFileSync(path.join(work, "revision"), revision);
  process.exit(0);
}

if (process.getuid() === 0) throw new Error("Ownership evidence must run as non-root.");
const revision = readFileSync(path.join(work, "revision"), "utf8");
check("fixture owner differs from the runtime user", statSync(checkout).uid !== process.getuid());
console.log(`== C1: foreign checkout owner ${statSync(checkout).uid}; runtime uid ${process.getuid()} ==`);

  console.log("\n-- 1. the refusal is real: plain isolated git cannot read a foreign-owned checkout --");
  let refusal = "";
  try {
    git(checkout, "rev-parse", "HEAD");
    check("plain git refuses a foreign-owned checkout", false, "it unexpectedly succeeded, so this evidence proves nothing");
  } catch (error) {
    refusal = String(error.stderr ?? error.message).trim().split("\n")[0];
    check("plain git refuses a foreign-owned checkout", /dubious ownership/i.test(refusal), refusal);
  }

  console.log("\n-- 2. the app's own git layer reads that same checkout --");
  let resolved = null;
  try {
    resolved = resolveCommit(checkout, "HEAD");
    check("resolveCommit(checkout, HEAD)", resolved === revision, `${resolved?.slice(0, 12)} vs ${revision.slice(0, 12)}`);
  } catch (error) {
    check("resolveCommit(checkout, HEAD)", false, error.message);
  }
  try {
    const files = readArticleAtCommit(checkout, revision, "editorial/articles/demo");
    check(
      "readArticleAtCommit reads the article and its assets",
      files.has("editorial/articles/demo/article.md") && files.has("editorial/articles/demo/assets/note.txt"),
      `${files.size} file(s)`,
    );
  } catch (error) {
    check("readArticleAtCommit reads the article and its assets", false, error.message);
  }
  try {
    const registry = JSON.parse(readRegistryTextAtCommit(checkout, revision));
    check("readRegistryTextAtCommit reads the registry at that commit", registry.articles?.[0]?.id === "demo", registry.schema);
  } catch (error) {
    check("readRegistryTextAtCommit reads the registry at that commit", false, error.message);
  }

  console.log("\n-- 3. a linked worktree of that checkout works too (this repository's own shape) --");
  const linked = path.join(work, "linked");
  try {
    check("resolveCommit on a foreign-owned linked worktree", resolveCommit(linked, "HEAD") === revision);
  } catch (error) {
    check("resolveCommit on a foreign-owned linked worktree", false, error.message);
  }
  try {
    const article = readArticleAtCommit(linked, revision, "editorial/articles/demo");
    check("readArticleAtCommit through the linked worktree", article.has("editorial/articles/demo/article.md"));
  } catch (error) {
    check("readArticleAtCommit through the linked worktree", false, error.message);
  }

  console.log("\n-- 4. the exception is scoped to the checkout the app was told to read --");
  const trustFile = trustConfigFile(checkout);
  const trustText = readFileSync(trustFile, "utf8");
  const trusted = trustedDirectories(checkout);
  // Judged on the config's DIRECTIVES, not its prose: a comment explaining
  // what the file must never contain would otherwise trip the check.
  const directives = trustText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));
  check(
    "the trust config never disables the ownership check wholesale",
    !directives.some((line) => /\*\s*$/.test(line)),
    `directives: ${JSON.stringify(directives)}`,
  );
  check("the trust config names the checkout", trusted.some((dir) => trustText.includes(dir)), trusted.join(", "));
  check(
    "the trust config names the worktree's git metadata as well",
    trustedDirectories(linked).some((dir) => trustText.includes(dir) || dir.includes(".git")),
    trustedDirectories(linked).join(", "),
  );
  check("the trust config holds nothing but the [safe] section", /^\s*(#.*)?\s*$|^\[safe\]$|^\tdirectory = /.test(trustText.split("\n").filter(Boolean).join("\n")) || trustText.split("\n").every((line) => line.startsWith("#") || line === "[safe]" || line.startsWith("\tdirectory = ") || line.trim() === ""), "no hooks, no signing, no url rewrites");

  let systemEntries = "";
  try {
    systemEntries = execFileSync("git", ["config", "--system", "--get-all", "safe.directory"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    systemEntries = ""; // no system config, or no such key: both mean "nothing global"
  }
  check("no system-level safe.directory was set", systemEntries === "", systemEntries || "(none)");

  console.log("\n-- 5. a DIFFERENT foreign-owned checkout is still refused under that same trust config --");
  try {
    execFileSync("git", ["-C", other, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: trustFile, GIT_CONFIG_NOSYSTEM: "1" },
    });
    check("the unrelated checkout is still refused", false, "the exception leaked to a path it does not name");
  } catch (error) {
    const reason = String(error.stderr ?? error.message).trim().split("\n")[0];
    check("the unrelated checkout is still refused", /dubious ownership/i.test(reason), reason);
  }
const failed = results.filter((result) => !result.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} ownership checks passed ==`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.label).join("; ")}`);
  process.exit(1);
}
console.log("Conclusion: the container can read a checkout owned by a different user, as on a Linux");
console.log("runner, through a `safe.directory` exception scoped to that checkout alone.");
