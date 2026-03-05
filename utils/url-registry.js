/**
 * /utils/url-registry.js
 *
 * Drop-in replacement for direct url.json reads across the codebase.
 * Scheduler, scraper, and discovery service should all use this instead
 * of reading url.json directly.
 *
 * API mirrors the shape of url.json entries so callers need minimal changes.
 */

import { getUrlRegistryModel } from '../data/models/model_factory.js';
import logger from './logger.js';

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get all active URLs due for scraping at a given frequency.
 * Equivalent to: urlJson.urls.filter(u => u.active && u.frequency === freq)
 */
export async function getActiveUrls(frequency = null) {
  const UrlRegistry = await getUrlRegistryModel();

  const query = { active: true };
  if (frequency) query.frequency = frequency;

  const docs = await UrlRegistry.find(query).sort({ lastScraped: 1 }).lean();
  return docs.map(toPlain);
}

/**
 * Get a single URL entry by URL string.
 */
export async function getUrlEntry(url) {
  const UrlRegistry = await getUrlRegistryModel();
  const doc = await UrlRegistry.findOne({ url: url.trim() }).lean();
  return doc ? toPlain(doc) : null;
}

/**
 * Get all URL entries (active and inactive), mirroring full url.json contents.
 */
export async function getAllUrls() {
  const UrlRegistry = await getUrlRegistryModel();
  const docs = await UrlRegistry.find({}).sort({ createdAt: 1 }).lean();
  return docs.map(toPlain);
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Mark a URL as scraped (updates lastScraped timestamp).
 * Call this after a successful scrape, replacing the url.json write.
 */
export async function markScraped(url) {
  const UrlRegistry = await getUrlRegistryModel();
  const result = await UrlRegistry.findOneAndUpdate(
    { url: url.trim() },
    { $set: { lastScraped: new Date() } },
    { new: true }
  ).lean();

  if (!result) {
    logger.warn(`[UrlRegistry] markScraped: URL not found in registry: ${url}`);
  }
  return result ? toPlain(result) : null;
}

/**
 * Upsert a URL entry. Used by the discovery service to add newly found URLs.
 * Will not overwrite lastScraped or manual fields if the doc already exists.
 */
export async function upsertUrl(entry) {
  const UrlRegistry = await getUrlRegistryModel();

  const { url, ...rest } = entry;
  if (!url) throw new Error('upsertUrl: url is required');

  const result = await UrlRegistry.findOneAndUpdate(
    { url: url.trim() },
    { $setOnInsert: { url: url.trim(), ...rest } },
    { upsert: true, new: true, rawResult: true }
  );

  const wasInserted = !result.lastErrorObject?.updatedExisting;
  logger.info(`[UrlRegistry] ${wasInserted ? 'Inserted' : 'Already exists'}: ${url}`);

  return {
    doc: toPlain(result.value),
    inserted: wasInserted,
  };
}

/**
 * Bulk upsert — used by discovery service to merge a batch of discovered URLs.
 * Returns { added, skipped } counts.
 */
export async function bulkUpsertUrls(entries) {
  let added   = 0;
  let skipped = 0;

  for (const entry of entries) {
    try {
      const { inserted } = await upsertUrl(entry);
      inserted ? added++ : skipped++;
    } catch (err) {
      logger.error(`[UrlRegistry] Failed to upsert ${entry.url}:`, err.message);
    }
  }

  logger.info(`[UrlRegistry] Bulk upsert complete — added: ${added}, skipped: ${skipped}`);
  return { added, skipped };
}

/**
 * Deactivate a URL (soft delete — keeps history).
 */
export async function deactivateUrl(url) {
  const UrlRegistry = await getUrlRegistryModel();
  await UrlRegistry.findOneAndUpdate(
    { url: url.trim() },
    { $set: { active: false } }
  );
  logger.info(`[UrlRegistry] Deactivated: ${url}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a Mongoose doc to a plain object matching the url.json entry shape.
 * This means callers that used to read url.json need zero changes.
 */
function toPlain(doc) {
  return {
    url:           doc.url,
    label:         doc.label         || '',
    frequency:     doc.frequency     || 'daily',
    active:        doc.active        ?? true,
    lastScraped:   doc.lastScraped   ? doc.lastScraped.toISOString() : null,
    notes:         doc.notes         || '',
    // Discovery metadata
    discoveredAt:   doc.discoveredAt   ? doc.discoveredAt.toISOString()   : null,
    discoveredFrom: doc.discoveredFrom || null,
    sourceType:     doc.sourceType     || null,
    publishedAt:    doc.publishedAt    ? doc.publishedAt.toISOString()    : null,
    // Timestamps
    createdAt:      doc.createdAt      ? doc.createdAt.toISOString()      : null,
    updatedAt:      doc.updatedAt      ? doc.updatedAt.toISOString()      : null,
  };
}