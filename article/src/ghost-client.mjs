// A thin Ghost Admin API client. Every request goes through request(), so
// the protections hold for all of them: redirects are refused rather than
// followed (a redirect would re-send the request — including a post body —
// to a destination the operator did not configure), and transport failures
// are told apart by method: a lost reply after a mutating request means the
// change may have been applied, so it is UncertainError (exit 5), never a
// plain RemoteError. The Admin API key never appears in an error message or
// a log line: it lives only in the Authorization header this module mints.
//
// Token minting is duplicated from tools/ghost-admin.mjs deliberately: that
// helper does not export mintToken, and it is the entry point of a different
// CLI, so the article pipeline carries its own copy rather than reaching
// into an unexported implementation. The two are kept byte-compatible
// (same header, same 300-second lifetime, same audience) — Ghost accepts
// either.

import { createHmac } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { RemoteError, UncertainError, ConflictError } from "./errors.mjs";

const GHOST_API_VERSION = "v6.0";
// A mutating method is one that can change Ghost: a lost reply after it is
// unknown-effect, not a plain remote failure.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// The methods whose success response carries exactly one object in a
// well-known key. A 2xx response of that method whose body cannot be read,
// parsed or shaped carries no usable confirmation of what was applied — the
// mutation stands, the outcome does not — so those failures are
// UncertainError, the error whose outcome is reconciled from Ghost rather
// than trusted. Reads never reach this class of failure: nothing was
// changed, a plain RemoteError reports them.
const SINGLETON_MUTATIONS = new Map([
  ["POST", "posts"],
  ["PUT", "posts"],
  ["PATCH", "posts"],
]);

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * The Admin API token Ghost's custom integrations use: HS256 over the key's
 * secret, kid the key id, a 5-minute lifetime, audience /admin/.
 */
function mintToken({ id, secret }) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 300, aud: "/admin/" }));
  const body = `${header}.${payload}`;
  const signature = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(body)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${body}.${signature}`;
}

/** The first message in a Ghost error body, for error reporting. */
async function readErrorBody(response) {
  try {
    const body = await response.json();
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length) {
      return errors.map((error) => error?.message ?? error?.type ?? "unknown error").join("; ");
    }
    if (typeof body?.message === "string" && body.message) return body.message;
    return `HTTP ${response.status} ${response.statusText}`.trim();
  } catch {
    return `HTTP ${response.status} ${response.statusText}`.trim();
  }
}

/**
 * A 2xx body that cannot be read to completion after a mutating request:
 * the request stands, its outcome does not. UncertainError, never a plain
 * remote failure — a mutating request that changed nothing is RemoteError's
 * claim, and this one may well have changed everything.
 */
async function readBodyText(response, method, url, mutating) {
  try {
    return await response.text();
  } catch (error) {
    if (!mutating) throw error;
    const reason = error?.message ?? "no message";
    throw new UncertainError(
      [
        `The ${method} request to ${url} was sent, but its response body could not be read: ${reason}.`,
        "The request may have been applied; its effect is unknown. Do not simply re-run.",
      ].join("\n"),
    );
  }
}

/**
 * A 2xx response of a mutating method whose body was never usable: the
 * request stands, the outcome does not, so the failure is UncertainError —
 * the outcome is reconciled from Ghost, never trusted from the response.
 */
function mutationOutcomeUnknown(lead) {
  return new UncertainError(
    [
      `${lead} The request may have been applied; its effect is unknown.`,
      "The outcome must be established from what Ghost now holds, not from this response.",
    ].join("\n"),
  );
}

/**
 * The single object a successful post write must return: exactly one entry
 * under its key. A body that is null, an array, or empty holds no usable
 * confirmation, so the write's outcome is unknown, not failed.
 */
function singletonMutation(body, key, operation) {
  const entries = Array.isArray(body?.[key]) ? body[key] : null;
  const entry = entries?.[0];
  if (!entry || typeof entry !== "object") {
    throw mutationOutcomeUnknown(`Ghost's ${operation} response holds no post.`);
  }
  return entry;
}

/**
 * The Admin API client. The constructor takes {origin, id, secret} exactly as
 * loadGhostConfig() returns them; createGhostClient() is the factory that
 * also accepts an injected fetchImpl for tests, so production and test share
 * one code path.
 */
export class GhostClient {
  /**
   * fetchImpl is the fetch this client uses, injectable for tests; the
   * default is the global fetch, resolved once so a test that swaps the
   * global after construction cannot change this client's transport.
   */
  constructor({ origin, id, secret }, { fetchImpl = null } = {}) {
    if (!origin || !id || !secret) {
      throw new RemoteError("The Ghost client needs an origin, a key id and a secret. Nothing was sent.");
    }
    this.origin = origin;
    this.keyId = id;
    this.secret = secret;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * One Admin API request. Returns the parsed JSON body, or null for an
   * empty one. Refuses 3xx (never follows), maps 409 from an update to
   * ConflictError, and never lets the key reach an error message.
   * The mutating flag marks requests whose lost reply is unknown-effect.
   */
  async request(endpoint, init = {}, { mutating = MUTATING.has((init.method ?? "GET").toUpperCase()) } = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const url = `${this.origin}/ghost/api/admin/${endpoint}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        headers: {
          Authorization: `Ghost ${mintToken({ id: this.keyId, secret: this.secret })}`,
          "Accept-Version": GHOST_API_VERSION,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      const reason = error?.message ?? "no message";
      // A mutating request that never got a reply may have been applied on
      // the server; that uncertainty belongs to the caller, not this layer.
      throw mutating
        ? new UncertainError(
            [
              `The ${method} request to ${url} could not be completed: ${reason}.`,
              "The request may have been applied; its effect is unknown. Do not simply re-run.",
            ].join("\n"),
          )
        : new RemoteError(`The ${method} request to ${url} could not be completed: ${reason}. Nothing was read.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(no Location header)";
      throw new RemoteError(
        [
          `Refused: ${this.origin} redirected the request (${response.status}).`,
          `  requested: ${url}`,
          `  redirect to: ${location}`,
          "",
          "The request was NOT followed and NOT re-sent. Set GHOST_ADMIN_API_URL",
          "to the destination the integration actually serves, then retry.",
        ].join("\n"),
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new RemoteError(
        [
          `Ghost rejected the credentials for ${this.origin} (${response.status}): authentication failed; nothing was changed.`,
          "Check the integration's Admin API key and its API URL. The key is never printed.",
        ].join("\n"),
      );
    }

    if (response.status === 409 && (init.update ?? MUTATING.has(method))) {
      const message = await readErrorBody(response);
      throw new ConflictError(
        [
          `Ghost rejected the update (${response.status}): ${message}`,
          "Ghost holds a newer edit than this pipeline recorded (UpdateCollisionError).",
          "Nothing was overwritten. Reconcile the edit in Ghost Admin by hand before re-publishing.",
        ].join("\n"),
      );
    }

    if (!response.ok) {
      const message = await readErrorBody(response);
      throw new RemoteError(`Ghost rejected the ${method} request (${response.status}): ${message}`);
    }

    if (response.status === 204) return null;
    const text = await readBodyText(response, method, url, mutating);
    if (!text) return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw mutating
        ? mutationOutcomeUnknown(`Ghost's ${method} response from ${url} was not JSON.`)
        : new RemoteError(`Ghost's ${method} response from ${url} was not JSON. Treating this as a failure.`);
    }
    return parsed;
  }

  /** A post by id, or null when Ghost answers 404. formats=html is always asked for: without it Ghost returns lexical. */
  async getPost(id) {
    let body;
    try {
      body = await this.request(`posts/${encodeURIComponent(id)}/?include=tags,authors&formats=html`, { method: "GET" });
    } catch (error) {
      if (error instanceof RemoteError && /404/.test(error.message)) return null;
      throw error;
    }
    const post = body?.posts?.[0];
    if (!post) throw new RemoteError(`Ghost's response for post ${id} holds no post. Treating this as a failure.`);
    return post;
  }

  /** Posts carrying a tag slug (internal or public), with html requested. */
  async findPostsByTag(tagSlug) {
    const body = await this.request(
      `posts/?filter=tag:${encodeURIComponent(tagSlug)}&include=tags,authors&formats=html&limit=all`,
      { method: "GET" },
    );
    return Array.isArray(body?.posts) ? body.posts : [];
  }

  /** Posts with a slug. Ghost suffixed a duplicate slug rather than refusing, so a slug match is not identity. */
  async findPostsBySlug(slug) {
    const body = await this.request(
      `posts/?filter=slug:${encodeURIComponent(slug)}&include=tags,authors&formats=html&limit=all`,
      { method: "GET" },
    );
    return Array.isArray(body?.posts) ? body.posts : [];
  }

  /** A tag by its exact slug, or null. */
  async findTagBySlug(slug) {
    const body = await this.request(`tags/?filter=slug:${encodeURIComponent(slug)}&limit=all`, { method: "GET" });
    const tags = Array.isArray(body?.tags) ? body.tags : [];
    return tags.find((tag) => tag?.slug === slug) ?? null;
  }

  /** Create a tag. Ghost derives the slug itself unless one is supplied, so an internal tag always supplies its slug. */
  async createTag({ name, slug, visibility, description }) {
    const body = await this.request("tags/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [{ name, slug, visibility, description }] }),
    });
    const tag = body?.tags?.[0];
    if (!tag) throw new UncertainError("Ghost's tag creation response holds no tag; the write may have applied.");
    return tag;
  }

  /**
   * Update a tag's description. A tag write does not change the post's
   * updated_at, so this is how the pipeline repairs state without colliding
   * with the post's own edit history.
   */
  async updateTagDescription(id, description, updatedAt) {
    const body = await this.request(`tags/${encodeURIComponent(id)}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [{ description, updated_at: updatedAt }] }),
    });
    const tag = body?.tags?.[0];
    if (!tag) throw new UncertainError("Ghost's tag update response holds no tag; the write may have applied.");
    return tag;
  }

  /** Create a post (source=html so the html field is stored as given, up to Ghost's own rewrites). */
  async createPost(payload) {
    const body = await this.request("posts/?source=html&include=tags,authors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: [payload] }),
    });
    return singletonMutation(body, "posts", "post creation");
  }

  /** Update a post. A stale updated_at yields 409, which is ConflictError here. */
  async updatePost(id, payload) {
    const body = await this.request(`posts/${encodeURIComponent(id)}/?source=html&include=tags,authors`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: [payload] }),
    });
    return singletonMutation(body, "posts", "post update");
  }

  /**
   * Upload an image, multipart. Ghost is not deduplicated by ref or content,
   * so the caller must only upload what it has not already placed. The part's
   * Content-Type is derived from the filename's extension: Ghost 6.64.0's
   * processor sniffs the declared part type, not the bytes, so a typeless part
   * (octet-stream) is a 415 "Please select a valid image."
   */
  async uploadImage(bytes, filename) {
    const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    const contentType =
      { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif" }[extension] ??
      "application/octet-stream";
    const form = new FormData();
    form.append("file", new File([bytes], filename, { type: contentType }));
    form.append("purpose", "image");
    form.append("ref", filename);
    const body = await this.request("images/upload/", { method: "POST", body: form });
    const image = body?.images?.[0];
    if (!image || typeof image.url !== "string" || !image.url) {
      throw new RemoteError(`Ghost's image upload response for "${filename}" holds no url. Treating this as a failure.`);
    }
    return { url: image.url };
  }

  /**
   * A public, unauthenticated page check. Redirects are allowed (the public
   * site may legitimately redirect) but bounded by the fetch default, and
   * nothing is parsed as an API.
   *
   * The response is returned twice over, because the two callers need
   * different things and one decode cannot serve both:
   *
   *   bytes  the body as a Buffer, byte-for-byte what Ghost served. The
   *          asset-reuse check digests this. A text round-trip cannot stand
   *          in for it: any decode that replaces a byte it cannot map
   *          silently changes the digest, so an unchanged image would read
   *          as changed and be re-uploaded.
   *   body   the same bytes decoded as TEXT, in the response's own character
   *          encoding. A public page is UTF-8 (`text/html; charset=utf-8`),
   *          and decoding it as anything else mangles every non-ASCII
   *          character — "café" arrives as "cafÃ©" — so the content check
   *          would compare mojibake against the candidate's real text and
   *          fail an article that is perfectly published. A body that is not
   *          text at all (an image, an octet-stream) is decoded latin1,
   *          which maps every byte to exactly one code unit and so loses
   *          nothing; `bytes` is the authoritative form there anyway.
   */
  async fetchPublic(url) {
    let response;
    try {
      response = await this.fetchImpl(url, { redirect: "follow" });
    } catch (error) {
      const reason = error?.message ?? "no message";
      throw new RemoteError(`The public page at ${url} could not be fetched: ${reason}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const encoding = textEncoding(response, bytes);
    const body = encoding === "latin1" ? bytes.toString("latin1") : new TextDecoder(encoding).decode(bytes);
    return { status: response.status, body, bytes, url: response.url || url };
  }
}

// Media types whose payload is text, so the response's own encoding (UTF-8
// unless it says otherwise) is the right decode. An SVG is XML text even
// though its type is under image/.
const TEXTUAL_MEDIA_TYPE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript)|image\/svg\+xml)/i;

/**
 * The encoding to read a public response's body as text: the charset the
 * response declares when it declares one, UTF-8 for a textual media type,
 * and latin1 otherwise — the one single-byte encoding that maps every byte
 * to exactly one code unit, so a binary body still round-trips losslessly
 * through `body` for anything that inspects it.
 */
function textEncoding(response, bytes) {
  const contentType = String(response.headers?.get?.("content-type") ?? "");
  const declared = /;\s*charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType)?.[1];
  if (declared) {
    // Only honour a charset Node can actually decode; an unknown one falls
    // back to the media type's default rather than throwing.
    try {
      new TextDecoder(declared.toLowerCase());
      return declared.toLowerCase();
    } catch {
      // fall through
    }
  }
  const mediaType = contentType.split(";")[0].trim();
  if (mediaType && TEXTUAL_MEDIA_TYPE.test(mediaType)) return "utf8";
  // No usable Content-Type: a body that parses as UTF-8 is text (Ghost's HTML
  // always does), and one that does not is binary and stays latin1.
  if (!mediaType && isUtf8(bytes)) return "utf8";
  return "latin1";
}

/**
 * The production factory: config is what loadGhostConfig() returns. An
 * injected fetchImpl keeps tests off the network without a second code
 * path — the same class, the same request logic, a different transport.
 */
export function createGhostClient(config, { log = null, fetchImpl = null } = {}) {
  void log; // reserved for the log a caller passes; nothing is logged here
  return new GhostClient(config, { fetchImpl });
}
