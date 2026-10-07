// identity.mjs: the durable Ghost-side state. Compact on the way in (Ghost
// caps tag names around 500 characters), tolerant on the way out (malformed
// stored state is "no established state", never a crash).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeState, encodeState, hash16, identityTagName, identityTagSlug } from "../src/identity.mjs";
import { ValidationError } from "../src/errors.mjs";

const state = () => ({
  id: "hello-world",
  revision: "1".repeat(40),
  candidateHash: "a".repeat(64),
  ghostBodyHash: "b".repeat(64),
  ownedHash: "c".repeat(64),
  publishedAt: "2026-09-24T12:00:00.000Z",
  status: "published",
  ghostUpdatedAt: "2026-09-24T12:00:01.000Z",
});

describe("identity tags", () => {
  test("the tag name and slug are derived from the article id", () => {
    assert.equal(identityTagName("hello-world"), "#nc-article-hello-world");
    assert.equal(identityTagSlug("hello-world"), "hash-nc-article-hello-world");
  });
});

describe("encodeState / decodeState", () => {
  test("round-trips a full state (hashes truncated to 16 hex, as encoded)", () => {
    const encoded = encodeState(state());
    assert.ok(encoded.length <= 500, `encoded state is ${encoded.length} chars`);
    const decoded = decodeState(encoded);
    // Encode deliberately truncates the 64-hex hashes to 16 hex (Ghost caps
    // tag names), so the round trip returns the truncated forms.
    assert.deepEqual(decoded, {
      ...state(),
      candidateHash: "a".repeat(16),
      ghostBodyHash: "b".repeat(16),
      ownedHash: "c".repeat(16),
    });
  });

  test("truncates the 64-hex hashes to 16 hex on encode", () => {
    const encoded = encodeState(state());
    assert.match(encoded, /"ch":"a{16}"/);
    assert.equal(decodeState(encoded).candidateHash, "a".repeat(16));
  });

  test("refuses a state that encodes over 500 characters", () => {
    // The realistic worst case (64-char id, 40-hex revision, timestamps) is
    // ~280 characters, comfortably under the limit; only a hostile field can
    // cross it (a 300-char revision below), and crossing it must be refused
    // before anything is sent.
    assert.throws(
      () =>
        encodeState({ ...state(), id: "i".repeat(64), revision: "r".repeat(300) }),
      (error) => error instanceof ValidationError && /over the 500-character limit/.test(error.message),
    );
    // The realistic worst case stays well under the limit and is accepted.
    const worst = { ...state(), id: "x".repeat(64) };
    assert.ok(encodeState(worst).length <= 500);
  });

  test("malformed stored state decodes to null, never throws", () => {
    for (const bad of ["", "not json", "42", "[]", "null", '{"s":2,"id":"x"}', '{"id":"x"}', '{"s":1}', "undefined"]) {
      assert.equal(decodeState(bad), null, `decodeState(${JSON.stringify(bad)}) must be null`);
    }
    assert.equal(decodeState(null), null);
    assert.equal(decodeState(undefined), null);
  });

  test("partial state still decodes its known fields", () => {
    const decoded = decodeState('{"s":1,"id":"hello-world","st":"draft"}');
    assert.deepEqual(decoded, {
      id: "hello-world",
      revision: null,
      candidateHash: null,
      ghostBodyHash: null,
      ownedHash: null,
      publishedAt: null,
      status: "draft",
      ghostUpdatedAt: null,
    });
  });
});

describe("hash16", () => {
  test("is the first 16 hex of sha256 and stable", () => {
    assert.match(hash16("x"), /^[0-9a-f]{16}$/);
    assert.equal(hash16("x"), hash16("x"));
    assert.notEqual(hash16("x"), hash16("y"));
  });
});
