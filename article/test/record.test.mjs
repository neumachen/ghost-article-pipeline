// record.mjs: the run record writes atomically and the job summary tells
// the operator what happened — including, for uncertain and
// public-check-failed outcomes, NOT to re-run blindly.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { RunRecord, baseRecord, finish, renderSummary } from "../src/record.mjs";

const dirs = [];
const temp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
after(() => {
  while (dirs.length) dirs.pop()();
});

describe("RunRecord", () => {
  test("writes atomically: no tmp file is left behind and the file is always complete", () => {
    const file = path.join(temp("article-record-"), "record.json");
    const record = new RunRecord(file, baseRecord("publish", "release", {}));
    assert.ok(!existsSync(`${file}.tmp`));
    record.set({ article: { id: "hello-world" } });
    record.step("build", "started");
    record.step("build", "ok");
    record.step("upload", "sending", { request_sent: true });
    record.step("upload", "ok");
    const data = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(data.article.id, "hello-world");
    assert.equal(data.steps.length, 2);
    // one step each: "started" then "ok" moved the same step on
    assert.equal(data.steps.filter((step) => step.name === "build").length, 1);
    assert.ok(data.steps[0].started_at);
    assert.ok(data.steps[0].finished_at);
    assert.equal(data.steps[1].request_sent, true);
    assert.ok(!existsSync(`${file}.tmp`));
  });

  test("baseRecord carries the github context when GITHUB_* is present", () => {
    const data = baseRecord("publish", "release", {
      GITHUB_REPOSITORY: "neumachen/neumachen.dev",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_ACTOR: "kareem",
    });
    assert.equal(data.github.repository, "neumachen/neumachen.dev");
    assert.equal(data.github.run_id, "123");
    assert.equal(data.github.run_url, "https://github.com/neumachen/neumachen.dev/actions/runs/123");
    assert.equal(data.github.workflow_sha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(data.github.actor, "kareem");
    const local = baseRecord("publish", "release", {});
    assert.equal(local.github.repository, null);
    assert.equal(local.github.run_url, null);
  });
});

describe("finish", () => {
  test("sets finished_at and reports the outcome", () => {
    const file = path.join(temp("article-finish-"), "record.json");
    const record = new RunRecord(file, baseRecord("publish", "release", {}));
    const result = finish(record, { outcome: "created", exit_code: 0, message: "Published." }, () => {});
    assert.equal(result.exitCode, 0);
    assert.ok(result.record.finished_at);
    assert.equal(result.record.outcome, "created");
  });
});

describe("renderSummary", () => {
  const base = (fields) => ({
    schema: "neumachen-article-record/1",
    operation: "publish",
    mode: "release",
    article: { id: "hello-world" },
    revision: "1".repeat(40),
    candidate_hash: "a".repeat(64),
    ghost_origin: "https://example.invalid/ghost",
    post: { id: "5", uuid: "u-5", slug: "hello-world" },
    published_at: "2026-09-24T12:00:00.000Z",
    status: "published",
    live_changed: "yes",
    steps: [{ name: "upload", status: "ok", started_at: "t", finished_at: "t" }],
    outcome: "created",
    exit_code: 0,
    message: "Published hello-world.",
    github: { run_id: "9" },
    ...fields,
  });

  test("includes the required fields for a created outcome", () => {
    const summary = renderSummary(base());
    assert.match(summary, /## Article pipeline: Published/);
    for (const field of ["hello-world", "a".repeat(64), "https:\/\/example.invalid\/ghost", "u-5", "2026-09-24T12:00:00.000Z"]) {
      assert.ok(summary.includes(field), `summary must include ${field}`);
    }
    assert.match(summary, /\| Live site changed \| yes \|/);
    assert.match(summary, /\| Exit code \| 0 \|/);
    assert.match(summary, /- upload: \*\*ok\*\*/);
    assert.match(summary, /Published hello-world\./);
    assert.doesNotMatch(summary, /Before doing anything else/);
  });

  for (const [outcome, headline] of [
    ["updated", "Updated"],
    ["unchanged", "Nothing to change"],
    ["planned", "Planned"],
    ["refused", "Refused"],
    ["rejected", "Rejected by Ghost"],
    ["unauthorised-effects", "UNAUTHORISED CHANGE"],
    ["uncertain", "UNCERTAIN"],
    ["public-check-failed", "CONFIRMED CHANGE"],
    ["error", "Failed before anything that changes Ghost was sent"],
    ["running", "INTERRUPTED"],
  ]) {
    test(`headline for ${outcome}`, () => {
      const summary = renderSummary(base({ outcome, exit_code: outcome === "planned" ? 0 : 5 }));
      assert.match(summary, new RegExp(headline));
    });
  }

  test("uncertain outcomes carry the do-not-re-run note", () => {
    for (const outcome of ["uncertain", "public-check-failed"]) {
      const summary = renderSummary(base({ outcome, exit_code: outcome === "uncertain" ? 5 : 6, live_changed: "unknown" }));
      assert.match(summary, /### Before doing anything else/);
      assert.match(summary, /Do not re-run the publication blindly/);
    }
  });

  test("a null record renders the no-record explanation", () => {
    assert.match(renderSummary(null), /No record was written/);
  });

  test("an interrupted run with an in-flight step says the effect is unknown", () => {
    const summary = renderSummary(
      base({
        outcome: "running",
        exit_code: null,
        steps: [{ name: "upload", status: "sending", started_at: "t" }],
      }),
    );
    assert.match(summary, /may have been in flight/);
    assert.match(summary, /do not simply re-run/);
    assert.match(summary, /### Before doing anything else/);
  });
});
