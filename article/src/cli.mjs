#!/usr/bin/env node
//
// The article pipeline's command line. Everything runs inside the container
// through tools/article/run.sh; nothing here runs on the host. Commands are
// data-in/data-out: a typed error prints its message to stderr and exits
// with classifyError's exit code, so a caller (a workflow) reads where a run
// stopped from the code alone.
//
//   validate  registry + candidate build for every enrolled article (no Ghost)
//   prepare   build candidates into an output directory (no Ghost)
//   inspect   load a prepared candidate and verify it (no Ghost)
//   preview   render a standalone preview.html for an article (no Ghost)
//   select-artifact  find and verify the candidate artifact Article CI produced
//                    for a commit, by provenance, from the GitHub REST API
//                    (no Ghost; never mutates anything — every failure is a refusal)
//   fetch-artifact   fetch the verified candidate artifact again, by its id,
//                    and re-check its digest (no Ghost; never mutates anything)
//   plan      read Ghost and report what a publish would do (sends nothing mutating)
//   publish   create or update the post, then verify (mutates Ghost)
//   verify    read back what Ghost holds and check the public page (never mutates)
//   summary   render a run record for humans (no Ghost)

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError, ValidationError, RefusedError, classifyError } from "./errors.mjs";
import { loadRegistry, loadRegistryAtCommit } from "./registry.mjs";
import { resolveCommit, readArticleAtCommit, readArticleFromWorkingTree, headCommit } from "./git-source.mjs";
import { buildCandidate, writeCandidate, loadCandidate, verifyCandidateForPublish, computeCandidateHash } from "./candidate.mjs";
import { loadGhostConfig } from "./config.mjs";
import { createGhostClient } from "./ghost-client.mjs";
import { runPublish } from "./publish.mjs";
import { resolveAssetUrls } from "./asset-store.mjs";
import { mapImageSrc } from "./markdown.mjs";
import { verifySavedPost, checkPublicPage } from "./verify.mjs";
import { identityTagSlug, decodeState } from "./identity.mjs";
import { renderSummary } from "./record.mjs";
import { selectCandidateArtifact, fetchCandidateArtifact, writeOutputs, writeSummary } from "./github-artifact.mjs";

// --- argument parsing -----------------------------------------------------------------

/**
 * A small, strict parser: --flag value, --flag (boolean), --help. Unknown
 * flags and commands are UsageError (exit 1), so a misspelled option never
 * silently becomes a publish with defaults.
 */
function parseArgs(argv) {
  const flags = new Map(); // name -> value | true
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.set("help", true);
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      throw new UsageError(`Unexpected argument "${arg}". Use --help for the usage.`);
    }
  }
  return flags;
}

const required = (flags, name) => {
  const value = flags.get(name);
  if (value === undefined || value === true || value === "") {
    throw new UsageError(`--${name} is required for this command.`);
  }
  return value;
};

const optional = (flags, name) => {
  const value = flags.get(name);
  return value === undefined || value === true ? null : value;
};

// --- the article files a candidate is built from --------------------------------------

/**
 * The article's files at a revision, or from the working tree when asked.
 * The working tree is local authoring only; publication refuses its
 * candidates (verifyCandidateForPublish).
 */
function articleFiles(repoRoot, article, { revision, workingTree }) {
  if (workingTree) {
    // The same shape the committed read returns, with no commit: the working
    // tree is not a revision, so callers record the candidate as
    // "working-tree" (verifyCandidateForPublish refuses it on publish).
    return { files: readArticleFromWorkingTree(repoRoot, article.path), commit: null };
  }
  const commit = resolveCommit(repoRoot, revision ?? "HEAD");
  return { files: readArticleAtCommit(repoRoot, commit, article.path), commit };
}

/** Build candidates for the selected articles: --all (default) or one --article id. */
function selectedArticles(registry, flags) {
  const article = optional(flags, "article");
  const all = flags.get("all") === true || article === null;
  if (flags.get("all") !== undefined && article !== null) {
    throw new UsageError("Give either --article <id> or --all, not both.");
  }
  if (all) return registry.articles;
  const found = registry.findArticle(article);
  if (!found) {
    throw new ValidationError(`Article "${article}" is not enrolled in the article registry.`);
  }
  return [found];
}

// --- commands -------------------------------------------------------------------------

async function validateCommand(flags) {
  const repoRoot = required(flags, "repo");
  const revision = optional(flags, "revision");
  const workingTree = flags.get("working-tree") === true;
  const registry = workingTree
    ? await loadRegistry(repoRoot)
    : await loadRegistryAtCommit(repoRoot, resolveCommit(repoRoot, revision ?? "HEAD"));
  const articles = selectedArticles(registry, flags);
  const problems = [];
  const rows = [];
  for (const article of articles) {
    try {
      const { files, commit } = articleFiles(repoRoot, article, { revision, workingTree });
      const candidate = buildCandidate({ repoRoot, article, revision: commit ?? "working-tree", files, kind: workingTree ? "working-tree" : "commit" });
      rows.push({ id: article.id, bodyHash: candidate.bodyHash, assets: candidate.assets.length, status: candidate.status });
    } catch (error) {
      problems.push({ id: article.id, error: error.message });
      console.error(`Article "${article.id}": ${error.message}`);
    }
  }
  for (const row of rows) {
    console.log(`OK ${row.id} bodyHash=${row.bodyHash} assets=${row.assets} status=${row.status}`);
  }
  if (problems.length > 0) {
    process.exitCode = 2;
    return;
  }
}

/** <out>/<id>/manifest.json: the artifact-side summary of a prepared candidate. */
function writeManifest(outDir, candidate) {
  const manifest = {
    schema: "neumachen-article-candidate-manifest/1",
    id: candidate.article.id,
    revision: candidate.source.revision,
    kind: candidate.source.kind,
    candidateHash: candidate.candidateHash,
    bodyHash: candidate.bodyHash,
    title: candidate.title,
    slug: candidate.slug,
    status: candidate.status,
    tags: candidate.tags,
    assets: candidate.assets.map((asset) => ({ ref: asset.ref, sha256: asset.sha256, size: asset.size })),
  };
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function prepareCommand(flags) {
  const repoRoot = required(flags, "repo");
  const out = required(flags, "out");
  const revision = optional(flags, "revision");
  const workingTree = flags.get("working-tree") === true;
  // A selected revision prepares under the registry THAT revision carried:
  // the registry is read from the commit, the same mechanism the article
  // files are read with, so preparing an older revision after a directory or
  // registry rename resolves the paths that revision was enrolled under.
  // Working-tree mode keeps the working-tree registry: it is local authoring.
  const registry = workingTree
    ? await loadRegistry(repoRoot)
    : await loadRegistryAtCommit(repoRoot, resolveCommit(repoRoot, revision ?? "HEAD"));
  const articles = selectedArticles(registry, flags);
  const count = articles.length;
  let preparedCount = 0;
  for (const article of articles) {
    const { files, commit } = articleFiles(repoRoot, article, { revision, workingTree });
    const candidate = buildCandidate({ repoRoot, article, revision: commit ?? "working-tree", files, kind: workingTree ? "working-tree" : "commit" });
    const outDir = path.join(out, article.id);
    const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
    await writeCandidate(outDir, candidate, assetBytes);
    await writeManifest(outDir, candidate);
    preparedCount += 1;
    console.log(`prepared ${outDir}`);
    console.log(`  candidateHash ${candidate.candidateHash}`);
    console.log(`  bodyHash      ${candidate.bodyHash}`);
  }
  // The artifact boundary's own count (also emitted to GITHUB_OUTPUT when set,
  // the same way inspectCommand emits): Article CI gates its upload on this,
  // so an empty registry produces a deliberate "none prepared" rather than a
  // failed "if-no-files-found: error" upload.
  console.log(`prepared candidates: ${preparedCount}/${count}`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `candidate_count=${preparedCount}\n`);
  }
}

async function inspectCommand(flags) {
  const candidateDir = required(flags, "candidate");
  const repoRoot = optional(flags, "repo");
  const articleId = optional(flags, "article");
  const revision = optional(flags, "revision");
  const { candidate } = await loadCandidate(candidateDir);
  if (repoRoot) verifyCandidateForPublish(candidate, { repoRoot });
  if (articleId !== null && candidate.article.id !== articleId) {
    throw new RefusedError(`The candidate in ${candidateDir} is for article "${candidate.article.id}", not "${articleId}".`);
  }
  if (revision !== null && candidate.source.revision !== revision) {
    throw new RefusedError(`The candidate in ${candidateDir} was built from ${candidate.source.revision}, not ${revision}.`);
  }
  const summary = {
    id: candidate.article.id,
    revision: candidate.source.revision,
    kind: candidate.source.kind,
    title: candidate.title,
    slug: candidate.slug,
    status: candidate.status,
    tags: candidate.tags,
    authors: candidate.authors,
    assets: candidate.assets.length,
    bodyHash: candidate.bodyHash,
    candidateHash: candidate.candidateHash,
  };
  console.log(JSON.stringify(summary));
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const lines = [
      `candidate_hash=${candidate.candidateHash}`,
      `body_hash=${candidate.bodyHash}`,
      `article=${candidate.article.id}`,
      `revision=${candidate.source.revision}`,
      `title=${candidate.title}`,
      `slug=${candidate.slug}`,
      `status=${candidate.status}`,
    ];
    appendFileSync(githubOutput, `${lines.join("\n")}\n`);
  }
}

async function previewCommand(flags) {
  const repoRoot = required(flags, "repo");
  const articleId = required(flags, "article");
  const out = required(flags, "out");
  const revision = optional(flags, "revision");
  const workingTree = flags.get("working-tree") === true;
  // The registry the selected revision carried, exactly as prepareCommand
  // reads it: a preview of an older revision must show that revision's
  // enrollment, not the working tree's current one.
  const registry = workingTree
    ? await loadRegistry(repoRoot)
    : await loadRegistryAtCommit(repoRoot, resolveCommit(repoRoot, revision ?? "HEAD"));
  const article = registry.findArticle(articleId);
  if (!article) {
    throw new ValidationError(`Article "${articleId}" is not enrolled in the article registry.`);
  }
  const { files, commit } = articleFiles(repoRoot, article, { revision, workingTree });
  const candidate = buildCandidate({ repoRoot, article, revision: commit ?? "working-tree", files, kind: workingTree ? "working-tree" : "commit" });
  // The preview must display on its own, so its assets travel with the page:
  // the candidate write (preview.html plus its assets/ directory) is placed
  // at a STABLE sibling of the requested output file — <dir>/<name>.assets/
  // — never a throwaway directory deleted behind the page's back (the old
  // behaviour copied the page out and deleted the assets, so every image the
  // page referenced 404'd). The page's own src values are rewritten to that
  // sibling, so a browser opening the file resolves each asset relatively.
  // The layout, documented: <out> is the page; <name>.assets/ holds the same
  // candidate write (candidate.json, body.html, preview.html, assets/).
  const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
  const previewDir = `${out.replace(/\.[^./\\]*$/, "")}.assets`;
  rmSync(previewDir, { recursive: true, force: true });
  const written = await writeCandidate(previewDir, candidate, assetBytes);
  // writeCandidate renders the page with refs rewritten to assets/<file>,
  // relative to the candidate directory itself; the page lives one level up
  // and one name over, so each ref gains the sibling prefix.
  const pageAssetPrefix = path.basename(previewDir) + "/assets/";
  const page = readFileSync(written.previewHtml, "utf8").replace(/\ssrc\s*=\s*"assets\//g, ` src="${pageAssetPrefix}`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, page);
  console.log(`preview written: ${out}`);
  if (candidate.assets.length > 0) {
    console.log(`preview assets: ${previewDir}/assets/ (the page references them as "${pageAssetPrefix}<file>")`);
  }
}

/**
 * The GitHub side, no Ghost: find and verify the candidate artifact Article
 * CI produced for a commit (provenance), or fetch the verified one again by
 * its id. Never mutates anything, so every failure is a refusal (exit 2).
 * Values verified in select are emitted to GITHUB_OUTPUT; fetch re-checks the
 * same digest before the publish job uses the candidate.
 */
async function selectArtifactCommand(flags) {
  const repoRoot = required(flags, "repo");
  const outDir = required(flags, "out");
  const selected = await selectCandidateArtifact({
    env: { ...process.env, CANDIDATE_COMMIT: required(flags, "revision") },
    repoRoot,
    outDir,
  });
  console.log(`Selected artifact ${selected.artifact_id} (Article CI run ${selected.ci_run_id}) for ${selected.commit}; every provenance check passed.`);
  writeOutputs(process.env, {
    commit: selected.commit,
    ci_run_id: selected.ci_run_id,
    artifact_id: selected.artifact_id,
    artifact_digest: selected.artifact_digest,
  });
  writeSummary(process.env, [
    "### Selected candidate artifact",
    "",
    "| | |",
    "| --- | --- |",
    `| Commit | \`${selected.commit}\` |`,
    `| From | Article CI run [${selected.ci_run_id}](${selected.ci_run_url}), artifact ${selected.artifact_id} |`,
    `| Digest | \`${selected.artifact_digest}\` |`,
    "",
    "Verified: the run is an Article CI run, a push, on main, in this repository; exactly one such run;",
    "it completed successfully with head SHA equal to the requested commit; the artifact belongs to that",
    "run, is unexpired, and the download's SHA-256 matches the digest GitHub recorded.",
  ]);
}

async function fetchArtifactCommand(flags) {
  const outDir = required(flags, "out");
  const fetched = await fetchCandidateArtifact({
    env: {
      ...process.env,
      CANDIDATE_COMMIT: required(flags, "revision"),
      CANDIDATE_ARTIFACT_ID: required(flags, "artifact-id"),
      CANDIDATE_ARTIFACT_DIGEST: required(flags, "artifact-digest"),
    },
    outDir,
  });
  console.log(`Fetched artifact ${fetched.artifact_id} again; it is byte-for-byte the verified one.`);
  writeOutputs(process.env, {
    artifact_id: fetched.artifact_id,
    artifact_digest: fetched.artifact_digest,
    out_dir: fetched.out_dir,
  });
}

async function planCommand(flags) {
  const result = await runPublish({
    repoRoot: optional(flags, "repo") ?? "/repo",
    candidateDir: required(flags, "candidate"),
    articleId: required(flags, "article"),
    revision: optional(flags, "revision"),
    mode: "plan",
    recordPath: required(flags, "record"),
  });
  process.exitCode = result.exitCode;
}

async function publishCommand(flags) {
  const mode = optional(flags, "mode") ?? "publish";
  if (mode !== "plan" && mode !== "publish") {
    throw new UsageError("--mode must be plan or publish.");
  }
  const result = await runPublish({
    repoRoot: optional(flags, "repo") ?? "/repo",
    candidateDir: required(flags, "candidate"),
    articleId: required(flags, "article"),
    revision: optional(flags, "revision"),
    mode,
    recordPath: required(flags, "record"),
    repairState: flags.get("repair-state") === true,
  });
  process.exitCode = result.exitCode;
}

/**
 * Read back what Ghost holds and check it, never mutating. Exit 0 when both
 * checks pass, 5 when the saved content mismatches, 6 when only the public
 * page fails.
 */
async function verifyCommand(flags) {
  const candidateDir = required(flags, "candidate");
  const articleId = required(flags, "article");
  const repoRoot = optional(flags, "repo") ?? "/repo";
  const recordPath = optional(flags, "record");
  const { candidate } = await loadCandidate(candidateDir);
  if (candidate.article.id !== articleId) {
    throw new RefusedError(`The candidate in ${candidateDir} is for article "${candidate.article.id}", not "${articleId}".`);
  }
  const client = createGhostClient(loadGhostConfig(), {});
  const byTag = await client.findPostsByTag(identityTagSlug(articleId));
  if (byTag.length > 1) {
    throw new RefusedError(`${byTag.length} posts carry the identity tag for "${articleId}"; the managed post is ambiguous.`);
  }
  const managed = byTag[0] ?? null;
  if (!managed) {
    console.error(`No post carries the identity tag for "${articleId}"; nothing has been published for it.`);
    process.exitCode = 2;
    return;
  }
  candidate.assetUrls = await resolveAssetUrls(client, candidate, managed);
  candidate.bodyHtml = mapImageSrc(candidate.bodyHtml, (src) => candidate.assetUrls[src] ?? src);
  candidate.featureImageUrl = candidate.featureImage ? candidate.assetUrls[candidate.featureImage] : null;
  const saved = verifySavedPost(managed, candidate);
  const page = managed.status === "published" && managed.url ? await client.fetchPublic(managed.url) : null;
  const publicCheck = page ? checkPublicPage(page, candidate) : { ok: true, problems: [] };
  for (const problem of saved.problems) console.error(`saved: ${problem}`);
  for (const problem of publicCheck.problems) console.error(`public: ${problem}`);
  const outcome = saved.ok && publicCheck.ok ? "verified" : saved.ok ? "public-check-failed" : "uncertain";
  console.log(`verified post id ${managed.id} (slug ${managed.slug}): saved ${saved.ok ? "ok" : "MISMATCH"}, public ${page ? (publicCheck.ok ? "ok" : "FAILED") : "not live"}`);
  process.exitCode = saved.ok ? (publicCheck.ok ? 0 : 6) : 5;
  if (recordPath) {
    const stateTag = managed.tags?.find((tag) => tag?.name === `#nc-article-${articleId}`);
    writeFileSync(
      recordPath,
      `${JSON.stringify(
        {
          schema: "neumachen-article-record/1",
          operation: "verify",
          mode: "verify",
          article: { id: articleId },
          revision: candidate.source.revision,
          candidate_hash: candidate.candidateHash,
          ghost_origin: client.origin,
          post: { id: managed.id, uuid: managed.uuid, slug: managed.slug, url: managed.url },
          status: managed.status,
          published_at: managed.published_at ?? null,
          live_changed: "no",
          steps: [
            { name: "read-state", status: "ok", started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
            { name: "verify-saved", status: saved.ok ? "ok" : "uncertain", ...(saved.ok ? {} : { problems: saved.problems }), started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
            ...(page
              ? [{ name: "public-check", status: publicCheck.ok ? "ok" : "failed", ...(publicCheck.ok ? {} : { problems: publicCheck.problems }), started_at: new Date().toISOString(), finished_at: new Date().toISOString() }]
              : [{ name: "public-check", status: "skipped", reason: "drafts have no public URL", started_at: new Date().toISOString(), finished_at: new Date().toISOString() }]),
          ],
          outcome,
          exit_code: process.exitCode,
          message: `Verified article "${articleId}" against post id ${managed.id}: saved ${saved.ok ? "ok" : "mismatched"}, public ${page ? (publicCheck.ok ? "ok" : "failed") : "not live"}${stateTag ? "" : "; the identity tag carries no state"}.`,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`record written: ${recordPath}`);
  }
}

async function summaryCommand(flags) {
  const recordPath = required(flags, "record");
  let data = null;
  try {
    data = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A missing record is the "no record" summary: the run stopped before a
    // record was written, which is itself the report.
  }
  const summary = renderSummary(data);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    mkdirSync(path.dirname(stepSummary), { recursive: true });
    appendFileSync(stepSummary, `${summary}\n`);
  }
  console.log(summary);
}

// --- entry ----------------------------------------------------------------------------

const USAGE = [
  "Usage: node src/cli.mjs <command> [options]",
  "",
  "Commands:",
  "  validate --repo <dir> [--article <id>|--all] [--revision <ref>] [--working-tree] [--out <dir>]",
  "  prepare  --repo <dir> (--article <id>|--all) --out <dir> [--revision <ref>] [--working-tree]",
  "  inspect  --candidate <dir> [--repo <dir>] [--article <id>] [--revision <commit>]",
  "  preview  --repo <dir> --article <id> --out <file> [--revision <ref>] [--working-tree]",
  "  select-artifact --repo <dir> --revision <commit> --out <dir>",
  "                  find and verify, by provenance, the candidate artifact Article CI produced for",
  "                  the commit (Article CI run, push, main, this repository, one run, succeeded,",
  "                  head_sha match, unexpired, digest match). Writes commit/ci_run_id/artifact_id/",
  "                  artifact_digest to GITHUB_OUTPUT. Refuses (exit 2) on any failed check.",
  "  fetch-artifact  --revision <commit> --artifact-id <id> --artifact-digest <sha256:<hex>> --out <dir>",
  "                  fetch the artifact select verified, by its id, re-checking the same digest.",
  "  plan     --candidate <dir> --article <id> --revision <commit> --record <file> [--repo <dir>]",
  "  publish  --candidate <dir> --article <id> --revision <commit> --mode <plan|publish> --record <file> [--repo <dir>]",
  "          [--repair-state]   when the live post already holds the candidate's content but the recorded",
  "                              state is missing or stale, write the state tag alone (no post write, no upload).",
  "  verify   --candidate <dir> --article <id> [--repo <dir>] [--record <file>]",
  "  summary  --record <file>",
  "",
  "Exit codes: 0 done or planned; 1 unexpected error; 2 refused; 3 Ghost rejected or conflicted;",
  "4 unauthorised effects; 5 a mutating request was sent and its outcome is unknown; 6 the Ghost",
  "mutation is CONFIRMED but the public page check failed.",
].join("\n");

// The two hyphenated GitHub commands are published under hyphenated names
// (select-artifact, fetch-artifact), consistent with the app's flag style.
const COMMANDS = {
  validate: validateCommand,
  prepare: prepareCommand,
  inspect: inspectCommand,
  preview: previewCommand,
  "select-artifact": selectArtifactCommand,
  "fetch-artifact": fetchArtifactCommand,
  plan: planCommand,
  publish: publishCommand,
  verify: verifyCommand,
  summary: summaryCommand,
};

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(command in COMMANDS)) {
    throw new UsageError(command ? `Unknown command "${command}".` : "A command is required.");
  }
  const flags = parseArgs(rest);
  if (flags.get("help") === true) {
    console.log(USAGE);
  } else {
    await COMMANDS[command](flags);
  }
} catch (error) {
  const { exitCode } = classifyError(error);
  console.error(error.message ?? String(error));
  process.exit(exitCode);
}
