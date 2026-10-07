// The durable Ghost-side state, carried as an internal tag on the post
// (#nc-article-<id>): which revision, candidate and body Ghost last holds.
// It is deliberately compact — Ghost caps tag names around 500 characters —
// and deliberately tolerant on read: state written by a different schema
// version or corrupted is "no established state", not a crash, because the
// publish decision must come from what Ghost actually serves, not from the
// tag alone.

import { createHash } from "node:crypto";
import { ValidationError } from "./errors.mjs";

// Ghost caps internal tag names around 500 characters; 500 is the contract.
export const STATE_MAX_LENGTH = 500;

/** The internal tag that carries this pipeline's state for an article. */
export function identityTagName(id) {
  return `#nc-article-${id}`;
}

/** The slug Ghost derives from that internal tag name. */
export function identityTagSlug(id) {
  return `hash-nc-article-${id}`;
}

/** First 16 hex characters of the SHA-256 of a value: short, still collision-safe for our use. */
export function hash16(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 16);
}

const STATE_SCHEMA = 1;

/**
 * Encode the Ghost-side state as a compact JSON string. Short keys keep it
 * under Ghost's ~500-character tag limit; the 16-hex hashes are enough to
 * detect any change (a mismatch anywhere re-reads the post anyway).
 *
 * state: { id, revision, candidateHash, ghostBodyHash, ownedHash,
 *          publishedAt, status, ghostUpdatedAt }
 * Throws ValidationError if the encoded string exceeds 500 characters —
 * before anything is sent.
 */
export function encodeState(state) {
  const encoded = JSON.stringify({
    s: STATE_SCHEMA,
    id: state.id,
    rev: state.revision,
    ch: state.candidateHash ? String(state.candidateHash).slice(0, 16) : null,
    gh: state.ghostBodyHash ? String(state.ghostBodyHash).slice(0, 16) : null,
    ow: state.ownedHash ? String(state.ownedHash).slice(0, 16) : null,
    pa: state.publishedAt ?? null,
    st: state.status ?? null,
    up: state.ghostUpdatedAt ?? null,
    ...(state.pending ? { next: { rev: state.pending.revision, ch: state.pending.candidateHash.slice(0, 16) } } : {}),
  });
  if (encoded.length > STATE_MAX_LENGTH) {
    throw new ValidationError(
      `The article state for "${state.id}" encodes to ${encoded.length} characters, over the ${STATE_MAX_LENGTH}-character limit Ghost places on tag names. Nothing was sent.`,
    );
  }
  return encoded;
}

/**
 * Whether two states say the same published content: true when the
 * states' content fingerprints (candidate, stored body, owned fields,
 * status) agree and both or neither record a stored-body hash. The
 * revision, publishedAt and ghostUpdatedAt are provenance, not content;
 * two runs of the same content from the same commit must read as the same
 * state, and the recorded-for-run fields never describe what Ghost serves.
 * Both arguments may be null: null is "no state", which never equals a
 * present state and never equals a second null (two unknowns are not one
 * known).
 */
export function stateSameContent(a, b) {
  if (!a || !b) return false;
  // Like-for-like: encodeState stores the fingerprints truncated to 16 hex
  // while callers hold full digests, so both sides are truncated here.
  const hex16 = (value) => (value == null ? null : String(value).slice(0, 16));
  if ((a.ghostBodyHash == null) !== (b.ghostBodyHash == null)) return false;
  return (
    hex16(a.candidateHash) === hex16(b.candidateHash) &&
    hex16(a.ghostBodyHash) === hex16(b.ghostBodyHash) &&
    hex16(a.ownedHash) === hex16(b.ownedHash) &&
    a.status === b.status
  );
}

/**
 * Decode stored state. Anything that is not exactly our schema — not JSON,
 * another schema, another shape — is no established state, returned as null;
 * a malformed stored tag must never throw and must never be trusted.
 */
export function decodeState(text) {
  if (typeof text !== "string" || !text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (parsed.s !== STATE_SCHEMA) return null;
  if (typeof parsed.id !== "string" || !parsed.id) return null;
  return {
    id: parsed.id,
    revision: typeof parsed.rev === "string" ? parsed.rev : null,
    candidateHash: typeof parsed.ch === "string" ? parsed.ch : null,
    ghostBodyHash: typeof parsed.gh === "string" ? parsed.gh : null,
    ownedHash: typeof parsed.ow === "string" ? parsed.ow : null,
    publishedAt: typeof parsed.pa === "string" ? parsed.pa : null,
    status: typeof parsed.st === "string" ? parsed.st : null,
    ghostUpdatedAt: typeof parsed.up === "string" ? parsed.up : null,
    ...(parsed.next?.rev && parsed.next?.ch ? { pending: { revision: parsed.next.rev, candidateHash: parsed.next.ch } } : {}),
  };
}
