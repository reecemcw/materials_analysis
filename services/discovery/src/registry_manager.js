/**
 * Registry Manager
 *
 * Manages the url.json registry. Responsible for:
 *   - Loading and saving the registry
 *   - Merging newly discovered URLs into the registry
 *   - Deduplication (by normalised URL)
 *   - Applying per-source config (frequency, notes, active flag)
 *
 * Fully backward-compatible with the existing url.json format and
 * the scheduler.js that reads it.
 */

import { promises as fs } from "fs";
import { join, dirname }  from "path";
import { fileURLToPath }  from "url";
import logger             from "../../../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const REGISTRY_PATH = process.env.REGISTRY_PATH
  ?? join(__dirname, "../../../url.json");

// Load registry from disk
export async function loadRegistry() {
  const raw = await fs.readFile(REGISTRY_PATH, "utf8");
  return JSON.parse(raw);
}

// Save registry to disk
export async function saveRegistry(registry) {
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
}

/**
 * Merge an array of discovered URLs into the registry.
 *
 * @param {object[]} discovered   Items from discoverer.js
 * @param {object}   sourceConfig Config entry from sources.json
 * @returns {{ added: number, skipped: number, registry: object }}
 */
export async function mergeDiscovered(discovered, sourceConfig = {}) {
  const registry = await loadRegistry();

  // Build a Set of already-registered URLs for O(1) lookup
  const existingUrls = new Set(registry.urls.map(e => normalise(e.url)));

  let added   = 0;
  let skipped = 0;

  for (const item of discovered) {
    const normUrl = normalise(item.url);

    if (existingUrls.has(normUrl)) {
      skipped++;
      continue;
    }

    // Optional regex filter defined per source (e.g. only /news/ paths)
    if (sourceConfig.urlFilter) {
      const re = new RegExp(sourceConfig.urlFilter, "i");
      if (!re.test(item.url)) {
        logger.debug("[Registry] Filtered out: " + item.url);
        skipped++;
        continue;
      }
    }

    const entry = {
      url:         item.url,
      label:       item.label ?? deriveLabel(item.url, sourceConfig),
      frequency:   sourceConfig.frequency ?? "daily",
      active:      sourceConfig.active    ?? true,
      lastScraped: null,
      notes:       buildNotes(item, sourceConfig),
      _discoveredAt:   new Date().toISOString(),
      _discoveredFrom: item.sourceFeed,
      _sourceType:     item.sourceType,
    };
    if (item.publishedAt) entry._publishedAt = item.publishedAt;

    registry.urls.push(entry);
    existingUrls.add(normUrl);
    added++;
    logger.info("[Registry] Added: " + entry.label + " — " + entry.url);
  }

  if (added > 0) {
    await saveRegistry(registry);
    logger.info("[Registry] Saved — " + added + " added, " + skipped + " skipped");
  } else {
    logger.info("[Registry] No new URLs — " + skipped + " already registered");
  }

  return { added, skipped, registry };
}

// Helpers

function normalise(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

function deriveLabel(url, sourceConfig) {
  const prefix = sourceConfig.name ? sourceConfig.name + " — " : "";
  try {
    const u    = new URL(url);
    const slug = u.pathname.split("/").filter(Boolean).pop() ?? u.hostname;
    const title = slug.replace(/[-_]/g, " ").replace(/\w/g, c => c.toUpperCase());
    return prefix + title;
  } catch {
    return prefix + url;
  }
}

function buildNotes(item, sourceConfig) {
  const parts = [];
  if (sourceConfig.notes) parts.push(sourceConfig.notes);
  if (item.sourceType === "rss")     parts.push("Auto-discovered via RSS");
  if (item.sourceType === "sitemap") parts.push("Auto-discovered via sitemap");
  return parts.join(" — ") || null;
}