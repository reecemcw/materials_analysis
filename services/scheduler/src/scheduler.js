import { randomUUID }     from 'crypto';
import axios              from 'axios';
import logger             from '../../../utils/logger.js';
import { getActiveUrls} from '../../../utils/url-registry.js';

const activeUrls = await getActiveUrls();          // all active
const dailyUrls  = await getActiveUrls('daily');   // filtered by frequency

const SCRAPER_URL  = process.env.SCRAPER_URL  || 'http://localhost:3001';
const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';
const GRAPH_URL    = process.env.GRAPH_URL    || 'http://localhost:3003';
const DISCOVERY_URL = process.env.DISCOVERY_URL || 'http://localhost:3005';

// ─── Frequency Helpers ────────────────────────────────────────────────────────

const FREQUENCY_MS = {
  daily:   24 * 60 * 60 * 1000,
  weekly:  7  * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function isDue(entry) {
  if (!entry.active) return false;
  if (!entry.lastScraped) return true; // never scraped — always due

  const intervalMs = FREQUENCY_MS[entry.frequency] ?? FREQUENCY_MS.daily;
  const lastScraped = new Date(entry.lastScraped).getTime();
  return (Date.now() - lastScraped) >= intervalMs;
}

// ─── Registry I/O ─────────────────────────────────────────────────────────────

async function markScraped(url, success) {
  if (success) await registryMarkScraped(url);
}

// ─── Dedup Check ──────────────────────────────────────────────────────────────

async function isAlreadyProcessed(url) {
  try {
    // Ask scraper if this URL has already been scraped
    const response = await axios.get(
      `${SCRAPER_URL}/api/articles/by-url`,
      { params: { url }, timeout: 5000 }
    );

    const article = response.data.article;
    if (!article) return { processed: false };

    // Article exists — check if it's also been labelled
    const labelResponse = await axios.get(
      `${LABELLER_URL}/api/tagged/${article.id}`,
      { timeout: 5000 }
    );

    const isLabelled = !!labelResponse.data.taggedArticle;

    return {
      processed:  isLabelled,
      articleId:  article.id,
      needsLabel: !isLabelled,   // scraped but not yet labelled
    };
  } catch (err) {
    // 404 means not found — needs scraping
    if (err.response?.status === 404) return { processed: false };
    logger.warn(`[Scheduler] Dedup check failed for ${url}: ${err.message}`);
    return { processed: false }; // fail open — scrape anyway
  }
}

// ─── Pipeline Stages ──────────────────────────────────────────────────────────

async function scrape(url) {
  try {
    const response = await axios.post(
      `${SCRAPER_URL}/api/scrape`,
      { url },
      { timeout: 30000 }
    );
    const article = response.data.article;
    logger.info(`[Scheduler] Scraped: ${article.id} — ${article.title}`);
    return { success: true, article };
  } catch (err) {
    logger.error(`[Scheduler] Scrape failed for ${url}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function label(articleId) {
  try {
    const response = await axios.post(
      `${LABELLER_URL}/api/label/${articleId}`,
      {},
      { timeout: 60000 }
    );
    logger.info(`[Scheduler] Labelled: ${articleId}`);
    return { success: true, labels: response.data.taggedArticle.labels };
  } catch (err) {
    logger.error(`[Scheduler] Label failed for ${articleId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function addToGraph(articleId, article) {
  try {
    const response = await axios.post(
      `${GRAPH_URL}/api/graph/add/${articleId}`,
      { article },
      { timeout: 15000 }
    );
    logger.info(`[Scheduler] Graphed: ${articleId} — ${response.data.relationshipsCreated} relationships`);
    return { success: true, relationshipsCreated: response.data.relationshipsCreated };
  } catch (err) {
    logger.error(`[Scheduler] Graph add failed for ${articleId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function finalSync(runId) {
  try {
    const response = await axios.post(
      `${GRAPH_URL}/api/graph/sync`,
      { runId },
      { timeout: 60000 }
    );
    logger.info(`[Scheduler] Final sync complete — v${response.data.snapshot?.version}`);
    return response.data;
  } catch (err) {
    logger.error(`[Scheduler] Final sync failed: ${err.message}`);
    return null;
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function checkServices() {
  const services = [
    { name: 'scraper',  url: SCRAPER_URL  },
    { name: 'labeller', url: LABELLER_URL },
    { name: 'graph',    url: GRAPH_URL    },
    { name: 'discovery',    url: DISCOVERY_URL    },
  ];

  const results = await Promise.all(
    services.map(async s => {
      try {
        await axios.get(`${s.url}/health`, { timeout: 3000 });
        return { name: s.name, healthy: true };
      } catch {
        return { name: s.name, healthy: false };
      }
    })
  );

  const unhealthy = results.filter(r => !r.healthy);
  if (unhealthy.length > 0) {
    logger.warn(`[Scheduler] Unhealthy services: ${unhealthy.map(s => s.name).join(', ')}`);
  }

  return {
    allHealthy: unhealthy.length === 0,
    services:   results,
  };
}

// ─── Main Run ─────────────────────────────────────────────────────────────────

export async function runScheduledPipeline() {
  const runId = randomUUID();
  logger.info(`[Scheduler] ─── Run ${runId} started ───`);

  // Check services are up before doing anything
  const health = await checkServices();
  if (!health.allHealthy) {
    logger.error('[Scheduler] Aborting — not all services are healthy');
    return { runId, aborted: true, reason: 'unhealthy_services', health };
  }

  // Load registry and filter to URLs that are due
  const allActiveUrls = await getActiveUrls();
  const dueUrls = allActiveUrls.filter(isDue);

  if (dueUrls.length === 0) {
    logger.info('[Scheduler] No URLs due for scraping');
    return { runId, processed: 0, due: 0 };
  }

  logger.info(
    `[Scheduler] ${dueUrls.length} URLs due — ` +
    `${allActiveUrls.filter(e => !isDue(e)).length} not yet due`
  );

  // ── Process each URL ──────────────────────────────────────────────────────

  const results = [];

  for (const entry of dueUrls) {
    logger.info(`[Scheduler] Processing: ${entry.label || entry.url}`);

    const result = {
      url:      entry.url,
      label:    entry.label,
      scraped:  false,
      labelled: false,
      graphed:  false,
      skipped:  false,
    };

    // ── Dedup check ───────────────────────────────────────────────────────
    const dedup = await isAlreadyProcessed(entry.url);

    if (dedup.processed) {
      logger.info(`[Scheduler] Skipping ${entry.label} — already scraped and labelled`);
      result.skipped   = true;
      result.reason    = 'already_processed';
      result.articleId = dedup.articleId;
      await markScraped(entry.url, true);
      results.push(result);
      continue;
    }

    if (dedup.needsLabel && dedup.articleId) {
      // Scraped but not labelled — skip scrape, go straight to label
      logger.info(`[Scheduler] ${entry.label} already scraped — labelling only`);
      result.scraped   = true;
      result.articleId = dedup.articleId;

      const labelResult = await label(dedup.articleId);
      if (labelResult.success) {
        result.labelled   = true;
        result.categories = labelResult.labels?.categories?.join(', ');
        result.sentiment  = labelResult.labels?.sentiment;

        const graphResult           = await addToGraph(dedup.articleId);
        result.graphed              = graphResult.success;
        result.relationshipsCreated = graphResult.relationshipsCreated ?? 0;
      } else {
        result.error = labelResult.error;
      }

      await markScraped(entry.url, result.labelled);
      results.push(result);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // ── Full pipeline ─────────────────────────────────────────────────────

    // Stage 1: Scrape
    const scrapeResult = await scrape(entry.url);
    if (!scrapeResult.success) {
      result.error = scrapeResult.error;
      results.push(result);
      await markScraped(entry.url, false);
      continue;
    }

    result.scraped   = true;
    result.articleId = scrapeResult.article.id;
    result.title     = scrapeResult.article.title;

    // Stage 2: Label
    const labelResult = await label(scrapeResult.article.id);
    if (!labelResult.success) {
      result.error = labelResult.error;
      results.push(result);
      await markScraped(entry.url, false);
      continue;
    }

    result.labelled   = true;
    result.categories = labelResult.labels?.categories?.join(', ');
    result.sentiment  = labelResult.labels?.sentiment;

    // Stage 3: Graph
    const graphResult           = await addToGraph(scrapeResult.article.id);
    result.graphed              = graphResult.success;
    result.relationshipsCreated = graphResult.relationshipsCreated ?? 0;

    await markScraped(entry.url, result.labelled);
    results.push(result);

    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Final sync & snapshot ─────────────────────────────────────────────────

  const syncResult = await finalSync(runId);

  // ── Summary ───────────────────────────────────────────────────────────────

  const summary = {
    runId,
    completedAt:  new Date().toISOString(),
    total:        dueUrls.length,
    skipped:      results.filter(r => r.skipped).length,
    scraped:      results.filter(r => r.scraped).length,
    labelled:     results.filter(r => r.labelled).length,
    graphed:      results.filter(r => r.graphed).length,
    failed:       results.filter(r => !r.scraped && !r.skipped).length,
    graphVersion: syncResult?.snapshot?.version ?? null,
    results,
  };

  logger.info(
    `[Scheduler] ─── Run ${runId} complete — ` +
    `${summary.skipped} skipped, ${summary.scraped} scraped, ` +
    `${summary.labelled} labelled, ${summary.graphed} graphed, ${summary.failed} failed ───`
  );

  return summary;
}

export { checkServices, isDue };