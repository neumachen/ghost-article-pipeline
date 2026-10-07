// Reading the exact committed revision. Publication always reads from git,
// never from the working tree: the registry commit alone is what a candidate
// hash is bound to, so "what would be sent" stays traceable to a commit even
// while the checkout has moved on.
//
// The working-tree mode exists only for local authoring (validate/prepare/
// preview); it is clearly labelled so publication can refuse it.

import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ValidationError, RefusedError } from "./errors.mjs";

// Fixture repositories (and a container's /repo mount) must not inherit the
// machine's git configuration: global hooks, templates or a signing setup
// would act on someone else's repository. Same isolation tools/test/helpers.mjs uses.
//
// Git >= 2.35.2 additionally refuses to touch a repository owned by a different
// user ("detected dubious ownership in repository"). That is precisely the
// situation on a Linux runner: actions/checkout leaves the workspace owned by
// the runner's user while this container runs as root, so every git command the
// pipeline needs would fail before it read anything.
//
// `safe.directory` is git's supported exception, and git honours it ONLY from a
// system or a global config file — never from `-c` or the GIT_CONFIG_*
// environment, deliberately, so that neither a repository nor a command line can
// grant itself trust. So the pipeline writes its OWN minimal global config,
// holding exactly the directories this run was told to read and nothing else,
// and points GIT_CONFIG_GLOBAL at that instead of at /dev/null. The machine's
// real global config is still not inherited, `safe.directory = *` is never
// written anywhere, and the ownership check stays fully in force for every
// other path.

/** repoRoot -> the env its git invocations run with (the trust file is written once). */
const trustCache = new Map();

function physical(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return null;
  }
}

/**
 * The directories a checkout of `repoRoot` needs trusted: the checkout itself,
 * and — for a linked worktree, whose `.git` is a FILE pointing at the main
 * repository's metadata — the per-worktree gitdir and the common dir that
 * holds it. tools/article/run.sh mounts that common dir read-only for exactly
 * this reason, and on a runner it is owned by the runner's user as well.
 *
 * Both the given path and its physical path are listed, because git compares
 * the resolved one and a symlinked checkout (macOS' /var -> /private/var, a
 * runner's workspace) resolves differently from how it was passed in.
 */
export function trustedDirectories(repoRoot) {
  const dirs = new Set();
  const add = (dir) => {
    if (typeof dir !== "string" || !dir) return;
    dirs.add(dir);
    const resolved = physical(dir);
    if (resolved) dirs.add(resolved);
  };
  add(repoRoot);
  try {
    const dotGit = path.join(repoRoot, ".git");
    if (lstatSync(dotGit).isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (target) {
        const gitdir = path.isAbsolute(target) ? target : path.resolve(repoRoot, target);
        add(gitdir);
        // <common dir>/worktrees/<name> -> <common dir>
        if (path.basename(path.dirname(gitdir)) === "worktrees") add(path.dirname(path.dirname(gitdir)));
      }
    } else {
      add(dotGit);
    }
  } catch {
    // No readable .git: checkRepo refuses it with a clear message below.
  }
  return [...dirs];
}

/**
 * The env every git invocation runs with: isolated from the machine's git
 * configuration, plus a scoped ownership exception for this checkout. Exported
 * because registry.mjs runs git too and must not be trusted differently.
 */
export function gitEnv(repoRoot) {
  const cached = trustCache.get(repoRoot);
  if (cached) return cached;
  const dirs = trustedDirectories(repoRoot);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "article-git-trust-")), "gitconfig");
  writeFileSync(
    file,
    [
      "# Written by the article pipeline for one run. It holds ONLY the",
      "# ownership exception for the checkout this run was told to read.",
      "# It never holds a wildcard entry, so the ownership check stays in",
      "# force for every path this run was not told to read.",
      "[safe]",
      ...dirs.map((entry) => `\tdirectory = ${entry}`),
      "",
    ].join("\n"),
  );
  const env = { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" };
  trustCache.set(repoRoot, env);
  return env;
}

/** The trust config file this run wrote for `repoRoot`, for evidence and tests. */
export function trustConfigFile(repoRoot) {
  gitEnv(repoRoot);
  return trustCache.get(repoRoot).GIT_CONFIG_GLOBAL;
}

function git(repoRoot, ...args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnv(repoRoot),
  });
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function checkRepo(repoRoot) {
  try {
    git(repoRoot, "rev-parse", "--git-dir");
  } catch (error) {
    const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
    throw new RefusedError(`${repoRoot} is not a usable git repository: ${reason}`);
  }
}

/**
 * Resolve a ref (sha, short sha, branch, tag, HEAD) to the full 40-hex commit
 * it names. A ref that names a tree, a blob or nothing is refused: nothing
 * has been read and nothing has been sent.
 */
export function resolveCommit(repoRoot, ref) {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new RefusedError("A revision is required (an empty ref names nothing).");
  }
  let out;
  try {
    out = git(repoRoot, "rev-parse", "--verify", `${ref.trim()}^{commit}`).trim();
  } catch (error) {
    const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
    throw new RefusedError(`The revision "${ref}" does not resolve to a commit in ${repoRoot}: ${reason}`);
  }
  if (!COMMIT_PATTERN.test(out)) {
    // --verify normally guarantees this; checking anyway keeps the contract
    // explicit rather than implied by git's behaviour.
    throw new RefusedError(`The revision "${ref}" resolved to "${out}", which is not a 40-hex commit.`);
  }
  return out;
}

/**
 * The article directory's files at an exact commit, as a Map of
 * repo-relative path -> Buffer. Only regular files are returned: a symlink
 * (mode 120000) or a gitlink (mode 160000) in an article directory is not
 * content a candidate can hash, so it is refused rather than followed.
 *
 * Byte-exactness matters for assets: an image is content, not text, so each
 * file is read as a base64-decoded blob, never as UTF-8 text (which would
 * replace every invalid byte with U+FFFD and corrupt the image — observed
 * live as Ghost 6.64.0's processor refusing the re-encoded bytes with 400
 * "cannot upload image").
 */
export function readArticleAtCommit(repoRoot, commit, articlePath) {
  let names;
  try {
    names = git(repoRoot, "ls-tree", "-r", "-z", "--name-only", commit, "--", articlePath).split("\0");
  } catch (error) {
    const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
    throw new RefusedError(`The article directory "${articlePath}" could not be listed at ${commit}: ${reason}`);
  }
  const prefix = `${articlePath}/`;
  const files = new Map();
  for (const name of names) {
    if (!name) continue;
    if (name !== articlePath && !name.startsWith(prefix)) {
      throw new RefusedError(`Git returned "${name}", which is outside the article directory "${articlePath}".`);
    }
    // The -z --name-only listing carries no modes, so the mode of each file
    // is read separately: this is the check that rejects symlinks.
    let modeLine;
    try {
      modeLine = git(repoRoot, "ls-tree", commit, "--", name).trim();
    } catch (error) {
      throw new RefusedError(`"${name}" could not be listed at ${commit}: ${error.message}`);
    }
    const mode = modeLine.split(/\s+/)[0];
    if (mode !== "100644" && mode !== "100755") {
      throw new RefusedError(
        `"${name}" is not a regular file at ${commit} (mode ${mode}). Symlinks and submodules are refused, not followed.`,
      );
    }
    let bytes;
    try {
      // base64: git show prints text, and an asset's bytes are not text. The
      // decode is byte-exact; UTF-8 decoding here is what corrupted images.
      bytes = execFileSync("git", ["-C", repoRoot, "show", `${commit}:${name}`], {
        encoding: "base64",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnv(repoRoot),
      });
    } catch (error) {
      const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
      throw new RefusedError(`"${name}" could not be read at ${commit}: ${reason}`);
    }
    files.set(name, Buffer.from(bytes, "base64"));
  }
  return files;
}

/**
 * NON-AUTHORITATIVE: the article directory as it sits in the working tree,
 * the same shape readArticleAtCommit returns. Used only by validate, prepare
 * and preview for local authoring; publication refuses it, because the
 * working tree is not a revision a candidate hash can be bound to. Symlinks,
 * special files and anything outside the article directory are refused the
 * same way the committed read refuses them.
 */
export function readArticleFromWorkingTree(repoRoot, articlePath) {
  const prefix = `${articlePath}/`;
  const files = new Map();
  let rootStat;
  try {
    rootStat = lstatSync(path.join(repoRoot, articlePath));
  } catch (error) {
    throw new RefusedError(`The article directory "${articlePath}" cannot be read in ${repoRoot}: ${error.message}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new RefusedError(`"${articlePath}" is not a plain directory in the working tree.`);
  }
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
      const rel = `${relative}/${entry.name}`;
      const stat = lstatSync(path.join(repoRoot, rel));
      if (stat.isSymbolicLink()) {
        throw new RefusedError(`"${rel}" is a symlink in the working tree. Symlinks are refused, not followed.`);
      }
      if (stat.isDirectory()) walk(rel);
      else if (stat.isFile()) files.set(rel, readFileSync(path.join(repoRoot, rel)));
      else throw new RefusedError(`"${rel}" is not a regular file in the working tree.`);
    }
  };
  walk(articlePath);
  // Every key must remain under the article path; nothing here should be
  // able to produce an escape, and this keeps that explicit.
  for (const key of files.keys()) {
    if (key !== articlePath && !key.startsWith(prefix)) {
      throw new ValidationError(`The working tree returned "${key}", which is outside "${articlePath}".`);
    }
  }
  return files;
}

/**
 * Whether maybeAncestor is an ancestor of commit in repoRoot's history.
 */
export function isAncestor(repoRoot, maybeAncestor, commit) {
  try {
    git(repoRoot, "merge-base", "--is-ancestor", maybeAncestor, commit);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether commit exists in repoRoot.
 */
export function commitExists(repoRoot, commit) {
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) return false;
  try {
    git(repoRoot, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** The commit HEAD points at (the default for --revision). */
export function headCommit(repoRoot) {
  checkRepo(repoRoot);
  return resolveCommit(repoRoot, "HEAD");
}

/**
 * The article directory names (ids) present under articlesRoot at a commit:
 * the immediate subdirectories of the articles root, which the registry's
 * ids are expected to match. Sorted, unique.
 */
export function listArticleDirsAtCommit(repoRoot, commit, articlesRoot) {
  // -d lists only trees: the article directories, not the registry.json that
  // sits directly in the articles root. Without the trailing slash git
  // answers with the tree entry itself, which names nothing.
  let out;
  try {
    out = git(repoRoot, "ls-tree", "-d", "--name-only", commit, "--", `${articlesRoot}/`);
  } catch (error) {
    const reason = String(error.stderr ?? "").trim().split("\n")[0] || error.message;
    throw new RefusedError(`The articles root "${articlesRoot}" could not be listed at ${commit}: ${reason}`);
  }
  const names = new Set();
  for (const line of out.split("\n")) {
    // ls-tree answers with paths relative to the repo root; only the last
    // segment is the article id, and the filter keeps the check honest even
    // if the articles root is nested deeper in a future layout.
    const name = line.trim().split("/").pop();
    if (name && !name.startsWith(".")) names.add(name);
  }
  return [...names].sort();
}
