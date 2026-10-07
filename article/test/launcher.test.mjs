import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const imageId = `sha256:${"a".repeat(64)}`;

function launch(args, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "article-launcher-"));
  try {
    for (const dir of ["tools/article", "article", "bin"]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync("/repo/tools/article/run.sh", join(root, "tools/article/run.sh"));
    writeFileSync(join(root, "bin/docker.mjs"), `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'image') {
  const format = args[args.indexOf('--format') + 1];
  if (args.includes('--format')) {
    console.log(format.includes('.Id') ? '${imageId}' : format.includes('.Os') ? 'linux/amd64' : format.includes('Labels') ? process.env.FAKE_TARGET : process.env.FAKE_USER);
  }
} else appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
`);
    writeFileSync(join(root, "bash-env"), 'docker() { /usr/local/bin/node "$FAKE_DOCKER" "$@"; }\nexec() { if [ "$1" = docker ]; then shift; docker "$@"; else builtin exec "$@"; fi; }\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ARTICLE_|GHOST_|GITHUB_|RUNNER_)/.test(key)));
    Object.assign(env, {
      BASH_ENV: join(root, "bash-env"), FAKE_DOCKER: join(root, "bin/docker.mjs"), FAKE_LOG: join(root, "calls"),
      FAKE_TARGET: "production", FAKE_USER: "1000:1000", ARTICLE_UID: "1001", ARTICLE_GID: "1001",
      GHOST_ADMIN_API_KEY: "dummy-never-forward-by-default", GITHUB_TOKEN: "dummy-never-forward-by-default",
    }, overrides);
    const result = spawnSync("bash", [join(root, "tools/article/run.sh"), ...args], { env, encoding: "utf8" });
    let calls = [];
    try { calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.doesNotMatch(result.stdout + result.stderr, /dummy-never-forward-by-default/);
    return { ...result, calls, root, run: calls.find(call => call[0] === "run") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("launcher applies production isolation and uses the inspected immutable image", () => {
  const result = launch(["--", "node", "src/cli.mjs", "validate"]);
  assert.equal(result.status, 0, result.stderr);
  for (const arg of ["--read-only", "ALL", "no-new-privileges=true", "1001:1001", "/tmp:rw,noexec,nosuid,nodev,mode=1777", `${result.root}:/repo:ro`, imageId]) assert.ok(result.run.includes(arg), arg);
  assert.ok(!result.run.includes("GHOST_ADMIN_API_KEY"));
  assert.ok(!result.run.includes("GITHUB_TOKEN"));
  assert.match(result.stdout, /neumachen-article-pipeline:production/);
});

test("launcher limits each credential to the production command that needs it", () => {
  for (const operation of ["plan", "publish", "verify", "select-artifact", "fetch-artifact", "prepare", "summary"]) {
    const result = launch(["node", "src/cli.mjs", operation]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.run.includes("GHOST_ADMIN_API_KEY"), ["plan", "publish", "verify"].includes(operation), operation);
    assert.equal(result.run.includes("GITHUB_TOKEN"), ["select-artifact", "fetch-artifact"].includes(operation), operation);
  }
});

test("test target builds explicitly and receives no production credentials", () => {
  const result = launch(["node", "--test", "test/*.test.mjs"], { ARTICLE_TARGET: "test", FAKE_TARGET: "test", ARTICLE_REBUILD: "1" });
  assert.equal(result.status, 0, result.stderr);
  const build = result.calls.find(call => call[0] === "build");
  assert.equal(build[build.indexOf("--target") + 1], "test");
  assert.ok(build.includes("neumachen-article-pipeline:test"));
  assert.ok(!result.run.includes("GHOST_ADMIN_API_KEY"));
  assert.ok(!result.run.includes("GITHUB_TOKEN"));
  assert.ok(result.run.includes("ARTICLE_INTEGRATION_URL"));
});

test("launcher refuses root, writable repositories and incorrectly labelled images", () => {
  for (const env of [{ ARTICLE_UID: "0" }, { ARTICLE_GID: "0" }, { ARTICLE_MOUNT_RW: "1" }, { FAKE_TARGET: "test" }, { FAKE_USER: "" }]) {
    const result = launch(["node", "src/cli.mjs", "validate"], env);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.run, undefined);
  }
});

test("only the production Node test command can mount the disposable test suite", () => {
  const result = launch(["node", "--test", "test/*.test.mjs"], { ARTICLE_TEST_MOUNT: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.run.includes(`${result.root}/article/test:/app/test:ro`));
  assert.ok(!result.run.includes("GHOST_ADMIN_API_KEY"));
  assert.ok(!result.run.includes("GITHUB_TOKEN"));
  const invalid = launch(["node", "src/cli.mjs", "publish"], { ARTICLE_TEST_MOUNT: "1" });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.run, undefined);
});
