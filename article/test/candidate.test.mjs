// candidate.mjs: build -> write -> load round-trip, candidateHash stability,
// tamper detection, and the publish-side refusal of working-tree candidates.
//
// A real fixture repository supplies the "exact committed revision" the
// candidate is bound to; it is a throwaway under the system temporary
// directory with the machine's git configuration switched off.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { buildCandidate, loadCandidate, verifyCandidateForPublish, writeCandidate } from "../src/candidate.mjs";
import { readArticleAtCommit, resolveCommit } from "../src/git-source.mjs";
import { RefusedError, ValidationError, classifyError } from "../src/errors.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const git = (root, ...args) =>
  sh(
    "git",
    ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { env: GIT_ENV },
  ).trim();

const cleanups = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (cleanups.length) cleanups.pop()();
});

/** Create nested directories (mkdtempSync only makes the leaf, and only at the top level). */
const mkdir = (...parts) => mkdirSync(path.join(...parts), { recursive: true });

const ARTICLE = { id: "hello-world", path: "editorial/articles/hello-world" };

const MARKDOWN = [
  "---",
  "id: hello-world",
  "title: Hello, world",
  "slug: hello-world",
  "status: draft",
  "authors:",
  "  - kareem",
  "excerpt: A first article.",
  "tags:",
  "  - tools",
  "  - ghost",
  "feature_image: hero.png",
  "---",
  "",
  "# Hello",
  "",
  "Body with an image.",
  "",
  "![hero](hero.png)",
  "",
  "And a deeper one: ![deep](img/deep.png)",
  "",
  '<div class="kg-card">raw html</div>',
].join("\n");

/** A repository whose single commit carries the article and its assets. */
function fixtureRepo() {
  const root = temp("article-candidate-");
  git(root, "init", "--initial-branch", "main");
  const dir = path.join(root, ARTICLE.path);
  mkdir(dir, "img");
  writeFileSync(path.join(dir, "article.md"), `${MARKDOWN}\n`);
  writeFileSync(path.join(dir, "hero.png"), "fakepng");
  writeFileSync(path.join(dir, "img/deep.png"), "deepbytes");
  git(root, "add", "-A");
  git(root, "commit", "-m", "article");
  const commit = resolveCommit(root, "HEAD");
  const files = readArticleAtCommit(root, commit, ARTICLE.path);
  return { root, commit, files };
}

function buildFixture() {
  const { root, commit, files } = fixtureRepo();
  const candidate = buildCandidate({
    repoRoot: root,
    article: ARTICLE,
    revision: commit,
    files,
    env: { ARTICLE_IMAGE: "test-image", ARTICLE_PLATFORM: "test-platform" },
  });
  return { root, commit, files, candidate };
}

describe("buildCandidate", () => {
  test("builds a candidate with validated fields, rendered body and resolved assets", () => {
    const { candidate } = buildFixture();
    assert.equal(candidate.schema, "neumachen-article-candidate/1");
    assert.equal(candidate.title, "Hello, world");
    assert.equal(candidate.slug, "hello-world");
    assert.equal(candidate.status, "draft");
    assert.deepEqual(candidate.authors, ["kareem"]);
    assert.deepEqual(candidate.tags, ["tools", "ghost"]);
    assert.equal(candidate.excerpt, "A first article.");
    assert.equal(candidate.featureImage, "hero.png");
    assert.match(candidate.bodyHtml, /<h1[^>]*>Hello<\/h1>/);
    assert.equal(candidate.source.kind, "commit");
    assert.equal(candidate.source.revision.length, 40);
    assert.equal(candidate.environment.image, "test-image");
    assert.deepEqual(
      candidate.assets.map((asset) => asset.ref),
      ["hero.png", "img/deep.png"],
    );
    assert.ok(/^[0-9a-f]{64}$/.test(candidate.candidateHash));
    assert.ok(/^[0-9a-f]{64}$/.test(candidate.bodyHash));
  });

  test("status defaults to published; unknown front-matter keys are recorded", () => {
    const { root, commit } = fixtureRepo();
    const extra = new Map(readArticleAtCommit(root, commit, ARTICLE.path));
    const markdown = extra
      .get(`${ARTICLE.path}/article.md`)
      .toString("utf8")
      .replace("status: draft\n", "")
      .replace("excerpt: A first article.\n", "excerpt: A first article.\nsubtitle: extra\n");
    extra.set(`${ARTICLE.path}/article.md`, Buffer.from(markdown));
    const candidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files: extra });
    assert.equal(candidate.status, "published");
    assert.deepEqual(candidate.unknownKeys, ["subtitle"]);
  });

  test("wrong field types are refused", () => {
    const { root, commit } = fixtureRepo();
    // Each variant replaces one existing front-matter line (replacing
    // "status:" with another "id:" would create duplicate YAML keys, which
    // YAML resolves silently rather than refusing).
    const variants = [
      ["id: hello-world\n", "id: other-id\n", /does not match the registry id/],
      ["slug: hello-world\n", "slug: Not A Slug\n", /slug "Not A Slug" does not match/],
      ["status: draft\n", "status: scheduled\n", /status must be "draft" or "published"/],
      ["authors:\n  - kareem\n", "authors: kareem\n", /authors must be a list/],
      ["tags:\n  - tools\n  - ghost\n", "tags: [1, 2]\n", /tags must be a list/],
      ["excerpt: A first article.\n", "excerpt: 12\n", /excerpt must be a string/],
      ["feature_image: hero.png\n", "assets: [{ path: 3 }]\n", /assets must be a list/],
      ["title: Hello, world\n", "title:\n", /field "title" is required/],
    ];
    for (const [from, to, pattern] of variants) {
      const files = new Map(readArticleAtCommit(root, commit, ARTICLE.path));
      const markdown = files.get(`${ARTICLE.path}/article.md`).toString("utf8").replace(from, to);
      files.set(`${ARTICLE.path}/article.md`, Buffer.from(markdown));
      assert.throws(
        () => buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files }),
        (error) => error instanceof ValidationError && pattern.test(error.message),
        `${to} should be refused: ${pattern}`,
      );
    }
  });

  test("candidateHash is stable across rebuilds of the same revision", () => {
    // Two separate builds from the SAME repo and commit must agree; two
    // fixture repos would not, because the revision is part of the hash.
    const { root, commit, files } = fixtureRepo();
    const a = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files });
    const b = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files: new Map(files) });
    assert.equal(a.candidateHash, b.candidateHash);
    assert.equal(a.bodyHash, b.bodyHash);
  });

  // C7(a): featureImage is a publication-affecting field (postPayload sends
  // feature_image) and must be bound into the candidateHash manifest. Before
  // the fix, swapping feature_image between two already-included assets left
  // the hash unchanged, so the integrity gate could not see the tamper.
  describe("C7(a): featureImage in the candidateHash manifest", () => {
    test("candidateHash changes when featureImage changes and is stable otherwise", () => {
      const { root, commit, files } = fixtureRepo();
      const base = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files });
      // Rebuild byte-identical inputs: same hash (stability).
      const again = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files: new Map(files) });
      assert.equal(again.candidateHash, base.candidateHash);
      // Swap feature_image to the other included asset: the manifest must move.
      const swappedFiles = new Map(files);
      const markdown = files.get(`${ARTICLE.path}/article.md`).toString("utf8").replace("feature_image: hero.png", "feature_image: img/deep.png");
      swappedFiles.set(`${ARTICLE.path}/article.md`, Buffer.from(markdown));
      const swapped = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files: swappedFiles });
      assert.equal(swapped.featureImage, "img/deep.png");
      assert.deepEqual(swapped.assets.map((asset) => asset.ref), base.assets.map((asset) => asset.ref), "both assets stay included");
      assert.notEqual(swapped.candidateHash, base.candidateHash, "a changed feature image must move the candidate hash");
    });

    test("tampering with feature_image in candidate.json makes loadCandidate refuse (exit 2)", async () => {
      const { root, commit, files } = fixtureRepo();
      const candidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files });
      const outDir = temp("article-out-");
      const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
      await writeCandidate(outDir, candidate, assetBytes);
      // Swap feature_image between the two included assets in candidate.json
      // alone: both assets are still included, so only the manifest field
      // can catch this tamper. Before the fix the swap was invisible.
      const fs = await import("node:fs/promises");
      const jsonPath = path.join(outDir, "candidate.json");
      const json = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      json.featureImage = "img/deep.png";
      await fs.writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
      await assert.rejects(
        () => loadCandidate(outDir),
        (error) => {
          assert.ok(error instanceof RefusedError, "a swapped feature image must refuse");
          assert.match(error.message, /recomputed candidate hash/);
          const { exitCode, outcome } = classifyError(error);
          assert.equal(exitCode, 2);
          assert.equal(outcome, "refused");
          return true;
        },
      );
    });
  });
});

describe("writeCandidate / loadCandidate", () => {
  test("round-trips: candidate, assets and body survive intact", async () => {
    const { root, candidate, files } = buildFixture();
    const outDir = temp("article-out-");
    const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
    const written = await writeCandidate(outDir, candidate, assetBytes);
    assert.ok(written.candidateJson.endsWith("candidate.json"));
    assert.ok(written.bodyHtml.endsWith("body.html"));
    assert.ok(written.previewHtml.endsWith("preview.html"));
    assert.equal(written.assets.length, 2);

    const { candidate: loaded, assetBytes: loadedBytes } = await loadCandidate(outDir);
    assert.equal(loaded.candidateHash, candidate.candidateHash);
    assert.equal(loaded.bodyHash, candidate.bodyHash);
    assert.equal(loaded.title, candidate.title);
    assert.equal(loaded.featureImage, "hero.png");
    for (const asset of candidate.assets) {
      assert.deepEqual(loadedBytes.get(asset.path), files.get(asset.path));
    }
    // preview.html is standalone and its asset paths point at the local copies
    const preview = await import("node:fs/promises").then((fs) => fs.readFile(written.previewHtml, "utf8"));
    assert.match(preview, /<style>/);
    assert.match(preview, /assets\/[0-9a-f]{8}\.png/);
    assert.ok(!preview.includes('src="hero.png"'));
  });

  test("tampering with body.html makes loadCandidate refuse (exit 2)", async () => {
    const { candidate, files } = buildFixture();
    const outDir = temp("article-out-");
    const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
    await writeCandidate(outDir, candidate, assetBytes);
    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(outDir, "body.html"), candidate.bodyHtml.replace("Hello", "Tampered"));
    await assert.rejects(
      () => loadCandidate(outDir),
      (error) => {
        assert.ok(error instanceof RefusedError, "tampered body must refuse");
        assert.match(error.message, /missing, mismatched, or unusable/);
        const { exitCode, outcome } = classifyError(error);
        assert.equal(exitCode, 2);
        assert.equal(outcome, "refused");
        return true;
      },
    );
  });

  test("tampering with an asset makes loadCandidate refuse (exit 2)", async () => {
    const { candidate, files } = buildFixture();
    const outDir = temp("article-out-");
    const assetBytes = new Map(candidate.assets.map((asset) => [asset.path, files.get(asset.path)]));
    const written = await writeCandidate(outDir, candidate, assetBytes);
    const fs = await import("node:fs/promises");
    const hero = written.assets.find((asset) => asset.ref === "hero.png").path;
    await fs.writeFile(hero, "tampered-bytes");
    await assert.rejects(
      () => loadCandidate(outDir),
      (error) => {
        assert.ok(error instanceof RefusedError);
        const { exitCode } = classifyError(error);
        assert.equal(exitCode, 2);
        return true;
      },
    );
  });

  test("a missing candidate directory refuses", async () => {
    await assert.rejects(
      () => loadCandidate(temp("article-empty-")),
      (error) => error instanceof RefusedError && /candidate.json cannot be read/.test(error.message),
    );
  });
});

describe("verifyCandidateForPublish", () => {
  test("a commit candidate from the repo is accepted", () => {
    const { root, candidate } = buildFixture();
    assert.equal(verifyCandidateForPublish(candidate, { repoRoot: root }), true);
  });

  test("a working-tree candidate is refused (exit 2)", () => {
    const { root, commit, files } = fixtureRepo();
    const candidate = buildCandidate({ repoRoot: root, article: ARTICLE, revision: commit, files, kind: "working-tree" });
    assert.throws(
      () => verifyCandidateForPublish(candidate, { repoRoot: root }),
      (error) => {
        assert.ok(error instanceof RefusedError);
        assert.match(error.message, /built from the working tree/);
        const { exitCode } = classifyError(error);
        assert.equal(exitCode, 2);
        return true;
      },
    );
  });

  test("a revision that is not a commit in the repo is refused", () => {
    const { root, candidate } = buildFixture();
    assert.throws(
      () => verifyCandidateForPublish({ ...candidate, source: { ...candidate.source, revision: "0".repeat(40) } }, { repoRoot: root }),
      (error) => error instanceof RefusedError && /not a commit present in/.test(error.message),
    );
  });
});
