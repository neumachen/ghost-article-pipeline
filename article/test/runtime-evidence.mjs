import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

assert.notEqual(process.getuid(), 0);
assert.notEqual(process.getgid(), 0);
assert.equal(existsSync("/app/test"), false, "production image contains tests");
assert.equal(existsSync("/opt/article-ownership"), false, "production image contains test fixtures");
for (const tool of ["npm", "npx", "yarn", "yarnpkg"]) assert.equal(existsSync(`/usr/local/bin/${tool}`), false, `${tool} remains in production`);
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
for (const dir of ["/app", "/repo"]) {
  const file = `${dir}/.article-write-probe-${randomUUID()}`;
  try {
    assert.throws(() => writeFileSync(file, "probe"), error => ["EROFS", "EACCES"].includes(error.code), `${dir} must reject writes`);
  } finally {
    if (existsSync(file)) rmSync(file);
  }
}
for (const root of ["/out", "/tmp"]) {
  const dir = mkdtempSync(`${root}/article-runtime-`);
  try {
    writeFileSync(`${dir}/output`, "writable");
    assert.equal(readFileSync(`${dir}/output`, "utf8"), "writable");
  } finally {
    rmSync(dir, { recursive: true });
  }
}
assert.equal(process.env.GHOST_ADMIN_API_KEY, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), rootFilesystem: "read-only", repository: "read-only", capabilities: "none", noNewPrivileges: true, writable: ["/out", "/tmp"], testsInProduction: false }));
