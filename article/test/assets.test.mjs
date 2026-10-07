// assets.mjs: every relative reference must exist inside the article
// directory at the revision being published, and unknown image types are
// refused rather than guessed at.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { resolveAssets } from "../src/assets.mjs";
import { ValidationError } from "../src/errors.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const articleDir = "editorial/articles/hello-world";
const png = Buffer.from("fakepng");
const files = new Map([
  ["editorial/articles/hello-world/article.md", Buffer.from("# x\n")],
  ["editorial/articles/hello-world/hero.png", png],
  ["editorial/articles/hello-world/img/deep.png", Buffer.from("deep")],
]);

describe("resolveAssets", () => {
  test("resolves body, feature_image and front-matter assets, sorted by ref", () => {
    const { assets, featureImage } = resolveAssets(files, articleDir, {
      html: '<img src="hero.png"><img src="img/deep.png"><a href="https://example.invalid/x">x</a>',
      featureImage: "hero.png",
      assetList: [{ path: "img/deep.png", alt: "deep image" }],
    });
    assert.deepEqual(
      assets.map((asset) => asset.ref),
      ["hero.png", "img/deep.png"],
    );
    assert.equal(assets[0].path, "editorial/articles/hello-world/hero.png");
    assert.equal(assets[0].sha256, sha256(png));
    assert.equal(assets[0].size, png.length);
    assert.equal(assets[0].contentType, "image/png");
    assert.equal(assets[1].contentType, "image/png");
    assert.equal(featureImage, "hero.png");
  });

  test("rejects a missing reference, naming the article and the reference", () => {
    assert.throws(
      () => resolveAssets(files, articleDir, { html: '<img src="missing.png">' }),
      (error) =>
        error instanceof ValidationError &&
        /"editorial\/articles\/hello-world"/.test(error.message) &&
        /"missing.png"/.test(error.message) &&
        /not a file in the article directory/.test(error.message),
    );
  });

  test("rejects a reference that climbs out of the article directory", () => {
    assert.throws(
      () => resolveAssets(files, articleDir, { html: '<img src="../other-article/hero.png">' }),
      (error) => error instanceof ValidationError && /"\.\." is not allowed/.test(error.message),
    );
    assert.throws(
      () => resolveAssets(files, articleDir, { featureImage: "../../outside.png" }),
      (error) => error instanceof ValidationError && /"\.\." is not allowed/.test(error.message),
    );
  });

  test("rejects an absolute reference", () => {
    // An absolute src never reaches assets.mjs (markdown.mjs filters it out
    // of the body refs), so the absolute-path refusal is exercised through
    // feature_image, which is not filtered.
    assert.throws(
      () => resolveAssets(files, articleDir, { featureImage: "/etc/passwd.png" }),
      (error) => error instanceof ValidationError && /absolute path/.test(error.message),
    );
    // ...and an absolute src in the body is simply not an asset reference:
    assert.deepEqual(resolveAssets(files, articleDir, { html: '<img src="/etc/passwd.png">' }).assets, []);
  });

  test("rejects an unknown extension", () => {
    const withTxt = new Map(files);
    withTxt.set("editorial/articles/hello-world/photo.bmp", Buffer.from("bmp"));
    assert.throws(
      () => resolveAssets(withTxt, articleDir, { html: '<img src="photo.bmp">' }),
      (error) => error instanceof ValidationError && /"\.bmp", which is not one of/.test(error.message),
    );
  });

  test("knows the common image content types", () => {
    const many = new Map(files);
    const pairs = [
      ["a.jpg", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.gif", "image/gif"],
      ["d.webp", "image/webp"],
      ["e.svg", "image/svg+xml"],
      ["f.avif", "image/avif"],
    ];
    for (const [name] of pairs) many.set(`${articleDir}/${name}`, Buffer.from(name));
    const { assets } = resolveAssets(many, articleDir, {
      html: pairs.map(([name]) => `<img src="${name}">`).join(""),
    });
    assert.deepEqual(
      assets.map((asset) => asset.contentType),
      pairs.map(([, type]) => type),
    );
  });
});
