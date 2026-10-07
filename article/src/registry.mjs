// The article registry: editorial/articles/registry.json, the list of article
// directories the pipeline will consider publishing. It is validated strictly
// because it is the trust boundary between "files in the repo" and "an
// article the pipeline will read from a commit": a registry entry with a `..`
// path or a duplicate id is not a parse failure to tolerate but a malformed
// input the pipeline must refuse before touching git or Ghost.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError, RefusedError } from "./errors.mjs";
import { gitEnv } from "./git-source.mjs";
import { execFileSync } from "node:child_process";

export const REGISTRY_SCHEMA = "neumachen-article-registry/1";
export const REGISTRY_PATH = path.join("editorial", "articles", "registry.json");
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The same git environment git-source.mjs builds: a fixture repository (or a
// container's /repo mount) must not inherit the machine's git configuration,
// and on a Linux runner the checkout is owned by a different user than this
// container, which git refuses without a scoped `safe.directory` exception.
// Reading the registry at a commit is a git operation like any other, so it
// gets the same treatment rather than its own, narrower one.

export class Registry {
  /** articles: the validated entries in file order, each { id, path }. */
  constructor(schema, articles) {
    this.schema = schema;
    this.articles = articles;
    this.byId = new Map(articles.map((entry) => [entry.id, entry]));
    this.byPath = new Map(articles.map((entry) => [entry.path, entry]));
  }

  findArticle(id) {
    return this.byId.get(id) ?? null;
  }
}

/**
 * Load and validate the registry under a repository root. Throws
 * ValidationError (exit 2) naming the first problem found; nothing is read
 * from git or Ghost first.
 */
export async function loadRegistry(repoRoot) {
  const file = path.join(repoRoot, REGISTRY_PATH);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new ValidationError(`The article registry ${REGISTRY_PATH} cannot be read under ${repoRoot}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`${REGISTRY_PATH} is not valid JSON: ${error.message}`);
  }
  return validateRegistryDocument(parsed, REGISTRY_PATH);
}

/**
 * Validate an already-parsed registry document against the strict rules, with
 * `where` naming the origin (the working-tree path or a commit) in every
 * error, so loadRegistry and loadRegistryAtCommit cannot drift apart: both
 * hold this one validation, never a copy of it.
 */
function validateRegistryDocument(parsed, where) {
  if (parsed?.schema !== REGISTRY_SCHEMA) {
    throw new ValidationError(`${where} is not a "${REGISTRY_SCHEMA}" document.`);
  }
  if (!Array.isArray(parsed.articles)) {
    throw new ValidationError(`${where} has no "articles" list.`);
  }
  const seen = new Map();
  const seenPaths = new Map();
  for (const [index, entry] of parsed.articles.entries()) {
    const entryWhere = `${where} entry ${index + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`${entryWhere} is not an object.`);
    }
    const { id, path: entryPath } = entry;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new ValidationError(
        `${entryWhere} has id ${JSON.stringify(id)}, which does not match ^[a-z0-9][a-z0-9-]{0,63}$.`,
      );
    }
    if (typeof entryPath !== "string" || !entryPath) {
      throw new ValidationError(`${entryWhere} (${id}) has no path.`);
    }
    if (path.isAbsolute(entryPath) || entryPath.split("/").includes("..")) {
      throw new ValidationError(`${entryWhere} (${id}) has path "${entryPath}", which must be a relative path inside the repository.`);
    }
    if (seen.has(id)) {
      throw new ValidationError(`${where} lists the id "${id}" more than once (${seen.get(id)} and entry ${index + 1}).`);
    }
    if (seenPaths.has(entryPath)) {
      throw new ValidationError(
        `${where} lists the path "${entryPath}" more than once ("${seenPaths.get(entryPath)}" and "${id}").`,
      );
    }
    seen.set(id, index + 1);
    seenPaths.set(entryPath, id);
  }
  return new Registry(REGISTRY_SCHEMA, parsed.articles);
}

/**
 * The registry's raw JSON text at an exact commit, read from git the same way
 * article files are read (git-source.mjs): the registry the SELECTED revision
 * was enrolled under, not the working tree's current one. Preparing an older
 * revision after a directory or registry rename must resolve the paths that
 * revision carried, so the registry travels with the revision.
 */
export function readRegistryTextAtCommit(repoRoot, commit) {
  try {
    const text = execFileSync("git", ["-C", repoRoot, "show", `${commit}:${REGISTRY_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(repoRoot),
    });
    return text;
  } catch (error) {
    const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
    throw new RefusedError(`The article registry ${REGISTRY_PATH} could not be read at ${commit}: ${reason}`);
  }
}

/**
 * Load and validate the registry as it stood at an exact commit: the text is
 * read from the revision (readRegistryTextAtCommit) and validated by the same
 * strict rules loadRegistry applies, so a malformed registry at the revision
 * is a refusal, not a tolerance. Errors name the commit, so an operator reads
 * which registry was rejected.
 */
export async function loadRegistryAtCommit(repoRoot, commit) {
  const raw = readRegistryTextAtCommit(repoRoot, commit);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(`${REGISTRY_PATH} at ${commit} is not valid JSON: ${error.message}`);
  }
  return validateRegistryDocument(parsed, `${REGISTRY_PATH} at ${commit}`);
}

/** findArticle as a plain function, for callers holding only the articles array. */
export function findArticle(registry, id) {
  const articles = registry instanceof Registry ? registry.articles : registry;
  return (Array.isArray(articles) ? articles : []).find((entry) => entry?.id === id) ?? null;
}
