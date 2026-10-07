// The pipeline's own configuration is exactly Ghost's Admin configuration:
// GHOST_ADMIN_API_URL and GHOST_ADMIN_API_KEY, with the shape and https rules
// already enforced by tools/ghost-admin.mjs. The validation below mirrors
// that helper's rules deliberately, rather than importing it: the pipeline
// runs in a container built from article/ alone, where tools/ghost-admin.mjs
// is not on the module path, so an import across that boundary would fail at
// runtime. Because the rules are duplicated, they must be kept in step with
// tools/ghost-admin.mjs's loadConfig; the same cases are tested in
// test/config.test.mjs. The key is never printed: it stays in the returned
// object, and no message here ever contains its value.

import { ConfigError } from "./errors.mjs";

export { ConfigError };

export function loadConfig() {
  const problems = [];
  const rawUrl = process.env.GHOST_ADMIN_API_URL?.trim();
  const rawKey = process.env.GHOST_ADMIN_API_KEY?.trim();

  if (!rawUrl) problems.push("GHOST_ADMIN_API_URL is not set (the integration's API URL)");
  if (!rawKey) problems.push("GHOST_ADMIN_API_KEY is not set (Admin API key, \"<id>:<secret>\")");

  let origin;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !local) {
        problems.push("GHOST_ADMIN_API_URL must use https, except for localhost");
      }
      origin = parsed.origin;
    } catch {
      problems.push("GHOST_ADMIN_API_URL is not a valid URL");
    }
  }

  if (rawKey && !/^[0-9a-f]{24}:[0-9a-f]{64}$/i.test(rawKey)) {
    problems.push(
      "GHOST_ADMIN_API_KEY must be \"<id>:<secret>\", 24 then 64 hex characters. " +
        "Use the integration's Admin API key exactly as Ghost shows it.",
    );
  }

  if (problems.length) {
    throw new ConfigError(
      [
        "Ghost Admin API is not configured, so no request was made.",
        "",
        ...problems.map((p) => `  - ${p}`),
        "",
        "In Ghost Admin: Settings -> Integrations -> Add custom integration.",
        "Copy its Admin API key and its API URL (they are shown together; the",
        "API URL is not always the public domain).",
        "",
        "  export GHOST_ADMIN_API_URL=<the integration's API URL>",
        "  export GHOST_ADMIN_API_KEY=<id>:<secret>",
        "",
        "See docs/TOOLING.md. Do not commit the key.",
      ].join("\n"),
    );
  }

  const [id, secret] = rawKey.split(":");
  return { origin, id, secret };
}

/**
 * Thin wrapper naming the intent from the article pipeline's side. Refusal is
 * loadConfig's own: it throws before any network request is made.
 */
export function loadGhostConfig() {
  return loadConfig();
}
