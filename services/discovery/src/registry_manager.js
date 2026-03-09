import { bulkUpsertUrls } from '../../../utils/url-registry.js';
import logger from '../../../utils/logger.js';

export async function mergeDiscovered(discovered, sourceConfig = {}) {
  const entries = [];

  for (const item of discovered) {
    // Guard against undefined/null items
    if (!item?.url) {
      logger.warn('[Registry] Skipping item with no URL:', JSON.stringify(item));
      continue;
    }

    // Apply per-source URL filter
    if (sourceConfig.urlFilter) {
      const re = new RegExp(sourceConfig.urlFilter, 'i');
      if (!re.test(item.url)) {
        logger.debug('[Registry] Filtered out: ' + item.url);
        continue;
      }
    }

    // Normalise URL — strip CMS duplicate suffix (-2, -3 etc.)
    const normalisedUrl = item.url.replace(/-\d+\/$/, '/').replace(/-\d+$/, '');
    if (!normalisedUrl) {
      logger.warn('[Registry] Normalisation produced empty URL for: ' + item.url);
      continue;
    }

    entries.push({
      url:            normalisedUrl,
      label:          item.label ?? deriveLabel(normalisedUrl, sourceConfig),
      frequency:      sourceConfig.frequency ?? 'daily',
      active:         sourceConfig.active    ?? true,
      lastScraped:    null,
      notes:          buildNotes(item, sourceConfig),
      discoveredAt:   new Date(),
      discoveredFrom: item.sourceFeed ?? null,
      sourceType:     item.sourceType ?? null,
      publishedAt:    item.publishedAt ? new Date(item.publishedAt) : null,
    });
  }

  if (entries.length === 0) {
    logger.info('[Registry] No URLs passed filter — nothing to upsert');
    return { added: 0, skipped: 0 };
  }

  const result = await bulkUpsertUrls(entries);
  logger.info(`[Registry] Merged — ${result.added} added, ${result.skipped} skipped`);
  return result;
}

function deriveLabel(url, sourceConfig) {
  const prefix = sourceConfig.name ? sourceConfig.name + ' — ' : '';
  try {
    const u    = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
    return prefix + slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return prefix + url;
  }
}

function buildNotes(item, sourceConfig) {
  const parts = [];
  if (sourceConfig.notes)        parts.push(sourceConfig.notes);
  if (item.sourceType === 'rss')     parts.push('Auto-discovered via RSS');
  if (item.sourceType === 'sitemap') parts.push('Auto-discovered via sitemap');
  return parts.join(' — ') || null;
}