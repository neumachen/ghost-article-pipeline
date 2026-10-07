// The candidate: the reviewable, revision-bound representation of what
// would be sent to Ghost. Everything a publish needs is derived here —
// validated front matter, rendered body, resolved assets — and bound
// together by candidateHash, the contract between prepare and publish:
// publish recomputes the hash from the candidate directory and refuses a
// mismatch, so what is sent is exactly what was reviewed.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { ValidationError, RefusedError } from "./errors.mjs";
import { parseArticle } from "./frontmatter.mjs";
import { mapImageSrc, renderMarkdown } from "./markdown.mjs";
import { resolveAssets, sha256 } from "./assets.mjs";
import { commitExists } from "./git-source.mjs";

export const CANDIDATE_SCHEMA = "neumachen-article-candidate/1";
export const ARTICLE_MARKDOWN = "article.md";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ARTICLE_STATUSES = ["draft", "published"];

const stringList = (value) => (Array.isArray(value) ? value.every((item) => typeof item === "string" && item) : false);

/**
 * The candidateHash manifest, canonical UTF-8 text: schema line, then
 * key: value lines, then one line per asset. Authors sorted; tags in
 * declared order — authors are a set, tags carry the author's ordering.
 *
 * Every publication-affecting candidate field is bound here: what
 * postPayload sends (title, slug, status, custom_excerpt, tags, authors,
 * feature_image) plus the body via bodyHash and every asset via its ref,
 * sha256 and size. featureImage is bound explicitly even though the asset
 * itself is already listed in assets: which asset is the feature image is
 * its own published fact (postPayload sends feature_image), so swapping it
 * between two already-included assets must move the hash. The remaining
 * candidate fields (article.path, source.kind, environment, unknownKeys)
 * never reach Ghost and cannot change the payload, so they stay out: the
 * manifest binds what would be sent, not where it was prepared.
 */
function manifestLines(candidate) {
  return [
    `schema: ${candidate.schema}`,
    `id: ${candidate.article.id}`,
    `revision: ${candidate.source.revision}`,
    `title: ${candidate.title}`,
    `slug: ${candidate.slug}`,
    `status: ${candidate.status}`,
    ...[...candidate.authors].sort().map((author) => `author: ${author}`),
    ...candidate.tags.map((tag) => `tag: ${tag}`),
    `excerpt: ${candidate.excerpt ?? ""}`,
    `featureImage: ${candidate.featureImage ?? ""}`,
    `bodyHash: ${candidate.bodyHash}`,
    ...candidate.assets.map((asset) => `asset: ${asset.ref} ${asset.sha256} ${asset.size}`),
  ];
}

export function computeCandidateHash(candidate) {
  return sha256(Buffer.from(`${manifestLines(candidate).join("\n")}\n`, "utf8"));
}

/**
 * Build a candidate from an article's files at a revision. The front matter
 * is validated strictly here — wrong types are a refused candidate, not a
 * runtime surprise later — and unknown keys are allowed but recorded, so a
 * new front-matter field never silently disappears.
 */
export function buildCandidate({ repoRoot, article, revision, files, env = process.env, kind = "commit" }) {
  const markdownBytes = files.get(`${article.path}/${ARTICLE_MARKDOWN}`);
  if (!markdownBytes) {
    throw new ValidationError(`Article "${article.id}" has no ${ARTICLE_MARKDOWN} in ${article.path}.`);
  }
  let markdown;
  try {
    markdown = markdownBytes.toString("utf8");
  } catch (error) {
    throw new ValidationError(`Article "${article.id}": ${ARTICLE_MARKDOWN} is not valid UTF-8: ${error.message}`);
  }
  const { data, body } = parseArticle(markdown);

  const required = (field) => {
    if (typeof data[field] !== "string" || !data[field]) {
      throw new ValidationError(`Article "${article.id}": front matter field "${field}" is required and must be a non-empty string.`);
    }
    return data[field];
  };
  const id = required("id");
  const title = required("title");
  const slug = required("slug");

  if (id !== article.id) {
    throw new ValidationError(
      `Article "${article.id}": front matter id is "${id}", which does not match the registry id. Nothing was sent.`,
    );
  }
  if (!ID_PATTERN.test(id)) {
    throw new ValidationError(`Article "${article.id}": the id does not match ^[a-z0-9][a-z0-9-]{0,63}$.`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError(`Article "${article.id}": the slug "${slug}" does not match ^[a-z0-9][a-z0-9-]{0,127}$.`);
  }

  let status = "published";
  if (data.status !== undefined) {
    if (typeof data.status !== "string" || !ARTICLE_STATUSES.includes(data.status)) {
      throw new ValidationError(`Article "${article.id}": status must be "draft" or "published", not ${JSON.stringify(data.status)}.`);
    }
    status = data.status;
  }

  const authors = data.authors === undefined ? [] : data.authors;
  if (!stringList(authors)) {
    throw new ValidationError(`Article "${article.id}": authors must be a list of non-empty strings.`);
  }
  const tags = data.tags === undefined ? [] : data.tags;
  if (!stringList(tags)) {
    throw new ValidationError(`Article "${article.id}": tags must be a list of non-empty strings.`);
  }
  const excerpt = data.excerpt === undefined ? null : data.excerpt;
  if (excerpt !== null && typeof excerpt !== "string") {
    throw new ValidationError(`Article "${article.id}": excerpt must be a string.`);
  }
  const featureImage = data.feature_image === undefined ? null : data.feature_image;
  if (featureImage !== null && (typeof featureImage !== "string" || !featureImage)) {
    throw new ValidationError(`Article "${article.id}": feature_image must be a non-empty string when set.`);
  }
  const assetList = data.assets === undefined ? [] : data.assets;
  if (!Array.isArray(assetList) || !assetList.every((asset) => asset && typeof asset === "object" && typeof asset.path === "string" && (asset.alt === undefined || typeof asset.alt === "string"))) {
    throw new ValidationError(`Article "${article.id}": assets must be a list of { path, alt } objects.`);
  }

  const unknownKeys = Object.keys(data).filter(
    (key) => !["id", "title", "slug", "status", "authors", "excerpt", "tags", "feature_image", "assets"].includes(key),
  );

  const html = renderMarkdown(body);
  const bodyHash = sha256(Buffer.from(html, "utf8"));
  const { assets, featureImage: resolvedFeatureImage } = resolveAssets(files, article.path, {
    html,
    featureImage,
    assetList,
  });

  const candidate = {
    schema: CANDIDATE_SCHEMA,
    article: { id: article.id, path: article.path },
    source: {
      revision,
      kind,
      repo: repoRoot ? path.basename(repoRoot) : null,
    },
    environment: {
      image: env.ARTICLE_IMAGE ?? null,
      platform: env.ARTICLE_PLATFORM ?? null,
      node: process.version,
    },
    title,
    slug,
    status,
    authors,
    excerpt,
    tags,
    featureImage: resolvedFeatureImage,
    bodyHtml: html,
    bodyHash,
    assets,
    unknownKeys,
    candidateHash: null, // filled below
  };
  candidate.candidateHash = computeCandidateHash(candidate);
  return candidate;
}

/** The JSON written to <outDir>/candidate.json: the candidate plus the asset file mapping. */
function candidateJson(candidate, assetFiles) {
  return {
    schema: candidate.schema,
    article: candidate.article,
    source: candidate.source,
    environment: candidate.environment,
    title: candidate.title,
    slug: candidate.slug,
    status: candidate.status,
    authors: candidate.authors,
    excerpt: candidate.excerpt,
    tags: candidate.tags,
    featureImage: candidate.featureImage,
    bodyHash: candidate.bodyHash,
    candidateHash: candidate.candidateHash,
    unknownKeys: candidate.unknownKeys ?? [],
    assets: candidate.assets.map((asset) => ({ ...asset, file: assetFiles.get(asset.ref) })),
  };
}

/** The on-disk name for an asset: a sha256 prefix avoids collisions between same-named assets. */
function assetFileName(asset) {
  return `${asset.sha256.slice(0, 8)}.${path.posix.extname(asset.ref).replace(".", "") || "bin"}`;
}

const PREVIEW_STYLE = [
  "body{max-width:42em;margin:2rem auto;padding:0 1rem;font-family:Georgia,serif;line-height:1.6;color:#211b2e}",
  "img{max-width:100%;height:auto}",
  "pre{overflow-x:auto;padding:0.75rem;background:#f4f2f6}",
  "table{border-collapse:collapse}td,th{border:1px solid #d8d4de;padding:0.35rem 0.6rem}",
].join(";");

/**
 * Write the candidate out: candidate.json (the reviewable record),
 * body.html (the rendered body), preview.html (a standalone page a browser
 * can render, with asset paths rewritten to assets/<file>), and the assets
 * themselves under assets/. Same-named assets land under their
 * sha-prefixed filenames, recorded per asset in candidate.json.
 */
export async function writeCandidate(outDir, candidate, assetBytes) {
  await mkdir(path.join(outDir, "assets"), { recursive: true });
  const assetFiles = new Map(); // ref -> file name
  for (const asset of candidate.assets) {
    const bytes = assetBytes.get(asset.path);
    if (!bytes) {
      throw new ValidationError(`Candidate for "${candidate.article.id}": no bytes for asset "${asset.ref}".`);
    }
    const name = assetFileName(asset);
    assetFiles.set(asset.ref, name);
    await writeFile(path.join(outDir, "assets", name), bytes);
  }

  const previewHtml = previewPage(candidate, assetFiles);
  const written = {
    candidateJson: path.join(outDir, "candidate.json"),
    bodyHtml: path.join(outDir, "body.html"),
    previewHtml: path.join(outDir, "preview.html"),
    assets: candidate.assets.map((asset) => ({
      ref: asset.ref,
      path: path.join(outDir, "assets", assetFiles.get(asset.ref)),
    })),
  };
  await writeFile(written.candidateJson, `${JSON.stringify(candidateJson(candidate, assetFiles), null, 2)}\n`);
  await writeFile(written.bodyHtml, candidate.bodyHtml);
  await writeFile(written.previewHtml, previewHtml);
  return written;
}

function previewPage(candidate, assetFiles) {
  // Rewrite each ref to its local assets/<file> copy so a browser renders
  // the page from the directory as-is. The same code-aware, <img>-only walk
  // discovery and publication use, so a preview shows exactly the images the
  // published post will carry — and a code example stays an example instead
  // of becoming a broken local path.
  const replaceRefs = (html) =>
    mapImageSrc(html, (value) => {
      const file = assetFiles.get(value);
      return file === undefined ? value : `assets/${file}`;
    });
  const body = replaceRefs(candidate.bodyHtml);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(candidate.title)}</title>`,
    `<style>${PREVIEW_STYLE}</style>`,
    "</head>",
    "<body>",
    `<article>`,
    `<h1>${escapeHtml(candidate.title)}</h1>`,
    body,
    `</article>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** candidate.json as written, with the asset file mapping applied. */
function candidateFromDisk(json) {
  return {
    schema: json.schema,
    article: json.article,
    source: json.source,
    environment: json.environment,
    title: json.title,
    slug: json.slug,
    status: json.status,
    authors: json.authors,
    excerpt: json.excerpt,
    tags: json.tags,
    featureImage: json.featureImage,
    bodyHash: json.bodyHash,
    candidateHash: json.candidateHash,
    unknownKeys: json.unknownKeys ?? [],
    assets: json.assets.map(({ file, ...asset }) => ({ ...asset })),
  };
}

/**
 * Load a candidate directory and re-verify it. The recorded candidateHash
 * is recomputed from what is actually on disk; any difference — a changed
 * body, a swapped asset, a missing file — is a RefusedError (exit 2), never
 * a best-effort continue: publish must send exactly what was reviewed.
 * Each asset's sha256 and size are checked too.
 */
export async function loadCandidate(dir) {
  const refused = (detail) =>
    new RefusedError(`The candidate in ${dir} is missing, mismatched, or unusable: ${detail} Nothing was sent.`);

  let json;
  try {
    json = JSON.parse(await readFile(path.join(dir, "candidate.json"), "utf8"));
  } catch (error) {
    throw refused(`candidate.json cannot be read: ${error.message}`);
  }
  if (json?.schema !== CANDIDATE_SCHEMA) {
    throw refused(`candidate.json is not a "${CANDIDATE_SCHEMA}" document.`);
  }
  let bodyHtml;
  try {
    bodyHtml = await readFile(path.join(dir, "body.html"), "utf8");
  } catch (error) {
    throw refused(`body.html cannot be read: ${error.message}`);
  }

  const candidate = candidateFromDisk(json);
  const assetBytes = new Map(); // asset.path -> bytes
  const assetFileByName = new Map(json.assets.map((asset) => [asset.ref, asset]));
  for (const asset of candidate.assets) {
    const onDisk = assetFileByName.get(asset.ref);
    if (!onDisk || typeof onDisk.file !== "string" || !onDisk.file) {
      throw refused(`asset "${asset.ref}" has no recorded file.`);
    }
    let bytes;
    try {
      bytes = await readFile(path.join(dir, "assets", onDisk.file));
    } catch (error) {
      throw refused(`asset "${asset.ref}" (${onDisk.file}) cannot be read: ${error.message}`);
    }
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw refused(`asset "${asset.ref}" (${onDisk.file}) has SHA-256 ${digest}, but the candidate records ${asset.sha256}.`);
    }
    if (bytes.length !== asset.size) {
      throw refused(`asset "${asset.ref}" (${onDisk.file}) is ${bytes.length} bytes, but the candidate records ${asset.size}.`);
    }
    assetBytes.set(asset.path, bytes);
  }

  const bodyHash = sha256(Buffer.from(bodyHtml, "utf8"));
  if (bodyHash !== candidate.bodyHash) {
    throw refused(`body.html has body hash ${bodyHash}, but the candidate records ${candidate.bodyHash}.`);
  }
  const withBody = { ...candidate, bodyHtml };
  const recomputed = computeCandidateHash(withBody);
  if (recomputed !== candidate.candidateHash) {
    throw refused(`the recomputed candidate hash is ${recomputed}, but the candidate records ${candidate.candidateHash}.`);
  }
  return { candidate: withBody, assetBytes };
}

/**
 * The publish-side gate: a candidate may only be published from an exact
 * commit that still exists in the repo. A working-tree candidate is
 * refused — the working tree is not a revision — and a commit that has
 * vanished (a rewritten branch) is refused too. The on-main check is added
 * by the workflow, not here.
 */
export function verifyCandidateForPublish(candidate, { repoRoot }) {
  if (candidate.source?.kind !== "commit") {
    throw new RefusedError(
      [
        `Refusing to publish article "${candidate.article?.id}": its candidate was built from the working tree, not from a commit.`,
        "A candidate must be bound to a revision before anything is sent. Nothing was sent.",
      ].join("\n"),
    );
  }
  const revision = candidate.source?.revision;
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision) || !commitExists(repoRoot, revision)) {
    throw new RefusedError(
      [
        `Refusing to publish article "${candidate.article?.id}": its revision ${revision ?? "(none)"} is not a commit present in ${repoRoot}.`,
        "Nothing was sent.",
      ].join("\n"),
    );
  }
  return true;
}
