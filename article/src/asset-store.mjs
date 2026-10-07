// A verified upload receipt survives runner changes and Ghost image re-encoding.
// Each internal tag binds one article/ref/source digest to the returned URL and
// served digest. Receipts are read-only after creation and never linked as
// public article tags.
import { sha256 as sha256Hex } from "./assets.mjs";
import { collectImageSrc } from "./markdown.mjs";
import { RefusedError, UncertainError } from "./errors.mjs";

function identity(articleId, asset) {
  const key = sha256Hex(Buffer.from(JSON.stringify([articleId, asset.ref, asset.sha256])));
  return { name: `#nc-asset-${key}`, slug: `hash-nc-asset-${key}` };
}

function receipt(tag, articleId, asset) {
  if (!tag) return null;
  const expected = identity(articleId, asset);
  let value;
  try { value = JSON.parse(tag.description); } catch { /* rejected below */ }
  if (tag.name !== expected.name || tag.slug !== expected.slug || tag.visibility !== "internal" ||
      value?.schema !== 1 || value.source !== asset.sha256 ||
      typeof value.url !== "string" || !/^https?:\/\//.test(value.url) ||
      !/^[0-9a-f]{64}$/.test(value.stored ?? "")) {
    throw new RefusedError(`Asset receipt for "${asset.ref}" is ambiguous or invalid; refusing to adopt it.`);
  }
  return value;
}

async function served(ghost, url) {
  const response = await ghost.fetchPublic(url);
  if (response.status !== 200 || !response.bytes) {
    throw new RefusedError(`Cannot verify stored image at ${url}; no upload will be retried blindly.`);
  }
  return sha256Hex(response.bytes);
}

export async function resolveAssetUrls(ghost, candidate, managed) {
  const urls = {};
  const live = [...new Set([
    ...collectImageSrc(managed?.html ?? ""),
    ...(managed?.feature_image ? [managed.feature_image] : []),
  ])].filter((url) => /^https?:\/\//.test(url));
  const digests = new Map();
  for (const asset of candidate.assets) {
    const tag = await ghost.findTagBySlug(identity(candidate.article.id, asset).slug);
    const known = receipt(tag, candidate.article.id, asset);
    if (known) {
      if (await served(ghost, known.url) !== known.stored) {
        throw new RefusedError(`Stored image for "${asset.ref}" changed since upload; refusing reuse or repair.`);
      }
      urls[asset.ref] = known.url;
      continue;
    }
    // Compatibility for earlier verbatim uploads. No basename inference:
    // source bytes must match what the URL actually serves.
    for (const url of live) {
      if (!digests.has(url)) digests.set(url, await served(ghost, url));
      if (digests.get(url) === asset.sha256) {
        urls[asset.ref] = url;
        break;
      }
    }
  }
  return urls;
}

export async function recordAssetUpload(ghost, candidate, asset, url, record) {
  const expected = identity(candidate.article.id, asset);
  const value = { schema: 1, source: asset.sha256, stored: await served(ghost, url), url };
  const description = JSON.stringify(value);
  if (description.length > 500) throw new UncertainError("Uploaded asset receipt exceeds Ghost's description limit; retain the upload URL from the run record.");
  record.step("asset-receipt", "sending", { asset: asset.ref, request_sent: true });
  let failure;
  try {
    const tag = await ghost.createTag({ ...expected, visibility: "internal", description });
    if (tag.slug !== expected.slug || tag.name !== expected.name) {
      throw new UncertainError("Ghost returned a different asset receipt identity.");
    }
  } catch (error) { failure = error; }
  try {
    const actual = receipt(await ghost.findTagBySlug(expected.slug), candidate.article.id, asset);
    if (!actual || actual.url !== url || actual.stored !== value.stored) throw new Error("receipt differs");
  } catch (error) {
    record.mutate("asset_receipts_uncertain");
    record.step("asset-receipt", "uncertain", { asset: asset.ref });
    throw new UncertainError(`Image upload completed, but its receipt could not be confirmed: ${failure?.message ?? error.message}. Do not upload again blindly.`);
  }
  record.mutate("asset_receipts_created");
  record.step("asset-receipt", "ok", { asset: asset.ref });
}
