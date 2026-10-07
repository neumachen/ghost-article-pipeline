// An in-process fake Ghost Admin API, shared by the article pipeline's tests.
//
// It models the behaviours the pipeline's guarantees rest on: HS256 JWT auth
// with kid, formats=html, 409 on a stale updated_at, 404 for a missing post,
// 401 for a bad token, a scriptable 500, and a scriptable lost reply (the
// request is applied — or not — and the socket is destroyed, so the caller
// cannot know whether the change took effect).
//
// The TAG behaviours are modelled on what real Ghost 6.64.0 was probed to do
// (2026-10-05), because the pipeline's C6 design depends on them and an
// earlier version of this fake got them wrong:
//
//   1. A `description` inside a post's `tags[]` array is SILENTLY IGNORED, on
//      create and on update. A tag auto-created from a post write gets an
//      empty description; an existing tag referenced from a post keeps its
//      current description. The OLD fake stored the post-supplied description
//      on the tag, so every C6 test that "proved" the provisional-write path
//      worked was proving a behaviour Ghost does not have.
//   2. A tag's description IS set by PUT /tags/:id/ directly.
//   3. Referencing an existing tag by name+slug alone inside a post's tags[]
//      preserves its current description (and links the SAME tag id).
//   4. A post write whose tag array OMITS a previously-attached tag drops that
//      tag from the post (the tag survives in the tag list).
//   5. A post write referencing an existing tag by its exact slug LINKS it; it
//      never creates a duplicate. But POST /tags/ a SECOND time with an
//      already-taken slug creates a DIFFERENT tag with a "-2"-suffixed slug.
//   6. PUT /tags/:id/ has NO optimistic-concurrency protection the client can
//      rely on: a stale updated_at is accepted (HTTP 200), unlike a post.
//
// No real site is contacted: the fake is an http server bound to 127.0.0.1 on
// an ephemeral port, and clients talk to it over loopback only. Every request
// is recorded with its url, headers and body.

import { createHmac } from "node:crypto";
import http from "node:http";

export const KEY_ID = "6529e4a1b2c3d4e5f6a7b8c9";
export const KEY_SECRET = "a".repeat(64);
export const BAD_SECRET = "b".repeat(64);

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A token minted the way Ghost's Admin API expects, against a given secret. */
export function mintToken({ id, secret }, kid = id) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid }));
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

export const jsonHeaders = () => ({ "Content-Type": "application/json", "Cache-Control": "no-store" });
export const errorBody = (status, message) =>
  JSON.stringify({ errors: [{ message, type: "GhostError", code: status }] });

// The post route shapes, kept in one place so the drop hook and the handler
// agree on what a "create" and an "update" are.
const POST_CREATE = (pathname) => pathname === "/ghost/api/admin/posts/";
const POST_UPDATE = (pathname) => /^\/ghost\/api\/admin\/posts\/[^/]+\/$/.test(pathname);
const TAG_CREATE = (pathname) => pathname === "/ghost/api/admin/tags/";
const TAG_UPDATE = (pathname) => /^\/ghost\/api\/admin\/tags\/[^/]+\/$/.test(pathname);

/** Ghost's slug derivation: lowercase, non-alphanumerics to dashes, trimmed. */
const slugify = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The fake Ghost Admin API. Behaviours are scripted per-test through options:
 *
 *   secret         the key secret the fake accepts (BAD_SECRET to test 401)
 *   status500      answer every request with a 500
 *   failAfterApply legacy: apply a PUT, then drop the reply (a lost update)
 *   drop           ({ method, kind, path }) -> null | { apply, mutate }
 *                  kind is "create" | "update" | "tag-create" | "tag" |
 *                  "upload" | "other", where "tag-create" is POST /tags/ and
 *                  "tag" is PUT /tags/:id/.
 *                  apply: apply the write before dropping; mutate(post) may
 *                  change the stored post after it is applied.
 *                  When it returns null the request is handled normally.
 *   faults         ({ method, kind, path }) -> null | "interrupt" | a fault
 *                  object, applied to a request the fake ANSWERS (a reply is
 *                  produced; the write happens first):
 *                    "interrupt"          the 2xx body is truncated mid-send
 *                    { body: string }     the 2xx body is exactly this string
 *                    { status, body }     a non-200 status with this body
 *                    { drop: true }       the reply is destroyed (synonym of
 *                                         the drop option, for one request)
 *                  kind is the same discriminator the drop option uses, plus
 *                  "read-post" for the post-by-id GET.
 *   publicFaults  ({ path, url }) -> null | "destroy" | an HTTP status number,
 *                  applied to a public /p/<slug>/ page fetch: "destroy" kills
 *                  the socket (a transport failure), a number answers with
 *                  that status (an HTTP failure). Assignable per-request.
 *   publicContent a Map, pathname -> Buffer, of content the public site
 *                  serves besides the posts' pages (an image store for
 *                  uploaded copies). Assignable per-test; null by default.
 *                  The upload route honours the faults hook like every other
 *                  answered route, so a scripted rejected upload is possible.
 */
export class FakeGhost {
  constructor({ secret = KEY_SECRET, failAfterApply = false, status500 = false, drop = null, faults = null, publicFaults = null } = {}) {
    this.secret = secret;
    this.failAfterApply = failAfterApply; // apply the request, then drop the socket
    this.status500 = status500; // answer 500 with a Ghost-shaped error body
    this.drop = drop; // a scripted lost reply
    this.faults = faults; // a scripted faulty 2xx reply
    this.publicFaults = publicFaults; // a scripted public-page fault
    this.requests = [];
    this.posts = new Map();
    this.tags = [];
    this.images = [];
    /** pathname -> the exact bytes an upload stored, served back publicly. */
    this.storedImages = new Map();
    // Publicly served content, pathname -> Buffer: what Ghost's image store
    // serves for an uploaded copy. Assignable per-test (like publicFaults),
    // so a seeded live URL can serve exactly the bytes a reuse decision
    // compares against. Null (the default) serves nothing extra.
    this.publicContent = null;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve(this)));
  }

  get origin() {
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  /**
   * Seed a post directly, as if Ghost already held it: its tags are first
   * registered WITH their descriptions (a seeded tag's description is the
   * state a prior run's tag write left, which no post write could have set),
   * then the post is stored through the ordinary link path.
   */
  seedPost(fields) {
    this.registerTags(this.normalizeTags(fields?.tags));
    return this.storePost(fields);
  }

  /**
   * Seed a registry tag directly, as if a prior run's tag-state write left it
   * there: the tag exists (with whatever description is supplied) WITHOUT any
   * post linking it. This is exactly the on-Ghost state a run that died
   * BETWEEN its tag-state step and its post write leaves behind — the tag
   * carries this candidate's provisional state, no post carries the tag yet.
   */
  seedTag(fields) {
    const [tag] = this.normalizeTags([fields]);
    this.registerTags([tag]);
    return tag;
  }

  /** Seed/registry tag normalisation: every tag has an id and a slug; a supplied description is kept. */
  normalizeTags(tags) {
    return (Array.isArray(tags) ? tags : []).map((tag, index) => {
      const name = tag?.name ?? "";
      const slug = tag?.slug ?? slugify(name);
      return { ...tag, id: tag?.id ?? `tag-${slug || index}`, name, slug, description: tag?.description ?? null };
    });
  }

  /** The registry tag with this exact slug, or null. */
  tagBySlug(slug) {
    return this.tags.find((tag) => tag.slug === slug) ?? null;
  }

  /**
   * A canonical tag object as Ghost serialises it: the tag's CURRENT
   * description from the registry (never one supplied through a post write),
   * with every other stored field. A post write's `description` is ignored
   * because the post routes below resolve every incoming tag through
   * linkTags(), which copies no description onto a tag.
   */
  tagView(tag) {
    return { id: tag.id, name: tag.name, slug: tag.slug, description: tag.description ?? null, visibility: tag.visibility ?? "public" };
  }

  /**
   * Resolve a post write's incoming tags[] against the tag registry, the way
   * real Ghost 6.64.0 was probed to: a tag whose exact slug already exists is
   * LINKED (its description is left untouched, whatever the post payload
   * said); a tag whose slug is new is auto-created with an EMPTY description
   * (the payload's `description` is silently ignored).
   *
   * The returned array holds the REGISTRY tag objects themselves, not copies:
   * a post's tags therefore always read as the current tag state, exactly as
   * real Ghost serialises a post's tags from the live tag — a tag-description
   * write that happens AFTER the post write is visible on the next read of
   * the post, and a description mutated directly on a stored post's tag is
   * the registry's, which is how a test seeds a stale recorded state.
   */
  linkTags(tags) {
    return (Array.isArray(tags) ? tags : []).map((incoming, index) => {
      const name = incoming?.name ?? "";
      const slug = incoming?.slug ?? slugify(name);
      let tag = this.tagBySlug(slug);
      if (!tag) {
        // Auto-created from a post write: description is ALWAYS empty (fact 1).
        tag = { id: incoming?.id ?? `tag-${slug || index}`, name, slug, visibility: incoming?.visibility ?? "public", description: null };
        this.registerTags([tag]);
      }
      return tag;
    });
  }

  /** Register registry tags, first-write-wins on an id. */
  registerTags(tags) {
    for (const tag of tags ?? []) {
      if (!this.tags.some((existing) => existing.id === tag.id)) this.tags.push(tag);
    }
  }

  /**
   * Store one multipart image upload the way Ghost does: under
   * /content/images/<year>/<month>/<the uploaded file's own name>, holding the
   * uploaded bytes unchanged. Returns the public url.
   */
  storeUpload(raw) {
    const text = raw.toString("latin1");
    const boundary = /--([^\r\n]+)/.exec(text)?.[1];
    const filename = /filename="([^"]*)"/.exec(text)?.[1] ?? "upload.png";
    const headEnd = text.indexOf("\r\n\r\n");
    let bytes = raw;
    if (headEnd >= 0) {
      const from = headEnd + 4;
      const to = boundary ? text.indexOf(`\r\n--${boundary}`, from) : -1;
      bytes = to > from ? raw.subarray(from, to) : raw.subarray(from);
    }
    const stamp = new Date().toISOString().slice(0, 7).replace("-", "/");
    const pathname = `/content/images/${stamp}/${filename.split("/").pop() || "upload.png"}`;
    this.storedImages.set(pathname, Buffer.from(bytes));
    return `${this.origin}${pathname}`;
  }

  /** Store a post from an incoming payload, assigning id/uuid/url/updated_at as Ghost would. */
  storePost(incoming) {
    const id = incoming.id ?? `p${this.posts.size + 1}`;
    const tags = this.linkTags(incoming.tags);
    const post = {
      ...incoming,
      id,
      uuid: incoming.uuid ?? `u-${id}`,
      tags,
      authors: incoming.authors ?? [],
      updated_at: incoming.updated_at ?? "2026-09-24T12:00:00.000Z",
      url: incoming.url ?? `${this.origin}/p/${incoming.slug}/`,
    };
    this.posts.set(id, post);
    return post;
  }

  /**
   * A post as Ghost serialises it: its tags rendered from the CURRENT tag
   * registry, not a snapshot taken at write time. Real Ghost returns a post's
   * tags with each tag's current fields, so a tag-description write that
   * happened AFTER the post write is visible on the very next read of the
   * post — the property the pipeline's read-back relies on.
   */
  postView(post) {
    if (!post) return post;
    return {
      ...post,
      tags: (post.tags ?? []).map((tag) => {
        const registry = this.tagBySlug(tag.slug);
        return registry ? this.tagView(registry) : tag;
      }),
    };
  }

  async handle(request, response) {
    // Collected as BYTES, not as a string: an image upload is multipart, and
    // decoding it on the way in would corrupt the very bytes the reuse check
    // compares. `body` stays the utf8 view the JSON routes and the fault
    // discriminators have always used.
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = raw.toString("utf8");
    const url = new URL(request.url, this.origin);
    const recorded = { method: request.method, url: request.url, headers: request.headers, body };
    this.requests.push(recorded);

    // The public site is unauthenticated: a post's own URL serves its stored
    // html, so the public-page check has something real to read back. Handled
    // before the Admin API authorization, which never applies to it.
    if (request.method === "GET" && this.publicContent instanceof Map && this.publicContent.has(url.pathname)) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(this.publicContent.get(url.pathname));
      return;
    }
    if (request.method === "GET" && this.storedImages.has(url.pathname)) {
      response.writeHead(200, { "Content-Type": "image/png" }).end(this.storedImages.get(url.pathname));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/p/")) {
      const slug = url.pathname.slice(3).replace(/\/$/, "");
      // A scripted public-page fault: "destroy" kills the socket (the
      // transport failure a fetch that never completes raises), a number
      // answers with that HTTP status. Either way nothing is served.
      const publicFault = this.publicFaults ? this.publicFaults({ path: url.pathname, url: request.url }) : null;
      if (publicFault === "destroy") {
        recorded.transportDropped = true;
        request.socket.destroy();
        return;
      }
      if (typeof publicFault === "number") {
        response.writeHead(publicFault, { "Content-Type": "text/html; charset=utf-8" }).end(errorBody(publicFault, "Public page failure"));
        return;
      }
      const post = [...this.posts.values()].find((entry) => entry.slug === slug);
      if (!post) {
        response.writeHead(404, jsonHeaders()).end(errorBody(404, "Page not found"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${post.html ?? ""}</body></html>`);
      return;
    }

    const authorize = () => {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Ghost ") ? header.slice(6) : null;
      if (!token) {
        response.writeHead(401, jsonHeaders()).end(errorBody(401, "No Authorization header"));
        return false;
      }
      const [headerPart, payloadPart, signaturePart] = token.split(".");
      const expected = createHmac("sha256", Buffer.from(this.secret, "hex"))
        .update(`${headerPart}.${payloadPart}`)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      const payload = JSON.parse(Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      if (signaturePart !== expected || payload.aud !== "/admin/" || payload.exp < Math.floor(Date.now() / 1000)) {
        response.writeHead(401, jsonHeaders()).end(errorBody(401, "Invalid token"));
        return false;
      }
      return JSON.parse(Buffer.from(headerPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    };

    const token = authorize();
    if (!token) return;
    if (token.kid !== KEY_ID) {
      response.writeHead(401, jsonHeaders()).end(errorBody(401, "Unknown key id"));
      return;
    }
    if (this.status500) {
      response.writeHead(500, jsonHeaders()).end(errorBody(500, "Internal server error"));
      return;
    }

    const postId = url.pathname.match(/^\/ghost\/api\/admin\/posts\/([^/]+)\/$/)?.[1];
    const kind = POST_CREATE(url.pathname) && request.method === "POST"
      ? "create"
      : POST_UPDATE(url.pathname) && request.method === "PUT"
        ? "update"
        : postId && request.method === "GET"
          ? "read-post"
          : TAG_CREATE(url.pathname) && request.method === "POST"
            ? "tag-create"
            : TAG_UPDATE(url.pathname) && request.method === "PUT"
              ? "tag"
              : url.pathname === "/ghost/api/admin/images/upload/"
                ? "upload"
                : "other";

    // The scripted fault for THIS request, evaluated exactly once so a hook
    // with a side effect (a counter that rejects the Nth upload) is not
    // double-counted by the two places that consult it (statusFault, which
    // answers a non-2xx before anything is applied, and answerFaulty, which
    // answers a 2xx fault after the write). The hook receives the REQUEST
    // body, so a fault can be discriminated on what the client sent.
    this._fault = this.faults ? this.faults({ method: request.method, kind, path: url.pathname, requestBody: body }) : null;

    // A scripted lost reply: apply (or not) and destroy the socket so the
    // caller never gets a response, then stop handling this request. The hook
    // also receives the REQUEST body, so a test can discriminate the
    // provisional tag-state write from the final state write (both are PUT
    // /tags/:id/, kind "tag"): the provisional body's state has `"gh":null`.
    const directive = this.drop ? this.drop({ method: request.method, kind, path: url.pathname, requestBody: body }) : null;
    const lostReply = directive ?? (this.failAfterApply && request.method === "PUT" ? { apply: true } : null);
    if (lostReply) {
      recorded.replyDropped = true;
      if (lostReply.apply) {
        if (kind === "create") {
          const incoming = body ? JSON.parse(body).posts?.[0] ?? {} : {};
          const post = this.storePost(incoming);
          lostReply.mutate?.(post);
        } else if (kind === "update") {
          const saved = this.applyUpdate(postId, body);
          if (saved) lostReply.mutate?.(saved);
        } else if (kind === "tag-create") {
          // POST /tags/: the same explicit-create-by-slug path as the
          // answered route, so a dropped tag create can be applied (or not).
          const created = this.createTag(body);
          lostReply.mutate?.(created);
        } else if (kind === "tag") {
          // The tag route's id is the TAG's id, not the post's: the tag
          // writes here must be applied with their own id, or a dropped
          // tag write would silently not apply.
          this.applyTagUpdate(url.pathname.match(/^\/ghost\/api\/admin\/tags\/([^/]+)\/$/)?.[1], body);
        }
      }
      request.socket.destroy();
      return;
    }

    if (postId && request.method === "GET") {
      if (!this.posts.has(postId)) {
        response.writeHead(404, jsonHeaders()).end(errorBody(404, "Post not found"));
        return;
      }
      // The read-back is scriptable too: an interrupt or a dropped reply is
      // how a read that fails after a confirmed write is produced. The
      // per-request fault (evaluated once above) is the one consulted here.
      const fault = this._fault;
      if (fault === "interrupt") {
        const body = JSON.stringify({ posts: [this.postView(this.posts.get(postId))] });
        response.writeHead(200, jsonHeaders());
        response.write(body.slice(0, Math.floor(body.length / 2)));
        response.destroy();
        return;
      }
      if (fault && typeof fault === "object" && fault.drop) {
        request.socket.destroy();
        return;
      }
      // A scripted read hook, so a test can change the stored post BETWEEN two
      // reads of it — the race a state repair's re-proof exists for. It receives
      // the stored object itself and the 1-based read count for that post.
      const held = this.posts.get(postId);
      if (this.onPostRead) {
        this.postReads = (this.postReads ?? new Map());
        const n = (this.postReads.get(postId) ?? 0) + 1;
        this.postReads.set(postId, n);
        this.onPostRead(held, n);
      }
      response.writeHead(200, jsonHeaders()).end(JSON.stringify({ posts: [this.postView(held)] }));
      return;
    }
    if (url.pathname === "/ghost/api/admin/posts/" && request.method === "GET") {
      // A list read: filter=slug:<slug> or filter=tag:<slug>, both honoured.
      const slug = url.searchParams.get("filter")?.match(/^slug:(.+)$/)?.[1];
      const tag = url.searchParams.get("filter")?.match(/^tag:(.+)$/)?.[1];
      const matching = [...this.posts.values()].filter((post) => {
        if (slug) return post.slug === slug;
        if (tag) return (post.tags ?? []).some((entry) => entry?.slug === tag);
        return true;
      });
      response.writeHead(200, jsonHeaders()).end(JSON.stringify({ posts: matching.map((post) => this.postView(post)) }));
      return;
    }
    if (postId && request.method === "PUT") {
      if (this.statusFault(response, kind, body)) return; // a rejection changed nothing
      const saved = this.applyUpdate(postId, body);
      if (saved === null) {
        // A stale updated_at is Ghost's UpdateCollisionError.
        response.writeHead(409, jsonHeaders()).end(errorBody(409, "Lost update: PUT is not allowed"));
        return;
      }
      this.answerFaulty(response, kind, JSON.stringify({ posts: [this.postView(saved)] }));
      return;
    }
    if (url.pathname === "/ghost/api/admin/posts/" && request.method === "POST") {
      if (this.statusFault(response, kind, body)) return; // a rejection changed nothing
      const incoming = body ? JSON.parse(body).posts?.[0] ?? {} : {};
      const post = this.storePost(incoming);
      this.answerFaulty(response, kind, JSON.stringify({ posts: [this.postView(post)] }));
      return;
    }
    if (url.pathname === "/ghost/api/admin/images/upload/") {
      // The request itself is recorded whether or not it is applied: the
      // tests count SENT upload requests (a rejected one was still sent).
      this.images.push(recorded);
      if (this.statusFault(response, kind, body)) return; // a rejection stored nothing
      // Real Ghost 6.64.0 names the stored file after the uploaded one, under a
      // year/month directory — observed live: `linked.png` comes back as
      // `<origin>/content/images/2026/10/linked.png`, and a second upload of the
      // SAME bytes gets a DIFFERENT url while storing the same bytes. Answering
      // every upload with one fixed `upload.png` could not represent that, so
      // the pipeline's basename-based src shape could never resolve a stored url
      // back to the candidate ref it came from, and the fake could not exercise
      // asset reuse at all. The fake now models the observed naming and keeps
      // the uploaded bytes, so a reuse check reads back what was sent.
      const stored = this.storeUpload(raw);
      this.answerFaulty(response, kind, JSON.stringify({ images: [{ url: stored }] }));
      return;
    }
    if (url.pathname === "/ghost/api/admin/tags/" && request.method === "GET") {
      const slug = url.searchParams.get("filter")?.match(/^slug:(.+)$/)?.[1];
      const tags = this.tags.filter((tag) => (slug ? tag.slug === slug : true)).map((tag) => this.tagView(tag));
      this.answerFaulty(response, "other", JSON.stringify({ tags }));
      return;
    }
    if (url.pathname === "/ghost/api/admin/tags/" && request.method === "POST") {
      if (this.statusFault(response, kind, body)) return; // a rejection changed nothing
      const tag = this.createTag(body);
      response.writeHead(201, jsonHeaders()).end(JSON.stringify({ tags: [tag] }));
      return;
    }
    if (TAG_UPDATE(url.pathname) && request.method === "PUT") {
      if (this.statusFault(response, kind, body)) return; // a rejection changed nothing
      const saved = this.applyTagUpdate(url.pathname.match(/^\/ghost\/api\/admin\/tags\/([^/]+)\/$/)?.[1], body);
      this.answerFaulty(response, kind, JSON.stringify({ tags: [saved] }));
      return;
    }
    response.writeHead(404, jsonHeaders()).end(errorBody(404, "Unknown route"));
  }

  /**
   * A scripted NON-2xx fault (a rejection). Real Ghost applies nothing when it
   * rejects a request, so the fault is answered here BEFORE the route applies
   * the write — the store is left untouched, which is what makes a rejected
   * write's effect "nothing changed" rather than "applied anyway". Returns
   * true when it answered (the caller must then return without applying).
   *
   * The hook receives the REQUEST body, so a test can fault only the FINAL tag
   * write (its state JSON carries a stored-body hash) and leave the
   * provisional tag-state write alone — both share the "tag" kind.
   */
  statusFault(response, kind, requestBody) {
    const fault = this._fault;
    if (fault && typeof fault === "object" && fault.status !== undefined) {
      response.writeHead(fault.status, jsonHeaders()).end(fault.body ?? "");
      return true;
    }
    return false;
  }

  /**
   * Answer a 2xx reply the way the faults option scripted it, or verbatim
   * when it did not. The write has already happened when this runs: a 2xx
   * fault (an interrupt, a malformed body) is a fault in the REPLY, never in
   * the store. Non-2xx rejections never reach here (see statusFault).
   */
  answerFaulty(response, kind, body) {
    const fault = this._fault;
    if (fault === "interrupt") {
      response.writeHead(201, jsonHeaders());
      // The body stops mid-send, so the client's response.text() rejects.
      response.write(body.slice(0, Math.floor(body.length / 2)));
      response.destroy();
      return;
    }
    if (fault && typeof fault === "object") {
      if (fault.drop) {
        response.req?.socket.destroy();
        return;
      }
      if (fault.body !== undefined) {
        response.writeHead(200, jsonHeaders()).end(fault.body);
        return;
      }
    }
    response.writeHead(200, jsonHeaders()).end(body);
  }

  /** The store's update behaviour: a stale updated_at is a 409, otherwise the post is saved. */
  applyUpdate(postId, bodyText) {
    const target = this.posts.get(postId);
    const incoming = bodyText ? JSON.parse(bodyText).posts?.[0] ?? {} : {};
    if (!target) return null;
    if (incoming.updated_at && incoming.updated_at !== target.updated_at) return null;
    const merged = { ...target, ...incoming, updated_at: "2026-09-24T12:00:00.000Z" };
    // A post write replaces the whole tag set (fact 4): an omitted tag is
    // dropped from the post, while the tag itself survives in the registry.
    // The incoming entries are resolved through linkTags, so a description in
    // the payload is ignored (fact 1) and a known tag keeps its description
    // (fact 3).
    merged.tags = this.linkTags(incoming.tags ?? target.tags);
    merged.authors = incoming.authors ?? target.authors ?? [];
    this.posts.set(postId, merged);
    return merged;
  }

  /**
   * POST /tags/: an EXPLICIT tag create. Real Ghost does not dedupe an
   * explicit create by slug (fact 5b): a second create with an already-taken
   * slug yields a DIFFERENT tag with a "-2"-suffixed slug, never an error.
   * The description in the payload IS stored — this is the route fact 2
   * covers, and the only route that ever writes a description.
   */
  createTag(bodyText) {
    const incoming = bodyText ? JSON.parse(bodyText).tags?.[0] ?? {} : {};
    const base = incoming.slug ?? slugify(incoming.name);
    let slug = base;
    let suffix = 2;
    while (this.tags.some((tag) => tag.slug === slug)) slug = `${base}-${suffix++}`;
    const tag = {
      id: incoming.id ?? `tag-${slug}`,
      name: incoming.name ?? "",
      slug,
      visibility: incoming.visibility ?? "public",
      description: incoming.description ?? null,
    };
    this.registerTags([tag]);
    return this.tagView(tag);
  }

  /**
   * A tag description update: the tag is found by id and its description
   * replaced. Real Ghost accepts a STALE updated_at here (fact 6): there is
   * no optimistic-concurrency protection on a tag write, unlike a post.
   */
  applyTagUpdate(tagId, bodyText) {
    const incoming = bodyText ? JSON.parse(bodyText).tags?.[0] ?? {} : {};
    const tag = this.tags.find((entry) => entry.id === tagId) ?? { id: tagId, name: "", slug: `tag-${tagId}` };
    if (incoming.description !== undefined) tag.description = incoming.description;
    this.registerTags([tag]);
    return this.tagView(tag);
  }
}
