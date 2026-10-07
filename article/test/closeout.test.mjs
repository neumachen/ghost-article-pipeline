import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAssetUrls, recordAssetUpload } from "../src/asset-store.mjs";
import { sha256 as sha256Hex } from "../src/assets.mjs";
import { candidateImageSrcShape, decide } from "../src/publish.mjs";
import { encodeState, decodeState } from "../src/identity.mjs";
import { storedBodyEquals } from "../src/verify.mjs";
import { ghostBodyHash } from "../src/normalize.mjs";

test("code verification preserves indentation and literal example markup", () => {
  const a = "<pre><code>if x:\n    run()\n&lt;img src=&quot;example.png&quot;&gt;</code></pre>";
  const b = "<pre><code>if x:\nrun()\n&lt;img src=&quot;example.png&quot;&gt;</code></pre>";
  assert.equal(storedBodyEquals(a, a).ok, true);
  assert.equal(storedBodyEquals(a, b).ok, false);
  assert.notEqual(ghostBodyHash(a), ghostBodyHash(b));
  assert.equal(storedBodyEquals(a, a.replace("example.png", "different.png")).ok, false);
});

test("asset proof never equates different URLs by basename", () => {
  const candidate = { assets: [{ ref: "assets/a.png" }], assetUrls: { "assets/a.png": "https://ghost.test/known/a.png" } };
  const shape = candidateImageSrcShape(candidate);
  assert.equal(shape("https://ghost.test/known/a.png"), "assets/a.png");
  assert.notEqual(shape("https://elsewhere.test/other/a.png"), "assets/a.png");
});

test("a durable receipt reuses transformed bytes and rejects changed stored bytes", async () => {
  const source = Buffer.from("original JPEG");
  let stored = Buffer.from("Ghost optimized JPEG");
  const candidate = { article: { id: "asset-test" }, assets: [{ ref: "assets/a.jpg", sha256: sha256Hex(source) }] };
  const tags = new Map();
  const ghost = {
    findTagBySlug: async (slug) => tags.get(slug) ?? null,
    createTag: async (tag) => { const saved = { ...tag, id: "receipt" }; tags.set(tag.slug, saved); return saved; },
    fetchPublic: async () => ({ status: 200, bytes: stored }),
  };
  const record = { step() {}, mutate() {} };
  await recordAssetUpload(ghost, candidate, candidate.assets[0], "https://ghost.test/optimized.jpg", record);
  assert.deepEqual(await resolveAssetUrls(ghost, candidate, null), { "assets/a.jpg": "https://ghost.test/optimized.jpg" });
  stored = Buffer.from("somebody replaced the image");
  await assert.rejects(resolveAssetUrls(ghost, candidate, null), /changed since upload/);
});

test("pending publication keeps the previous confirmed state across interruption", () => {
  const previous = { id: "state-test", revision: "a".repeat(40), candidateHash: "b".repeat(64),
    ghostBodyHash: "c".repeat(64), ownedHash: "d".repeat(64), ghostUpdatedAt: "2026-10-05T00:00:00.000Z", status: "published" };
  const pending = { revision: "e".repeat(40), candidateHash: "f".repeat(64) };
  const decoded = decodeState(encodeState({ ...previous, pending }));
  assert.equal(decoded.revision, previous.revision);
  assert.equal(decoded.ghostBodyHash, "c".repeat(16));
  assert.equal(decoded.pending.candidateHash, "f".repeat(16));
  const result = decide({ managed: { id: "post", updated_at: "new" }, priorState: decoded,
    candidate: { source: { revision: pending.revision } }, candidateHash16: "f".repeat(16),
    liveContentMatchesCandidate: true });
  assert.equal(result.action, "unchanged");
});

test("CLI defaults use HEAD registry; explicit working tree uses mutable enrollment; empty preparation emits zero", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "article-selection-"));
  const cli = path.resolve(import.meta.dirname, "../src/cli.mjs");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GITHUB_OUTPUT: path.join(root, "output") };
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@localhost.invalid", "-c", "commit.gpgsign=false", ...args], { env, stdio: "pipe" });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--repo", root], { env, encoding: "utf8" });
  try {
    mkdirSync(path.join(root, "editorial/articles"), { recursive: true });
    const registry = path.join(root, "editorial/articles/registry.json");
    writeFileSync(registry, JSON.stringify({ schema: "neumachen-article-registry/1", articles: [] }));
    git("init", "--initial-branch", "main"); git("add", "."); git("commit", "-m", "empty registry");
    writeFileSync(registry, "invalid YAML and JSON");
    for (const command of [["validate"], ["prepare", "--out", path.join(root, "candidates")]]) {
      const result = run(...command);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /candidate_count=0/);
    assert.equal(run("validate", "--working-tree").status, 2);
    assert.equal(run("preview", "--article", "missing", "--out", path.join(root, "preview.html")).status, 2);
    const entry = { id: "selection", path: "editorial/articles/selection" };
    mkdirSync(path.join(root, entry.path), { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "neumachen-article-registry/1", articles: [entry] }));
    writeFileSync(path.join(root, entry.path, "article.md"), "---\nid: selection\ntitle: Selected\nslug: selected\nstatus: draft\nauthors: []\ntags: []\n---\n\nCommitted prose.");
    git("add", "."); git("commit", "-m", "enroll");
    writeFileSync(registry, "invalid working-tree registry");
    const output = path.join(root, "populated");
    for (const command of [["validate"], ["prepare", "--out", output], ["preview", "--article", "selection", "--out", path.join(root, "preview.html")]]) {
      const result = run(...command);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /candidate_count=1/);
    const prepared = path.join(output, "selection");
    assert.equal(run("inspect", "--candidate", prepared).status, 0);
    rmSync(path.join(prepared, "candidate.json"));
    assert.notEqual(run("inspect", "--candidate", prepared).status, 0, "expected output missing is an error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
