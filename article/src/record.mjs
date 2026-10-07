// The run record for an article pipeline run, mirroring the good parts of
// tools/theme-release.mjs's RunRecord: a JSON file rewritten in full after
// every change of state, written atomically (tmp + rename), so a reader
// never sees half a record and a run that dies mid-request still says which
// request may have been sent.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ValidationError } from "./errors.mjs";

export const RECORD_SCHEMA = "neumachen-article-record/1";

const now = () => new Date().toISOString();

/**
 * The run's JSON record. step(name, status, detail) moves the most recent
 * unfinished step of that name on when one is open, so "sending" then "ok"
 * is one step, not two. A step is terminal unless its status is
 * started/sending; steps carry started_at/finished_at and request_sent
 * where set.
 */
export class RunRecord {
  constructor(file, data) {
    this.file = file;
    this.data = data;
    this.save();
  }

  set(fields) {
    Object.assign(this.data, fields);
    this.save();
  }

  /**
   * Record one mutation of one kind. A string value replaces (the post and the
   * tags have one fate each); a number accumulates (assets are counted).
   */
  mutate(kind, change = 1) {
    const mutations = this.data.mutations ?? (this.data.mutations = {});
    mutations[kind] = typeof change === "number" ? (mutations[kind] ?? 0) + change : change;
    this.save();
  }

  step(name, status, detail = {}) {
    const open = this.data.steps.findLast((step) => step.name === name && !step.finished_at);
    const terminal = !["started", "sending"].includes(status);
    if (open) {
      Object.assign(open, { status, ...detail }, terminal ? { finished_at: now() } : {});
    } else {
      this.data.steps.push({
        name,
        status,
        started_at: now(),
        ...detail,
        ...(terminal ? { finished_at: now() } : {}),
      });
    }
    this.save();
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(temporary, this.file);
  }
}

/**
 * A fresh run's base record. The github block reads only what GitHub itself
 * put in the environment; nothing here is invented when a run is local.
 */
export function baseRecord(operation, mode, env = process.env) {
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  return {
    schema: RECORD_SCHEMA,
    operation,
    mode,
    started_at: now(),
    finished_at: null,
    github: {
      repository: env.GITHUB_REPOSITORY ?? null,
      run_id: env.GITHUB_RUN_ID ?? null,
      run_attempt: env.GITHUB_RUN_ATTEMPT ?? null,
      run_url: runUrl,
      workflow_sha: env.GITHUB_SHA ?? null,
      actor: env.GITHUB_ACTOR ?? null,
    },
    // The ACTUAL execution environment of THIS run: the immutable image id the
    // launcher built and ran, its human-readable tag, the platform, and the
    // Node inside it. A candidate carries the environment it was BUILT in; a
    // publication record carries the environment it was PUBLISHED from, and
    // those are two different runs — Article CI prepares, the publish workflow
    // runs later against an image it built itself. Both belong in the record's
    // provenance, so "what produced this change" is answerable from the record
    // alone without trusting a tag that can be moved.
    environment: {
      image: env.ARTICLE_IMAGE ?? null,
      image_tag: env.ARTICLE_IMAGE_TAG ?? null,
      platform: env.ARTICLE_PLATFORM ?? null,
      node: process.version,
    },
    ghost_origin: null,
    article: null,
    revision: null,
    candidate_hash: null,
    post: null,
    published_at: null,
    status: null,
    live_changed: "no",
    // What this run actually changed in Ghost, counted by kind. `live_changed`
    // answers "did the LIVE SITE change"; this answers "did Ghost change", and
    // the two are not the same question: rewriting the state tag changes Ghost
    // and changes nothing a reader can see. A run that only repaired a tag must
    // not read as "nothing changed", and a run that uploaded one image and
    // reused four must not read as "five uploads".
    mutations: { post: "none", assets_uploaded: 0, assets_reused: 0, assets_uncertain: 0, tags: "none", asset_receipts_created: 0, asset_receipts_uncertain: 0 },
    steps: [],
    outcome: "running",
    exit_code: null,
    message: null,
  };
}

/**
 * Finish a run: set the final fields, then report. The message goes to
 * stderr unless the run succeeded, the same way tools/theme-release.mjs
 * does it, because a caller grepping for the failure sees it on the
 * failing stream.
 */
export function finish(record, fields, log = console.log) {
  record.set({ ...fields, finished_at: now() });
  const { outcome, exit_code: exitCode, message } = record.data;
  if (message) (exitCode === 0 ? log : console.error)(`\n${message}`);
  log(`\nOutcome: ${outcome} (exit ${exitCode}). Live site changed: ${record.data.live_changed}.`);
  log(`Ghost mutations: ${describeMutations(record.data)}`);
  return { exitCode, record: record.data };
}

// --- job summary --------------------------------------------------------------------

const HEADLINES = {
  created: "Published",
  updated: "Updated",
  unchanged: "Nothing to change",
  "state-repaired": "State repaired — the live site was not changed, one tag was written",
  planned: "Planned — nothing that changes Ghost was sent",
  refused: "Refused — nothing that changes Ghost was sent",
  rejected: "Rejected by Ghost",
  conflict: "CONFLICT — Ghost has a newer edit than this pipeline recorded",
  "unauthorised-effects": "UNAUTHORISED CHANGE — the live site changed unexpectedly",
  uncertain: "UNCERTAIN — Ghost may have changed",
  "state-uncertain": "CONFIRMED CHANGE — but the recorded pipeline state was not confirmed",
  "public-check-failed": "CONFIRMED CHANGE — but the public page could not be verified",
  error: "Failed before anything that changes Ghost was sent",
  running: "INTERRUPTED",
};

const code = (value) => (value ? `\`${value}\`` : "—");

/**
 * One line naming every kind of Ghost mutation this run made, for the console
 * and the job summary. "none" everywhere is a true statement only when nothing
 * was written — including the state tag.
 */
export function describeMutations(data) {
  const m = data?.mutations;
  if (!m) return "not accounted";
  const assets =
    m.assets_uploaded || m.assets_reused || m.assets_uncertain
      ? `${m.assets_uploaded} uploaded, ${m.assets_reused} reused${m.assets_uncertain ? `, ${m.assets_uncertain} uncertain` : ""}`
      : "none touched";
  const receipts = m.asset_receipts_created || m.asset_receipts_uncertain
    ? ` · asset receipts ${m.asset_receipts_created ?? 0} created, ${m.asset_receipts_uncertain ?? 0} uncertain` : "";
  return `post ${m.post ?? "none"} · assets ${assets} · tags ${m.tags ?? "none"}${receipts}`;
}

const escapeCell = (value) => (value === null || value === undefined ? "—" : String(value).replace(/\|/g, "\\|"));

/**
 * Markdown describing a record, for $GITHUB_STEP_SUMMARY. For uncertain and
 * public-check-failed outcomes the operator is told, before anything else,
 * NOT to re-run blindly: a repeat may publish a duplicate or a second change
 * whose first copy's fate is still unknown.
 */
export function renderSummary(data) {
  if (!data) {
    return [
      "## Article pipeline",
      "",
      "No record was written: this job stopped before contacting Ghost, so nothing was sent to it.",
      "See the failed step above.",
      "",
    ].join("\n");
  }

  const interrupted = data.outcome === "running";
  const inFlight = data.steps?.find((step) => step.status === "sending" && !step.finished_at);
  const lines = [`## Article pipeline: ${HEADLINES[data.outcome] ?? data.outcome}`, ""];

  if (interrupted) {
    lines.push(
      inFlight
        ? `> **The run stopped while the ${inFlight.name} request may have been in flight. Its effect is ` +
            "unknown.** Read the post in Ghost Admin before doing anything else, and do not simply re-run."
        : "> **The run stopped before finishing.** No request that changes Ghost was in flight when it stopped.",
      "",
    );
  }

  lines.push("| | |", "| --- | --- |");
  lines.push(`| Article | ${escapeCell(data.article?.id)} |`);
  lines.push(`| Revision | ${code(data.revision)} |`);
  lines.push(`| Candidate | ${code(data.candidate_hash)} |`);
  if (data.ghost_origin) lines.push(`| Ghost Admin API | ${data.ghost_origin} |`);
  if (data.post) {
    lines.push(`| Post | id ${code(data.post.id)} uuid ${code(data.post.uuid)} |`);
    if (data.post.slug) lines.push(`| Slug | ${code(data.post.slug)} |`);
  }
  lines.push(`| Published at | ${code(data.published_at)} |`);
  lines.push(`| Status | ${code(data.status)} |`);
  lines.push(`| Live site changed | ${interrupted && inFlight ? "unknown" : data.live_changed} |`);
  lines.push(`| Ghost mutations | ${escapeCell(describeMutations(data))} |`);
  if (data.environment?.image || data.environment?.platform) {
    lines.push(
      `| Execution image | ${code(data.environment.image ?? data.environment.image_tag)}${
        data.environment.platform ? ` (${escapeCell(data.environment.platform)})` : ""
      } |`,
    );
  }
  lines.push(`| Exit code | ${data.exit_code ?? "—"} |`);
  lines.push("");

  if (data.steps?.length) {
    lines.push("Steps:", "");
    for (const step of data.steps) {
      const detail = step.error ? ` — ${step.error.split("\n")[0]}` : "";
      lines.push(`- ${step.name}: **${step.status}**${detail}`);
    }
    lines.push("");
  }

  if (data.message) lines.push("```", data.message, "```", "");

  if (["uncertain", "state-uncertain", "public-check-failed", "unauthorised-effects", "conflict"].includes(data.outcome) || (interrupted && inFlight)) {
    lines.push(
      "### Before doing anything else",
      "",
      "Do not re-run the publication blindly. Its outcome is not established:",
      data.outcome === "public-check-failed"
        ? "- The Ghost mutation is CONFIRMED, but the public page check failed, so re-running may publish a duplicate."
        : data.outcome === "state-uncertain"
          ? "- The Ghost mutation is CONFIRMED, but the recorded pipeline state was not confirmed, so re-running may report a false conflict."
          : data.outcome === "conflict"
            ? "- The post was edited in Ghost since the last publish this pipeline recorded, so re-running would overwrite that edit. Reconcile by hand."
            : "- A request that changes Ghost was sent and its effect is unknown, so re-running may apply a second change.",
      "",
      "Check the post in Ghost Admin and on the public site, compare with the candidate, then decide.",
      "",
    );
  }
  return lines.join("\n");
}
