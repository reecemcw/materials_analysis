/**
 * Discovery Runner
 *
 * Orchestrates the full discovery cycle:
 *   1. Load sources.json — the list of sites to monitor
 *   2. For each source, discover new URLs (RSS, sitemap, or auto-detect)
 *   3. Merge discovered URLs into url.json (deduped)
 *   4. Return a structured run report
 *
 * This is called by:
 *   - The cron job in discovery-server.js (daily automated runs)
 *   - POST /discover/run (manual trigger via HTTP)
 */

import { discoverFromFeed, discoverFromSitemap, autoDiscover } from "./url_discoverer.js";
import { mergeDiscovered } from "./registry_manager.js";
import logger from "../../../utils/logger.js";

/**
 * Run a full discovery cycle across all active sources.
 *
 * @param {object[]} sources  Array of source config objects from sources.json
 * @returns {object}          Run report
 */
export async function runDiscovery(sources) {
  const startedAt = new Date().toISOString();
  logger.info("[Discovery] === Discovery run started ===");

  const activeSources = sources.filter(s => s.active !== false);
  logger.info("[Discovery] Active sources: " + activeSources.length + " / " + sources.length);

  const sourceReports = [];
  let totalAdded   = 0;
  let totalSkipped = 0;
  let totalErrors  = 0;

  for (const source of activeSources) {
    logger.info("[Discovery] Processing source: " + source.name + " (" + source.baseUrl + ")");

    const report = {
      name:      source.name,
      baseUrl:   source.baseUrl,
      discovered: 0,
      added:     0,
      skipped:   0,
      errors:    [],
    };

    // Collect all discovered items from this source
    const allDiscovered = [];

    // --- RSS / Atom feeds ---
    const feedUrls = await resolveFeeds(source);
    for (const feedUrl of feedUrls) {
      try {
        const items = await discoverFromFeed(feedUrl);
        allDiscovered.push(...items);
      } catch (err) {
        const msg = "Feed error (" + feedUrl + "): " + err.message;
        logger.error("[Discovery] " + msg);
        report.errors.push(msg);
        totalErrors++;
      }
    }

    // --- Sitemaps ---
    const sitemapUrls = await resolveSitemaps(source);
    for (const sitemapUrl of sitemapUrls) {
      try {
        const items = await discoverFromSitemap(sitemapUrl, {
          maxDepth: source.sitemapDepth ?? 2,
        });
        allDiscovered.push(...items);
      } catch (err) {
        const msg = "Sitemap error (" + sitemapUrl + "): " + err.message;
        logger.error("[Discovery] " + msg);
        report.errors.push(msg);
        totalErrors++;
      }
    }

    report.discovered = allDiscovered.length;

    // --- Merge into registry ---
    if (allDiscovered.length > 0) {
      try {
        const { added, skipped } = await mergeDiscovered(allDiscovered, source);
        report.added   = added;
        report.skipped = skipped;
        totalAdded   += added;
        totalSkipped += skipped;
      } catch (err) {
        const msg = "Registry merge error: " + err.message;
        logger.error("[Discovery] " + msg);
        report.errors.push(msg);
        totalErrors++;
      }
    }

    sourceReports.push(report);
    // Brief pause between sources to be respectful
    await sleep(1500);
  }

  const summary = {
    startedAt,
    completedAt:   new Date().toISOString(),
    sourcesRun:    activeSources.length,
    totalDiscovered: sourceReports.reduce((n, r) => n + r.discovered, 0),
    totalAdded,
    totalSkipped,
    totalErrors,
    sources: sourceReports,
  };

  logger.info(
    "[Discovery] === Run complete — " +
    totalAdded + " added, " +
    totalSkipped + " skipped, " +
    totalErrors + " errors ==="
  );

  return summary;
}

// ─── Resolve feed/sitemap URLs for a source ────────────────────────────────────

async function resolveFeeds(source) {
  // Explicit feeds take priority
  if (source.feeds && source.feeds.length > 0) return source.feeds;
  // Auto-discover from homepage if no explicit feeds and autoDiscover not disabled
  if (source.autoDiscover !== false) {
    try {
      const { feeds } = await autoDiscover(source.baseUrl);
      return feeds;
    } catch (err) {
      logger.warn("[Discovery] Auto-discover feeds failed for " + source.baseUrl + ": " + err.message);
    }
  }
  return [];
}

async function resolveSitemaps(source) {
  if (source.sitemaps && source.sitemaps.length > 0) return source.sitemaps;
  if (source.autoDiscover !== false) {
    try {
      const { sitemaps } = await autoDiscover(source.baseUrl);
      return sitemaps;
    } catch (err) {
      logger.warn("[Discovery] Auto-discover sitemaps failed for " + source.baseUrl + ": " + err.message);
    }
  }
  return [];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}