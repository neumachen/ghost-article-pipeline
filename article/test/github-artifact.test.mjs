// github-artifact.mjs: candidate-artifact provenance, against an in-process
// fake GitHub REST API modelled on tools/test/helpers.mjs's fakeGitHub(). The
// provenance checks are the mirror of tools/release-artifact.mjs's established
// theme-package checks; these tests hold this side to the same standard.
//
// Everything here is local: a fake GitHub on 127.0.0.1, throwaway git
// repositories and candidate archives under the system temporary directory.
// Nothing reads real credentials or contacts a real site.
//
// The acceptance matrix is the defect C1's fix: only a candidate demonstrably
// produced by the trusted validation path (Article CI) for the requested
// revision may be selected, and every other producer — another workflow, a
// pull request, another branch, a fork, a different head SHA, a run still in
// progress or failed, an expired or absent or tampered artifact, ambiguity —
// is refused (exit 2) before anything mutating could happen.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  CI_WORKFLOW_FILE,
  CANDIDATE_ARTIFACT_PREFIX,
  ciRunProblem,
  fetchCandidateArtifact,
  requireArtifact,
  requireSucceeded,
  selectCandidateArtifact,
} from "../src/github-artifact.mjs";
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const cleanups = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (cleanups.length) cleanups.pop()();
});

// --- a minimal, dependency-free ZIP writer ---------------------------------------

/**
 * Assemble a stored (uncompressed) ZIP archive from {name, data, crc} entries:
 * local file headers, then the central directory, then its end record. Only
 * what unzip — and GitHub's own artifact zips — need to read it back.
 */
function zipArchive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.name;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01, the ZIP epoch)
    localHeader.writeUInt32LE(entry.crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length
    local.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: stored
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(0, 38); // external attributes
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    central.push(centralHeader, name);

    offset += 30 + name.length + entry.data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8); // entries this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...local, ...central, end]);
}

// --- the fake GitHub REST API ----------------------------------------------------

/**
 * The Actions endpoints the provenance checks read, plus the pre-signed
 * storage URL artifact downloads redirect to, modelled on tools/test/helpers.mjs.
 * `mutations` records any non-GET request: the checks never make one, so an
 * empty list after every scenario is part of the assertion.
 */
async function fakeGitHub({ repository = "neumachen/neumachen.dev", token = "test-token" } = {}) {
  const state = {
    repository,
    workflows: {
      "article-ci.yml": { id: 2001, path: ".github/workflows/article-ci.yml" },
      "theme-ci.yml": { id: 1001, path: ".github/workflows/theme-ci.yml" },
    },
    runs: [],
    artifacts: [],
    mutations: [],
  };
  let base;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    state.mutations.push({ method: req.method, path: url.pathname });
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    };

    const blob = /^\/storage\/(\d+)$/.exec(url.pathname);
    if (blob) {
      const artifact = state.artifacts.find((a) => String(a.id) === blob[1]);
      if (!artifact) return send(404, { message: "gone" });
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(artifact.served ?? artifact.bytes);
    }

    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    const prefix = `/repos/${repository}/actions`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: "Not Found" });
    const route = url.pathname.slice(prefix.length);

    const artifactJson = (a) => {
      const run = state.runs.find((r) => r.id === a.run_id);
      return {
        id: a.id,
        name: a.name,
        size_in_bytes: (a.served ?? a.bytes).length,
        expired: a.expired ?? false,
        digest: a.digest ?? `sha256:${sha256(a.bytes)}`,
        workflow_run: { id: a.run_id, head_sha: run?.head_sha, head_branch: run?.head_branch },
      };
    };

    let match;
    if ((match = /^\/workflows\/([^/]+)$/.exec(route))) {
      const workflow = state.workflows[match[1]];
      return workflow ? send(200, workflow) : send(404, { message: "Not Found" });
    }
    if ((match = /^\/workflows\/(\d+)\/runs$/.exec(route))) {
      const q = url.searchParams;
      const runs = state.runs.filter(
        (r) =>
          r.workflow_id === Number(match[1]) &&
          (!q.get("head_sha") || r.head_sha === q.get("head_sha")) &&
          (!q.get("event") || r.event === q.get("event")) &&
          (!q.get("branch") || r.head_branch === q.get("branch")),
      );
      return send(200, { total_count: runs.length, workflow_runs: runs });
    }
    if ((match = /^\/runs\/(\d+)$/.exec(route))) {
      const run = state.runs.find((r) => r.id === Number(match[1]));
      return run ? send(200, run) : send(404, { message: "Not Found" });
    }
    if ((match = /^\/runs\/(\d+)\/artifacts$/.exec(route))) {
      const name = url.searchParams.get("name");
      const artifacts = state.artifacts
        .filter((a) => a.run_id === Number(match[1]) && (!name || a.name === name))
        .map(artifactJson);
      return send(200, { total_count: artifacts.length, artifacts });
    }
    if ((match = /^\/artifacts\/(\d+)$/.exec(route))) {
      const artifact = state.artifacts.find((a) => a.id === Number(match[1]));
      return artifact ? send(200, artifactJson(artifact)) : send(404, { message: "Not Found" });
    }
    if ((match = /^\/artifacts\/(\d+)\/zip$/.exec(route))) {
      const artifact = state.artifacts.find((a) => a.id === Number(match[1]));
      if (!artifact) return send(404, { message: "Not Found" });
      return send(302, {}, { location: `${base}/storage/${artifact.id}?sig=signed` });
    }
    return send(404, { message: "Not Found" });
  });

  const listen = () =>
    new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await listen();
  base = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(() =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  );

  let nextId = 5000;
  const addRun = (fields) => {
    const run = {
      id: nextId++,
      workflow_id: state.workflows[CI_WORKFLOW_FILE].id,
      event: "push",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/${repository}/actions/runs/fake`,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      ...fields,
    };
    state.runs.push(run);
    return run;
  };
  const addArtifact = (fields) => {
    const artifact = { id: nextId++, ...fields };
    state.artifacts.push(artifact);
    return artifact;
  };
  return { url: base, state, addRun, addArtifact, token };
}

// --- fixtures ----------------------------------------------------------------

/** A fake candidate archive: a directory tree zipped flat-ish, as prepare writes. */
function candidateZip(files) {
  // Written as a ZIP with Node's own zlib, not the zip binary: the pinned
  // base image ships unzip but not zip, and the test must run in the
  // container. Entries are stored uncompressed with a correct CRC-32 —
  // unzip, GitHub's artifact records and this suite all read that fine.
  const dir = temp("candidate-zip-");
  const entries = Object.entries(files).map(([name, content]) => {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    const data = Buffer.from(content, "utf8");
    return { name: Buffer.from(name, "utf8"), data, crc: crc32(data) };
  });
  return { bytes: zipArchive(entries), dir };
}

/** The canonical happy-path fixture: repo with commits A→B, Article CI runs and artifacts for each. */
async function happyFixture() {
  const api = await fakeGitHub();
  const root = temp("article-provenance-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(path.join(root, "editorial/articles/demo"), { recursive: true });
  writeFileSync(path.join(root, "editorial/articles/registry.json"), '{"articles":[]}\n');
  writeFileSync(path.join(root, "editorial/articles/demo/article.md"), "# v1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "A");
  const A = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "editorial/articles/demo/article.md"), "# v2\n");
  git(root, "commit", "-q", "-am", "B");
  const B = git(root, "rev-parse", "HEAD");
  const { bytes: bytesA } = candidateZip({ "demo/candidate.json": '{"article":"demo"}\n', "demo/body.html": "<p>v1</p>\n" });
  const { bytes: bytesB } = candidateZip({ "demo/candidate.json": '{"article":"demo"}\n', "demo/body.html": "<p>v2</p>\n" });
  const runA = api.addRun({ head_sha: A });
  const runB = api.addRun({ head_sha: B });
  api.addArtifact({ run_id: runA.id, name: `${CANDIDATE_ARTIFACT_PREFIX}${A}`, bytes: bytesA });
  api.addArtifact({ run_id: runB.id, name: `${CANDIDATE_ARTIFACT_PREFIX}${B}`, bytes: bytesB });
  return { api, root, A, B };
}

const envFor = (api, commit) => ({
  GITHUB_TOKEN: api.token,
  GITHUB_REPOSITORY: api.state.repository,
  GITHUB_API_URL: api.url,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "irrelevant-here",
  CANDIDATE_COMMIT: commit,
});

/** Run select and return { ok, result, refusal } without throwing. */
async function trySelect(api, root, commit, outDir) {
  try {
    const result = await selectCandidateArtifact({ env: envFor(api, commit), repoRoot: root, outDir });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof RefusedError) return { ok: false, refusal: error.message };
    throw error;
  }
}

/** Assert a refusal, its message matching a regex, and no mutating request made. */
async function assertRefused(api, root, commit, outDir, pattern) {
  const outcome = await trySelect(api, root, commit, outDir);
  assert.equal(outcome.ok, false, "expected a refusal");
  assert.match(outcome.refusal, pattern);
  assert.equal(
    api.state.mutations.filter((r) => r.method !== "GET").length,
    0,
    "a refusal must not make any mutating request",
  );
}

// --- acceptance matrix ------------------------------------------------------------

describe("selectCandidateArtifact provenance", () => {
  test("accepts the correct artifact from a successful Article CI push run on main for the requested SHA", async () => {
    const { api, root, A } = await happyFixture();
    const outDir = path.join(temp("out-"), "candidates");
    const result = await selectCandidateArtifact({ env: envFor(api, A), repoRoot: root, outDir });
    assert.equal(result.commit, A);
    assert.match(result.ci_run_id, /^[0-9]+$/);
    assert.match(result.artifact_id, /^[0-9]+$/);
    assert.match(result.artifact_digest, /^sha256:[0-9a-f]{64}$/);
    // The extracted candidate is on disk for the inspect step.
    assert.ok(existsSync(path.join(outDir, "demo/candidate.json")));
    assert.equal(
      api.state.mutations.filter((r) => r.method !== "GET").length,
      0,
      "a successful select makes no mutating request",
    );
  });

  test("refuses a same-named artifact produced by a different workflow: never seen by select", async () => {
    const { api, root, A } = await happyFixture();
    // A theme-ci run for the same SHA with the same artifact name. Select
    // lists runs scoped to the Article CI workflow only, so a run of another
    // workflow never appears in its listing: it cannot be picked, whatever
    // its artifact is named or how new it is.
    const otherRun = api.addRun({ workflow_id: 1001, head_sha: A });
    api.addArtifact({ run_id: otherRun.id, name: `${CANDIDATE_ARTIFACT_PREFIX}${A}`, bytes: Buffer.from("theme-flavored") });
    const outDir = path.join(temp("out-"), "candidates");
    const outcome = await trySelect(api, root, A, outDir);
    // Selecting A still picks the Article CI run's artifact, not the newer
    // theme-run one, and never trusts the other workflow's artifact by name.
    assert.equal(outcome.ok, true);
    const artifactRun = api.state.runs.find((r) => String(r.id) === outcome.result.ci_run_id);
    assert.equal(artifactRun.workflow_id, api.state.workflows[CI_WORKFLOW_FILE].id);
  });

  test("refuses a pull_request event run", async () => {
    const { api, root, A } = await happyFixture();
    // Recreate the scenario with the run marked pull_request: the listing
    // filter excludes it, so selection finds nothing.
    api.state.runs.find((r) => r.head_sha === A).event = "pull_request";
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /no run for a push/);
  });

  test("refuses a run from a branch other than main", async () => {
    const { api, root, A } = await happyFixture();
    api.state.runs.find((r) => r.head_sha === A).head_branch = "feature";
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /no run for a push/);
  });

  test("refuses a run from a different (fork) repository", async () => {
    const { api, root, A } = await happyFixture();
    api.state.runs.find((r) => r.head_sha === A).head_repository = { full_name: "someone/fork" };
    // The run-level filter excludes it: select finds no qualifying run at
    // all rather than guessing at a fork-origin one. (fetch names the same
    // defect "did not run on <repo>'s own main" through ciRunProblem.)
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /no run for a push/);
  });

  test("refuses when the run's head_sha is a different revision", async () => {
    const { api, root, A, B } = await happyFixture();
    // The artifact for A is attached to a run whose head is B: name matches,
    // digest is self-consistent, but the run checked a different commit.
    api.state.runs.find((r) => r.head_sha === A).head_sha = B;
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /no run for a push/);
  });

  test("refuses a run that is still in progress", async () => {
    const { api, root, A } = await happyFixture();
    api.state.runs.find((r) => r.head_sha === A).status = "in_progress";
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /has not finished/);
  });

  test("refuses a run that concluded failure", async () => {
    const { api, root, A } = await happyFixture();
    api.state.runs.find((r) => r.head_sha === A).conclusion = "failure";
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /concluded "failure", not success/);
  });

  test("refuses an expired artifact", async () => {
    const { api, root, A } = await happyFixture();
    const artifact = api.state.artifacts.find((a) => a.name === `${CANDIDATE_ARTIFACT_PREFIX}${A}`);
    artifact.expired = true;
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /has expired/);
  });

  test("refuses an absent artifact", async () => {
    const { api, root, A } = await happyFixture();
    // Delete the artifact, keep the run: no artifact for the (sole, good) run.
    api.state.artifacts.length = 0;
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /holds no artifact named/);
  });

  test("refuses several qualifying runs", async () => {
    const { api, root, A } = await happyFixture();
    api.addRun({ head_sha: A });
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /refusing to guess which one to trust/);
  });

  test("refuses a download whose digest does not match what GitHub recorded", async () => {
    const { api, root, A } = await happyFixture();
    const artifact = api.state.artifacts.find((a) => a.name === `${CANDIDATE_ARTIFACT_PREFIX}${A}`);
    artifact.served = Buffer.from("tampered-bytes");
    await assertRefused(api, root, A, path.join(temp("out-"), "candidates"), /downloaded as sha256:/);
  });

  test("refuses a commit that is not on main", async () => {
    const { api, root } = await happyFixture();
    const offMain = git(root, "rev-parse", "HEAD");
    // Build a commit on a side branch: present in the object store but not an
    // ancestor of main's head.
    git(root, "checkout", "-q", "-b", "side");
    writeFileSync(path.join(root, "editorial/articles/demo/article.md"), "# side\n");
    git(root, "commit", "-q", "-am", "side");
    const side = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    // Even a perfectly good-looking run+artifact for the side commit.
    const sideRun = api.addRun({ head_sha: side, head_branch: "side" });
    api.addArtifact({ run_id: sideRun.id, name: `${CANDIDATE_ARTIFACT_PREFIX}${side}`, bytes: Buffer.from("side") });
    await assertRefused(api, root, side, path.join(temp("out-"), "candidates"), /is not on main/);
    assert.notEqual(offMain, side);
  });

  test("refuses a non-main ref (GITHUB_REF) outright", async () => {
    const { api, root, A } = await happyFixture();
    const env = { ...envFor(api, A), GITHUB_REF: "refs/heads/feature" };
    await assert.rejects(
      () => selectCandidateArtifact({ env, repoRoot: root, outDir: path.join(temp("out-"), "candidates") }),
      (error) => error instanceof RefusedError && /runs only from main/.test(error.message),
    );
  });
});

describe("fetchCandidateArtifact re-verification", () => {
  test("fetches by id and re-checks the same digest", async () => {
    const { api, root, A } = await happyFixture();
    const outDir = path.join(temp("out-"), "fetch");
    const selected = await selectCandidateArtifact({ env: envFor(api, A), repoRoot: root, outDir });
    const fetched = await fetchCandidateArtifact({
      env: {
        ...envFor(api, A),
        CANDIDATE_ARTIFACT_ID: selected.artifact_id,
        CANDIDATE_ARTIFACT_DIGEST: selected.artifact_digest,
      },
      outDir,
    });
    assert.equal(fetched.artifact_id, selected.artifact_id);
    assert.equal(fetched.artifact_digest, selected.artifact_digest);
  });

  test("refuses when the artifact was replaced between the jobs (digest changed)", async () => {
    const { api, root, A } = await happyFixture();
    const outDir = path.join(temp("out-"), "fetch");
    const selected = await selectCandidateArtifact({ env: envFor(api, A), repoRoot: root, outDir });
    // A re-run replaced the artifact: same id is now a different digest.
    const artifact = api.state.artifacts.find((a) => String(a.id) === selected.artifact_id);
    artifact.bytes = Buffer.from("replaced-by-a-rerun");
    delete artifact.served;
    artifact.digest = `sha256:${sha256(artifact.bytes)}`;
    await assert.rejects(
      () =>
        fetchCandidateArtifact({
          env: {
            ...envFor(api, A),
            CANDIDATE_ARTIFACT_ID: selected.artifact_id,
            CANDIDATE_ARTIFACT_DIGEST: selected.artifact_digest,
          },
          outDir,
        }),
      (error) => error instanceof RefusedError && /select verified/.test(error.message),
    );
  });

  test("refuses an artifact whose producing run checked a different commit (by re-read)", async () => {
    const { api, root, A, B } = await happyFixture();
    const outDir = path.join(temp("out-"), "fetch");
    const selected = await selectCandidateArtifact({ env: envFor(api, A), repoRoot: root, outDir });
    // Fetch re-reads the producing run and re-checks ciRunProblem: the
    // artifact was produced for A, but the fetch is asked for commit B, so
    // the run's head does not qualify for that commit.
    await assert.rejects(
      () =>
        fetchCandidateArtifact({
          env: {
            ...envFor(api, B),
            CANDIDATE_ARTIFACT_ID: selected.artifact_id,
            CANDIDATE_ARTIFACT_DIGEST: selected.artifact_digest,
          },
          outDir,
        }),
      (error) => error instanceof RefusedError && /checked .* not |was built for/.test(error.message),
    );
    assert.notEqual(A, B);
  });

  test("refuses a fetched artifact produced by a different workflow, by id", async () => {
    const { api, root, A } = await happyFixture();
    const outDir = path.join(temp("out-"), "fetch");
    // A same-named artifact on a theme-ci run for the same commit: select
    // would never list it, but fetch is by id — an id handed to it must
    // still re-qualify through the Article CI workflow's own checks.
    const otherRun = api.addRun({ workflow_id: 1001, head_sha: A });
    const other = api.addArtifact({ run_id: otherRun.id, name: `${CANDIDATE_ARTIFACT_PREFIX}${A}`, bytes: Buffer.from("theme-flavored") });
    await assert.rejects(
      () =>
        fetchCandidateArtifact({
          env: {
            ...envFor(api, A),
            CANDIDATE_ARTIFACT_ID: String(other.id),
            CANDIDATE_ARTIFACT_DIGEST: `sha256:${sha256(Buffer.from("theme-flavored"))}`,
          },
          outDir,
        }),
      (error) => error instanceof RefusedError && /not an Article CI run/.test(error.message),
    );
  });
});

describe("provenance helpers", () => {
  const workflow = { id: 2001 };
  const repository = "neumachen/neumachen.dev";

  test("ciRunProblem names each disqualifying field", () => {
    const base = { id: 1, workflow_id: 2001, head_sha: "a".repeat(40), event: "push", head_branch: "main", repository: { full_name: repository }, head_repository: { full_name: repository } };
    assert.equal(ciRunProblem(base, workflow, base.head_sha, repository), null);
    assert.match(ciRunProblem({ ...base, workflow_id: 1001 }, workflow, base.head_sha, repository), /not an Article CI run/);
    assert.match(ciRunProblem({ ...base, event: "pull_request" }, workflow, base.head_sha, repository), /not a push/);
    assert.match(ciRunProblem({ ...base, head_branch: "feature" }, workflow, base.head_sha, repository), /not main/);
    assert.match(ciRunProblem({ ...base, head_repository: { full_name: "someone/fork" } }, workflow, base.head_sha, repository), /own main/);
  });

  test("requireSucceeded refuses in-progress and failed runs", () => {
    const commit = "a".repeat(40);
    assert.throws(() => requireSucceeded({ id: 9, status: "in_progress", conclusion: null }, commit), (e) => e instanceof RefusedError && /has not finished/.test(e.message));
    assert.throws(() => requireSucceeded({ id: 9, status: "completed", conclusion: "failure" }, commit), (e) => e instanceof RefusedError && /not success/.test(e.message));
    requireSucceeded({ id: 9, status: "completed", conclusion: "success" }, commit);
  });

  test("requireArtifact refuses expired, wrong-run, wrong-head, wrong-name, no-digest, and implausible size", () => {
    const commit = "b".repeat(40);
    const good = { id: 7, name: `article-candidates-${commit}`, expired: false, workflow_run: { id: 5, head_sha: commit }, size_in_bytes: 100, digest: `sha256:${"c".repeat(64)}` };
    requireArtifact(good, { runId: 5, commit, name: good.name });
    assert.throws(() => requireArtifact({ ...good, name: "other" }, { runId: 5, commit, name: good.name }), /is "other"/);
    assert.throws(() => requireArtifact({ ...good, expired: true }, { runId: 5, commit, name: good.name }), /has expired/);
    assert.throws(() => requireArtifact({ ...good, workflow_run: { id: 6, head_sha: commit } }, { runId: 5, commit, name: good.name }), /belongs to run/);
    assert.throws(() => requireArtifact({ ...good, workflow_run: { id: 5, head_sha: "c".repeat(40) } }, { runId: 5, commit, name: good.name }), /was built for/);
    assert.throws(() => requireArtifact({ ...good, size_in_bytes: 0 }, { runId: 5, commit, name: good.name }), /implausible size/);
    assert.throws(() => requireArtifact({ ...good, digest: "md5:x" }, { runId: 5, commit, name: good.name }), /no SHA-256 digest/);
  });
});
