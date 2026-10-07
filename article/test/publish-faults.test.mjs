// publish.mjs through the CLI as a child process: the post-write tail's
// failure modes, exercised the way a workflow runs them. The finding says
// these paths must be driven through the CLI, so each scenario spawns
// node src/cli.mjs publish against the in-process fake Ghost
// (test/fake-ghost.mjs), whose faults hooks script the faulty 2xx replies.
//
// Every scenario asserts all three of: the process exit code, the record the
// CLI wrote (outcome, exit_code, live_changed, steps), and the number of
// mutating requests the fake received — a record that says "confirmed
// mutation" must match a fake that received the mutation.
//
// C8 lives here too: the asset step's mutation accounting (a partial upload
// failure, an uncertain upload, reuse instead of re-upload), driven through
// runInProcess the same way, with per-asset steps asserted in the record.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { buildCandidate, writeCandidate } from "../src/candidate.mjs";
import { cpSync, readFileSync as readFixture } from "node:fs";
import { readArticleAtCommit, resolveCommit } from "../src/git-source.mjs";
import { runPublish, ownedFieldsMatch } from "../src/publish.mjs";
import { describeMutations, renderSummary } from "../src/record.mjs";
import { GhostClient } from "../src/ghost-client.mjs";
import { decodeState, encodeState, identityTagName, identityTagSlug } from "../src/identity.mjs";
import { errorBody, FakeGhost, KEY_ID, KEY_SECRET } from "./fake-ghost.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.mjs");
const ARTICLE = { id: "publish-faults-fixture", path: "editorial/articles/publish-faults-fixture" };
const MARKDOWN = [
  "---",
  "id: publish-faults-fixture",
  "title: The publish faults fixture",
  "slug: publish-faults-fixture",
  "status: published",
  "authors: []",
  "excerpt: A fixture for the post-write tail's failure modes.",
  "tags:",
  "  - Tools",
  "---",
  "",
  "# The publish faults fixture",
  "",
  "A paragraph with a [link](https://example.invalid/post).",
  "",
  "## A heading",
  "",
  "```js",
  "const tail = \"verified\";",
  "```",
  "",
].join("\n");

const cleanups = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A throwaway repo with the fixture article at one commit. */
function fixtureRepo() {
  const root = temp("article-faults-");
  git(root, "init", "--initial-branch", "main");
  mkdirSync(path.join(root, ARTICLE.path), { recursive: true });
  writeFileSync(path.join(root, ARTICLE.path, "article.md"), `${MARKDOWN}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-m", "article");
  return root;
}

const RAW_HTML_FIXTURE = { id: "raw-html-fixture", path: "editorial/articles/raw-html-fixture" };

/**
 * A fixture repo built from test/fixtures/raw-html (C9): nested raw HTML and
 * every src quoting form, with the fixture's real PNG assets, so the asset
 * upload path and the rewrite path run against genuine image bytes.
 */
function rawHtmlFixtureRepo() {
  const root = temp("article-raw-html-");
  git(root, "init", "--initial-branch", "main");
  const fixture = path.resolve(import.meta.dirname, "fixtures", "raw-html");
  const target = path.join(root, RAW_HTML_FIXTURE.path);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(fixture, target, { recursive: true });
  writeFileSync(
    path.join(path.dirname(target), "registry.json"),
    `${JSON.stringify({ schema: "neumachen-article-registry/1", articles: [{ id: RAW_HTML_FIXTURE.id, path: RAW_HTML_FIXTURE.path }] }, null, 2)}\n`,
  );
  git(root, "add", "-A");
  git(root, "commit", "-m", "raw html fixture");
  return root;
}

/** Build and write a candidate for the fixture, returning its directory and revision. */
async function preparedCandidate(root) {
  const revision = resolveCommit(root, "HEAD");
  const files = readArticleAtCommit(root, revision, ARTICLE.path);
  const candidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision, files, kind: "commit" });
  const outDir = temp("article-faults-out-");
  await writeCandidate(outDir, candidate, new Map());
  return { candidateDir: outDir, revision };
}

/** The same, for any (article, repo) pair: the raw-html fixture is not ARTICLE. */
async function preparedCandidateFor(root, article) {
  const revision = resolveCommit(root, "HEAD");
  const files = readArticleAtCommit(root, revision, article.path);
  const candidate = buildCandidate({ repoRoot: root, article, revision, files, kind: "commit" });
  const outDir = temp("article-faults-out-");
  const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
  await writeCandidate(outDir, candidate, assetBytes);
  return { candidateDir: outDir, candidate, revision };
}

const ghosts = [];
/** A started fake Ghost, closed when the tests end. */
async function fakeGhost(options) {
  const ghost = await new FakeGhost(options).listen();
  ghosts.push(ghost);
  return ghost;
}

/** The child CLI's environment: the fake Ghost's origin and key, never a real one. */
function cliEnv(ghost) {
  return {
    ...process.env,
    GHOST_ADMIN_API_URL: ghost.origin,
    GHOST_ADMIN_API_KEY: `${KEY_ID}:${KEY_SECRET}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/**
 * Run the publish CLI as a child process against the fake Ghost and wait for
 * it. The fake is an in-process http server, so the parent's event loop must
 * stay free to serve it — spawnSync would deadlock both — hence spawn plus
 * a promise, not spawnSync.
 */
function runCli({ ghost, repo, candidateDir, revision, mode = "publish", repairState = false, recordFile }) {
  const args = ["publish", "--repo", repo, "--candidate", candidateDir, "--article", ARTICLE.id, "--revision", revision, "--mode", mode, "--record", recordFile];
  if (repairState) args.push("--repair-state");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: cliEnv(ghost) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

const mutatingRequests = (ghost) => ghost.requests.filter((request) => ["POST", "PUT"].includes(request.method));

/**
 * The post mutations the fake received: a create (POST) and an update (PUT)
 * both write the post, so a count that only looked for PUT would silently
 * read a create as zero. The intent of every count below is "the post is
 * written exactly once, never re-written" — a create must be counted too.
 */
const postMutations = (ghost) =>
  ghost.requests.filter((request) => (request.method === "POST" || request.method === "PUT") && request.url.startsWith("/ghost/api/admin/posts/"));

/** The tag writes the fake received: an explicit tag create (POST /tags/) and a tag update (PUT /tags/:id/). */
const tagWrites = (ghost) =>
  ghost.requests.filter((request) => ["POST", "PUT"].includes(request.method) && request.url.startsWith("/ghost/api/admin/tags/"));

/** The uploads the fake received. */
const uploads = (ghost) => ghost.requests.filter((request) => request.method === "POST" && request.url.startsWith("/ghost/api/admin/images/"));

/** The identity tag in the fake's registry for an article, or null. */
const registryTagOf = (ghost, articleId) => ghost.tagBySlug(identityTagSlug(articleId));

/** Run runPublish in-process (a path check without a CLI process). */
async function runInProcess({ ghost, root, candidateDir, revision, mode = "publish", repairState = false, articleId = ARTICLE.id }) {
  const recordPath = path.join(temp("article-faults-record-"), "record.json");
  const client = new GhostClient({ origin: ghost.origin, id: KEY_ID, secret: KEY_SECRET });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let result;
  try {
    result = await runPublish({
      repoRoot: root,
      candidateDir,
      articleId,
      revision,
      mode,
      recordPath,
      client,
      log: () => {},
      repairState,
    });
  } finally {
    console.error = originalError;
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  return { ...result, record, errors };
}

const stepOf = (record, name) => record.steps.findLast((step) => step.name === name) ?? null;

const state = {};

before(async () => {
  state.root = fixtureRepo();
  const { candidateDir, revision } = await preparedCandidate(state.root);
  state.candidateDir = candidateDir;
  state.revision = revision;
});

/**
 * A fresh repo and candidate, isolated from the shared one: every scenario
 * that advances a repo's history (a second commit) or stales a recorded state
 * gets its own, so the shared fixtures stay true to the FIRST commit and the
 * tests stay independent of each other's writes.
 */
async function freshFixture() {
  const root = fixtureRepo();
  const { candidateDir, revision } = await preparedCandidate(root);
  return { root, candidateDir, revision };
}

after(() => {
  while (cleanups.length) cleanups.pop()();
});
after(async () => {
  while (ghosts.length) await ghosts.pop().close();
});

describe("C5: post-write tail failures through the CLI", () => {
  // The confirmed-write public failures both need a REAL update first: a
  // second commit's candidate differs from the recorded state, so decide()
  // is an update; its write applies, and only the public fetch then fails.
  // The edit is committed onto the SAME repository, so the live revision
  // stays an ancestor and the publish is an update, never a stale refusal.
  let edited = null;
  async function editedSecondCommit() {
    if (edited) return edited;
    const markdown = MARKDOWN.replace("A paragraph with a [link](https://example.invalid/post).", "A paragraph with an [edit](https://example.invalid/edited).");
    writeFileSync(path.join(state.root, ARTICLE.path, "article.md"), `${markdown}\n`);
    git(state.root, "add", "-A");
    git(state.root, "commit", "-m", "edit");
    const { candidateDir, revision } = await preparedCandidate(state.root);
    edited = { candidateDir, revision };
    return edited;
  }

  test("a public HTTP failure after a confirmed write: exit 6, record finalised, live_changed yes", async () => {
    const ghost = await fakeGhost();
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const result = await runCli({ ghost, repo: state.root, candidateDir: state.candidateDir, revision: state.revision, recordFile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).outcome, "created");

    const { candidateDir: candidateDir2, revision: revision2 } = await editedSecondCommit();
    // The public page answers 503 on the very fetch after the update applied.
    ghost.publicFaults = () => 503;
    const mutationsBefore = mutatingRequests(ghost).length;

    const recordFile2 = path.join(temp("article-faults-record-"), "record2.json");
    const result2 = await runCli({ ghost, repo: state.root, candidateDir: candidateDir2, revision: revision2, recordFile: recordFile2 });
    assert.equal(result2.status, 6, `stdout:\n${result2.stdout}\nstderr:\n${result2.stderr}`);
    const record2 = JSON.parse(readFileSync(recordFile2, "utf8"));
    assert.equal(record2.outcome, "public-check-failed");
    assert.equal(record2.exit_code, 6);
    assert.equal(record2.live_changed, "yes");
    assert.notEqual(record2.outcome, "running");
    // The write was sent and applied before the public fetch failed.
    assert.ok(mutatingRequests(ghost).length > mutationsBefore, "the update was sent before the public failure");
  });

  test("a confirmed write whose public check then failed still reports the write", async () => {
    const ghost = await fakeGhost();
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const first = await runCli({ ghost, repo: state.root, candidateDir: state.candidateDir, revision: state.revision, recordFile });
    assert.equal(first.status, 0, first.stderr);

    const { candidateDir: candidateDir2, revision: revision2 } = await editedSecondCommit();
    ghost.publicFaults = () => 503;
    const recordFile2 = path.join(temp("article-faults-record-"), "record2.json");
    const failed = await runCli({ ghost, repo: state.root, candidateDir: candidateDir2, revision: revision2, recordFile: recordFile2 });
    assert.equal(failed.status, 6, `stdout:\n${failed.stdout}\nstderr:\n${failed.stderr}`);
    assert.match(failed.stdout, /Live site changed: yes/, `a confirmed mutation is not logged as nothing changed:\n${failed.stdout}`);
    assert.match(failed.stdout, /post updated/);
    assert.doesNotMatch(failed.stdout, /Nothing to change/);

    const summary = renderSummary(JSON.parse(readFileSync(recordFile2, "utf8")));
    assert.match(summary, /post updated/, `the summary names the confirmed write:\n${summary}`);
    assert.doesNotMatch(summary, /Nothing to change/);
    assert.doesNotMatch(summary, /nothing changed/i);
  });

  test("a public-fetch transport failure after a confirmed write: exit 6, not 3", async () => {
    const ghost = await fakeGhost();
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const ok = await runCli({ ghost, repo: state.root, candidateDir: state.candidateDir, revision: state.revision, recordFile });
    assert.equal(ok.status, 0, ok.stderr);

    const { candidateDir: candidateDir2, revision: revision2 } = await editedSecondCommit();
    // The public route destroys the connection: the fetch never completes,
    // a transport failure, not an HTTP status Ghost chose.
    ghost.publicFaults = () => "destroy";

    const recordFile2 = path.join(temp("article-faults-record-"), "record2.json");
    const result = await runCli({ ghost, repo: state.root, candidateDir: candidateDir2, revision: revision2, recordFile: recordFile2 });
    assert.equal(result.status, 6, `expected exit 6 (confirmed mutation, public fetch failed), got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const record = JSON.parse(readFileSync(recordFile2, "utf8"));
    assert.equal(record.outcome, "public-check-failed");
    assert.equal(record.exit_code, 6);
    assert.equal(record.live_changed, "yes");
    assert.notEqual(record.outcome, "running");
    assert.match(record.message, /CONFIRMED/);
  });

  test("an interrupted write-response body: reconciliation path, exit 0, reconciled", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "create" ? "interrupt" : null) });
    const { exitCode, record } = await runInProcess({ ghost, root: state.root, candidateDir: state.candidateDir, revision: state.revision });
    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "created");
    assert.equal(record.live_changed, "yes");
    assert.equal(stepOf(record, "create").status, "ok");
    assert.equal(stepOf(record, "create").reconciled, true);
    assert.equal(stepOf(record, "reconcile").status, "ok");
    assert.equal(ghost.posts.size, 1);
    assert.notEqual(record.outcome, "running");
  });

  test("a malformed successful write response: reconciliation path, exit 0", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "create" ? { body: "{not json" } : null) });
    const { exitCode, record } = await runInProcess({ ghost, root: state.root, candidateDir: state.candidateDir, revision: state.revision });
    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "created");
    assert.equal(stepOf(record, "create").reconciled, true);
    assert.equal(stepOf(record, "reconcile").status, "ok");
    assert.equal(ghost.posts.size, 1);
    assert.notEqual(record.outcome, "running");
  });

  test("a successful write response missing the post data: reconciliation path, exit 0", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "create" ? { body: "{}" } : null) });
    const { exitCode, record } = await runInProcess({ ghost, root: state.root, candidateDir: state.candidateDir, revision: state.revision });
    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "created");
    assert.equal(stepOf(record, "create").reconciled, true);
    assert.equal(ghost.posts.size, 1);
    assert.notEqual(record.outcome, "running");
  });

  test("a read-back failure after a confirmed write: uncertain, live_changed yes, never 'nothing changed'", async () => {
    // The create's 2xx reply is well-formed, but the read-back GET is dropped:
    // the mutation is confirmed and its verification failed.
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "read-post" ? "interrupt" : null) });
    const { exitCode, record } = await runInProcess({ ghost, root: state.root, candidateDir: state.candidateDir, revision: state.revision });
    assert.equal(exitCode, 5);
    assert.equal(record.outcome, "uncertain");
    assert.equal(record.live_changed, "yes");
    assert.equal(stepOf(record, "create").status, "ok"); // the write's reply was received
    assert.equal(stepOf(record, "verify-saved").status, "uncertain");
    assert.match(record.message, /CONFIRMED/);
    assert.ok(ghost.posts.size === 1, "the mutation stands on the server");
    assert.notEqual(record.outcome, "running");
  });

  test("no record from any of these paths ends with outcome running", async () => {
    // Every scenario above already asserts it; this is the explicit invariant
    // for the whole tail, driven once more end-to-end through the CLI.
    const ghost = await fakeGhost();
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const result = await runCli({ ghost, repo: state.root, candidateDir: state.candidateDir, revision: state.revision, recordFile });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.notEqual(record.outcome, "running");
    assert.equal(record.finished_at !== null, true);
  });
});

describe("C6: state-tag persistence failures and the repair path", () => {
  /** A managed post carrying the candidate's content and the recorded state. */
  test("a rejected state-tag write after a successful post mutation: non-zero exit, record says so", async () => {
    // The post write succeeds; the state-tag write is answered with a 500.
    //
    // C6 correction: under the two-step sequence there are now TWO tag writes
    // per publish — the provisional "tag-state" write BEFORE the post write,
    // and the final "state-write" after it. This scenario is about the SECOND
    // one, so the fault is scoped to the final write only (identified by its
    // body carrying the final state: a non-null stored-body hash). A fault
    // scoped to `kind === "tag"` alone would hit the tag-state step first and
    // stop the run at exit 3 (a definite rejection before the post write) —
    // which is a different, also-correct scenario, covered separately below.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const result = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(result.exitCode, 0, "the clean publish first: the state write is rejected on the NEXT run");
    assert.equal(result.record.outcome, "created");

    // A second commit on the same repository makes the next publish an
    // update, and its FINAL state-tag write is answered with a 500.
    const markdown = MARKDOWN.replace("The publish faults fixture", "The publish faults fixture (edited)");
    writeFileSync(path.join(root, ARTICLE.path, "article.md"), `${markdown}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-m", "edit");
    const { candidateDir: candidateDir2, revision: revision2 } = await preparedCandidate(root);

    const postWritesBefore = postMutations(ghost).length;
    ghost.faults = ({ kind, requestBody }) => {
      if (kind !== "tag") return null;
      // A status fault is discriminated on the REQUEST body (the fake answers
      // it before applying, so nothing is stored): the provisional write has
      // `"gh":null`, the final write has a stored-body hash. Reject only the
      // final write, leaving the provisional tag-state write to succeed.
      const description = JSON.parse(requestBody ?? "{}")?.tags?.[0]?.description ?? "";
      const isFinal = /"gh":"[0-9a-f]/.test(description) && !JSON.parse(description).next;
      return isFinal ? { status: 500, body: errorBody(500, "nope") } : null;
    };
    const result3 = await runInProcess({ ghost, root, candidateDir: candidateDir2, revision: revision2 });
    assert.equal(result3.exitCode, 5, `expected exit 5 (confirmed mutation, state not persisted), got ${result3.exitCode}`);
    const record3 = result3.record;
    assert.equal(record3.outcome, "uncertain");
    assert.equal(record3.exit_code, 5);
    assert.equal(record3.live_changed, "yes");
    // The provisional tag-state write succeeded; only the final write failed.
    assert.equal(stepOf(record3, "tag-state").status, "ok");
    assert.equal(stepOf(record3, "state-write").status, "failed");
    assert.match(record3.message, /CONFIRMED/);
    assert.match(record3.message, /state-tag write was rejected/);
    assert.notEqual(record3.outcome, "running");
    // The post write is exactly one more mutation; no post was re-written
    // after the state write failed.
    const postWrites = postMutations(ghost);
    assert.equal(postWrites.length, postWritesBefore + 1, "the post is written exactly once");
    ghost.faults = null;

    // The recovery: a plain re-run of the same candidate reaches the
    // unchanged path, repairs the state alone, and no post write is sent.
    const beforeRepair = postMutations(ghost).length;
    const repaired = await runInProcess({ ghost, root, candidateDir: candidateDir2, revision: revision2 });
    assert.equal(repaired.exitCode, 0, `the recovery run repairs the state: ${repaired.record.message}`);
    // ORACLE CHANGE: was "unchanged". A repair writes the state tag, which is a
    // Ghost mutation, so the outcome now names it instead of claiming nothing
    // changed. live_changed stays "no" — the LIVE SITE did not change.
    assert.equal(repaired.record.outcome, "state-repaired");
    assert.equal(repaired.record.mutations.tags, "repaired");
    assert.equal(repaired.record.mutations.post, "none");
    assert.equal(repaired.record.mutations.assets_uploaded, 0);
    assert.equal(stepOf(repaired.record, "state-repair")?.status, "ok");
    assert.equal(postMutations(ghost).length, beforeRepair, "no post write during the recovery");
  });

  test("the recovery path repairs the state with no post write and no upload", async () => {
    // After a run whose state write never landed, the live post holds the
    // candidate's content but the state tag records something else.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const seeded = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(seeded.exitCode, 0);
    assert.equal(seeded.record.outcome, "created");
    const postId = seeded.record.post.id;
    const post = ghost.posts.get(postId);
    const tag = post.tags.find((tag) => tag.name === identityTagName(ARTICLE.id));
    tag.description = encodeState({
      id: ARTICLE.id,
      revision,
      candidateHash: "9".repeat(64), // a stale, different candidate was recorded
      ghostBodyHash: "0".repeat(16), // a stale, different body was recorded
      ownedHash: "1".repeat(16),
      publishedAt: null,
      status: "published",
      ghostUpdatedAt: post.updated_at,
    });

    const mutatingBefore = mutatingRequests(ghost).length;
    const postWritesBefore = postMutations(ghost).length;
    const uploadsBefore = ghost.images.length;

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, repairState: true });
    assert.equal(exitCode, 0);
    // ORACLE CHANGE: was "unchanged" — see the note above. The tag write is a
    // Ghost mutation and the report must distinguish it from a true no-op.
    assert.equal(record.outcome, "state-repaired");
    assert.equal(record.live_changed, "no", "the live site did not change");
    assert.equal(record.mutations.tags, "repaired", "the tag write is accounted");
    assert.equal(record.mutations.post, "none", "no post write is accounted");
    assert.equal(stepOf(record, "state-repair").status, "ok");
    // Zero post mutations and zero uploads during the recovery.
    assert.equal(postMutations(ghost).length, postWritesBefore);
    assert.equal(ghost.images.length, uploadsBefore);
    assert.equal(mutatingRequests(ghost).length - mutatingBefore, 1, "exactly the tag write");

    // The repaired state makes the next ordinary publish a clean unchanged.
    const { exitCode: again, record: recordAgain } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(again, 0);
    assert.equal(recordAgain.outcome, "unchanged");
    assert.equal(stepOf(recordAgain, "state-repair"), null, "no repair step on a clean no-op");
  });

  test("the repair path is reachable through the CLI", async () => {
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    // Publish cleanly, then stale the recorded state.
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const ok = await runCli({ ghost, repo: root, candidateDir, revision, recordFile });
    assert.equal(ok.status, 0, ok.stderr);
    const postId = JSON.parse(readFileSync(recordFile, "utf8")).post.id;
    const post = ghost.posts.get(postId);
    const tag = post.tags.find((tag) => tag.name === identityTagName(ARTICLE.id));
    tag.description = encodeState({
      id: ARTICLE.id,
      revision,
      candidateHash: "9".repeat(64),
      ghostBodyHash: null,
      ownedHash: null,
      publishedAt: null,
      status: "published",
      ghostUpdatedAt: post.updated_at,
    });

    const postWritesBefore = postMutations(ghost).length;
    const recordFile2 = path.join(temp("article-faults-record-"), "record2.json");
    const result = await runCli({ ghost, repo: root, candidateDir, revision, repairState: true, recordFile: recordFile2 });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const record = JSON.parse(readFileSync(recordFile2, "utf8"));
    // ORACLE CHANGE: was "unchanged" — see the note above.
    assert.equal(record.outcome, "state-repaired");
    assert.equal(record.live_changed, "no");
    assert.equal(record.mutations.tags, "repaired");
    // No post write during the repair: the post mutation count did not move.
    assert.equal(postMutations(ghost).length, postWritesBefore);
  });

  test("a lost reply after the state write applied is reconciled as applied, not retried blindly", async () => {
    // The state-tag write applies on the server, then its reply is destroyed.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "tag" ? { apply: true } : null) });
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "created");
    assert.equal(record.live_changed, "yes");
    assert.equal(stepOf(record, "state-write").status, "ok");
    assert.equal(stepOf(record, "state-write").reconciled, true);
    // The tag write is sent exactly once — applied, never retried.
    const tagWrites = ghost.requests.filter((request) => request.method === "PUT" && request.url.startsWith("/ghost/api/admin/tags/"));
    assert.equal(tagWrites.length, 1);
    assert.notEqual(record.outcome, "running");
  });

  test("C8: a second asset upload failing after the first succeeded: the record shows the first completed, never 'nothing changed'", async () => {
    // Two assets; the SECOND upload is answered with a 500. Before the fix
    // every asset was uploaded before reuse was decided and no upload was
    // recorded per asset, so this run finished with outcome "rejected",
    // live_changed "no" and no step recording the first upload that DID
    // mutate Ghost's content store.
    const root = rawHtmlFixtureRepo();
    const { candidateDir, revision, candidate } = await preparedCandidateFor(root, RAW_HTML_FIXTURE);
    assert.equal(candidate.assets.length, 2, "the fixture must carry two assets");
    const ghost = await fakeGhost();

    let uploads = 0;
    ghost.faults = ({ kind }) => {
      if (kind !== "upload") return null;
      uploads += 1;
      return uploads === 2 ? { status: 500, body: errorBody(500, "second upload rejected") } : null;
    };

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, articleId: RAW_HTML_FIXTURE.id });
    assert.equal(exitCode, 3, "the rejected upload is exit 3 (that request changed nothing)");
    assert.equal(record.outcome, "rejected");
    // The first upload completed and is visible in the record as a per-asset
    // step with its URL: the run did NOT change nothing.
    const assetSteps = record.steps.filter((step) => step.name === "assets");
    const first = assetSteps.find((step) => step.asset === "assets/cover.png");
    assert.equal(first?.status, "ok", "the first asset's upload completed and is recorded");
    assert.equal(first?.outcome, "uploaded");
    assert.ok(first?.url, "the completed upload records its URL");
    const second = assetSteps.find((step) => step.asset === "assets/diagram.png");
    assert.equal(second?.status, "failed", "the second asset's failed upload is recorded");
    assert.match(second?.error ?? "", /second upload rejected/);
    assert.equal(ghost.images.length, 2, "both upload requests were sent (the first applied, the second was rejected)");
    // The operator is told the earlier upload stands rather than reading a
    // clean "nothing was sent" refusal.
    assert.match(record.message, /already completed/);
    assert.equal(record.live_changed, "unknown", "an earlier upload changed the content store");
  });

  test("C8: an uncertain (dropped-reply) upload is reported uncertain for that asset, not retried", async () => {
    // The first upload applies, then its reply is destroyed: the client
    // raises UncertainError. Before the fix the run reported generic
    // "uncertain" with no per-asset record of which upload was in flight,
    // and nothing recorded which asset was affected.
    const root = rawHtmlFixtureRepo();
    const { candidateDir, revision } = await preparedCandidateFor(root, RAW_HTML_FIXTURE);
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "upload" ? { apply: true } : null) });

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, articleId: RAW_HTML_FIXTURE.id });
    assert.equal(exitCode, 5, "a mutating request was sent and its outcome is unknown");
    assert.equal(record.outcome, "uncertain");
    assert.equal(record.live_changed, "unknown");
    // The record names the asset whose upload was in flight.
    const uncertainStep = record.steps.filter((step) => step.name === "assets").find((step) => step.status === "uncertain");
    assert.ok(uncertainStep, "an assets step records the uncertain upload");
    assert.equal(uncertainStep.asset, "assets/cover.png");
    assert.match(uncertainStep.error, /could not be completed/);
    // The operator is told not to re-run blindly: a retry may store a
    // second copy of the same bytes.
    assert.match(record.message, /upload of asset "assets\/cover\.png"/);
    assert.match(record.message, /Do not simply re-run/);
    // No post write followed the uncertain upload.
    assert.equal(postMutations(ghost).length, 0);
  });

  test("C8: an unchanged asset during a genuine update is reused, not uploaded again", async () => {
    // A managed post already serving one asset's exact bytes from a live
    // URL: a genuine update reuses that URL instead of uploading a fresh
    // copy of the same bytes, while a second asset whose stored bytes
    // differ is uploaded afresh. Before the fix, every asset was uploaded
    // first, so a real update minted a new copy of BOTH every run.
    const root = rawHtmlFixtureRepo();
    const { candidateDir, revision, candidate } = await preparedCandidateFor(root, RAW_HTML_FIXTURE);
    const ghost = await fakeGhost();

    // Seed a managed post whose html already points both assets at live
    // URLs, and serve exactly the asset bytes from those URLs.
    const coverBytes = readFixture(path.join(root, RAW_HTML_FIXTURE.path, "assets/cover.png"));
    const diagramBytes = readFixture(path.join(root, RAW_HTML_FIXTURE.path, "assets/diagram.png"));
    const coverUrl = `${ghost.origin}/content/images/cover.png`;
    const diagramUrl = `${ghost.origin}/content/images/diagram.png`;
    // Both assets are declared in the body and served from live URLs, but
    // only the COVER is byte-identical to its live copy: the reuse check is
    // bytes, not names, and diagram.png is deliberately served with a
    // changed byte so it must be uploaded afresh (the reuse evidence does
    // not exist for it).
    const diagramStored = Buffer.concat([diagramBytes, Buffer.from("x")]); // what Ghost stored differs
    ghost.publicContent = new Map([
      ["/content/images/cover.png", coverBytes],
      ["/content/images/diagram.png", diagramStored],
    ]);
    ghost.seedPost({
      id: "p1",
      uuid: "u-p1",
      slug: candidate.slug,
      title: "An older title",
      status: candidate.status,
      custom_excerpt: candidate.excerpt,
      html: `<img src="${coverUrl}"><img src="${diagramUrl}">`,
      published_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-21T10:00:00.000Z",
      authors: [],
      tags: [
        ...candidate.tags.map((name) => ({ name })),
        {
          name: identityTagName(RAW_HTML_FIXTURE.id),
          slug: identityTagSlug(RAW_HTML_FIXTURE.id),
          visibility: "internal",
          description: encodeState({
            id: RAW_HTML_FIXTURE.id,
            revision,
            candidateHash: "9".repeat(64), // a different candidate was published last: this is an update
            ghostBodyHash: null,
            ownedHash: null,
            publishedAt: "2026-09-20T10:00:00.000Z",
            status: candidate.status,
            ghostUpdatedAt: "2026-09-21T10:00:00.000Z",
          }),
        },
      ],
    });

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, articleId: RAW_HTML_FIXTURE.id });
    assert.equal(exitCode, 0, `the update must succeed: ${record.message}`);
    assert.equal(record.outcome, "updated");
    // The decision to reuse is made BEFORE uploading: the byte-identical
    // asset (cover) is never uploaded again; the changed one (diagram) is.
    const uploadedAssets = ghost.images.length;
    assert.equal(uploadedAssets, 1, "only the genuinely changed asset is uploaded; the unchanged one is reused");
    const coverStep = record.steps.filter((step) => step.name === "assets").find((step) => step.asset === "assets/cover.png");
    assert.equal(coverStep.outcome, "reused");
    assert.equal(coverStep.url, coverUrl);
    const diagramStep = record.steps.filter((step) => step.name === "assets").find((step) => step.asset === "assets/diagram.png");
    assert.equal(diagramStep.outcome, "uploaded");
    assert.ok(diagramStep.url?.startsWith(ghost.origin));
    // The post write went through with the reused URL for cover and a fresh
    // URL for diagram.
    const [post] = [...ghost.posts.values()];
    assert.ok(post.html.includes(coverUrl), "the unchanged asset keeps its live URL");
    ghost.publicContent = null;
  });

  // C10: a PUT replaces the whole tag set, so an ordinary update that sends
  // candidate tags + the identity tag alone silently deletes an unrelated
  // internal tag a human added in Ghost. Before the fix, the update below
  // left #featured-series behind on the fake's stored post — the update's
  // payload never carried it — and the third run read "changed" forever
  // because the live tag set never matched what the pipeline sent.
  test("C10: a legitimate update preserves an unrelated internal tag and stays a no-op afterwards", async () => {
    const root = fixtureRepo();
    const { candidateDir, revision } = await preparedCandidate(root);
    const candidate = JSON.parse(readFixture(path.join(candidateDir, "candidate.json"), "utf8"));
    const ghost = await fakeGhost();
    const created = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(created.exitCode, 0, `the create must succeed: ${created.record.message}`);

    // A human adds an internal tag in Ghost Admin, on the managed post.
    const [post] = [...ghost.posts.values()];
    post.tags = ghost.normalizeTags([
      ...candidate.tags.map((name) => ({ name })),
      { name: "#featured-series", visibility: "internal", description: "a human's internal tag" },
      { name: identityTagName(ARTICLE.id), slug: identityTagSlug(ARTICLE.id), visibility: "internal", description: post.tags.find((tag) => tag.name === identityTagName(ARTICLE.id))?.description ?? "" },
    ]);
    ghost.registerTags(post.tags);

    // A legitimate update: a new commit changes the article body.
    const articlePath = path.join(root, ARTICLE.path, "article.md");
    const first = readFixture(articlePath, "utf8");
    writeFileSync(articlePath, first.replace("A paragraph with", "An edited paragraph with"));
    git(root, "add", "-A");
    git(root, "commit", "-m", "edit");
    const { candidateDir: editedDir, revision: editedRevision } = await preparedCandidate(root);
    const edited = JSON.parse(readFixture(path.join(editedDir, "candidate.json"), "utf8"));
    const updated = await runInProcess({ ghost, root, candidateDir: editedDir, revision: editedRevision });
    assert.equal(updated.exitCode, 0, `the update must succeed: ${updated.record.message}`);
    assert.equal(updated.record.outcome, "updated");

    // The stored post kept the human's internal tag, the identity tag, and
    // exactly the candidate's public tags.
    const [stored] = [...ghost.posts.values()];
    const tagNames = stored.tags.map((tag) => tag.name).sort();
    assert.ok(tagNames.includes("#featured-series"), `the unrelated internal tag must survive the update: ${JSON.stringify(tagNames)}`);
    assert.ok(tagNames.includes(identityTagName(ARTICLE.id)), "the identity tag must be present");
    assert.deepEqual(tagNames.filter((name) => !name.startsWith("#")), [...edited.tags].sort());

    // The preserved internal tag must not make a no-op read as changed: a
    // repeat publish of the same edited candidate is "unchanged", and no
    // further post write is sent.
    const repeat = await runInProcess({ ghost, root, candidateDir: editedDir, revision: editedRevision });
    assert.equal(repeat.exitCode, 0, `the repeat must be a clean no-op: ${repeat.record.message}`);
    assert.equal(repeat.record.outcome, "unchanged");
    assert.equal(postMutations(ghost).length, 2, "exactly one create and one update; the repeat wrote nothing");
  });

  test("C8: a repeat update of an unchanged article is a no-op that uploads nothing", async () => {
    // The reuse decision needs a live post to compare against; on the very
    // first publish of an article there is none, so both assets upload. The
    // no-op guarantee for an unchanged article is the unchanged path, which
    // never reaches the asset step at all — a plain repeat publish sends no
    // upload whatsoever, so unbounded duplicate accumulation cannot happen.
    const root = rawHtmlFixtureRepo();
    const { candidateDir, revision } = await preparedCandidateFor(root, RAW_HTML_FIXTURE);
    const ghost = await fakeGhost();
    const first = await runInProcess({ ghost, root, candidateDir, revision, articleId: RAW_HTML_FIXTURE.id });
    assert.equal(first.exitCode, 0, `the first publish must succeed: ${first.record.message}`);
    assert.ok(ghost.images.length >= 1, "the first publish uploads its assets");
    const uploadsAfterFirst = ghost.images.length;
    const second = await runInProcess({ ghost, root, candidateDir, revision, articleId: RAW_HTML_FIXTURE.id });
    assert.equal(second.exitCode, 0);
    assert.equal(second.record.outcome, "unchanged");
    assert.equal(ghost.images.length, uploadsAfterFirst, "a repeat publish of an unchanged article uploads nothing");
    ghost.publicContent = null;
  });

  test("a lost reply after the state write did NOT apply: uncertain, the post is not re-written", async () => {
    // The state-tag write's reply is destroyed BEFORE it applies: the tag
    // keeps the provisional state, so the run reports the incomplete state.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "tag" ? { apply: false } : null) });
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 5);
    assert.equal(record.outcome, "uncertain");
    assert.equal(record.live_changed, "yes");
    assert.equal(stepOf(record, "state-write").status, "uncertain");
    assert.match(record.message, /CONFIRMED/);
    assert.match(record.message, /state-tag write was lost/);
    // The post write is exactly one mutation; nothing re-writes the post.
    const postWrites = postMutations(ghost);
    assert.equal(postWrites.length, 1);
    assert.notEqual(record.outcome, "running");

    // The recovery: the next publish of the same candidate reaches the
    // unchanged path, repairs the state alone, and no post write is sent.
    // The drop hook is scripted for the FIRST run's lost reply only; it must
    // not keep destroying the recovery's repair write, or the recovery could
    // never succeed (the same reason the sibling scenario clears its fault
    // before re-running).
    ghost.drop = null;
    const postWritesBefore = postMutations(ghost).length;
    const { exitCode: recovered, record: recoveredRecord } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(recovered, 0);
    // ORACLE CHANGE: was "unchanged". This recovery writes the state tag, so it
    // is a Ghost mutation; the outcome names it and the accounting counts it,
    // while the post-write count below still proves no post was touched.
    assert.equal(recoveredRecord.outcome, "state-repaired");
    assert.equal(stepOf(recoveredRecord, "state-repair").status, "ok");
    assert.equal(recoveredRecord.mutations.tags, "repaired");
    assert.equal(recoveredRecord.mutations.post, "none");
    assert.equal(recoveredRecord.mutations.assets_uploaded, 0);
    assert.equal(postMutations(ghost).length, postWritesBefore);
  });

  // --- C6, the two-step sequence itself: the tag-state step's own faults ---

  test("a brand-new identity tag: the tag-state step creates it, the post links it, the final state lands", async () => {
    // The create path end to end, asserting the SEQUENCE and that the tag is
    // written through the tag route (not the post payload, which real Ghost
    // ignores): the tag-state POST /tags/ happens BEFORE the post create, and
    // the final state write happens AFTER it.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 0, record.message);
    assert.equal(record.outcome, "created");
    assert.equal(stepOf(record, "tag-state").status, "ok");
    assert.equal(stepOf(record, "tag-state").tag_action, "create");

    // The tag was created through POST /tags/, not through the post write.
    const tagCreate = ghost.requests.find((request) => request.method === "POST" && request.url === "/ghost/api/admin/tags/");
    assert.ok(tagCreate, "the identity tag must be created by its own request");
    const postCreate = ghost.requests.find((request) => request.method === "POST" && request.url.startsWith("/ghost/api/admin/posts/"));
    assert.ok(postCreate, "the post write must have been sent");
    const order = ghost.requests.map((request) => `${request.method} ${request.url}`);
    const tagCreateIndex = order.findIndex((entry) => entry === "POST /ghost/api/admin/tags/");
    const postCreateIndex = order.findIndex((entry) => entry.startsWith("POST /ghost/api/admin/posts/"));
    assert.ok(tagCreateIndex < postCreateIndex, `the tag-state step must precede the post write: ${JSON.stringify(order)}`);

    // Exactly one tag exists (the post write LINKED it, never duplicated it).
    assert.equal(ghost.tags.filter((tag) => tag.slug === identityTagSlug(ARTICLE.id)).length, 1, "the post write must link the existing tag, not duplicate it");
    // The post links that same tag id.
    const [post] = [...ghost.posts.values()];
    const linked = post.tags.find((tag) => tag.name === identityTagName(ARTICLE.id));
    assert.equal(linked.id, registryTagOf(ghost, ARTICLE.id).id);

    // The final state (stored-body hash + updated_at) landed through the tag
    // route, the SECOND tag write of the run.
    const state = decodeState(registryTagOf(ghost, ARTICLE.id).description);
    assert.equal(state.candidateHash, record.candidate_hash.slice(0, 16));
    assert.ok(state.ghostBodyHash, "the final stored-body hash was written");
    assert.ok(state.ghostUpdatedAt, "the final updated_at was written");
    const tagPut = ghost.requests.filter((request) => request.method === "PUT" && request.url.startsWith("/ghost/api/admin/tags/"));
    assert.equal(tagPut.length, 1, "the final state write is the only tag PUT on the create path");
    // The post payload carried NO description on the identity tag entry.
    const payload = JSON.parse(postCreate.body).posts[0];
    const identityEntry = payload.tags.find((tag) => tag.name === identityTagName(ARTICLE.id));
    assert.equal("description" in identityEntry, false, "the post payload must not carry the tag's state");
  });

  test("an existing identity tag from a prior publish is updated to the final state on an ordinary publish", async () => {
    // The tag already existed (a prior run created it) with a COMPLETE state;
    // an ordinary update overwrites it: the tag-state step updates it to the
    // provisional state, the post write links it, and the final state lands.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const first = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(first.exitCode, 0, first.record.message);
    const tagId = registryTagOf(ghost, ARTICLE.id).id;
    const completeState = registryTagOf(ghost, ARTICLE.id).description;
    assert.ok(decodeState(completeState).ghostBodyHash, "the first publish wrote a complete state");

    // A second commit makes the next publish an update.
    const markdown = MARKDOWN.replace("The publish faults fixture", "The publish faults fixture (edited)");
    writeFileSync(path.join(root, ARTICLE.path, "article.md"), `${markdown}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-m", "edit");
    const { candidateDir: candidateDir2, revision: revision2 } = await preparedCandidate(root);

    const tagWritesBefore = tagWrites(ghost).length;
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir: candidateDir2, revision: revision2 });
    assert.equal(exitCode, 0, record.message);
    assert.equal(record.outcome, "updated");
    assert.equal(stepOf(record, "tag-state").status, "ok");
    assert.equal(stepOf(record, "tag-state").tag_action, "update", "the existing tag is updated, not re-created");
    // Two tag writes: the provisional tag-state update, then the final state.
    assert.equal(tagWrites(ghost).length - tagWritesBefore, 2, "the update path writes the tag twice (provisional, then final)");
    // The same tag id survived; no duplicate tag was minted.
    assert.equal(registryTagOf(ghost, ARTICLE.id).id, tagId, "the same identity tag id is reused");
    assert.equal(ghost.tags.filter((tag) => tag.slug === identityTagSlug(ARTICLE.id)).length, 1);
    // The tag now carries the update's final state.
    const state = decodeState(registryTagOf(ghost, ARTICLE.id).description);
    assert.equal(state.candidateHash, record.candidate_hash.slice(0, 16));
    assert.ok(state.ghostBodyHash);
    assert.notEqual(registryTagOf(ghost, ARTICLE.id).description, completeState, "the complete state was replaced by this run's");
  });

  test("the tag-state step's reply is lost AFTER applying: reconciled, the run continues to the post write", async () => {
    // (a) The tag create applies on the server, then its reply is destroyed.
    // The re-read finds the provisional state present, so the run continues.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "tag-create" ? { apply: true } : null) });
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 0, record.message);
    assert.equal(record.outcome, "created");
    assert.equal(stepOf(record, "tag-state").status, "ok");
    assert.equal(stepOf(record, "tag-state").reconciled, true, "the lost tag-state reply is reconciled as applied");
    // The run DID continue: the post write was sent.
    assert.equal(postMutations(ghost).length, 1, "the post write followed the reconciled tag-state step");
    // The tag create was sent exactly once — reconciled, never retried.
    const tagCreates = ghost.requests.filter((request) => request.method === "POST" && request.url === "/ghost/api/admin/tags/");
    assert.equal(tagCreates.length, 1, "the tag create is not retried after a lost reply");
  });

  test("the tag-state step's reply is lost WITHOUT applying: uncertain, exit 5, nothing further sent", async () => {
    // (b) The tag create's reply is destroyed BEFORE it applies: the re-read
    // finds no provisional state, so the run reports uncertain and sends
    // NOTHING further — no post write, no asset upload.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "tag-create" ? { apply: false } : null) });
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 5, `expected exit 5, got ${exitCode}: ${record.message}`);
    assert.equal(record.outcome, "uncertain");
    assert.equal(stepOf(record, "tag-state").status, "uncertain");
    assert.match(record.message, /provisional state write was sent/);
    assert.match(record.message, /did not apply/);
    // Nothing further was sent: no post write, no upload, and the tag create
    // was not retried.
    assert.equal(postMutations(ghost).length, 0, "no post write follows an unconfirmed tag-state step");
    assert.equal(uploads(ghost).length, 0, "no asset upload follows an unconfirmed tag-state step");
    const tagCreates = ghost.requests.filter((request) => request.method === "POST" && request.url === "/ghost/api/admin/tags/");
    assert.equal(tagCreates.length, 1, "the tag write is never retried (a retry could stomp a concurrent edit)");
    assert.equal(ghost.posts.size, 0);
  });

  test("a definite rejection of the tag-state step stops the run before the post write", async () => {
    // A 500 on the tag-state create changed nothing (a rejected request is not
    // applied by real Ghost), so the run stops at exit 3 with nothing further
    // sent.
    const ghost = await fakeGhost();
    ghost.faults = ({ kind }) => (kind === "tag-create" ? { status: 500, body: errorBody(500, "nope") } : null);
    const { root, candidateDir, revision } = await freshFixture();
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 3, `expected exit 3 (a rejection changed nothing), got ${exitCode}: ${record.message}`);
    assert.equal(record.outcome, "rejected");
    assert.equal(stepOf(record, "tag-state").status, "failed");
    assert.equal(postMutations(ghost).length, 0, "the post write must not follow a rejected tag-state step");
    assert.equal(uploads(ghost).length, 0);
    assert.equal(ghost.posts.size, 0);
    // The tag itself was not created (the rejection changed nothing).
    assert.equal(registryTagOf(ghost, ARTICLE.id), null, "a rejected tag create must not leave a tag behind");
  });

  test("a run that dies BETWEEN the tag-state step and the post write leaves a safe state for the next run", async () => {
    // The literal gap the two-step sequence introduces: the tag-state write
    // fully succeeded, but the post write never started (a crash, a kill).
    // The fake's state is seeded to EXACTLY that: the identity tag exists
    // with this candidate's provisional state, and NO post carries it. A
    // fresh run must proceed safely — a plain create, reusing the existing
    // tag (no duplicate), never treating the provisional tag as proof of
    // anything.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const candidate = JSON.parse(readFixture(path.join(candidateDir, "candidate.json"), "utf8"));
    // The provisional state the tag-state step would have written, then a
    // crash before the post write: seed the tag, no post.
    ghost.seedTag({
      name: identityTagName(ARTICLE.id),
      slug: identityTagSlug(ARTICLE.id),
      visibility: "internal",
      description: encodeState({
        id: ARTICLE.id,
        revision,
        candidateHash: candidate.candidateHash,
        ghostBodyHash: null,
        ownedHash: "0".repeat(16),
        publishedAt: null,
        status: candidate.status,
        ghostUpdatedAt: null,
      }),
    });
    assert.equal(ghost.posts.size, 0, "the seeded state is exactly 'tag written, no post'");

    const tagWritesBefore = tagWrites(ghost).length;
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(exitCode, 0, `the next run must proceed safely: ${record.message}`);
    assert.equal(record.outcome, "created", "with no managed post the next run is a plain create");
    // The create REUSED the existing tag: it updated it (tag_action update),
    // it did not create a duplicate.
    assert.equal(stepOf(record, "tag-state").tag_action, "update", "the pre-existing tag is reused, not duplicated");
    assert.equal(ghost.tags.filter((tag) => tag.slug === identityTagSlug(ARTICLE.id)).length, 1, "no duplicate tag");
    assert.equal(ghost.posts.size, 1, "exactly one post was created");
    const [post] = [...ghost.posts.values()];
    assert.equal(post.tags.find((tag) => tag.name === identityTagName(ARTICLE.id)).id, registryTagOf(ghost, ARTICLE.id).id);
    // The final state is complete, not provisional.
    const state = decodeState(registryTagOf(ghost, ARTICLE.id).description);
    assert.ok(state.ghostBodyHash, "the final state replaced the provisional one");
    assert.ok(state.ghostUpdatedAt);
    // Two tag writes on this run (provisional update, then final), no create.
    assert.equal(tagWrites(ghost).length - tagWritesBefore, 2);
  });

  test("a provisional tag state for this candidate is NOT sufficient proof the write completed: a live post that does not match still conflicts", async () => {
    // A tag whose description is this candidate's provisional state, but the
    // live managed post does NOT hold the candidate's content (a Ghost-side
    // edit, or a different body): the provisional tag must never be taken as
    // proof the write finished, so the ordinary conflict logic still applies.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const candidate = JSON.parse(readFixture(path.join(candidateDir, "candidate.json"), "utf8"));
    ghost.seedPost({
      id: "p1",
      uuid: "u-p1",
      slug: candidate.slug,
      title: candidate.title,
      status: candidate.status,
      custom_excerpt: candidate.excerpt,
      html: "<p>a body that is NOT the candidate's</p>",
      published_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-21T10:00:00.000Z",
      authors: [],
      tags: [
        ...candidate.tags.map((name) => ({ name })),
        {
          name: identityTagName(ARTICLE.id),
          slug: identityTagSlug(ARTICLE.id),
          visibility: "internal",
          // Provisional for THIS candidate: the pipeline's own incomplete write.
          description: encodeState({
            id: ARTICLE.id,
            revision,
            candidateHash: candidate.candidateHash,
            ghostBodyHash: null,
            ownedHash: "0".repeat(16),
            publishedAt: null,
            status: candidate.status,
            ghostUpdatedAt: null,
          }),
        },
      ],
    });

    const tagWritesBefore = tagWrites(ghost).length;
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    // The live content does not match the candidate, so this is NOT a repair:
    // the post cannot be accounted for and the conflict stands. Nothing was
    // sent, and in particular the tag was NOT clobbered.
    assert.notEqual(exitCode, 0, `expected a refusal/conflict, got ${exitCode}: ${record.message}`);
    assert.ok(["conflict", "refused"].includes(record.outcome), `expected conflict/refused, got ${record.outcome}`);
    assert.equal(tagWrites(ghost).length, tagWritesBefore, "no tag write may be sent when the decision refuses/conflicts");
    assert.equal(postMutations(ghost).length, 0, "no post write on a conflict/refusal");
  });

  test("a conflict with a COMPLETE different candidate's state is refused BEFORE any tag write is sent", async () => {
    // The identity tag already carries a complete state for a DIFFERENT
    // candidate, and the live post matches that other state, not this one:
    // the conflict is decided from the recorded state alone, so the tag-state
    // step must not run at all — zero tag writes for the whole scenario.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const candidate = JSON.parse(readFixture(path.join(candidateDir, "candidate.json"), "utf8"));
    ghost.seedPost({
      id: "p1",
      uuid: "u-p1",
      slug: candidate.slug,
      title: "A title a human set",
      status: candidate.status,
      custom_excerpt: candidate.excerpt,
      html: "<p>some other published body</p>",
      published_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-21T10:00:00.000Z",
      authors: [],
      tags: [
        ...candidate.tags.map((name) => ({ name })),
        {
          name: identityTagName(ARTICLE.id),
          slug: identityTagSlug(ARTICLE.id),
          visibility: "internal",
          // A COMPLETE state for a different candidate: ghostBodyHash and
          // ghostUpdatedAt are both set, and the updated_at does not match the
          // live post's, so this is a genuine conflict.
          description: encodeState({
            id: ARTICLE.id,
            revision,
            candidateHash: "9".repeat(64),
            ghostBodyHash: "0".repeat(16),
            ownedHash: "1".repeat(16),
            publishedAt: "2026-09-20T10:00:00.000Z",
            status: candidate.status,
            ghostUpdatedAt: "2026-09-19T10:00:00.000Z",
          }),
        },
      ],
    });

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision });
    assert.notEqual(exitCode, 0, `expected a conflict, got ${exitCode}: ${record.message}`);
    assert.equal(record.outcome, "conflict");
    assert.equal(tagWrites(ghost).length, 0, "no tag write may be sent on a conflict");
    assert.equal(postMutations(ghost).length, 0);
    assert.equal(uploads(ghost).length, 0);
  });
});

// --------------------------------------------------------------------------------------
// C6: the repair's proof is repeated against the post it actually records, and the proof
// covers every owned field the pipeline declares — including the feature image, which
// ownedFieldsMatch did not compare at all.
// --------------------------------------------------------------------------------------

describe("C6: the state repair proves the live post before certifying it", () => {
  test("the repair re-proves against the post it just re-read, and REFUSES one that changed", async () => {
    // The proof that routes a run to the repair is made against the post as it
    // was read a moment earlier (by tag, from the list route). The state the
    // repair records is derived from a SECOND read of the same post, so the same
    // proof is repeated against that fresh value. A post that changed in
    // between — a Ghost-side edit landing mid-run — must not be certified as
    // this candidate: recording it would make every later stale-revision and
    // Ghost-edit check reason from a lie. Refusing costs a re-run.
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const seeded = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(seeded.exitCode, 0, seeded.record.message);
    const postId = seeded.record.post.id;
    const post = ghost.posts.get(postId);
    const tag = post.tags.find((entry) => entry.name === identityTagName(ARTICLE.id));
    const stale = encodeState({
      id: ARTICLE.id,
      revision,
      candidateHash: "9".repeat(64),
      ghostBodyHash: "0".repeat(16),
      ownedHash: "1".repeat(16),
      publishedAt: null,
      status: "published",
      ghostUpdatedAt: post.updated_at,
    });
    tag.description = stale;

    // The post changes under the run: the repair's own re-read (the first
    // id-based read; `managed` came from the tag list route) sees a body that is
    // no longer the candidate's.
    ghost.onPostRead = (held, n) => {
      if (n === 1) held.html = `${held.html}<p>An edit that landed mid-run.</p>`;
    };

    const mutatingBefore = mutatingRequests(ghost).length;
    const uploadsBefore = uploads(ghost).length;
    const tagWritesBefore = tagWrites(ghost).length;
    // --repair-state, exactly as the sibling repair scenario: without it a
    // stale owned-field fingerprint is (correctly) a Ghost-edit conflict.
    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, repairState: true });

    assert.equal(exitCode, 2, `the repair must be REFUSED, not certified: ${record.message}`);
    assert.equal(record.outcome, "refused");
    assert.equal(record.live_changed, "no");
    assert.notEqual(record.outcome, "running");
    assert.equal(stepOf(record, "state-repair").status, "refused");
    assert.match(record.message, /REFUSED/);
    assert.match(record.message, /no longer represents this candidate/);
    // Nothing at all was written: no post write, no upload, no tag write.
    assert.equal(mutatingRequests(ghost).length, mutatingBefore, "a refused repair writes nothing");
    assert.equal(uploads(ghost).length, uploadsBefore, "a refused repair uploads nothing");
    assert.equal(tagWrites(ghost).length, tagWritesBefore, "a refused repair writes no tag");
    assert.equal(record.mutations.post, "none");
    assert.equal(record.mutations.tags, "none");
    assert.equal(record.mutations.assets_uploaded, 0);
    // The stale recorded state is still stale: the run did not paper over it.
    assert.equal(tag.description, stale, "the recorded state was left exactly as it was");
  });

  test("the owned-field proof covers the feature image, and a file name is not proof of the bytes", () => {
    // ownedFieldsMatch compared title, slug, status, excerpt, tags and authors —
    // and NOT feature_image, so a live post wearing a different feature image
    // still read as this candidate and a repair would have certified it.
    const candidate = {
      title: "T",
      slug: "s",
      status: "published",
      excerpt: null,
      tags: [],
      authors: [],
      featureImage: "assets/cover.png",
      assets: [{ ref: "assets/cover.png" }],
      bodyHtml: "<p>x</p>",
    };
    const managed = (feature_image) => ({
      title: "T",
      slug: "s",
      status: "published",
      custom_excerpt: null,
      tags: [],
      authors: [],
      feature_image,
      html: "<p>x</p>",
    });
    assert.equal(
      ownedFieldsMatch(managed("https://ghost.example.invalid/content/images/2026/10/cover.png"), {
        ...candidate, assetUrls: { "assets/cover.png": "https://ghost.example.invalid/content/images/2026/10/cover.png" },
      }),
      true,
      "a verified source-to-URL binding matches",
    );
    assert.equal(
      ownedFieldsMatch(managed("https://ghost.example.invalid/content/images/2026/10/a-different-picture.png"), candidate),
      false,
      "a different feature image does not match",
    );
    assert.equal(ownedFieldsMatch(managed(null), candidate), false, "a missing feature image does not match");
    // Two candidate refs sharing a basename: the shape resolves the stored url to
    // neither, so the proof FAILS instead of picking one. A matching file NAME is
    // a hint about which upload a src came from, never proof of the bytes.
    const ambiguous = { ...candidate, assets: [{ ref: "assets/cover.png" }, { ref: "extra/cover.png" }] };
    assert.equal(
      ownedFieldsMatch(managed("https://ghost.example.invalid/content/images/2026/10/cover.png"), ambiguous),
      false,
      "an ambiguous basename is refused, not guessed",
    );
  });
});

// --------------------------------------------------------------------------------------
// C5: the RENDERED summary, not only the record and the exit status. The workflow prints
// `cli.mjs summary --record <file>` into the job summary, so that rendering is part of the
// report an operator reads.
// --------------------------------------------------------------------------------------

describe("C5: the rendered summary tells the truth about what changed in Ghost", () => {
  /** Render a record the way the workflow's summary step does. */
  function renderRecord(record) {
    return renderSummary(record);
  }

  test("a confirmed post mutation is never summarised as nothing changed", async () => {
    const ghost = await fakeGhost();
    const recordFile = path.join(temp("article-faults-record-"), "record.json");
    const created = await runCli({ ghost, repo: state.root, candidateDir: state.candidateDir, revision: state.revision, recordFile });
    assert.equal(created.status, 0, created.stderr);
    // The CLI's own console output names the mutations by kind.
    assert.match(created.stdout, /Ghost mutations: post created/, `the run log names the post mutation:\n${created.stdout}`);
    assert.doesNotMatch(created.stdout, /Nothing to change/);

    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    const summary = renderRecord(record);
    assert.match(summary, /Ghost mutations/, "the rendered summary carries a mutations row");
    assert.match(summary, /post created/);
    assert.doesNotMatch(summary, /Nothing to change/);
    assert.match(summary, /Live site changed \| yes/);
  });

  test("a successful tag repair says a tag was written, not that nothing changed", async () => {
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const seeded = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(seeded.exitCode, 0, seeded.record.message);
    const post = ghost.posts.get(seeded.record.post.id);
    const tag = post.tags.find((entry) => entry.name === identityTagName(ARTICLE.id));
    tag.description = encodeState({
      id: ARTICLE.id,
      revision,
      candidateHash: "9".repeat(64),
      ghostBodyHash: "0".repeat(16),
      ownedHash: "1".repeat(16),
      publishedAt: null,
      status: "published",
      ghostUpdatedAt: post.updated_at,
    });

    const { exitCode, record } = await runInProcess({ ghost, root, candidateDir, revision, repairState: true });
    assert.equal(exitCode, 0, record.message);
    assert.equal(record.outcome, "state-repaired");
    assert.equal(describeMutations(record), "post none · assets none touched · tags repaired");

    const summary = renderRecord(record);
    assert.match(summary, /tags repaired/, `the summary names the tag write:\n${summary}`);
    assert.doesNotMatch(summary, /Nothing to change/, "a tag repair is a Ghost mutation, not a no-op");
    assert.match(summary, /Live site changed \| no/, "the LIVE SITE did not change — a different question, answered separately");
    assert.match(record.message, /one tag write/, "the message says what was written");
    assert.doesNotMatch(record.message, /nothing was sent that changes Ghost/);
  });

  test("a true no-op is the only path that may say nothing changed", async () => {
    const ghost = await fakeGhost();
    const { root, candidateDir, revision } = await freshFixture();
    const seeded = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(seeded.exitCode, 0, seeded.record.message);
    const repeat = await runInProcess({ ghost, root, candidateDir, revision });
    assert.equal(repeat.exitCode, 0, repeat.record.message);
    assert.equal(repeat.record.outcome, "unchanged");
    assert.equal(describeMutations(repeat.record), "post none · assets none touched · tags none");
    assert.match(renderRecord(repeat.record), /Nothing to change/);
  });
});
