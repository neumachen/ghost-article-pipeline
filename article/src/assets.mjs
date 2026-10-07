// Asset resolution: every relative reference the rendered article carries
// must exist inside the article's own directory, at the revision being
// published. An asset that is missing, unreadable, outside the directory or
// of an unknown type stops the pipeline before anything is sent — a
// published post whose images 404 is worse than a refused one.

import { createHash } from "node:crypto";
import path from "node:path";
import { ValidationError } from "./errors.mjs";
import { extractAssetRefs } from "./markdown.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Ghost accepts these image types natively; anything else in an <img> or the
// front matter is a file the pipeline cannot promise to serve correctly.
const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

/**
 * Resolve every asset reference an article carries against its file map.
 *
 * @param {Map<string, Buffer>} articleFiles the article's files, keyed by repo-relative path
 * @param {string} articleDirRel the article directory, repo-relative
 * @param {object} options
 *   html: the rendered body (relative src values are extracted from it)
 *   featureImage: optional relative front-matter feature_image
 *   assetList: optional front-matter assets [{path, alt}]
 * @returns {{ assets, featureImage }}
 *   assets: [{ ref, path, sha256, size, contentType }] sorted by ref
 *   featureImage: the resolved feature-image ref, or null
 */
export function resolveAssets(articleFiles, articleDirRel, { html = "", featureImage = null, assetList = [] } = {}) {
  const bodyRefs = extractAssetRefs(html);
  const refs = new Map(); // ref -> where it was declared, for error messages
  const add = (ref, origin) => {
    if (typeof ref === "string" && ref) refs.set(ref, origin);
  };
  for (const ref of bodyRefs) add(ref, "the rendered body");
  if (featureImage) add(featureImage, "front matter feature_image");
  for (const asset of assetList) add(asset?.path, "front matter assets");

  const resolved = [];
  let resolvedFeatureImage = null;
  for (const [ref, origin] of [...refs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (path.posix.isAbsolute(ref) || path.win32.isAbsolute(ref)) {
      throw new ValidationError(
        `Article "${articleDirRel}": asset "${ref}" (${origin}) is an absolute path; it must be relative to the article directory.`,
      );
    }
    // The containment check tests the raw segments as well as the joined
    // result: path.posix.join would quietly collapse "a/../b" back inside.
    if (ref.split("/").includes("..") || ref.split(path.sep).includes("..")) {
      throw new ValidationError(
        `Article "${articleDirRel}": asset "${ref}" (${origin}) climbs out of the article directory; ".." is not allowed.`,
      );
    }
    const joined = path.posix.normalize(path.posix.join(articleDirRel, ref));
    if (joined !== articleDirRel && !joined.startsWith(`${articleDirRel}/`)) {
      throw new ValidationError(
        `Article "${articleDirRel}": asset "${ref}" (${origin}) resolves to "${joined}", outside the article directory.`,
      );
    }
    const bytes = articleFiles.get(joined);
    if (!bytes) {
      throw new ValidationError(
        `Article "${articleDirRel}": asset "${ref}" (${origin}) resolves to "${joined}", which is not a file in the article directory at this revision.`,
      );
    }
    const ext = path.posix.extname(joined).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      throw new ValidationError(
        `Article "${articleDirRel}": asset "${ref}" (${origin}) has extension "${ext || "(none)"}", which is not one of ${Object.keys(CONTENT_TYPES).join(" ")}.`,
      );
    }
    if (featureImage && ref === featureImage) resolvedFeatureImage = ref;
    resolved.push({ ref, path: joined, sha256: sha256(bytes), size: bytes.length, contentType });
  }
  // feature_image, when given, went through add(), so it either resolved
  // above or already threw naming it; resolvedFeatureImage is null only
  // when no feature image was declared.
  return { assets: resolved, featureImage: resolvedFeatureImage };
}
