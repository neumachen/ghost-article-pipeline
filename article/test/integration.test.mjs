// The article pipeline against a REAL, disposable Ghost instance: end-to-end
// verification of the guarantees unit tests with a fake Ghost cannot fully
// establish — that a candidate is bound to a revision, that the identity tag
// is the only handle on a managed post, that a rename keeps the same post,
// that Ghost-side edits and stale attempts are refused rather than
// overwritten, and that a published post is served on its public page.
//
// SKIPPED unless ARTICLE_INTEGRATION_URL names a running instance, so the
// normal `npm test` (no Ghost) skips this file and exits cleanly:
//
//   ARTICLE_INTEGRATION_URL=http://localhost:23680 npm test
//
// The instance is DISPOSABLE and local only: `mise run article:integration`
// brings the compose stack up, runs this file, and tears the stack down
// (docker compose down -v) on every exit. Nothing here touches production.
//
// Safety:
//   - The owner account is created with a throwaway generated password, and
//     the Admin API key is read into memory only. Neither is written to the
//     repository nor logged.
//   - Every CLI run gets a temp repository under os.tmpdir() and its own
//     record file; nothing under the checkout is modified.
//   - Cleanup removes the temp repositories. The Ghost posts are left in
//     place: the client has no delete, and the stack is destroyed on teardown
//     anyway (the spec allows leaving them).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { GhostClient } from "../src/ghost-client.mjs";
import { decodeState, identityTagName, identityTagSlug } from "../src/identity.mjs";

const BASE_URL = (process.env.ARTICLE_INTEGRATION_URL ?? "").trim().replace(/\/+$/, "");
const SKIP = BASE_URL ? false : "ARTICLE_INTEGRATION_URL is not set: the disposable-Ghost integration test is skipped.";

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.mjs");
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "synthetic");
const REGISTRY_SCHEMA = "neumachen-article-registry/1";
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const MAIN_ID = "synthetic-fixture";
const STALE_ID = "stale-fixture";
const BAD_ID = "bad-fixture";
const PUBLISHED_ID = "published-fixture";
const C6_ID = "c6-fixture";

const tempDirs = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

// --- a throwaway repository under os.tmpdir() -----------------------------------------

function git(root, ...args) {
  return execFileSync(
    "git",
    ["-C", root, "-c", "user.name=Article Integration", "-c", "user.email=integration@localhost.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV },
  ).trim();
}

const commitAll = (root, message) => {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

function writeRegistry(root, entries) {
  const file = path.join(root, "editorial", "articles", "registry.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: REGISTRY_SCHEMA, articles: entries }, null, 2)}\n`);
}

function articleMarkdown({ id, title, slug, status = "draft", tags = [], body }) {
  const lines = ["---", `id: ${id}`, `title: ${title}`];
  if (slug) lines.push(`slug: ${slug}`);
  lines.push(`status: ${status}`, "authors: []");
  if (tags.length) lines.push("tags:", ...tags.map((tag) => `  - ${tag}`));
  else lines.push("tags: []");
  lines.push("---", "", body, "");
  return lines.join("\n");
}

/** A simple single-article repo. */
function buildRepo({ id, markdown, copyFixture = false }) {
  const root = temp(`article-integration-${id}-`);
  const dir = path.join(root, "editorial", "articles", id);
  mkdirSync(dir, { recursive: true });
  if (copyFixture) cpSync(FIXTURE, dir, { recursive: true });
  else writeFileSync(path.join(dir, "article.md"), `${markdown}\n`);
  writeRegistry(root, [{ id, path: `editorial/articles/${id}` }]);
  git(root, "init", "--initial-branch", "main");
  commitAll(root, `add ${id}`);
  return root;
}

// --- the CLI as a child process --------------------------------------------------------

/** The child's environment: the generated key and the disposable Ghost, never production. */
function cliEnv({ url = BASE_URL, key = state.key } = {}) {
  const env = { ...process.env };
  delete env.GHOST_ADMIN_API_KEY; // no production credential can leak into this run
  env.GHOST_ADMIN_API_URL = url;
  env.GHOST_ADMIN_API_KEY = key;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function runCli(args, env = cliEnv()) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
}

/** Assert an exit code, naming the scenario and showing the child's output on failure. */
function expectExit(result, code, label) {
  const detail = `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`;
  if (result.status === null) {
    assert.fail(`${label}: the CLI was killed by ${result.signal} (expected exit ${code}).\n${detail}`);
  }
  assert.equal(result.status, code, `${label}: expected exit ${code}, got ${result.status}.\n${detail}`);
}

const recordFile = (name) => path.join(state.records, `${name}.json`);
const recordOf = (name) => JSON.parse(readFileSync(recordFile(name), "utf8"));

const publishArgs = ({ repo, candidate, articleId, revision, mode, record, repairState = false }) => [
  "publish",
  "--repo", repo,
  "--candidate", candidate,
  "--article", articleId,
  "--revision", revision,
  "--mode", mode,
  "--record", record,
  ...(repairState ? ["--repair-state"] : []),
];

const prepareArgs = ({ repo, articleId, out, revision }) => [
  "prepare",
  "--repo", repo,
  "--article", articleId,
  "--out", out,
  ...(revision ? ["--revision", revision] : []),
];

// --- the disposable Ghost, read and set up through a staff session ---------------------

const state = {};

async function staff(endpoint, init = {}, cookie) {
  return fetch(`${BASE_URL}/ghost/api/admin/${endpoint}`, {
    ...init,
    redirect: "manual",
    headers: {
      "Accept-Version": "v6.0",
      Origin: BASE_URL,
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function getSetupStatus() {
  const response = await staff("authentication/setup/");
  if (!response.ok) throw new Error(`the setup status of ${BASE_URL} could not be read: HTTP ${response.status}`);
  const body = await response.json();
  return body?.setup?.[0]?.status === true;
}

/**
 * Bootstrap the disposable Ghost: complete owner setup with a throwaway
 * generated password when the instance is fresh, sign in, create a custom
 * integration, and read its Admin API key into memory. The key never leaves
 * this process except as the GHOST_ADMIN_API_KEY of a child CLI run.
 */
async function bootstrap() {
  const alreadySetUp = await getSetupStatus();
  const envEmail = process.env.ARTICLE_INTEGRATION_OWNER_EMAIL?.trim();
  const envPassword = process.env.ARTICLE_INTEGRATION_OWNER_PASSWORD;

  let owner;
  if (envEmail && envPassword) {
    owner = { email: envEmail, password: envPassword };
  } else if (!alreadySetUp) {
    owner = {
      name: "Article Integration",
      email: `article-integration-${randomBytes(4).toString("hex")}@localhost.local`,
      password: randomBytes(24).toString("hex"),
    };
  } else {
    throw new Error(
      [
        `The Ghost at ${BASE_URL} is already set up, and ARTICLE_INTEGRATION_OWNER_EMAIL/ARTICLE_INTEGRATION_OWNER_PASSWORD are not set,`,
        "so the throwaway owner credentials cannot be used to sign in.",
        "This integration test needs a fresh instance: run `docker compose -f docker-compose.article.yml down -v` before starting it,",
        "or set ARTICLE_INTEGRATION_OWNER_EMAIL and ARTICLE_INTEGRATION_OWNER_PASSWORD for the existing instance.",
      ].join("\n"),
    );
  }

  if (!alreadySetUp) {
    const created = await staff("authentication/setup/", {
      method: "POST",
      body: JSON.stringify({ setup: [{ ...owner, blogTitle: "article integration (disposable)" }] }),
    });
    if (!created.ok) throw new Error(`owner setup on ${BASE_URL} failed: HTTP ${created.status} ${await created.text()}`);
  }

  const session = await staff("session/", { method: "POST", body: JSON.stringify({ username: owner.email, password: owner.password }) });
  if (!session.ok) {
    throw new Error(`staff sign-in on ${BASE_URL} failed: HTTP ${session.status} ${await session.text()}`);
  }
  const cookie = session.headers.getSetCookie().map((entry) => entry.split(";")[0]).join("; ");

  const integration = await staff(
    "integrations/?include=api_keys",
    { method: "POST", body: JSON.stringify({ integrations: [{ name: `article integration ${Date.now()}` }] }) },
    cookie,
  );
  if (!integration.ok) throw new Error(`integration creation on ${BASE_URL} failed: HTTP ${integration.status} ${await integration.text()}`);
  // Ghost returns the admin key's secret already as "<id>:<secret>" — the
  // string Ghost Admin shows as the Admin API key, and the form the CLI takes.
  const key = (await integration.json()).integrations[0].api_keys.find((entry) => entry.type === "admin")?.secret;
  if (!/^[0-9a-f]{24}:[0-9a-f]{64}$/i.test(key ?? "")) throw new Error("the integration's admin key has an unexpected shape");
  return key;
}

/** A port nothing listens on, for the "remote down" scenario. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Wait until the wall clock has left the second an ISO timestamp names.
 * Ghost stores a post's updated_at with SECOND granularity, and the pipeline
 * (like Ghost itself) uses updated_at as its optimistic-concurrency token, so
 * a Ghost-side edit made within the same second as the recorded one is not a
 * distinguishable edit at all. A simulated Ghost-side edit must therefore
 * land in a later second; waiting for it keeps the conflict scenario
 * deterministic instead of racing the clock.
 */
async function waitPastSecond(isoTimestamp) {
  const recordedSecond = Math.floor(Date.parse(isoTimestamp) / 1000);
  while (Math.floor(Date.now() / 1000) <= recordedSecond) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The public page, retried briefly: a freshly published post may take a moment to be served. */
async function fetchPublicEventually(url) {
  let page = await state.ghost.fetchPublic(url);
  for (let attempt = 0; attempt < 20 && page.status !== 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    page = await state.ghost.fetchPublic(url);
  }
  return page;
}

const postsFor = (id) => state.ghost.findPostsByTag(identityTagSlug(id));

describe("the article pipeline against a disposable Ghost", () => {
  before(async () => {
    if (SKIP) return;
    state.key = await bootstrap();
    const [id, secret] = state.key.split(":");
    state.ghost = new GhostClient({ origin: BASE_URL, id, secret });

    state.root = temp("article-integration-work-");
    state.records = path.join(state.root, "records");
    state.outMain = path.join(state.root, "out-main");
    state.outMain2 = path.join(state.root, "out-main-2");
    mkdirSync(state.records, { recursive: true });

    state.repo = buildRepo({ id: MAIN_ID, copyFixture: true });
    state.mainCommit1 = git(state.repo, "rev-parse", "HEAD");
    state.staleRepo = buildRepo({
      id: STALE_ID,
      markdown: articleMarkdown({ id: STALE_ID, title: "The stale fixture (v1)", slug: STALE_ID, body: "# The stale fixture\n\nVersion one." }),
    });
    state.badRepo = buildRepo({
      id: BAD_ID,
      markdown: articleMarkdown({ id: BAD_ID, title: "The bad fixture", slug: null, body: "# The bad fixture" }),
    });
    state.publishedRepo = buildRepo({
      id: PUBLISHED_ID,
      markdown: articleMarkdown({
        id: PUBLISHED_ID,
        title: "The published fixture article",
        slug: PUBLISHED_ID,
        status: "published",
        body: "# The published fixture article\n\nA paragraph the public page must serve verbatim.",
      }),
    });
  });

  after(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  test("scenario 1: validate --all exits 0", { skip: SKIP }, () => {
    const result = runCli(["validate", "--repo", state.repo, "--all"]);
    expectExit(result, 0, "scenario 1 (validate --all)");
    assert.match(result.stdout, /OK synthetic-fixture/);
  });

  test("scenario 2: prepare writes a candidate and inspect exits 0", { skip: SKIP }, () => {
    const prepared = runCli(prepareArgs({ repo: state.repo, articleId: MAIN_ID, out: state.outMain, revision: state.mainCommit1 }));
    expectExit(prepared, 0, "scenario 2 (prepare)");
    state.mainCandidate = path.join(state.outMain, MAIN_ID);
    const manifest = JSON.parse(readFileSync(path.join(state.mainCandidate, "candidate.json"), "utf8"));
    assert.equal(manifest.article.id, MAIN_ID);
    assert.equal(manifest.source.revision, state.mainCommit1);

    const inspected = runCli(["inspect", "--candidate", state.mainCandidate, "--repo", state.repo, "--article", MAIN_ID, "--revision", state.mainCommit1]);
    expectExit(inspected, 0, "scenario 2 (inspect)");
    assert.match(inspected.stdout, new RegExp(`"id":"${MAIN_ID}"`));
  });

  test("scenario 3: publish --mode plan exits 0 and sends nothing mutating", { skip: SKIP }, async () => {
    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate, articleId: MAIN_ID, revision: state.mainCommit1, mode: "plan", record: recordFile("scenario-03") }),
    );
    expectExit(result, 0, "scenario 3 (publish --mode plan)");
    const record = recordOf("scenario-03");
    assert.equal(record.outcome, "planned");
    assert.equal(record.live_changed, "no");
    // Nothing was sent: no post carries the identity tag.
    assert.equal((await postsFor(MAIN_ID)).length, 0, "a plan must not create a post");
  });

  test("scenario 4: publish creates exactly one post", { skip: SKIP }, async () => {
    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate, articleId: MAIN_ID, revision: state.mainCommit1, mode: "publish", record: recordFile("scenario-04") }),
    );
    expectExit(result, 0, "scenario 4 (publish creates)");
    const record = recordOf("scenario-04");
    assert.equal(record.outcome, "created");
    assert.equal(record.live_changed, "yes");
    const posts = await postsFor(MAIN_ID);
    assert.equal(posts.length, 1, "exactly one post must carry the identity tag");
    state.mainPostId = posts[0].id;
    assert.equal(record.post.id, state.mainPostId);
    // ORACLE CHANGE: was `assert.equal(publicCheck.status, "skipped")`. The
    // representative fixture is now `status: published`, because the fixture
    // has to travel the COMPLETE path — Markdown, render, wrap, upload, Ghost
    // save, public verification — and a draft has no public page to verify, so
    // a draft fixture could never exercise it. The draft skip is still asserted
    // where a draft actually is published: the C6 fixture, scenario 14b.
    const publicCheck = record.steps.findLast((step) => step.name === "public-check");
    assert.equal(publicCheck.status, "ok", `the published fixture's public page must verify: ${JSON.stringify(publicCheck)}`);
    assert.equal(record.mutations.post, "created", "the record names the post mutation");
    assert.equal(record.mutations.assets_uploaded, 5, "all five assets were uploaded once");
    assert.equal(record.mutations.tags, "created", "the identity tag was created");
    assert.ok(record.environment?.image, `the record carries the execution image: ${JSON.stringify(record.environment)}`);
    assert.ok(record.environment?.platform, "the record carries the execution platform");
  });

  test("scenario 5: a repeated publish is unchanged and creates no duplicate", { skip: SKIP }, async () => {
    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate, articleId: MAIN_ID, revision: state.mainCommit1, mode: "publish", record: recordFile("scenario-05") }),
    );
    expectExit(result, 0, "scenario 5 (repeat publish)");
    const record = recordOf("scenario-05");
    assert.equal(record.outcome, "unchanged");
    assert.equal(record.live_changed, "no");
    const posts = await postsFor(MAIN_ID);
    assert.equal(posts.length, 1, "a repeat publish must not create a duplicate");
    assert.equal(posts[0].id, state.mainPostId);
  });

  test("scenario 6: an edit and a directory rename update the SAME post", { skip: SKIP }, async () => {
    // Change the title and rename the article directory; the registry path
    // moves with it. Identity is the front-matter id, so the same post is
    // updated — the rename must not mint a second one.
    const oldDir = path.join(state.repo, "editorial", "articles", MAIN_ID);
    const newDir = path.join(state.repo, "editorial", "articles", "synthetic-renamed");
    renameSync(oldDir, newDir);
    writeRegistry(state.repo, [{ id: MAIN_ID, path: "editorial/articles/synthetic-renamed" }]);
    const edited = readFileSync(path.join(newDir, "article.md"), "utf8").replace(
      "title: The synthetic fixture article",
      "title: The synthetic fixture article (renamed)",
    );
    writeFileSync(path.join(newDir, "article.md"), edited);
    const commit2 = commitAll(state.repo, "rename and retitle");
    state.mainCommit2 = commit2;

    const prepared = runCli(prepareArgs({ repo: state.repo, articleId: MAIN_ID, out: state.outMain2, revision: commit2 }));
    expectExit(prepared, 0, "scenario 6 (prepare after rename)");
    state.mainCandidate2 = path.join(state.outMain2, MAIN_ID);

    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate2, articleId: MAIN_ID, revision: commit2, mode: "publish", record: recordFile("scenario-06") }),
    );
    expectExit(result, 0, "scenario 6 (publish after rename)");
    const record = recordOf("scenario-06");
    assert.equal(record.outcome, "updated");
    assert.equal(record.post.id, state.mainPostId, "the rename must update the same post, not create a new one");
    assert.equal((await postsFor(MAIN_ID)).length, 1);
    assert.equal((await state.ghost.getPost(state.mainPostId)).title, "The synthetic fixture article (renamed)");
  });

  test("scenario 7: a Ghost-side edit is a conflict, and the live title is not overwritten", { skip: SKIP }, async () => {
    const live = await state.ghost.getPost(state.mainPostId);
    // Ghost timestamps updated_at to the second; wait so this edit is a
    // genuinely LATER edit than the one the pipeline recorded, not one that
    // collapses into the same second.
    await waitPastSecond(live.updated_at);
    await state.ghost.updatePost(state.mainPostId, { title: "A Ghost-side edit", updated_at: live.updated_at });

    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate2, articleId: MAIN_ID, revision: state.mainCommit2, mode: "publish", record: recordFile("scenario-07") }),
    );
    expectExit(result, 3, "scenario 7 (conflict)");
    const record = recordOf("scenario-07");
    assert.equal(record.outcome, "conflict");
    assert.equal(record.live_changed, "no");
    assert.equal((await state.ghost.getPost(state.mainPostId)).title, "A Ghost-side edit", "the conflict must not overwrite the Ghost-side edit");
  });

  test("scenario 8: a stale attempt is refused", { skip: SKIP }, async () => {
    const first = git(state.staleRepo, "rev-parse", "HEAD");
    const staleOut1 = path.join(state.root, "stale-out-1");
    const staleOut2 = path.join(state.root, "stale-out-2");

    const preparedV1 = runCli(prepareArgs({ repo: state.staleRepo, articleId: STALE_ID, out: staleOut1, revision: first }));
    expectExit(preparedV1, 0, "scenario 8 (prepare v1)");
    const candidateV1 = path.join(staleOut1, STALE_ID);
    const publishedV1 = runCli(publishArgs({ repo: state.staleRepo, candidate: candidateV1, articleId: STALE_ID, revision: first, mode: "publish", record: recordFile("scenario-08a") }));
    expectExit(publishedV1, 0, "scenario 8 (publish v1)");
    assert.equal(recordOf("scenario-08a").outcome, "created");

    const markdown = readFileSync(path.join(state.staleRepo, "editorial", "articles", STALE_ID, "article.md"), "utf8").replace("(v1)", "(v2)");
    writeFileSync(path.join(state.staleRepo, "editorial", "articles", STALE_ID, "article.md"), markdown);
    const second = commitAll(state.staleRepo, "stale v2");

    const preparedV2 = runCli(prepareArgs({ repo: state.staleRepo, articleId: STALE_ID, out: staleOut2, revision: second }));
    expectExit(preparedV2, 0, "scenario 8 (prepare v2)");
    const candidateV2 = path.join(staleOut2, STALE_ID);
    const publishedV2 = runCli(publishArgs({ repo: state.staleRepo, candidate: candidateV2, articleId: STALE_ID, revision: second, mode: "publish", record: recordFile("scenario-08b") }));
    expectExit(publishedV2, 0, "scenario 8 (publish v2)");
    assert.equal(recordOf("scenario-08b").outcome, "updated");

    // The older revision's candidate, while the newer one is live: refused.
    const stale = runCli(publishArgs({ repo: state.staleRepo, candidate: candidateV1, articleId: STALE_ID, revision: first, mode: "publish", record: recordFile("scenario-08c") }));
    expectExit(stale, 2, "scenario 8 (stale publish)");
    const record = recordOf("scenario-08c");
    assert.equal(record.outcome, "refused");
    assert.equal(record.live_changed, "no");
    const posts = await postsFor(STALE_ID);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].title, "The stale fixture (v2)", "the stale attempt must not move the live post backwards");
  });

  test("scenario 9: a tampered candidate is refused before anything is sent", { skip: SKIP }, async () => {
    const tampered = path.join(state.root, "tampered-candidate");
    cpSync(state.mainCandidate2, tampered, { recursive: true });
    writeFileSync(path.join(tampered, "body.html"), "<p>tampered body that was never reviewed</p>\n");

    const result = runCli(
      publishArgs({ repo: state.repo, candidate: tampered, articleId: MAIN_ID, revision: state.mainCommit2, mode: "publish", record: recordFile("scenario-09") }),
    );
    expectExit(result, 2, "scenario 9 (tampered candidate)");
    const record = recordOf("scenario-09");
    assert.equal(record.outcome, "refused");
    assert.equal(record.live_changed, "no");
    assert.equal((await postsFor(MAIN_ID)).length, 1, "a tampered candidate must not create a post");
  });

  test("scenario 10: an article missing slug fails prepare and creates no post", { skip: SKIP }, async () => {
    const out = path.join(state.root, "bad-out");
    const result = runCli(prepareArgs({ repo: state.badRepo, articleId: BAD_ID, out }));
    expectExit(result, 2, "scenario 10 (missing slug)");
    assert.match(result.stderr, /slug/i);
    assert.equal((await postsFor(BAD_ID)).length, 0, "nothing may be created for an invalid article");
  });

  test("scenario 11: a wrong key is rejected and nothing changes", { skip: SKIP }, async () => {
    const before = await state.ghost.getPost(state.mainPostId);
    const wrongKey = `${"0".repeat(24)}:${"0".repeat(64)}`;
    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate2, articleId: MAIN_ID, revision: state.mainCommit2, mode: "publish", record: recordFile("scenario-11") }),
      cliEnv({ key: wrongKey }),
    );
    expectExit(result, 3, "scenario 11 (auth failure)");
    const record = recordOf("scenario-11");
    assert.equal(record.outcome, "rejected");
    assert.equal(record.live_changed, "no");
    const after = await state.ghost.getPost(state.mainPostId);
    assert.equal(after.title, before.title);
    assert.equal(after.updated_at, before.updated_at, "a rejected request must not change the post");
  });

  test("scenario 12: an unreachable remote is rejected", { skip: SKIP }, async () => {
    const port = await closedPort();
    const result = runCli(
      publishArgs({ repo: state.repo, candidate: state.mainCandidate2, articleId: MAIN_ID, revision: state.mainCommit2, mode: "publish", record: recordFile("scenario-12") }),
      cliEnv({ url: `http://localhost:${port}` }),
    );
    expectExit(result, 3, "scenario 12 (remote down)");
    const record = recordOf("scenario-12");
    assert.equal(record.outcome, "rejected");
    assert.equal(record.live_changed, "no");
  });

  test("scenario 13: a published article's public page is checked ok", { skip: SKIP }, async () => {
    const revision = git(state.publishedRepo, "rev-parse", "HEAD");
    const out = path.join(state.root, "published-out");
    const prepared = runCli(prepareArgs({ repo: state.publishedRepo, articleId: PUBLISHED_ID, out, revision }));
    expectExit(prepared, 0, "scenario 13 (prepare)");
    const candidate = path.join(out, PUBLISHED_ID);

    const result = runCli(publishArgs({ repo: state.publishedRepo, candidate, articleId: PUBLISHED_ID, revision, mode: "publish", record: recordFile("scenario-13") }));
    expectExit(result, 0, "scenario 13 (publish)");
    const record = recordOf("scenario-13");
    assert.equal(record.outcome, "created");
    assert.equal(record.status, "published");

    const publicCheck = record.steps.findLast((step) => step.name === "public-check");
    assert.equal(publicCheck.status, "ok", "the publish's own public-check must be ok");

    assert.ok(record.post?.url, "a published post has a public url");
    const page = await fetchPublicEventually(record.post.url);
    assert.equal(page.status, 200, `the public page ${record.post.url} must answer 200`);
    assert.match(page.body, /A paragraph the public page must serve verbatim/);
  });

  // C6 on the REAL target. The defect the fake masked was that the identity
  // tag's state was written by riding along inside the post payload's tags[]
  // array — which real Ghost SILENTLY IGNORES. These scenarios assert the
  // corrected two-step sequence against real Ghost: the tag is written
  // through the tag route, its description actually lands, a repeat publish
  // reuses the same tag (no duplicate, no duplicate post), and a hand-added
  // internal tag survives an update.

  test("C6 scenario 14: a create writes the identity tag's state through the tag route, not the post payload", { skip: SKIP }, async () => {
    const repo = buildRepo({
      id: C6_ID,
      markdown: articleMarkdown({ id: C6_ID, title: "The C6 fixture", slug: C6_ID, body: "# The C6 fixture\n\nA body for the tag-state assertions." }),
    });
    state.c6Repo = repo;
    state.c6Revision = git(repo, "rev-parse", "HEAD");
    const out = path.join(state.root, "c6-out");
    const prepared = runCli(prepareArgs({ repo, articleId: C6_ID, out, revision: state.c6Revision }));
    expectExit(prepared, 0, "C6 scenario 14 (prepare)");
    state.c6Candidate = path.join(out, C6_ID);

    const result = runCli(publishArgs({ repo, candidate: state.c6Candidate, articleId: C6_ID, revision: state.c6Revision, mode: "publish", record: recordFile("c6-14") }));
    expectExit(result, 0, "C6 scenario 14 (publish creates)");
    // scenario 14b: the C6 fixture is a DRAFT, and a draft has no public page,
    // so its public check is skipped rather than failed. This is the assertion
    // scenario 4 used to carry, kept where a draft actually is published.
    assert.equal(
      recordOf("c6-14").steps.findLast((step) => step.name === "public-check").status,
      "skipped",
      "a draft's public check is skipped, not failed",
    );
    const record = recordOf("c6-14");
    assert.equal(record.outcome, "created");

    // The tag-state step ran, before the post write, as its own step.
    const tagState = record.steps.findLast((step) => step.name === "tag-state");
    assert.equal(tagState?.status, "ok", "the tag-state step must have run and succeeded");
    assert.equal(tagState.tag_action, "create", "a fresh article has no tag yet, so the step creates it");

    // THE ASSERTION THE OLD DESIGN FAILED: the tag's description on real
    // Ghost actually holds the final state. With the old design (the state
    // riding in the post payload), real Ghost would have left it empty.
    const tag = await state.ghost.findTagBySlug(identityTagSlug(C6_ID));
    assert.ok(tag, "the identity tag must exist");
    const tagStateDecoded = decodeState(tag.description);
    assert.ok(tagStateDecoded, `the identity tag's description must decode to a state, got ${JSON.stringify(tag?.description)}`);
    assert.equal(tagStateDecoded.id, C6_ID);
    assert.equal(tagStateDecoded.candidateHash, record.candidate_hash.slice(0, 16), "the tag records this run's candidate");
    assert.ok(tagStateDecoded.ghostBodyHash, "the final stored-body hash landed on real Ghost");
    assert.ok(tagStateDecoded.ghostUpdatedAt, "the final updated_at landed on real Ghost");

    // Exactly one post carries the identity tag; the post links that same tag id.
    const posts = await postsFor(C6_ID);
    assert.equal(posts.length, 1);
    state.c6PostId = posts[0].id;
    const linked = (posts[0].tags ?? []).find((entry) => entry.name === identityTagName(C6_ID));
    assert.equal(linked?.id, tag.id, "the post links the SAME tag the tag-state step wrote");

    // Only one identity tag exists (the post write linked, never duplicated).
    const tags = await state.ghost.request(`tags/?filter=slug:${encodeURIComponent(identityTagSlug(C6_ID))}&limit=all`, { method: "GET" });
    assert.equal((tags?.tags ?? []).length, 1, "the post write must link the existing tag, never create a duplicate");
  });

  test("C6 scenario 15: a repeat publish reuses the tag and does not duplicate it or the post", { skip: SKIP }, async () => {
    const result = runCli(publishArgs({ repo: state.c6Repo, candidate: state.c6Candidate, articleId: C6_ID, revision: state.c6Revision, mode: "publish", record: recordFile("c6-15") }));
    expectExit(result, 0, "C6 scenario 15 (repeat)");
    const record = recordOf("c6-15");
    assert.equal(record.outcome, "unchanged");
    // The post is the same one; no duplicate.
    const posts = await postsFor(C6_ID);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, state.c6PostId);
    // Exactly one identity tag exists; the tag id is unchanged.
    const tags = await state.ghost.request(`tags/?filter=slug:${encodeURIComponent(identityTagSlug(C6_ID))}&limit=all`, { method: "GET" });
    assert.equal((tags?.tags ?? []).length, 1, "a repeat publish must not create a second identity tag");
  });

  test("C6 scenario 16: an update rewrites the SAME tag's state, and a hand-added internal tag survives", { skip: SKIP }, async () => {
    // A human adds an unrelated internal tag in Ghost Admin.
    const before = await state.ghost.getPost(state.c6PostId);
    await waitPastSecond(before.updated_at);
    const withHumanTag = await state.ghost.updatePost(state.c6PostId, {
      tags: [
        ...(before.tags ?? []).filter((entry) => entry.name !== "#featured-series").map((entry) => ({ name: entry.name, slug: entry.slug, visibility: entry.visibility })),
        { name: "#featured-series", visibility: "internal" },
      ],
      updated_at: before.updated_at,
    });
    const humanTagId = (withHumanTag.tags ?? []).find((entry) => entry.name === "#featured-series")?.id;
    assert.ok(humanTagId, "the human's internal tag must be attached");

    // A new commit changes the body: the next publish is an update.
    const articlePath = path.join(state.c6Repo, "editorial", "articles", C6_ID, "article.md");
    writeFileSync(articlePath, readFileSync(articlePath, "utf8").replace("A body for the tag-state", "An edited body for the tag-state"));
    const commit2 = commitAll(state.c6Repo, "c6 edit");
    const out2 = path.join(state.root, "c6-out-2");
    const prepared = runCli(prepareArgs({ repo: state.c6Repo, articleId: C6_ID, out: out2, revision: commit2 }));
    expectExit(prepared, 0, "C6 scenario 16 (prepare)");
    const candidate2 = path.join(out2, C6_ID);

    // Wait past the recorded second so the update's post write is a genuine
    // later write (the recorded updated_at is the optimistic-concurrency
    // token; the tag-state step itself does not move the post's updated_at).
    const live = await state.ghost.getPost(state.c6PostId);
    await waitPastSecond(live.updated_at);

    const result = runCli(publishArgs({ repo: state.c6Repo, candidate: candidate2, articleId: C6_ID, revision: commit2, mode: "publish", record: recordFile("c6-16") }));
    expectExit(result, 0, `C6 scenario 16 (update): ${result.stdout}${result.stderr}`);
    const record = recordOf("c6-16");
    assert.equal(record.outcome, "updated");
    assert.equal(record.post.id, state.c6PostId, "the update must target the same post");
    assert.equal(record.steps.findLast((step) => step.name === "tag-state")?.tag_action, "update", "the existing tag is updated, not re-created");

    // The update rewrote the SAME tag's state through the tag route.
    const tag = await state.ghost.findTagBySlug(identityTagSlug(C6_ID));
    const tagStateDecoded = decodeState(tag.description);
    assert.equal(tagStateDecoded.candidateHash, record.candidate_hash.slice(0, 16), "the tag records the update's candidate");
    assert.ok(tagStateDecoded.ghostBodyHash);

    // The human's internal tag survived the update (a PUT replaces the whole
    // tag set, so the pipeline must send it back — fact 4), and the identity
    // tag is still the same one.
    const after = await state.ghost.getPost(state.c6PostId);
    const names = (after.tags ?? []).map((entry) => entry.name);
    assert.ok(names.includes("#featured-series"), `the human's internal tag must survive: ${JSON.stringify(names)}`);
    assert.equal((after.tags ?? []).find((entry) => entry.name === identityTagName(C6_ID))?.id, tag.id);
    const tags = await state.ghost.request(`tags/?filter=slug:${encodeURIComponent(identityTagSlug(C6_ID))}&limit=all`, { method: "GET" });
    assert.equal((tags?.tags ?? []).length, 1, "no duplicate identity tag after an update");

    // A repeat publish of the same (edited) candidate is a clean no-op: the
    // preserved internal tag does not make it read as changed forever.
    const repeat = runCli(publishArgs({ repo: state.c6Repo, candidate: candidate2, articleId: C6_ID, revision: commit2, mode: "publish", record: recordFile("c6-16b") }));
    expectExit(repeat, 0, "C6 scenario 16 (repeat after update)");
    assert.equal(recordOf("c6-16b").outcome, "unchanged");
  });
  // ------------------------------------------------------------------------------------
  // C2: ONE small representative fixture, through the COMPLETE path — Markdown, render,
  // wrap, upload, Ghost save, public verification — asserting what Ghost actually stored
  // and what the public page actually serves. Every construct below was observed to be
  // lost or reflowed by Ghost 6.64.0 when sent unwrapped; the evidence is in the
  // assertions, not in a comment.
  // ------------------------------------------------------------------------------------

  /** The representative fixture committed under its own id, so a scenario owns its post. */
  function buildFixtureRepo(id) {
    const root = buildRepo({ id, copyFixture: true });
    const file = path.join(root, "editorial", "articles", id, "article.md");
    const text = readFileSync(file, "utf8").replace(/^id: .*$/m, `id: ${id}`).replace(/^slug: .*$/m, `slug: ${id}`);
    writeFileSync(file, text);
    writeRegistry(root, [{ id, path: `editorial/articles/${id}` }]);
    return { root, revision: commitAll(root, `re-id the representative fixture as ${id}`) };
  }

  /** Prepare a candidate at a revision and publish it, returning the record. */
  function prepareAndPublish({ root, revision, id, label, out, mode = "publish", repairState = false, expect = 0 }) {
    const outDir = out ?? path.join(state.root, `out-${label}`);
    const prepared = runCli(prepareArgs({ repo: root, articleId: id, out: outDir, revision }));
    expectExit(prepared, 0, `${label} (prepare)`);
    const result = runCli(
      publishArgs({ repo: root, candidate: path.join(outDir, id), articleId: id, revision, mode, record: recordFile(label), repairState }),
    );
    expectExit(result, expect, `${label} (publish): ${result.stdout}${result.stderr}`);
    return recordOf(label);
  }

  test("C2 scenario 18: the representative fixture survives the full path into Ghost and onto the public page", { skip: SKIP }, async () => {
    const id = "c2-fixture";
    const { root, revision } = buildFixtureRepo(id);
    const record = prepareAndPublish({ root, revision, id, label: "c2-18" });
    assert.equal(record.outcome, "created");

    const post = await state.ghost.getPost(record.post.id);
    const html = post.html;
    const verification = runCli(["verify", "--candidate", path.join(state.root, "out-c2-18", id), "--article", id, "--repo", root]);
    expectExit(verification, 0, "standalone verify of the rich article with assets");
    const page = await fetchPublicEventually(post.url);
    assert.equal(page.status, 200, "the published fixture has a public page");

    // A LINKED image. Ghost drops an <img> inside an <a> outright — observed:
    // the stored body comes back as an empty <a href="..."></a> — so the
    // pipeline wraps that paragraph in Ghost's own kg-card html markers and the
    // link keeps its image.
    assert.match(html, /<a href="https:\/\/example\.invalid\/linked-target"><img src="[^"]+" alt="The linked image's alt text"><\/a>/);
    assert.ok(page.body.includes('alt="The linked image\'s alt text"'), "the linked image reaches the public page");

    // An INLINE image with text around it. Ghost lifts the image out and stores
    // one paragraph as paragraph / kg-image-card / paragraph, breaking the
    // sentence; wrapped, it stays the one paragraph the author wrote.
    assert.match(html, /<p>Text before the inline image <img src="[^"]+" alt="inline"> and text after it\.<\/p>/);
    assert.ok(!/<p>Text before the inline image<\/p>/.test(html), "the paragraph was not split in three");

    // Formatting Ghost drops on its own: <del>, and an <a>'s title attribute.
    assert.match(html, /<del>struck through<\/del>/);
    assert.match(html, /title="The title attribute"/);

    // Non-ASCII text and typographic punctuation, on BOTH sides. The public
    // response used to be decoded as latin1, which turns "café" into "cafÃ©"
    // and made any non-ASCII article fail its own public check.
    for (const needle of ["café", "Zürich", "—", "–", "“double curly quotes”", "…"]) {
      assert.ok(html.includes(needle), `the stored body carries ${JSON.stringify(needle)}`);
      assert.ok(page.body.includes(needle), `the public page carries ${JSON.stringify(needle)}`);
    }
    assert.ok(!page.body.includes("cafÃ©"), "the public response is decoded as UTF-8, not latin1");

    // A CODE EXAMPLE stays literal. It is documentation, not an asset: it keeps
    // its relative path, was never uploaded, and was never rewritten to a url.
    assert.ok(html.includes('&lt;img src="assets/inside-code.png"'), "the fenced example stays literal");
    assert.ok(html.includes('&lt;img src="assets/in-inline-code.png"&gt;'), "the inline example stays literal");
    assert.ok(!/src="https?:[^"]*inside-code\.png"/.test(html), "no code example became a live url");
    assert.ok(!/src="https?:[^"]*in-inline-code\.png"/.test(html), "no inline-code example became a live url");

    // Every REAL asset was uploaded and rewritten to a Ghost url, including the
    // unquoted source form, which must stay valid markup after rewriting.
    for (const name of ["linked.png", "inline.png", "unquoted.png", "diagram.png"]) {
      assert.ok(!new RegExp(`src=["']?assets/${name.replace(".", "\\.")}`).test(html), `${name} was rewritten to a Ghost url`);
    }
    assert.match(html, /<img src="[^"]*\/unquoted(?:-\d+)?\.png" alt="unquoted">/, "Ghost normalizes quoting and preserves the unquoted source's image");
    assert.match(html, /<img src="[^"]*\/unquoted(?:-\d+)?\.png" alt="single quoted">/, "Ghost normalizes quoting and preserves the single-quoted source's image");

    // The feature image is bound into the candidate and uploaded like any other.
    assert.match(post.feature_image ?? "", /\/cover(?:-\d+)?\.png$/, `the feature image is a Ghost url: ${post.feature_image}`);
  });

  // ------------------------------------------------------------------------------------
  // C8: asset reuse, demonstrated against disposable Ghost and read off the record's
  // mutation accounting — which counts what was actually uploaded, not what was asked for.
  // ------------------------------------------------------------------------------------

  test("C8 scenario 19: an update whose assets are unchanged uploads nothing and reuses all of them", { skip: SKIP }, async () => {
    const id = "c8-fixture";
    const { root, revision } = buildFixtureRepo(id);
    state.c8 = { root, id };
    const created = prepareAndPublish({ root, revision, id, label: "c8-19a" });
    assert.equal(created.mutations.assets_uploaded, 5, "the create uploaded all five assets");
    assert.equal(created.mutations.assets_reused, 0);
    state.c8.postId = created.post.id;
    state.c8.revision1 = revision;

    // Change the TITLE only: an update is needed, so the asset step runs, and
    // every asset is unchanged. Reuse must be decided by the bytes Ghost holds,
    // not by a file name or a url prefix.
    const file = path.join(root, "editorial", "articles", id, "article.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^title: .*$/m, "title: The representative fixture article (retitled)"));
    const revision2 = commitAll(root, "retitle, leaving every asset alone");
    const updated = prepareAndPublish({ root, revision: revision2, id, label: "c8-19b" });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.mutations.post, "updated");
    assert.equal(updated.mutations.assets_uploaded, 0, "an unchanged asset is not uploaded again");
    assert.equal(updated.mutations.assets_reused, 5, "all five were reused");
    assert.equal(updated.post.id, state.c8.postId, "the same post was updated");
    state.c8.revision2 = revision2;
  });

  test("C8 scenario 20: changing one asset uploads only that one", { skip: SKIP }, async () => {
    const { root, id, postId } = state.c8;
    const assets = path.join(root, "editorial", "articles", id, "assets");
    // Different bytes under the SAME file name: reuse must not be inferred from
    // the name. linked.png's bytes are a valid, different image.
    writeFileSync(path.join(assets, "diagram.png"), Buffer.concat([readFileSync(path.join(assets, "linked.png")), Buffer.from("changed-fixture")]));
    const before = await state.ghost.getPost(postId);
    const revision = commitAll(root, "replace diagram.png's bytes, keeping its name");
    const updated = prepareAndPublish({ root, revision, id, label: "c8-20" });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.mutations.assets_uploaded, 1, "only the changed asset was uploaded");
    assert.equal(updated.mutations.assets_reused, 4, "the other four were reused");
    const after = await state.ghost.getPost(updated.post.id);
    assert.equal(after.id, postId);
    const srcOf = (html, name) => new RegExp(`src="([^"]+/${name.replace(".png", "(?:-\\d+)?.png")})"`).exec(html)?.[1];
    assert.notEqual(srcOf(after.html, "diagram.png"), srcOf(before.html, "diagram.png"), "the changed asset now points at a different stored file");
    assert.equal(srcOf(after.html, "inline.png"), srcOf(before.html, "inline.png"), "an unchanged asset keeps its stored url");
    state.c8.revision3 = revision;
  });

  test("C8 scenario 21: the feature image follows the same rules", { skip: SKIP }, async () => {
    const { root, id, postId } = state.c8;
    const assets = path.join(root, "editorial", "articles", id, "assets");
    // Same name, different bytes, for the FEATURE image this time.
    writeFileSync(path.join(assets, "cover.png"), Buffer.concat([readFileSync(path.join(assets, "inline.png")), Buffer.from("changed-cover-fixture")]));
    const before = await state.ghost.getPost(postId);
    const revision = commitAll(root, "replace cover.png's bytes, keeping its name");
    const updated = prepareAndPublish({ root, revision, id, label: "c8-21" });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.mutations.assets_uploaded, 1, "only the changed feature image was uploaded");
    const after = await state.ghost.getPost(updated.post.id);
    assert.notEqual(after.feature_image, before.feature_image, "a changed feature image is a different stored file");
    assert.match(after.feature_image ?? "", /\/cover(?:-\d+)?\.png$/);
    state.c8.revision4 = revision;
  });

  test("C8 scenario 22: an unchanged candidate repeated is a no-op that touches nothing", { skip: SKIP }, async () => {
    const { root, id, revision4 } = state.c8;
    const repeat = prepareAndPublish({ root, revision: revision4, id, label: "c8-22" });
    assert.equal(repeat.outcome, "unchanged");
    assert.equal(repeat.live_changed, "no");
    assert.equal(repeat.mutations.post, "none");
    assert.equal(repeat.mutations.assets_uploaded, 0);
    assert.equal(repeat.mutations.assets_reused, 0, "the no-op path never reaches the asset step");
    assert.equal(repeat.mutations.tags, "none");
  });

  // ------------------------------------------------------------------------------------
  // C13: exactly two recovery procedures. Neither uses a force option and neither invents
  // a state hash by hand. A discard-live-edit operation is deliberately NOT implemented.
  // ------------------------------------------------------------------------------------

  test("C13 scenario 23: earlier content is restored through a NEW DESCENDANT revision, with stale protection still active", { skip: SKIP }, async () => {
    const id = "c13-restore";
    const { root } = buildFixtureRepo(id);
    const file = path.join(root, "editorial", "articles", id, "article.md");

    const bodyV1 = readFileSync(file, "utf8");
    const revisionA = git(root, "rev-parse", "HEAD");
    const createdA = prepareAndPublish({ root, revision: revisionA, id, label: "c13-23a" });
    assert.equal(createdA.outcome, "created");
    const postId = createdA.post.id;

    // Version two, published over version one.
    writeFileSync(file, bodyV1.replace(/^title: .*$/m, "title: The representative fixture article (version two)"));
    const revisionB = commitAll(root, "version two");
    const updatedB = prepareAndPublish({ root, revision: revisionB, id, label: "c13-23b" });
    assert.equal(updatedB.outcome, "updated");
    assert.equal(updatedB.post.id, postId, "version two updated the same post");
    assert.match((await state.ghost.getPost(postId)).title, /version two/);

    // RESTORE version one's content in a NEW commit that DESCENDS from version
    // two. This is the supported way back: the earlier content arrives as a
    // later revision, so stale-revision protection has nothing to object to.
    writeFileSync(file, bodyV1);
    const revisionC = commitAll(root, "restore version one's content in a new descendant revision");
    assert.equal(git(root, "merge-base", "--is-ancestor", revisionB, revisionC) === "", true, "C descends from B");
    const restoredC = prepareAndPublish({ root, revision: revisionC, id, label: "c13-23c" });
    assert.equal(restoredC.outcome, "updated");
    assert.equal(restoredC.post.id, postId, "the restore updated the SAME post — identity is the tag, not the directory or the slug");
    const restored = await state.ghost.getPost(postId);
    assert.doesNotMatch(restored.title, /version two/, "version one's title is back");
    assert.equal(restoredC.live_changed, "yes");

    // Stale protection is STILL active: publishing the older revision B
    // directly, now that C is recorded, is refused — not silently applied.
    const staleOut = path.join(state.root, "out-c13-23-stale");
    const stalePrepare = runCli(prepareArgs({ repo: root, articleId: id, out: staleOut, revision: revisionB }));
    expectExit(stalePrepare, 0, "C13 scenario 23 (prepare the older revision)");
    const stale = runCli(
      publishArgs({ repo: root, candidate: path.join(staleOut, id), articleId: id, revision: revisionB, mode: "publish", record: recordFile("c13-23-stale") }),
    );
    expectExit(stale, 2, "C13 scenario 23 (the older revision is refused)");
    const staleRecord = recordOf("c13-23-stale");
    assert.equal(staleRecord.outcome, "refused");
    assert.equal(staleRecord.live_changed, "no");
    assert.equal(staleRecord.mutations.post, "none", "a refused stale publish writes nothing");
    assert.equal((await state.ghost.getPost(postId)).id, postId);
    assert.doesNotMatch((await state.ghost.getPost(postId)).title, /version two/, "the refused stale publish did not restore version two");
  });

  test("C13 scenario 24: a Ghost-side edit is incorporated into Git, and the state is reconciled only after the proof", { skip: SKIP }, async () => {
    const id = "c13-reconcile";
    const { root, revision } = buildFixtureRepo(id);
    const created = prepareAndPublish({ root, revision, id, label: "c13-24a" });
    assert.equal(created.outcome, "created");
    const postId = created.post.id;
    const file = path.join(root, "editorial", "articles", id, "article.md");

    // Someone edits the post in Ghost. updated_at has SECOND granularity and is
    // the optimistic-concurrency token, so the edit must land in a later second
    // to be a distinguishable edit at all.
    const live = await state.ghost.getPost(postId);
    await waitPastSecond(live.updated_at);
    await state.ghost.updatePost(postId, { title: "A title an editor changed in Ghost", updated_at: live.updated_at });

    // A plain publish now REFUSES: Ghost holds an edit this pipeline did not
    // make, and overwriting it would destroy someone's work.
    const conflict = prepareAndPublish({ root, revision, id, label: "c13-24b", out: path.join(state.root, "out-c13-24b"), expect: 3 });
    assert.equal(conflict.outcome, "conflict");
    assert.equal(conflict.live_changed, "no");
    assert.equal((await state.ghost.getPost(postId)).title, "A title an editor changed in Ghost", "the conflict did not overwrite the edit");

    // INCORPORATE the edit into Git: the editor's title becomes the source of
    // truth again, in a new descendant revision.
    writeFileSync(file, readFileSync(file, "utf8").replace(/^title: .*$/m, "title: A title an editor changed in Ghost"));
    const revision2 = commitAll(root, "incorporate the Ghost-side title edit");

    // RECONCILE the recorded state. The candidate now describes exactly what
    // Ghost holds, so the run proves that and writes the state tag — and only
    // the state tag. No post write, no asset upload.
    const planned = prepareAndPublish({ root, revision: revision2, id, label: "c13-24-plan", repairState: true, mode: "plan" });
    assert.equal(planned.outcome, "planned");
    assert.equal(planned.mutations.tags, "none");
    const reconciled = prepareAndPublish({ root, revision: revision2, id, label: "c13-24c", repairState: true });
    assert.equal(reconciled.outcome, "state-repaired", `the reconciliation records the state: ${reconciled.message}`);
    assert.equal(reconciled.exit_code, 0);
    assert.equal(reconciled.live_changed, "no", "reconciling state does not change the live site");
    assert.equal(reconciled.mutations.post, "none", "no post write");
    assert.equal(reconciled.mutations.assets_uploaded, 0, "no asset upload");
    assert.equal(reconciled.mutations.tags, "repaired", "one tag write, accounted as such");
    assert.equal(reconciled.post.id, postId);
    assert.equal((await state.ghost.getPost(postId)).title, "A title an editor changed in Ghost", "the editor's title survived");

    // And the reconciliation is durable: a plain publish at the same revision is
    // now a clean no-op rather than a conflict forever.
    const after = prepareAndPublish({ root, revision: revision2, id, label: "c13-24d", out: path.join(state.root, "out-c13-24d") });
    assert.equal(after.outcome, "unchanged", `the reconciled state makes a repeat a no-op: ${after.message}`);
    assert.equal(after.mutations.post, "none");
    state.c13 = { root, id, postId, revision2 };
  });

  test("C13 scenario 25: reconciling against a live post that does NOT match is refused", { skip: SKIP }, async () => {
    const { root, id, postId } = state.c13;
    // A Ghost-side edit the operator has NOT incorporated: the live post no
    // longer represents any committed candidate.
    const live = await state.ghost.getPost(postId);
    await waitPastSecond(live.updated_at);
    await state.ghost.updatePost(postId, { title: "An edit nobody committed", updated_at: live.updated_at });

    // Reconciling the LAST KNOWN GOOD revision must refuse rather than certify a
    // post that is not the candidate. Certifying it would make every later
    // stale-revision and Ghost-edit check reason from a lie.
    const refused = prepareAndPublish({
      root,
      revision: state.c13.revision2,
      id,
      label: "c13-25",
      out: path.join(state.root, "out-c13-25"),
      repairState: true,
      expect: 2,
    });
    assert.equal(refused.outcome, "refused", `a mismatched live post is not reconciled: ${refused.message}`);
    assert.equal(refused.live_changed, "no");
    assert.equal(refused.mutations.post, "none");
    assert.equal(refused.mutations.tags, "none", "a refused reconciliation writes no tag");
    assert.equal((await state.ghost.getPost(postId)).title, "An edit nobody committed", "the uncommitted edit was not overwritten");
  });

});
