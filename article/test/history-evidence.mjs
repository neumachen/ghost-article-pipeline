#!/usr/bin/env node
// C4 evidence: the publish gates need full committed history, demonstrated
// THROUGH THE CONTAINER CONTRACT.
//
// This runs inside the pinned application image, not on the host. The fixture
// repositories are built in the container's own /tmp, the clones are made by
// the container's git, and the predicates are the app's own, imported from
// /app/src — the same module the publish gates call. A host-node version of
// this evidence proved something about a developer's machine and their git,
// not about the thing that actually runs on a GitHub-hosted runner; the
// conclusion it supported (both publish jobs need `fetch-depth: 0`) was only
// as good as that difference.
//
// Run it with: bash article/test/history-evidence.sh
// or directly: tools/article/run.sh -- node /repo/article/test/history-evidence.mjs
//
// Exits non-zero if the evidence does not hold, so it is a check and not just
// a printout.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { commitExists, isAncestor } from "/app/src/git-source.mjs";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

function git(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, "-c", "user.name=Evidence", "-c", "user.email=evidence@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

const work = mkdtempSync(path.join(tmpdir(), "article-history-"));
/** The fixture origin, assigned inside the try block below. */
let origin = "";
console.log("== C4: committed history inside the container, shallow clone vs full clone ==");
console.log(`   container git: ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()}`);
console.log(`   work directory: ${work}`);

/**
 * Run one predicate against one fresh clone of the origin.
 * form: "shallow" (depth 1 — what a checkout WITHOUT fetch-depth gets) or
 *       "full" (everything — what `fetch-depth: 0` gets).
 */
function scenario(label, form, predicate) {
  const clone = path.join(work, `clone-${form}-${results.length}`);
  if (form === "shallow") {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "main", `file://${origin}`, clone], { stdio: ["ignore", "pipe", "pipe"] });
  } else {
    execFileSync("git", ["clone", "-q", "--branch", "main", `file://${origin}`, clone], { stdio: ["ignore", "pipe", "pipe"] });
  }
  const head = git(clone, "rev-parse", "HEAD").slice(0, 7);
  let ok = false;
  let error = "";
  try {
    ok = predicate(clone);
  } catch (caught) {
    error = String(caught.stderr ?? caught.message).trim().split("\n")[0];
  }
  console.log(`  ${ok ? "true " : "false"}  ${label} (${form} clone, HEAD=${head})${error ? `  — ${error}` : ""}`);
  rmSync(clone, { recursive: true, force: true });
  return ok;
}

try {
  // --- the origin fixture: main with A -> B -> C ---
  origin = path.join(work, "origin");
  mkdirSync(path.join(origin, "editorial/articles/demo"), { recursive: true });
  writeFileSync(path.join(origin, "editorial/articles/registry.json"), '{"schema":"neumachen-article-registry/1","articles":[]}\n');
  writeFileSync(path.join(origin, "editorial/articles/demo/article.md"), "# v1\n");
  execFileSync("git", ["-C", origin, "init", "-q", "--initial-branch", "main"], { stdio: ["ignore", "pipe", "pipe"] });
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "A");
  const A = git(origin, "rev-parse", "HEAD");
  writeFileSync(path.join(origin, "editorial/articles/demo/article.md"), "# v2\n");
  git(origin, "commit", "-q", "-am", "B");
  const B = git(origin, "rev-parse", "HEAD");
  writeFileSync(path.join(origin, "editorial/articles/demo/article.md"), "# v3\n");
  git(origin, "commit", "-q", "-am", "C");
  const C = git(origin, "rev-parse", "HEAD");
  console.log(`   A=${A.slice(0, 7)}  B=${B.slice(0, 7)} (the revision a prior publication recorded)  C=${C.slice(0, 7)} (main's head)`);

  // The app's own predicates, exactly as the publish gates call them:
  // commitExists(repoRoot, revision) — what verifyCandidateForPublish calls —
  // and isAncestor(repoRoot, prior, candidate) — what decide() calls.
  const existsA = (clone) => commitExists(clone, A);
  const bAncestorOfC = (clone) => isAncestor(clone, B, C);
  const bAncestorOfA = (clone) => isAncestor(clone, B, A);

  console.log("\n-- 1. initial publication: the candidate's revision exists in the checkout --");
  const s1 = scenario("commitExists(A)", "shallow", existsA);
  const f1 = scenario("commitExists(A)", "full", existsA);
  check("a full clone satisfies the existence gate", f1 === true);
  check("a shallow clone does NOT", s1 === false);

  console.log("\n-- 2. subsequent update: the prior published revision is an ancestor --");
  const s2 = scenario("isAncestor(B, C)", "shallow", bAncestorOfC);
  const f2 = scenario("isAncestor(B, C)", "full", bAncestorOfC);
  check("a full clone satisfies the ancestry gate", f2 === true);
  check("a shallow clone does NOT", s2 === false);

  console.log("\n-- 3. eligible non-HEAD revision: a candidate from A while HEAD is C --");
  const s3 = scenario("commitExists(A), HEAD is C", "shallow", existsA);
  const f3 = scenario("commitExists(A), HEAD is C", "full", existsA);
  check("a full clone satisfies the gate for an older eligible revision", f3 === true);
  check("a shallow clone does NOT", s3 === false);

  console.log("\n-- 4. stale/competing candidate: A is NOT a descendant of published B --");
  const s4 = scenario("isAncestor(B, A)", "shallow", bAncestorOfA);
  const f4 = scenario("isAncestor(B, A)", "full", bAncestorOfA);
  check("a full clone REFUSES the stale candidate on present history", f4 === false);
  check("a shallow clone also refuses — but for the wrong reason: absent history", s4 === false);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n== ${results.length - failed.length}/${results.length} history checks passed ==`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.label).join("; ")}`);
  process.exit(1);
}
console.log(`
Reading of the results:
  - The shallow clones (depth 1, what a checkout gets without fetch-depth) FAIL
    scenarios 1-3: A and B are not in a shallow clone at all, so a legitimate
    publication — initial, update, or an eligible non-HEAD candidate — cannot
    pass its gates. Scenario 4's refusal happens for the wrong reason too:
    absent history, which isAncestor cannot distinguish from a genuinely stale
    candidate.
  - The full clones (fetch-depth: 0) PASS scenarios 1-3 and keep scenario 4's
    refusal decided on present, real history.
Conclusion: every job performing revision or ancestry checks needs full history;
both jobs of .github/workflows/article-publish.yml use fetch-depth: 0.

NOTE: this is a LOCAL container run. It is not a GitHub-hosted run, and it does
not stand in for one.`);
