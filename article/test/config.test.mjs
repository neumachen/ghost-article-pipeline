// config.mjs: the pipeline's Ghost Admin configuration. The validation
// deliberately mirrors tools/ghost-admin.mjs's loadConfig (the pipeline runs
// in a container where that file is not on the module path), so these tests
// pin the mirrored rules: missing URL, missing key, malformed key, non-https
// non-local URL, valid localhost http URL, valid https URL — and that a
// thrown message never contains the key value.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { ConfigError, loadConfig, loadGhostConfig } from "../src/config.mjs";
import { classifyError } from "../src/errors.mjs";

const KEY_ID = "6529e4a1b2c3d4e5f6a7b8c9";
const KEY_SECRET = "a".repeat(64);
const VALID_KEY = `${KEY_ID}:${KEY_SECRET}`;

const REFUSAL_PREAMBLE = "Ghost Admin API is not configured, so no request was made.";
const REFUSAL_GUIDANCE = [
  "In Ghost Admin: Settings -> Integrations -> Add custom integration.",
  "See docs/TOOLING.md. Do not commit the key.",
];

// Tests mutate process.env, so each one starts from a clean slate and every
// test cleans up after itself.
const ENV_KEYS = ["GHOST_ADMIN_API_URL", "GHOST_ADMIN_API_KEY"];
const setEnv = (values) => {
  for (const name of ENV_KEYS) {
    if (name in values) process.env[name] = values[name];
    else delete process.env[name];
  }
};

/** Asserts that loadConfig refuses with the expected problem line, and that
 * the thrown message leaks neither the key value nor its secret. */
function assertRefusal({ with: env, problem }) {
  setEnv(env);
  assert.throws(
    () => loadConfig(),
    (error) => {
      assert.ok(error instanceof ConfigError, "refusal must be a ConfigError");
      assert.match(error.message, new RegExp(`^${REFUSAL_PREAMBLE}`));
      for (const guidance of REFUSAL_GUIDANCE) assert.ok(error.message.includes(guidance));
      if (problem) assert.ok(error.message.includes(problem), `message must list: ${problem}`);
      if (env.GHOST_ADMIN_API_KEY) {
        assert.ok(!error.message.includes(env.GHOST_ADMIN_API_KEY), "message must not contain the key value");
        assert.ok(!error.message.includes(KEY_SECRET), "message must not contain the secret");
      }
      return true;
    },
  );
}

describe("loadConfig (mirrors tools/ghost-admin.mjs)", () => {
  afterEach(() => setEnv({}));

  test("missing URL is a problem", () => {
    assertRefusal({ with: { GHOST_ADMIN_API_KEY: VALID_KEY }, problem: "GHOST_ADMIN_API_URL is not set" });
  });

  test("missing key is a problem", () => {
    assertRefusal({ with: { GHOST_ADMIN_API_URL: "https://ghost.example.com" }, problem: "GHOST_ADMIN_API_KEY is not set" });
  });

  test("malformed key is a problem, and the message never contains the key value", () => {
    assertRefusal({
      with: { GHOST_ADMIN_API_URL: "https://ghost.example.com", GHOST_ADMIN_API_KEY: "not-a-key" },
      problem: "24 then 64 hex characters",
    });
  });

  test("non-https non-local URL is a problem", () => {
    assertRefusal({
      with: { GHOST_ADMIN_API_URL: "http://ghost.example.com", GHOST_ADMIN_API_KEY: VALID_KEY },
      problem: "must use https, except for localhost",
    });
  });

  test("a URL that does not parse is a problem", () => {
    assertRefusal({
      with: { GHOST_ADMIN_API_URL: "not a url", GHOST_ADMIN_API_KEY: VALID_KEY },
      problem: "is not a valid URL",
    });
  });

  test("http is allowed for localhost and 127.0.0.1", () => {
    for (const url of ["http://localhost:2368", "http://127.0.0.1:2368"]) {
      setEnv({ GHOST_ADMIN_API_URL: url, GHOST_ADMIN_API_KEY: VALID_KEY });
      assert.deepEqual(loadConfig(), { origin: url, id: KEY_ID, secret: KEY_SECRET });
    }
  });

  test("a valid https URL returns origin, id and secret split on the first colon", () => {
    setEnv({ GHOST_ADMIN_API_URL: "https://ghost.example.com", GHOST_ADMIN_API_KEY: VALID_KEY });
    assert.deepEqual(loadConfig(), { origin: "https://ghost.example.com", id: KEY_ID, secret: KEY_SECRET });
  });

  test("values are trimmed before validation", () => {
    setEnv({
      GHOST_ADMIN_API_URL: "  https://ghost.example.com  ",
      GHOST_ADMIN_API_KEY: `  ${VALID_KEY}  `,
    });
    assert.deepEqual(loadConfig(), { origin: "https://ghost.example.com", id: KEY_ID, secret: KEY_SECRET });
  });

  test("refusal happens before any network request: no request is made", () => {
    // ConfigError classify: exit 2, outcome refused — the pipeline's contract
    // for "nothing was sent".
    setEnv({});
    try {
      loadConfig();
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      const { exitCode, outcome } = classifyError(error);
      assert.equal(exitCode, 2);
      assert.equal(outcome, "refused");
    }
  });
});

describe("loadGhostConfig", () => {
  afterEach(() => setEnv({}));

  test("wraps loadConfig: same success and same refusal", () => {
    setEnv({ GHOST_ADMIN_API_URL: "https://ghost.example.com", GHOST_ADMIN_API_KEY: VALID_KEY });
    assert.deepEqual(loadGhostConfig(), { origin: "https://ghost.example.com", id: KEY_ID, secret: KEY_SECRET });
    setEnv({});
    assert.throws(() => loadGhostConfig(), (error) => error instanceof ConfigError);
  });
});
