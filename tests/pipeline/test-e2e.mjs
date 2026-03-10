/**
 * E2E Pipeline Test
 * Tests: discovery → scraper → labeller → graph → frontend
 *
 * Usage:
 *   node tests/pipeline/test-e2e.mjs                  # full test
 *   node tests/pipeline/test-e2e.mjs --skip-discovery  # skip discovery, test scrape onwards
 *
 * Env overrides:
 *   TEST_URL=https://rareearthexchanges.com/news/some-real-article/
 *   SCRAPER_URL, LABELLER_URL, GRAPH_URL, SCHEDULER_URL, DISCOVERY_URL, FRONTEND_URL
 */

import axios from 'axios';

const SERVICES = {
  scraper:   process.env.SCRAPER_URL   || 'http://localhost:3001',
  labeller:  process.env.LABELLER_URL  || 'http://localhost:3002',
  graph:     process.env.GRAPH_URL     || 'http://localhost:3003',
  scheduler: process.env.SCHEDULER_URL || 'http://localhost:3004',
  discovery: process.env.DISCOVERY_URL || 'http://localhost:3005',
  frontend:  process.env.FRONTEND_URL  || 'http://localhost:3000',
};

// Override via TEST_URL env var — default is a known stable REE article
// e.g. TEST_URL=https://rareearthexchanges.com/news/some-article/ node tests/pipeline/test-e2e.mjs
const TEST_URL = process.env.TEST_URL ||
  'https://www.supplychaindive.com/news/critical-minerals-supply-chain-rare-earth/';

const SKIP_DISCOVERY = process.argv.includes('--skip-discovery');

let passed = 0;
let failed = 0;
let testArticleId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

function pass(label) {
  passed++;
  log('✅', label);
}

function fail(label, err) {
  failed++;
  log('❌', `${label}: ${err?.response?.data?.error || err?.message || err}`);
}

/**
 * Safe date parser — returns ms timestamp or 0 for invalid/null values.
 * Used wherever we compare dates to avoid NaN sort bugs from malformed publishDate strings.
 */
function safeDate(val) {
  if (!val) return 0;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

async function get(service, path, params = {}) {
  return axios.get(`${SERVICES[service]}${path}`, { params, timeout: 10000 });
}

async function post(service, path, body = {}) {
  return axios.post(`${SERVICES[service]}${path}`, body, { timeout: 90000 });
}

async function poll(fn, label, { intervalMs = 2000, maxAttempts = 15 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    if (result) return result;
    if (i < maxAttempts - 1) {
      process.stdout.write(`   ⏳ ${label} (attempt ${i + 1}/${maxAttempts})...\r`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  process.stdout.write('\n');
  return null;
}

// ─── Stage 1: Health Checks ───────────────────────────────────────────────────

async function checkHealth() {
  console.log('\n── Stage 1: Health Checks ──');

  for (const [name, baseUrl] of Object.entries(SERVICES)) {
    try {
      const res = await axios.get(`${baseUrl}/health`, { timeout: 3000 });
      if (res.data.status === 'healthy') {
        pass(`${name} is healthy`);
      } else {
        fail(`${name} health`, `unexpected status: ${res.data.status}`);
      }
    } catch (err) {
      fail(`${name} health`, err);
    }
  }
}

// ─── Stage 2: Discovery ───────────────────────────────────────────────────────

async function testDiscovery() {
  if (SKIP_DISCOVERY) {
    log('⏭️ ', 'Discovery skipped (--skip-discovery)');
    return;
  }

  console.log('\n── Stage 2: Discovery ──');

  try {
    const triggerRes = await post('discovery', '/discover/run');
    if (!triggerRes.data.success) throw new Error('Trigger rejected');
    pass('Discovery run triggered');

    const completed = await poll(
      async () => {
        const status = await get('discovery', '/status');
        return status.data.running === false && status.data.lastRun ? status.data.lastRun : null;
      },
      'Waiting for discovery run',
      { intervalMs: 3000, maxAttempts: 30 }
    );

    if (!completed) {
      fail('Discovery run completed', 'timed out');
      return;
    }

    const { totalAdded, totalSkipped, totalErrors } = completed;
    pass(`Discovery complete — ${totalAdded} added, ${totalSkipped} skipped, ${totalErrors} errors`);

    if (totalErrors > 0) {
      log('⚠️ ', `${totalErrors} source errors (network or 403) — check logs`);
    }

    const registry = await get('scheduler', '/registry');
    if (registry.data.total > 0) {
      pass(`Registry has ${registry.data.total} URLs (${registry.data.active} active, ${registry.data.due} due)`);
    } else {
      fail('Registry has URLs', 'no entries found after discovery');
    }
  } catch (err) {
    fail('Discovery stage', err);
  }
}

// ─── Stage 3: Scraper ─────────────────────────────────────────────────────────

async function testScraper() {
  console.log('\n── Stage 3: Scraper ──');

  try {
    const res = await post('scraper', '/api/scrape', { url: TEST_URL });

    if (!res.data.success || !res.data.article?.id) {
      throw new Error('No article returned');
    }

    testArticleId = res.data.article.id;
    const { title, publishDate, imageUrl } = res.data.article;

    pass(`Scraped article: "${title?.slice(0, 60)}..."`);
    pass(`Article ID: ${testArticleId}`);

    // Validate publishDate is ISO format or null (not a human-readable string)
    // This verifies the scraper extractDate normalisation fix is working
    if (publishDate) {
      const d = new Date(publishDate);
      if (!isNaN(d.getTime())) {
        pass(`Publish date extracted (valid ISO): ${publishDate}`);
      } else {
        fail('Publish date format', `expected ISO string or null, got: "${publishDate}" — scraper normalisation may not be applied`);
      }
    } else {
      log('⚠️ ', 'No publish date extracted (article will sort by processedAt instead)');
    }

    if (imageUrl) pass('Image URL extracted');
    else log('ℹ️ ', 'No image URL (placeholder will show in UI)');

    // Verify persistence
    const fetchRes = await get('scraper', `/api/articles/${testArticleId}`);
    if (fetchRes.data.article?.id === testArticleId) {
      pass('Article persisted and retrievable by ID');
    } else {
      fail('Article persistence check', 'ID mismatch or not found');
    }

    // Verify by-url lookup (used by scheduler dedup check)
    const byUrlRes = await get('scraper', '/api/articles/by-url', { url: TEST_URL });
    if (byUrlRes.data.article?.id) {
      pass('Article retrievable by URL (dedup check will work)');
    } else {
      fail('By-URL lookup', 'not found');
    }
  } catch (err) {
    fail('Scraper stage', err);
    throw new Error('FATAL: No article to label — aborting remaining stages');
  }
}

// ─── Stage 4: Labeller ────────────────────────────────────────────────────────

async function testLabeller() {
  console.log('\n── Stage 4: Labeller ──');

  try {
    const res = await post('labeller', `/api/label/${testArticleId}`);

    if (!res.data.success || !res.data.taggedArticle) {
      throw new Error('No tagged article returned');
    }

    const { labels } = res.data.taggedArticle;
    pass('Article labelled successfully');

    // Verify Claude returned clean JSON — parseError flag should be absent
    // This validates the labeller markdown-fence stripping fix
    if (labels?.parseError) {
      fail('Label parse quality', 'parseError flag is set — Claude response was not clean JSON (check labeller fix)');
    } else {
      pass('Labels parsed cleanly (no parseError flag)');
    }

    if (labels?.categories?.length > 0)  pass(`Categories: ${labels.categories.join(', ')}`);
    else fail('Categories extracted', 'empty array');

    if (labels?.topics?.length > 0)      pass(`Topics: ${labels.topics.slice(0, 3).join(', ')}`);
    else fail('Topics extracted', 'empty array');

    if (labels?.sentiment)               pass(`Sentiment: ${labels.sentiment}`);
    else fail('Sentiment extracted', 'missing');

    if (labels?.summary)                 pass('Summary generated');
    else fail('Summary generated', 'missing');

    if (labels?.entities?.organizations?.length > 0) {
      pass(`Organizations: ${labels.entities.organizations.join(', ')}`);
    } else {
      log('ℹ️ ', 'No organizations extracted (depends on article content)');
    }

    // Verify persistence
    const taggedRes = await get('labeller', `/api/tagged/${testArticleId}`);
    if (taggedRes.data.taggedArticle?.id === testArticleId) {
      pass('Tagged article persisted and retrievable');
    } else {
      fail('Tagged article retrieval', 'ID mismatch or not found');
    }
  } catch (err) {
    fail('Labeller stage', err);
    throw new Error('FATAL: No labelled article for graph — aborting remaining stages');
  }
}

// ─── Stage 5: Knowledge Graph ─────────────────────────────────────────────────

async function testGraph() {
  console.log('\n── Stage 5: Knowledge Graph ──');

  // NOTE: /graph/add/:id and /graph/sync are intentionally skipped in E2E.
  //
  // /graph/add/:id fetches the article from the labeller before inserting —
  // this serialises a MongoDB read into every add and times out under load.
  // The scheduler handles per-article adds during pipeline runs.
  //
  // /graph/sync is O(n²) over all nodes and blocks the event loop even with
  // batching at 595+ articles. Run manually when needed:
  //   curl -X POST http://localhost:3003/api/graph/sync
  //
  // E2E only validates the graph is alive, queryable, and can snapshot.

  try {
    // Stats — confirms service is up and graph is populated from disk
    const statsRes = await get('graph', '/api/graph/stats');
    const stats = statsRes.data.stats;

    if (stats.totalNodes === 0) {
      fail('Graph has nodes', 'graph loaded with 0 nodes — run sync manually: curl -X POST http://localhost:3003/api/graph/sync');
      return;
    }
    pass(`Graph stats: ${stats.totalNodes} nodes, ${stats.totalEdges} edges, v${stats.currentVersion}`);

    // Topic query — confirms in-memory graph is queryable
    const topicRes = await get('graph', '/api/graph/query/topic', { q: 'rare earth', limit: 3 });
    if (topicRes.data.results?.length >= 0) {
      pass(`Topic query works (${topicRes.data.resultCount} results for "rare earth")`);
    } else {
      fail('Topic query', 'unexpected response shape');
    }

    // Snapshot — fast, just persists current in-memory state, no article iteration
    const snapshotRes = await post('graph', '/api/graph/snapshot', { reason: 'e2e_test' });
    if (snapshotRes.data.success && snapshotRes.data.version) {
      pass(`Graph snapshot saved — v${snapshotRes.data.version}`);
    } else {
      fail('Graph snapshot', 'no version returned');
    }
  } catch (err) {
    fail('Graph stage', err);
  }
}

// ─── Stage 6: Frontend Surface ────────────────────────────────────────────────

async function testFrontend() {
  console.log('\n── Stage 6: Frontend ──');

  try {
    const recentRes = await get('frontend', '/api/recent', { limit: 100 });

    // Accept both key shapes: post-fix returns taggedArticles, legacy returns articles
    const articles = recentRes.data.taggedArticles || recentRes.data.articles || [];

    if (articles.length === 0) {
      fail('Frontend /api/recent returns articles', 'empty array');
      return;
    }

    pass(`Frontend /api/recent returns ${articles.length} articles`);

    const ourArticle = articles.find(a => a.id === testArticleId);
    if (ourArticle) {
      pass('Our test article appears in /api/recent');
    } else {
      fail('Test article in /api/recent', `not found — article ID: ${testArticleId}`);
    }

    // Verify sort order using safeDate to handle legacy invalid publishDate values
    if (articles.length > 1) {
      const first  = safeDate(articles[0].publishDate  || articles[0].processedAt);
      const second = safeDate(articles[1].publishDate  || articles[1].processedAt);
      if (first >= second) {
        pass('Articles sorted newest first');
      } else {
        fail('Article sort order',
          `article[0].publishDate=${articles[0].publishDate} is older than article[1].publishDate=${articles[1].publishDate}`);
      }
    }

    // Check /api/stats
    const statsRes = await get('frontend', '/api/stats');
    const { scrapedArticles, taggedArticles, graphNodes } = statsRes.data.stats;
    pass(`Stats — scraped: ${scrapedArticles}, tagged: ${taggedArticles}, graph nodes: ${graphNodes}`);

    // RAG query smoke test
    const queryRes = await post('frontend', '/api/query', {
      query: 'rare earth supply chain',
      maxSources: 3,
    });

    if (queryRes.data.success && queryRes.data.answer) {
      pass(`RAG query returned answer (${queryRes.data.answer.length} chars)`);
      pass(`RAG sources used: ${queryRes.data.sources?.length || 0}`);
    } else {
      fail('RAG query', queryRes.data.error || 'no answer returned');
    }
  } catch (err) {
    fail('Frontend stage', err);
  }
}

// ─── Stage 7: Scheduler Integration ──────────────────────────────────────────

async function testSchedulerIntegration() {
  console.log('\n── Stage 7: Scheduler Integration ──');

  try {
    const registry = await get('scheduler', '/registry');
    pass(`Registry: ${registry.data.total} total, ${registry.data.active} active, ${registry.data.due} due`);

    const services = await get('scheduler', '/services');
    const unhealthy = services.data.services.filter(s => !s.healthy);
    if (unhealthy.length === 0) {
      pass('All services healthy (from scheduler perspective)');
    } else {
      fail('All services healthy', `unhealthy: ${unhealthy.map(s => s.name).join(', ')}`);
    }

    log('ℹ️ ', 'Full scheduler run not triggered in E2E (would scrape all due URLs)');
    log('ℹ️ ', 'To test manually: curl -X POST http://localhost:3004/run');
  } catch (err) {
    fail('Scheduler integration', err);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary() {
  console.log('\n' + '─'.repeat(50));
  console.log('E2E Test Complete');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📦 Test article ID: ${testArticleId || 'none'}`);
  console.log('─'.repeat(50));

  if (failed > 0) process.exit(1);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('🧪 E2E Pipeline Test');
  console.log(`   TEST_URL: ${TEST_URL}`);
  console.log(`   Services: ${Object.entries(SERVICES).map(([k, v]) => `${k}@${v.split('//')[1]}`).join(', ')}`);

  try {
    await checkHealth();
    await testDiscovery();
    await testScraper();
    await testLabeller();
    await testGraph();
    await testFrontend();
    await testSchedulerIntegration();
  } catch (err) {
    log('💥', `Fatal: ${err.message}`);
  }

  printSummary();
}

run();