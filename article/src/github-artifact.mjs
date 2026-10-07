// The GitHub side of the article pipeline: establish where a candidate
// artifact came from before publication trusts it. The mirror of
// tools/release-artifact.mjs's established, reviewed provenance checks, which
// it follows closely:
//
//   select  Article publish, select job: find the candidate artifact for a
//           commit and verify it end to end.
//   fetch   Article publish, publish job: fetch the artifact select verified,
//           by its id, and re-verify it before use.
//
// It talks only to the GitHub REST API, with the workflow's own token, and it
// never reads Ghost configuration. It changes nothing anywhere, so every
// failure is a refusal (exit 2) before anything reaches Ghost.
//
// `select` trusts a candidate artifact only when all of this holds:
//   - this run is on main, and the requested commit is main's head or one of
//     its ancestors;
//   - Article CI has exactly one run for a push of that commit to main, it
//     has finished, and it succeeded;
//   - that run holds the artifact article-candidates-<commit>, unexpired, of
//     a plausible size, with a SHA-256 digest GitHub recorded;
//   - the artifact belongs to that run, and its run's head SHA is that commit;
//   - the download's SHA-256 matches the digest GitHub recorded for it.
// Nothing is re-resolved by name in the publish job: select emits the run id,
// artifact id and digest, and fetch re-reads them by id and re-checks the same
// digest.
//
// The candidate's own self-consistency (the inspect command's integrity,
// publish-gate and id/revision checks) runs after this, on the directory
// these commands extract. Provenance and integrity are deliberately separate:
// neither alone establishes that a candidate may be published.
//
// Inputs come from the environment the workflow sets:
//   GITHUB_REPOSITORY GITHUB_REF GITHUB_SHA GITHUB_TOKEN GITHUB_API_URL
//   CANDIDATE_COMMIT          select: the commit to select for (required)
//                             fetch: the verified commit (required)
//   CANDIDATE_ARTIFACT_ID     fetch: the artifact id select verified
//   CANDIDATE_ARTIFACT_DIGEST fetch: the digest select verified
// Results go to GITHUB_OUTPUT and GITHUB_STEP_SUMMARY when those are set.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RefusedError } from "./errors.mjs";
import { sha256 } from "./assets.mjs";
import { headCommit, isAncestor } from "./git-source.mjs";

/** The workflow file that produces candidate artifacts, resolved by name. */
export const CI_WORKFLOW_FILE = "article-ci.yml";
/** Candidate artifacts are named <prefix><commit>. */
export const CANDIDATE_ARTIFACT_PREFIX = "article-candidates-";
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Require a full 40-hex commit id. */
export function requireSha(value, label) {
  const sha = String(value ?? "").trim();
  if (!SHA_PATTERN.test(sha)) throw new RefusedError(`${label} must be a full 40-character lowercase commit SHA; got "${sha}".`);
  return sha;
}

/** Require a numeric id (a run or an artifact). */
function requireId(value, label) {
  const id = String(value ?? "").trim();
  if (!ID_PATTERN.test(id)) throw new RefusedError(`${label} must be a numeric ID; got "${id}".`);
  return id;
}

/** Refuse unless this run is on main. */
export function requireMain(env) {
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new RefusedError(`Article publishing runs only from main. This run is on ${env.GITHUB_REF || "an unknown ref"}.`);
  }
}

// --- the GitHub REST API ----------------------------------------------------------

/**
 * A minimal GitHub REST API client with the Actions endpoints the provenance
 * checks read, plus the pre-signed storage URL artifact downloads redirect to.
 * The token is the workflow's own; it is never logged.
 */
export function github(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new RefusedError("GITHUB_TOKEN is not set; the workflow passes its own token.");
  const repository = env.GITHUB_REPOSITORY;
  if (!REPOSITORY_PATTERN.test(repository ?? "")) {
    throw new RefusedError(`GITHUB_REPOSITORY is not owner/name: "${repository}".`);
  }
  const base = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "neumachen-article-pipeline",
  };

  async function call(pathname) {
    try {
      return await fetch(`${base}${pathname}`, { headers, redirect: "manual" });
    } catch (error) {
      throw new RefusedError(`The GitHub API request for ${pathname} failed: ${error.message}`);
    }
  }

  async function json(pathname, what) {
    const response = await call(pathname);
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json())?.message ?? "";
      } catch {
        // not JSON; the status is enough
      }
      throw new RefusedError(`${what}: GitHub answered ${response.status}${detail ? ` (${detail})` : ""}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new RefusedError(`${what}: GitHub's response was not JSON.`);
    }
  }

  /**
   * GitHub answers an artifact download with a redirect to a short-lived,
   * pre-signed storage URL. That URL carries its own authorisation, so the
   * GitHub token is deliberately not sent to it.
   */
  async function download(artifact, destination) {
    const response = await call(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`);
    if (response.status !== 302) {
      throw new RefusedError(`Downloading artifact ${artifact.id}: expected a redirect, GitHub answered ${response.status}.`);
    }
    let url;
    try {
      url = new URL(response.headers.get("location"));
    } catch {
      throw new RefusedError(`Downloading artifact ${artifact.id}: GitHub's redirect had no usable location.`);
    }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
      throw new RefusedError(`Downloading artifact ${artifact.id}: refusing a non-https download location.`);
    }
    let blob;
    try {
      blob = await fetch(url, { headers: { "User-Agent": "neumachen-article-pipeline" } });
    } catch (error) {
      throw new RefusedError(`Downloading artifact ${artifact.id} failed: ${error.message}`);
    }
    if (!blob.ok) throw new RefusedError(`Downloading artifact ${artifact.id}: storage answered ${blob.status}.`);
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new RefusedError(`Artifact ${artifact.id} is larger than a candidate artifact can be (${bytes.length} bytes).`);
    }
    writeFileSync(destination, bytes);
    return bytes;
  }

  return { repository, json, download };
}

/** Why a workflow run cannot vouch for commit on main, or null if it can. */
export function ciRunProblem(runInfo, workflow, commit, repository) {
  if (runInfo.workflow_id !== workflow.id) return `run ${runInfo.id} is not an Article CI run`;
  if (runInfo.head_sha !== commit) return `run ${runInfo.id} checked ${runInfo.head_sha}, not ${commit}`;
  if (runInfo.event !== "push") return `run ${runInfo.id} was triggered by ${runInfo.event}, not a push`;
  if (runInfo.head_branch !== "main") return `run ${runInfo.id} ran for ${runInfo.head_branch}, not main`;
  if (runInfo.repository?.full_name !== repository || runInfo.head_repository?.full_name !== repository) {
    return `run ${runInfo.id} did not run on ${repository}'s own main`;
  }
  return null;
}

/** Refuse an unfinished or unsuccessful producing run, naming it. */
export function requireSucceeded(runInfo, commit) {
  if (runInfo.status !== "completed") {
    throw new RefusedError(
      `Article CI run ${runInfo.id} for ${commit} has not finished (status: ${runInfo.status}). ` +
        "Wait for it, then start the publication again.",
    );
  }
  if (runInfo.conclusion !== "success") {
    throw new RefusedError(
      `Article CI run ${runInfo.id} for ${commit} concluded "${runInfo.conclusion}", not success. ` +
        "That commit is not eligible for publication.",
    );
  }
}

/** Refuse an artifact that is not exactly the one this run produced for this commit. */
export function requireArtifact(artifact, { runId, commit, name }) {
  if (artifact.name !== name) throw new RefusedError(`Artifact ${artifact.id} is "${artifact.name}", not "${name}".`);
  if (artifact.expired !== false) {
    throw new RefusedError(`Artifact ${name} has expired. Push a new commit to main to produce a fresh candidate.`);
  }
  if (String(artifact.workflow_run?.id) !== String(runId)) {
    throw new RefusedError(`Artifact ${artifact.id} belongs to run ${artifact.workflow_run?.id}, not ${runId}.`);
  }
  if (artifact.workflow_run?.head_sha !== commit) {
    throw new RefusedError(`Artifact ${artifact.id} was built for ${artifact.workflow_run?.head_sha}, not ${commit}.`);
  }
  if (!(artifact.size_in_bytes > 0) || artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
    throw new RefusedError(`Artifact ${artifact.id} has an implausible size: ${artifact.size_in_bytes}.`);
  }
  if (!DIGEST_PATTERN.test(artifact.digest ?? "")) {
    throw new RefusedError(`Artifact ${artifact.id} has no SHA-256 digest recorded, so its download cannot be checked.`);
  }
}

/** Download an artifact, check it against its recorded digest, extract it. */
export async function downloadArtifact(api, artifact, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(path.join(os.tmpdir(), "article-artifact-"));
  try {
    const archive = path.join(work, "artifact.zip");
    const bytes = await api.download(artifact, archive);
    const digest = `sha256:${sha256(bytes)}`;
    if (digest !== artifact.digest) {
      throw new RefusedError(`Artifact ${artifact.id} downloaded as ${digest}, but GitHub recorded ${artifact.digest}.`);
    }
    // unzip is present in the pinned base image (article/Dockerfile).
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("unzip", ["-qq", archive, "-d", outDir], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const reason = String(error?.stderr ?? "").trim().split("\n")[0] || error.message || String(error);
      throw new RefusedError(`Could not extract artifact ${artifact.id}: ${reason}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- select and fetch ------------------------------------------------------------

/**
 * Select job: find the candidate artifact Article CI produced for a commit on
 * main, and verify it end to end. Refuses (exit 2) unless every provenance
 * check passes. Emits to GITHUB_OUTPUT when set:
 *   commit, ci_run_id, artifact_id, artifact_digest.
 */
export async function selectCandidateArtifact({ env = process.env, repoRoot, outDir }) {
  requireMain(env);
  const api = github(env);
  const commit = requireSha(env.CANDIDATE_COMMIT, "CANDIDATE_COMMIT");
  if (!repoRoot) throw new RefusedError("select-artifact needs the repository (give --repo <dir>).");

  // The commit must be on main in this checkout: main's head or an ancestor.
  const head = headCommit(repoRoot);
  if (commit !== head && !isAncestor(repoRoot, commit, head)) {
    throw new RefusedError(
      `${commit} is not on main: it is not ${head} or one of its ancestors. ` +
        "Only a commit Article CI checked on main can be published.",
    );
  }

  // Resolve the Article CI workflow by its file name, and compare run's
  // workflow_id against it: only an Article CI run vouches for a candidate.
  const workflow = await api.json(
    `/repos/${api.repository}/actions/workflows/${CI_WORKFLOW_FILE}`,
    "Reading the Article CI workflow",
  );
  const query = new URLSearchParams({
    head_sha: commit,
    event: "push",
    branch: "main",
    exclude_pull_requests: "true",
    per_page: "100",
  });
  const listed = await api.json(
    `/repos/${api.repository}/actions/workflows/${workflow.id}/runs?${query}`,
    "Listing Article CI runs",
  );
  const runs = (listed.workflow_runs ?? []).filter(
    (runInfo) => !ciRunProblem(runInfo, workflow, commit, api.repository),
  );
  if (runs.length === 0) {
    throw new RefusedError(
      `Article CI has no run for a push of ${commit} to main. Only commits that were the head of a ` +
        "push to main were checked there. Choose one that was, or push a new commit to main.",
    );
  }
  if (runs.length > 1) {
    throw new RefusedError(
      `Article CI has ${runs.length} push runs of ${commit} on main (${runs.map((r) => r.id).join(", ")}); ` +
        "refusing to guess which one to trust.",
    );
  }
  const [ciRun] = runs;
  requireSucceeded(ciRun, commit);

  const name = `${CANDIDATE_ARTIFACT_PREFIX}${commit}`;
  const artifacts = await api.json(
    `/repos/${api.repository}/actions/runs/${ciRun.id}/artifacts?${new URLSearchParams({ name, per_page: "100" })}`,
    "Listing the Article CI run's artifacts",
  );
  const matching = (artifacts.artifacts ?? []).filter((artifact) => artifact.name === name);
  if (matching.length !== 1) {
    throw new RefusedError(
      matching.length === 0
        ? `Article CI run ${ciRun.id} holds no artifact named ${name}; it may have expired or been deleted.`
        : `Article CI run ${ciRun.id} holds ${matching.length} artifacts named ${name}; refusing to guess.`,
    );
  }
  const [artifact] = matching;
  requireArtifact(artifact, { runId: ciRun.id, commit, name });

  // The download's digest must match what GitHub recorded: the bytes are the
  // candidate CI validated, not merely an artifact with a matching name.
  await downloadArtifact(api, artifact, outDir);

  return {
    commit,
    ci_run_id: String(ciRun.id),
    ci_run_url: ciRun.html_url ?? "",
    artifact_id: String(artifact.id),
    artifact_digest: artifact.digest,
    out_dir: outDir,
  };
}

/**
 * Publish job: fetch the artifact select verified, by its id, and re-verify it
 * against the same digest before use. Never re-resolves by name.
 */
export async function fetchCandidateArtifact({ env = process.env, outDir }) {
  requireMain(env);
  const api = github(env);
  const commit = requireSha(env.CANDIDATE_COMMIT, "CANDIDATE_COMMIT");
  const artifactId = requireId(env.CANDIDATE_ARTIFACT_ID, "CANDIDATE_ARTIFACT_ID");
  const digest = String(env.CANDIDATE_ARTIFACT_DIGEST ?? "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new RefusedError("CANDIDATE_ARTIFACT_DIGEST must be a sha256:<64 hex> digest.");
  }

  // The run is re-read rather than trusted from the earlier job: a re-run of
  // Article CI in between replaces the artifact and changes the run's state.
  // Mirroring the theme pipeline's fetch, the producing run is re-checked as
  // an Article CI push run on main in this repository, so an artifact whose
  // run belongs to another workflow cannot reach the publish job either.
  const artifact = await api.json(
    `/repos/${api.repository}/actions/artifacts/${artifactId}`,
    "Reading the selected artifact",
  );
  const runId = requireId(artifact.workflow_run?.id, `The run artifact ${artifactId} belongs to`);
  const workflow = await api.json(
    `/repos/${api.repository}/actions/workflows/${CI_WORKFLOW_FILE}`,
    "Reading the Article CI workflow",
  );
  const ciRun = await api.json(`/repos/${api.repository}/actions/runs/${runId}`, "Reading the Article CI run");
  const problem = ciRunProblem(ciRun, workflow, commit, api.repository);
  if (problem) throw new RefusedError(`The selected run no longer qualifies: ${problem}.`);
  requireSucceeded(ciRun, commit);
  requireArtifact(artifact, { runId, commit, name: `${CANDIDATE_ARTIFACT_PREFIX}${commit}` });
  if (artifact.digest !== digest) {
    throw new RefusedError(
      `Artifact ${artifactId} now records digest ${artifact.digest}, but select verified ${digest}. ` +
        "The artifact was replaced between the jobs; refuse rather than publish unverified bytes.",
    );
  }

  await downloadArtifact(api, artifact, outDir);
  return { artifact_id: artifactId, artifact_digest: digest, out_dir: outDir };
}

// --- command-line plumbing (shared with cli.mjs) ----------------------------------

/** Write values to GITHUB_OUTPUT when it is set, and echo them. */
export function writeOutputs(env, values) {
  for (const [key, value] of Object.entries(values)) {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`output ${key} contains a newline`);
    console.log(`  ${key}: ${text}`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
}

/** Append to GITHUB_STEP_SUMMARY when it is set. */
export function writeSummary(env, lines) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/** Read a file as text, or null when missing. */
export function readTextOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
