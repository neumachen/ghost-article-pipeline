// publish.mjs: reconciliation after a lost reply. When the create/update
// request's reply is lost (UncertainError), runPublish reads the live state
// back and establishes the outcome from it instead of leaving it unknown.
//
// The fake Ghost (test/fake-ghost.mjs) is scripted to apply the write and then
// destroy the socket, so the client raises UncertainError with the change
// already on the server — exactly the case reconciliation exists for.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { buildCandidate, writeCandidate } from "../src/candidate.mjs";
import { readArticleAtCommit, resolveCommit } from "../src/git-source.mjs";
import { runPublish } from "../src/publish.mjs";
import { GhostClient } from "../src/ghost-client.mjs";
import { decodeState, encodeState, identityTagName, identityTagSlug } from "../src/identity.mjs";
import { FakeGhost, KEY_ID, KEY_SECRET } from "./fake-ghost.mjs";

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.mjs");

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();

const ARTICLE = { id: "reconcile-fixture", path: "editorial/articles/reconcile-fixture" };
const MARKDOWN = [
  "---",
  "id: reconcile-fixture",
  "title: The reconciliation fixture",
  "slug: reconcile-fixture",
  "status: published",
  "authors: []",
  "excerpt: A fixture for the lost-reply reconciliation.",
  "tags:",
  "  - Tools",
  "---",
  "",
  "# The reconciliation fixture",
  "",
  "A paragraph with a [link](https://example.invalid/post).",
  "",
  "## A heading",
  "",
  "```js",
  "const reconciled = true;",
  "```",
  "",
].join("\n");

const cleanups = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (cleanups.length) cleanups.pop()();
});

const ghosts = [];
async function fakeGhost(options) {
  const ghost = await new FakeGhost(options).listen();
  ghosts.push(ghost);
  return ghost;
}
after(async () => {
  while (ghosts.length) await ghosts.pop().close();
});

/** A throwaway repo with the fixture article at one commit. */
function fixtureRepo() {
  const root = temp("article-reconcile-");
  git(root, "init", "--initial-branch", "main");
  mkdirSync(path.join(root, ARTICLE.path), { recursive: true });
  writeFileSync(path.join(root, ARTICLE.path, "article.md"), `${MARKDOWN}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-m", "article");
  return root;
}

/** Build and write a candidate for the fixture, returning its directory and candidate. */
async function preparedCandidate(root) {
  const revision = resolveCommit(root, "HEAD");
  const files = readArticleAtCommit(root, revision, ARTICLE.path);
  const candidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision, files, kind: "commit" });
  const outDir = temp("article-reconcile-out-");
  await writeCandidate(outDir, candidate, new Map());
  return { candidateDir: outDir, candidate, revision };
}

/** Run runPublish against the fake Ghost, silencing the log streams. */
async function publish({ root, candidateDir, articleId, revision, ghost, mode = "publish" }) {
  const recordPath = path.join(temp("article-reconcile-record-"), "record.json");
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
    });
  } finally {
    console.error = originalError;
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  return { ...result, record, errors };
}

const stepOf = (record, name) => record.steps.findLast((step) => step.name === name) ?? null;

describe("runPublish reconciliation after a lost reply", () => {
  test("drop-after-apply on create: outcome created, exit 0, reconciled, exactly one post", async () => {
    const root = fixtureRepo();
    const { candidateDir, candidate, revision } = await preparedCandidate(root);
    // The create applies, then the reply is destroyed: the client raises
    // UncertainError, but the post is on the server.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "create" ? { apply: true } : null) });

    const { exitCode, record } = await publish({ root, candidateDir, articleId: ARTICLE.id, revision, ghost });

    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "created");
    assert.equal(record.live_changed, "yes");
    const step = stepOf(record, "create");
    assert.equal(step.status, "ok");
    assert.equal(step.reconciled, true);
    // The reconciliation read is recorded too, and found exactly one post.
    const reconcile = stepOf(record, "reconcile");
    assert.equal(reconcile.status, "ok");
    // No duplicate was created: the run found the applied write, it did not
    // create a second post to "make sure".
    assert.equal(ghost.posts.size, 1);
    const [post] = [...ghost.posts.values()];
    assert.equal(post.slug, candidate.slug);
    assert.ok((post.tags ?? []).some((tag) => tag.slug === identityTagSlug(ARTICLE.id)));
    // The message says the outcome was established after a lost reply.
    assert.match(record.message, /reply to the write was lost/i);
    assert.match(record.message, /found and verified/i);
    assert.match(record.message, /reconciled/i);
    // verify-saved and state-write ran, as on the normal path.
    assert.equal(stepOf(record, "verify-saved").status, "ok");
    assert.equal(stepOf(record, "state-write").status, "ok");
    assert.equal(stepOf(record, "public-check").status, "ok");
  });

  test("drop-after-apply on update: outcome updated, exit 0, reconciled, same post", async () => {
    const root = fixtureRepo();
    const { candidateDir, candidate, revision } = await preparedCandidate(root);
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "update" ? { apply: true } : null) });
    // A managed post that carries the identity tag and readable state, behind
    // the candidate on its recorded candidate hash: decide() returns "update".
    ghost.seedPost({
      id: "p1",
      uuid: "u-p1",
      slug: candidate.slug,
      title: "An older title",
      status: candidate.status,
      custom_excerpt: candidate.excerpt,
      html: "<p>the previously stored body</p>",
      published_at: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-21T10:00:00.000Z",
      authors: [],
      tags: [
        ...candidate.tags.map((name) => ({ name })),
        {
          name: identityTagName(ARTICLE.id),
          slug: identityTagSlug(ARTICLE.id),
          visibility: "internal",
          description: encodeState({
            id: ARTICLE.id,
            revision,
            candidateHash: "9".repeat(64), // a different candidate was published last
            ghostBodyHash: null,
            ownedHash: null,
            publishedAt: "2026-09-20T10:00:00.000Z",
            status: candidate.status,
            ghostUpdatedAt: "2026-09-21T10:00:00.000Z",
          }),
        },
      ],
    });

    const { exitCode, record } = await publish({ root, candidateDir, articleId: ARTICLE.id, revision, ghost });

    assert.equal(exitCode, 0);
    assert.equal(record.outcome, "updated");
    assert.equal(record.live_changed, "yes");
    const step = stepOf(record, "update");
    assert.equal(step.status, "ok");
    assert.equal(step.reconciled, true);
    assert.equal(step.post_id, "p1");
    assert.equal(ghost.posts.size, 1);
    assert.equal(ghost.posts.get("p1").title, candidate.title);
    assert.match(record.message, /Updated post/);
    assert.match(record.message, /reconciled/i);
  });

  test("a write that dropped and did NOT apply: outcome uncertain, exit 5, no post", async () => {
    const root = fixtureRepo();
    const { candidateDir, revision } = await preparedCandidate(root);
    // The reply is destroyed BEFORE the write is applied: the create never
    // happened, and the read-back finds no post carrying the identity tag.
    const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "create" ? { apply: false } : null) });

    const { exitCode, record } = await publish({ root, candidateDir, articleId: ARTICLE.id, revision, ghost });

    assert.equal(exitCode, 5);
    assert.equal(record.outcome, "uncertain");
    assert.equal(record.live_changed, "unknown");
    // The failed write is recorded uncertain; the read-back says it did not apply.
    assert.equal(stepOf(record, "create").status, "uncertain");
    assert.equal(stepOf(record, "reconcile").status, "uncertain");
    assert.match(record.message, /NOT found after the failed reply/i);
    // Nothing was created: reconciliation never creates a second post.
    assert.equal(ghost.posts.size, 0);
  });

  test("a drop where the found post does not match the candidate: uncertain, exit 5", async () => {
    const root = fixtureRepo();
    const { candidateDir, revision } = await preparedCandidate(root);
    // The write applied, but the stored post is not what the candidate asked
    // for (a Ghost-side edit landed between apply and read-back). The outcome
    // is not established, and the post is not re-written.
    const ghost = await fakeGhost({
      drop: ({ kind }) =>
        kind === "create"
          ? { apply: true, mutate: (post) => { post.title = "A different title entirely"; } }
          : null,
    });

    const { exitCode, record } = await publish({ root, candidateDir, articleId: ARTICLE.id, revision, ghost });

    assert.equal(exitCode, 5);
    assert.equal(record.outcome, "uncertain");
    assert.equal(record.live_changed, "unknown");
    assert.equal(stepOf(record, "create").status, "uncertain");
    assert.equal(stepOf(record, "reconcile").status, "uncertain");
    assert.match(record.message, /does not match the candidate/i);
    assert.equal(ghost.posts.size, 1);
    // The mismatching post was left alone: no second write.
    assert.equal(ghost.posts.get([...ghost.posts.keys()][0]).title, "A different title entirely");
  });
});

// C2: a lost reply to an UPDATE whose write did NOT apply must not be
// confirmed as applied. The old body is what stays live, and it differs from
// the new candidate ONLY in one of the six ways below — each of which the
// old marker-containment proof could not see (a deletion, a reorder, a
// duplicate) or which visible text alone cannot express (a changed href, a
// dropped emphasis). The strict outline proof must find the difference, so
// the run reports uncertain (exit 5), does NOT advance the identity tag, and
// sends exactly the one post write whose reply was lost.
const C2_VARIANTS = [
  {
    name: "(1) two paragraphs swapped",
    first: "# The fixture\n\nParagraph A.\n\nParagraph B.\n",
    second: "# The fixture\n\nParagraph B.\n\nParagraph A.\n",
  },
  {
    name: "(2) a paragraph deleted (the old body is a superset)",
    first: "# The fixture\n\nParagraph A.\n\nParagraph B.\n\nParagraph C.\n",
    second: "# The fixture\n\nParagraph A.\n\nParagraph C.\n",
  },
  {
    name: "(3) a paragraph the old body had duplicated now appears once",
    first: "# The fixture\n\nParagraph A.\n\nParagraph A.\n\nParagraph B.\n",
    second: "# The fixture\n\nParagraph A.\n\nParagraph B.\n",
  },
  {
    name: "(4) one link href changed",
    first: "# The fixture\n\nA paragraph with a [link](https://old.invalid/post).\n",
    second: "# The fixture\n\nA paragraph with a [link](https://new.invalid/post).\n",
  },
  {
    name: "(5) inline emphasis removed from one phrase",
    first: "# The fixture\n\nA paragraph with *emphasis* here.\n",
    second: "# The fixture\n\nA paragraph with emphasis here.\n",
  },
  {
    name: "(6) a heading level changed",
    first: "# The fixture\n\n## A section\n\nA paragraph.\n",
    second: "# The fixture\n\n### A section\n\nA paragraph.\n",
  },
];

/** A throwaway repo whose fixture article has two commits: the first is the published body, the second the update. */
function twoCommitRepo({ first, second }) {
  const root = temp("article-reconcile-c2-");
  git(root, "init", "--initial-branch", "main");
  mkdirSync(path.join(root, ARTICLE.path), { recursive: true });
  const frontMatter = [
    "---",
    `id: ${ARTICLE.id}`,
    "title: The reconciliation fixture",
    `slug: ${ARTICLE.id}`,
    "status: published",
    "authors: []",
    "excerpt: A fixture for the lost-reply reconciliation.",
    "tags:",
    "  - Tools",
    "---",
    "",
  ].join("\n");
  const articlePath = path.join(root, ARTICLE.path, "article.md");
  writeFileSync(articlePath, `${frontMatter}${first}`);
  git(root, "add", "-A");
  git(root, "commit", "-m", "first");
  writeFileSync(articlePath, `${frontMatter}${second}`);
  git(root, "add", "-A");
  git(root, "commit", "-m", "second");
  return root;
}

/** The identity tag of the single managed post, or undefined. */
const identityTagOf = (ghost) => {
  const [post] = [...ghost.posts.values()];
  return post?.tags?.find((tag) => tag.name === identityTagName(ARTICLE.id));
};

const postWrites = (ghost) =>
  ghost.requests.filter((request) => ["POST", "PUT"].includes(request.method) && request.url.startsWith("/ghost/api/admin/posts/"));
const tagWrites = (ghost) =>
  ghost.requests.filter((request) => request.method === "PUT" && request.url.startsWith("/ghost/api/admin/tags/"));

/** Run the publish CLI as a child process (the fake is in-process: spawnSync would deadlock). */
function runCli({ ghost, repo, candidateDir, revision, mode = "publish", repairState = false, recordFile }) {
  const args = ["publish", "--repo", repo, "--candidate", candidateDir, "--article", ARTICLE.id, "--revision", revision, "--mode", mode, "--record", recordFile];
  if (repairState) args.push("--repair-state");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        GHOST_ADMIN_API_URL: ghost.origin,
        GHOST_ADMIN_API_KEY: `${KEY_ID}:${KEY_SECRET}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
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

/**
 * Publish the FIRST commit cleanly (so the live post is the previous
 * article), then run the SECOND commit's update with its reply lost and NOT
 * applied. Returns everything the assertions need.
 */
async function lostUpdateWithoutApplying({ first, second, viaCli = false }) {
  const root = twoCommitRepo({ first, second });
  const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "update" ? { apply: false } : null) });
  const firstRevision = git(root, "rev-parse", "HEAD~1");
  const secondRevision = git(root, "rev-parse", "HEAD");

  // 1. The first commit published cleanly: the live post is the previous article.
  const firstFiles = readArticleAtCommit(root, firstRevision, ARTICLE.path);
  const firstCandidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: firstRevision, files: firstFiles, kind: "commit" });
  const firstDir = temp("article-reconcile-c2-out-");
  await writeCandidate(firstDir, firstCandidate, new Map());
  const created = await publish({ root, candidateDir: firstDir, articleId: ARTICLE.id, revision: firstRevision, ghost });
  assert.equal(created.exitCode, 0, `the first publish must succeed: ${created.record.message}`);
  assert.equal(created.record.outcome, "created");
  const tagBefore = identityTagOf(ghost);
  const descriptionBefore = tagBefore?.description;
  const htmlBefore = [...ghost.posts.values()][0].html;

  // 2. The second commit's update: the reply is lost and the write did NOT apply.
  const secondFiles = readArticleAtCommit(root, secondRevision, ARTICLE.path);
  const secondCandidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: secondRevision, files: secondFiles, kind: "commit" });
  const secondDir = temp("article-reconcile-c2-out-");
  await writeCandidate(secondDir, secondCandidate, new Map());

  const writesBefore = postWrites(ghost).length;
  const tagWritesBefore = tagWrites(ghost).length;

  let exitCode;
  let record;
  if (viaCli) {
    const recordFile = path.join(temp("article-reconcile-c2-record-"), "record.json");
    const result = await runCli({ ghost, repo: root, candidateDir: secondDir, revision: secondRevision, recordFile });
    exitCode = result.status;
    record = JSON.parse(readFileSync(recordFile, "utf8"));
  } else {
    ({ exitCode, record } = await publish({ root, candidateDir: secondDir, articleId: ARTICLE.id, revision: secondRevision, ghost }));
  }

  return {
    root,
    ghost,
    exitCode,
    record,
    secondDir,
    secondRevision,
    secondCandidateHash16: secondCandidate.candidateHash.slice(0, 16),
    descriptionBefore,
    htmlBefore,
    postWritesDuringRun: postWrites(ghost).length - writesBefore,
    tagWritesDuringRun: tagWrites(ghost).length - tagWritesBefore,
  };
}

describe("C2: reconciliation distinguishes the intended article from the previous one", () => {
  for (const variant of C2_VARIANTS) {
    test(`an UPDATE whose reply is lost WITHOUT applying (${variant.name}): uncertain, exit 5, state not advanced`, async () => {
      const result = await lostUpdateWithoutApplying({ first: variant.first, second: variant.second });

      assert.equal(result.exitCode, 5, `expected exit 5, got ${result.exitCode}: ${result.record.message}`);
      assert.equal(result.record.outcome, "uncertain");
      assert.notEqual(result.record.live_changed, "yes");
      // The recorded state was NOT advanced to the new candidate. Under the
      // two-step sequence the tag-state step writes a PROVISIONAL state for
      // the new candidate BEFORE the post write (its description is no longer
      // "exactly what it was before"), so the real invariant is stronger and
      // more precise: the tag must NOT carry the new candidate's FINAL state
      // (a stored-body hash and a new updated_at). It carries only the
      // provisional state (ghostBodyHash and ghostUpdatedAt still null), which
      // is genuine evidence of a started-but-unfinished write, never proof it
      // completed.
      const tagState = decodeState(identityTagOf(result.ghost)?.description);
      assert.equal(tagState.pending.candidateHash, result.secondCandidateHash16, "the attempted candidate is pending");
      assert.notEqual(tagState.candidateHash, result.secondCandidateHash16, "the confirmed candidate was not advanced");
      assert.ok(tagState.ghostBodyHash, "the previous confirmed body hash survives the interruption");
      assert.ok(tagState.ghostUpdatedAt, "the previous confirmed timestamp survives the interruption");
      // Exactly one post write was received during the run — the lost one.
      assert.equal(result.postWritesDuringRun, 1, "exactly the one lost post write");
      // The tag-state step wrote the provisional state, but the FINAL state
      // write (finishWrite's state-write, after the post write) never ran: the
      // run stopped at the lost post write. The single tag write is the
      // provisional one.
      assert.equal(result.tagWritesDuringRun, 1, "exactly the one provisional tag-state PUT, and no final state write");
      // The write did not apply: the live body is still the previous article's.
      const [post] = [...result.ghost.posts.values()];
      assert.equal(post.html, result.htmlBefore, "the live body is unchanged (the lost write did not apply)");
    });
  }

  test("(1) two paragraphs swapped, driven through the CLI: exit 5, one post write, no tag write", async () => {
    const result = await lostUpdateWithoutApplying({
      first: C2_VARIANTS[0].first,
      second: C2_VARIANTS[0].second,
      viaCli: true,
    });
    assert.equal(result.exitCode, 5, `expected exit 5, got ${result.exitCode}`);
    assert.equal(result.record.outcome, "uncertain");
    assert.notEqual(result.record.live_changed, "yes");
    // Same corrected oracle as the in-process variants: the tag carries the
    // PROVISIONAL state for this run's candidate (never the final state), and
    // the only tag write is that provisional one.
    const tagState = decodeState(identityTagOf(result.ghost)?.description);
    assert.equal(tagState.pending.candidateHash, result.secondCandidateHash16);
    assert.equal(tagState.candidateHash, decodeState(result.descriptionBefore).candidateHash);
    assert.equal(tagState.ghostBodyHash, decodeState(result.descriptionBefore).ghostBodyHash);
    assert.equal(tagState.ghostUpdatedAt, decodeState(result.descriptionBefore).ghostUpdatedAt);
    assert.equal(result.postWritesDuringRun, 1);
    assert.equal(result.tagWritesDuringRun, 1);
  });

  // The APPLIED counterpart: when the update DID apply, reconciliation finds
  // the candidate and confirms it — so the same six differences are what make
  // the not-applied case distinguishable, not an accident of the setup.
  for (const index of [0, 3]) {
    const variant = C2_VARIANTS[index];
    test(`an UPDATE whose reply is lost AFTER applying (${variant.name}): exit 0, updated, reconciled, state advanced`, async () => {
      const root = twoCommitRepo({ first: variant.first, second: variant.second });
      const ghost = await fakeGhost({ drop: ({ kind }) => (kind === "update" ? { apply: true } : null) });
      const firstRevision = git(root, "rev-parse", "HEAD~1");
      const secondRevision = git(root, "rev-parse", "HEAD");

      const firstFiles = readArticleAtCommit(root, firstRevision, ARTICLE.path);
      const firstCandidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: firstRevision, files: firstFiles, kind: "commit" });
      const firstDir = temp("article-reconcile-c2-out-");
      await writeCandidate(firstDir, firstCandidate, new Map());
      const created = await publish({ root, candidateDir: firstDir, articleId: ARTICLE.id, revision: firstRevision, ghost });
      assert.equal(created.exitCode, 0, created.record.message);
      const descriptionBefore = identityTagOf(ghost)?.description;

      const secondFiles = readArticleAtCommit(root, secondRevision, ARTICLE.path);
      const secondCandidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: secondRevision, files: secondFiles, kind: "commit" });
      const secondDir = temp("article-reconcile-c2-out-");
      await writeCandidate(secondDir, secondCandidate, new Map());

      const { exitCode, record } = await publish({ root, candidateDir: secondDir, articleId: ARTICLE.id, revision: secondRevision, ghost });
      assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${record.message}`);
      assert.equal(record.outcome, "updated");
      assert.equal(stepOf(record, "update").reconciled, true);
      // The state was advanced: the tag now records this run's candidate.
      assert.notEqual(identityTagOf(ghost)?.description, descriptionBefore);
      assert.ok(identityTagOf(ghost)?.description?.includes(secondCandidate.candidateHash.slice(0, 16)), identityTagOf(ghost)?.description);
    });
  }
});
