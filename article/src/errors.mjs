// Exit codes and error classes shared by the article pipeline. They extend
// the convention tools/ghost-admin.mjs established, because that convention
// is what a caller reads to tell "nothing was sent" from "the site may have
// changed": each code records where a run stopped, not merely that it failed.
//
//   0  done or planned
//   1  an unexpected error before anything that changes Ghost was sent
//   2  refused before any mutating request; nothing was sent
//   3  the remote rejected a request; that request changed nothing
//   4  a change took effect that was not authorised
//   5  a mutating request was sent and its outcome is unknown
//   6  the Ghost mutation is CONFIRMED but the public-page check failed; the
//      caller must not blindly repeat the publication

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;
export const EXIT_REMOTE = 3;
export const EXIT_EFFECTS = 4;
export const EXIT_UNCERTAIN = 5;
export const EXIT_PUBLIC = 6;

export class PipelineError extends Error {}

export class UsageError extends PipelineError {} // 1
export class ConfigError extends PipelineError {} // 2
export class ValidationError extends PipelineError {} // 2
export class RefusedError extends PipelineError {} // 2
export class RemoteError extends PipelineError {} // 3
// 409 from an update: Ghost holds a newer edit than this pipeline recorded.
// Nothing was overwritten; the operator must reconcile the edit by hand.
export class ConflictError extends PipelineError {} // 3
export class EffectsError extends PipelineError {} // 4
export class UncertainError extends PipelineError {} // 5
export class PublicCheckError extends PipelineError {} // 6

const OUTCOMES = new Map([
  [UsageError, { exitCode: EXIT_ERROR, outcome: "error" }],
  [ConfigError, { exitCode: EXIT_REFUSED, outcome: "refused" }],
  [ValidationError, { exitCode: EXIT_REFUSED, outcome: "refused" }],
  [RefusedError, { exitCode: EXIT_REFUSED, outcome: "refused" }],
  [RemoteError, { exitCode: EXIT_REMOTE, outcome: "rejected" }],
  [ConflictError, { exitCode: EXIT_REMOTE, outcome: "conflict" }],
  [EffectsError, { exitCode: EXIT_EFFECTS, outcome: "unauthorised-effects" }],
  [UncertainError, { exitCode: EXIT_UNCERTAIN, outcome: "uncertain" }],
  [PublicCheckError, { exitCode: EXIT_PUBLIC, outcome: "public-check-failed" }],
]);

// Map order: registered subclasses before ConfigError, so subclass tests do
// not let every error fall through to the base PipelineError match first.
// (ConfigError is deliberately listed before its role-specific subclasses so
// that role-specific classes stay preferred.)
export function classifyError(error) {
  for (const [errorClass, outcome] of OUTCOMES) {
    if (error instanceof errorClass) return { ...outcome };
  }
  return { exitCode: EXIT_ERROR, outcome: "error" };
}
