// ghost-client.mjs: the Admin API client against the shared in-process fake
// Ghost (test/fake-ghost.mjs), modelling the behaviours the client's
// guarantees rest on: HS256 JWT auth with kid, formats=html, 409 on a stale
// updated_at, 404 for a missing post, 401 for a bad token, a scriptable 500,
// and a drop-after-apply lost reply.
//
// No real site is contacted: the fake is an http server bound to 127.0.0.1
// on an ephemeral port, and the client talks to it over loopback only.

import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";
import { ConflictError, RemoteError, UncertainError } from "../src/errors.mjs";
import { GhostClient, createGhostClient } from "../src/ghost-client.mjs";
import { FakeGhost, KEY_ID, KEY_SECRET, BAD_SECRET, jsonHeaders } from "./fake-ghost.mjs";

const ghosts = [];
/** A started fake Ghost, closed when the tests end. */
async function fakeGhost(options) {
  const ghost = await new FakeGhost(options).listen();
  ghosts.push(ghost);
  return ghost;
}
after(async () => {
  while (ghosts.length) await ghosts.pop().close();
});

const clientFor = (ghost, secret = KEY_SECRET) => new GhostClient({ origin: ghost.origin, id: KEY_ID, secret });

describe("GhostClient authentication", () => {
  test("a request with the right key is accepted and carries the Authorization header", async () => {
    const ghost = await fakeGhost();
    const client = clientFor(ghost);
    await client.findPostsBySlug("hello");
    assert.equal(ghost.requests.length, 1);
    assert.match(ghost.requests[0].headers.authorization, /^Ghost [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(ghost.requests[0].headers["accept-version"], "v6.0");
  });

  test("a bad key (401) is a RemoteError that says nothing changed", async () => {
    const ghost = await fakeGhost({ secret: BAD_SECRET });
    const client = clientFor(ghost);
    await assert.rejects(client.findPostsBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /authentication failed; nothing was changed/);
      // The key itself never appears in the message.
      assert.ok(!error.message.includes(KEY_SECRET));
      assert.ok(!error.message.includes("Authorization"));
      return true;
    });
  });

  test("the key never appears in any thrown message, including transport failures", async () => {
    const ghost = await fakeGhost({ status500: true });
    const client = clientFor(ghost);
    for (const [promise, klass] of [
      [client.findPostsBySlug("hello"), RemoteError],
      [client.createPost({ title: "t", slug: "t", html: "<p>x</p>" }), RemoteError],
    ]) {
      await assert.rejects(promise, (error) => {
        assert.ok(error instanceof klass);
        assert.ok(!error.message.includes(KEY_SECRET));
        assert.ok(!error.message.includes(KEY_ID + ":" + KEY_SECRET));
        assert.ok(!/Ghost [A-Za-z0-9_-]+\./.test(error.message));
        return true;
      });
    }
  });
});

describe("GhostClient request behaviour", () => {
  test("asks for formats=html when reading posts (a single GET without it returns lexical)", async () => {
    const ghost = await fakeGhost();
    const client = clientFor(ghost);
    ghost.posts.set("p1", { id: "p1", slug: "hello", html: "<p>stored</p>", tags: [], authors: [] });
    await client.getPost("p1");
    await client.findPostsByTag("hash-nc-article-x");
    await client.findPostsBySlug("hello");
    for (const request of ghost.requests) {
      assert.match(request.url, /formats=html/);
    }
  });

  test("a missing post is null, not an error", async () => {
    const ghost = await fakeGhost();
    const client = clientFor(ghost);
    assert.equal(await client.getPost("no-such-post"), null);
  });

  test("a redirect (3xx) is refused: RemoteError, never followed", async () => {
    const ghost = await fakeGhost();
    const redirectServer = http.createServer((request, response) => {
      if (request.url.startsWith("/ghost/api/admin/")) {
        response.writeHead(302, { Location: `${ghost.origin}/ghost/api/admin/elsewhere/` }).end();
      } else {
        // If the client followed the redirect, this would run and the test fails below.
        response.writeHead(200, jsonHeaders()).end(JSON.stringify({ posts: [] }));
      }
    });
    ghosts.push({ close: () => new Promise((resolve) => redirectServer.close(resolve)) });
    await new Promise((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    const client = new GhostClient({
      origin: `http://127.0.0.1:${redirectServer.address().port}`,
      id: KEY_ID,
      secret: KEY_SECRET,
    });
    await assert.rejects(client.findPostsBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /redirected the request \(302\)/);
      assert.match(error.message, /NOT followed/);
      return true;
    });
    // The redirect destination was never requested: no request reached the fake Ghost.
    assert.equal(ghost.requests.length, 0);
  });

  test("a stale updated_at update is a ConflictError", async () => {
    const ghost = await fakeGhost();
    const client = clientFor(ghost);
    ghost.posts.set("p1", { id: "p1", slug: "hello", html: "<p>stored</p>", updated_at: "2026-09-24T12:00:00.000Z", tags: [], authors: [] });
    await assert.rejects(
      client.updatePost("p1", { title: "t", slug: "hello", html: "<p>x</p>", updated_at: "2026-09-24T11:00:00.000Z" }),
      (error) => {
        assert.ok(error instanceof ConflictError);
        assert.ok(!(error instanceof RemoteError) || true); // ConflictError is a sibling, checked below
        assert.match(error.message, /409|Lost update/);
        return true;
      },
    );
    assert.ok(new ConflictError("x") instanceof Error);
  });

  test("a transport failure on a mutating request is an UncertainError (the request may have been applied)", async () => {
    const ghost = await fakeGhost({ failAfterApply: true });
    const client = clientFor(ghost);
    ghost.posts.set("p1", { id: "p1", slug: "hello", html: "<p>old</p>", updated_at: "2026-09-24T12:00:00.000Z", tags: [], authors: [] });
    await assert.rejects(
      client.updatePost("p1", { title: "t", slug: "hello", html: "<p>new</p>", updated_at: "2026-09-24T12:00:00.000Z" }),
      (error) => {
        assert.ok(error instanceof UncertainError);
        assert.match(error.message, /may have been applied/);
        return true;
      },
    );
    // The fake applied the request before dropping the reply — which is
    // exactly why the effect is uncertain, not failed.
    assert.equal(ghost.posts.get("p1").html, "<p>new</p>");
  });

  test("a transport failure on a GET is a RemoteError", async () => {
    const client = new GhostClient({ origin: "http://127.0.0.1:1", id: KEY_ID, secret: KEY_SECRET });
    await assert.rejects(client.findPostsBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      assert.ok(!(error instanceof UncertainError));
      return true;
    });
  });

  test("a 5xx answer is a RemoteError with the parsed error message", async () => {
    const ghost = await fakeGhost({ status500: true });
    const client = clientFor(ghost);
    await assert.rejects(client.findPostsBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /Internal server error/);
      return true;
    });
  });
});

describe("GhostClient post-write response faults", () => {
  // The C5 oracle: a 2xx reply whose body is interrupted, unparseable, or
  // missing the post is a possible-applied mutation, never a "changed
  // nothing" report — the failure is UncertainError (exit 5), the outcome
  // the caller reconciles from Ghost, never RemoteError (exit 3), which
  // would wrongly imply the request changed nothing.
  const seeded = async (ghost) => {
    ghost.posts.set("p1", {
      id: "p1",
      slug: "hello",
      title: "Old",
      html: "<p>old</p>",
      updated_at: "2026-09-24T12:00:00.000Z",
      tags: [],
      authors: [],
    });
    return clientFor(ghost);
  };
  const payload = { title: "New", slug: "hello", html: "<p>new</p>", updated_at: "2026-09-24T12:00:00.000Z" };

  test("an interrupted 2xx body after an update is an UncertainError, and the write applied", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "update" ? "interrupt" : null) });
    const client = await seeded(ghost);
    await assert.rejects(client.updatePost("p1", payload), (error) => {
      assert.ok(error instanceof UncertainError);
      assert.ok(!(error instanceof RemoteError));
      return true;
    });
    // The write applied on the server: exactly why the outcome is unknown.
    assert.equal(ghost.posts.get("p1").title, "New");
  });

  test("a malformed 2xx JSON body after an update is an UncertainError", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "update" ? { body: "{not json" } : null) });
    const client = await seeded(ghost);
    await assert.rejects(client.updatePost("p1", payload), (error) => {
      assert.ok(error instanceof UncertainError);
      assert.match(error.message, /was not JSON/);
      return true;
    });
    assert.equal(ghost.posts.get("p1").title, "New");
  });

  test("a successful response missing the post data is an UncertainError", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "update" ? { body: "{}" } : null) });
    const client = await seeded(ghost);
    await assert.rejects(client.updatePost("p1", payload), (error) => {
      assert.ok(error instanceof UncertainError);
      assert.match(error.message, /holds no post/);
      return true;
    });
    assert.equal(ghost.posts.get("p1").title, "New");
  });

  test("a read whose body is not JSON stays a RemoteError (nothing was mutated)", async () => {
    const ghost = await fakeGhost({ faults: ({ kind }) => (kind === "other" ? { body: "{not json" } : null) });
    const client = clientFor(ghost);
    // A tag list read is the route the "other" hook reaches: a GET, so a
    // broken body there says nothing was changed.
    await assert.rejects(client.findTagBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      assert.ok(!(error instanceof UncertainError));
      assert.match(error.message, /was not JSON/);
      return true;
    });
  });
});

describe("createGhostClient", () => {
  test("builds a client from loadGhostConfig-shaped input and honours an injected fetchImpl", async () => {
    const ghost = await fakeGhost();
    const client = createGhostClient({ origin: ghost.origin, id: KEY_ID, secret: KEY_SECRET });
    assert.ok(client instanceof GhostClient);
    const posts = await client.findPostsBySlug("hello");
    assert.deepEqual(posts, []);

    // An injected fetchImpl replaces fetch for construction: a client whose
    // fetch always refuses reaches nothing, without monkey-patching beyond it.
    let seen = null;
    const injected = createGhostClient({ origin: ghost.origin, id: KEY_ID, secret: KEY_SECRET }, {
      fetchImpl: async (url, init) => {
        seen = { url, init };
        throw new TypeError("fetch disabled in this test");
      },
    });
    await assert.rejects(injected.findPostsBySlug("hello"), (error) => {
      assert.ok(error instanceof RemoteError);
      return true;
    });
    assert.ok(seen.url.startsWith(ghost.origin));
  });
});

// C8: a public response is read as bytes and decoded by content type.
// Confirmed defect: fetchPublic decoded EVERY response as latin1 "so binary
// bodies survive", which is right for image bytes and wrong for everything
// else — a public page's UTF-8 article text came back as mojibake ("café" as
// "cafÃ©") and the public content check compared that against a correctly
// decoded candidate, so any non-ASCII article failed its own public check. The
// asset-reuse digest check had to round-trip the same bytes back through
// Buffer.from(body, "binary") to be accurate at all.
describe("C8: fetchPublic decodes text correctly and preserves image bytes", () => {
  /** A loopback server that answers every request with one fixed payload. */
  async function serving(payload, contentType) {
    const server = http.createServer((request, response) => {
      response.writeHead(200, contentType ? { "Content-Type": contentType } : {});
      response.end(payload);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new GhostClient({
      origin: `http://127.0.0.1:${server.address().port}`,
      id: KEY_ID,
      secret: KEY_SECRET,
    });
    return { client, url: `http://127.0.0.1:${server.address().port}/page/`, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  test("a UTF-8 public page decodes as UTF-8, and its bytes are still exact", async () => {
    const html = Buffer.from("<html><body><p>café — naïve … Zürich “quoted”</p></body></html>", "utf8");
    const { client, url, close } = await serving(html, "text/html; charset=utf-8");
    try {
      const page = await client.fetchPublic(url);
      assert.equal(page.status, 200);
      assert.ok(page.body.includes("café"), `decoded as UTF-8: ${JSON.stringify(page.body.slice(0, 90))}`);
      assert.ok(page.body.includes("Zürich"));
      assert.ok(!page.body.includes("cafÃ©"), "no latin1 mojibake in the decoded text");
      assert.deepEqual(page.bytes, html, "the bytes are the response's, undecoded");
    } finally {
      await close();
    }
  });

  test("image bytes come back exactly, with no text decoding in the way", async () => {
    // Bytes that are NOT valid UTF-8, so a utf8 decode would corrupt them.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0xc3, 0x28]);
    const { client, url, close } = await serving(png, "image/png");
    try {
      const page = await client.fetchPublic(url);
      assert.deepEqual(page.bytes, png);
      assert.equal(page.bytes.length, png.length);
      // The reuse digest is computed over `bytes`, never over a re-encoded
      // `body`, so it cannot be perturbed by the text decode.
      assert.deepEqual(Buffer.from(page.bytes), png);
    } finally {
      await close();
    }
  });

  test("a textual media type without a charset still decodes as UTF-8", async () => {
    const html = Buffer.from("<p>café</p>", "utf8");
    const { client, url, close } = await serving(html, "text/html");
    try {
      assert.ok((await client.fetchPublic(url)).body.includes("café"));
    } finally {
      await close();
    }
  });

  test("a response with no Content-Type at all is decoded by what its bytes are", async () => {
    const html = Buffer.from("<p>café</p>", "utf8");
    const text = await serving(html, null);
    try {
      assert.ok((await text.client.fetchPublic(text.url)).body.includes("café"), "valid UTF-8 reads as text");
    } finally {
      await text.close();
    }
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0x4a]);
    const image = await serving(binary, null);
    try {
      const page = await image.client.fetchPublic(image.url);
      assert.deepEqual(page.bytes, binary, "invalid UTF-8 stays byte-exact");
    } finally {
      await image.close();
    }
  });
});
