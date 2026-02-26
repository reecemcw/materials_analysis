import axios from 'axios';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';
import { connectAllDatabases } from '../../data/connection.js';
import { getPipelineRunModel } from '../../data/models/model_factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const SCRAPER_URL  = 'http://localhost:3001';
const LABELLER_URL = 'http://localhost:3002';
const GRAPH_URL    = 'http://localhost:3003';

const TEST_URLS = [
  'https://www.supplychaindive.com/news/usgs-releases-2025-list-of-us-essential-minerals/805364/',
  'https://rareearthexchanges.com/news/securing-defense-supply-chains-in-a-rare-earth-world/',
  'https://www.thinkchina.sg/economy/malaysia-becomes-lynchpin-us-led-effort-break-chinas-grip-rare-earths'
  // 'https://www.proactiveinvestors.co.uk/companies/news/1079569/tech-bytes-antimony-the-obscure-metal-that-could-choke-tech-supply-chains-1079569.html',
  // 'https://www.theaustralian.com.au/business/stockhead/content/pinnacle-ramps-up-exploration-at-adina-east-as-lithium-prices-rebound/news-story/6ba22c20be01303c23368c4d234bcecc',
  // 'https://www.bbc.co.uk/worklife/article/20251104-the-story-behind-the-scramble-for-greenlands-rare-earths',
  // 'https://www.juniorminingnetwork.com/junior-miner-news/press-releases/3348-nasdaq/crml/192976-crml-executes-term-sheet-for-50-50-joint-venture-with-eu-and-nato-member-romania-creating-a-fully-integrated-mine-to-processing-supply-chain-for-long-term-security-for-the-european-manufacturing-national-security-sectors.html',
  // 'https://www.tradingview.com/news/reuters.com,2025:newsml_L4N3XF0ZI:0-critical-metals-partners-with-romania-s-fpcu-to-set-up-rare-earth-processing-plant/',
  // 'https://renewablesnow.com/news/vulcan-breaks-ground-on-german-lithium-geothermal-project-1286352/'
];

const colors = {
  reset: '\x1b[0m', bright: '\x1b[1m', green: '\x1b[32m',
  red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// ─── Pipeline Observer ────────────────────────────────────────────────────────

class PipelineObserver {
  constructor(runId, totalUrls) {
    this.runId     = runId;
    this.totalUrls = totalUrls;
    this.startedAt = new Date();
    this.Model     = null;
  }

  async init() {
    this.Model = await getPipelineRunModel();

    await this.Model.create({
      runId:     this.runId,
      startedAt: this.startedAt,
      totalUrls: this.totalUrls,
      summary:   { scraped: 0, labelled: 0, graphed: 0, failed: 0 },
      articles:  []
    });

    logger.info(`[MongoDB] Run initialised in pipelineruns/${process.env.NODE_ENV || 'test'}: ${this.runId}`);
  }

  async recordArticle(articleEntry) {
    const successfulStages = articleEntry.stages
      .filter(s => s.status === 'success')
      .map(s => s.stage);

    const finalStatus = successfulStages.includes('scrape')
      ? (successfulStages.includes('label') && successfulStages.includes('graph') ? 'complete' : 'partial')
      : 'failed';

    await this.Model.findOneAndUpdate(
      { runId: this.runId },
      {
        $push: { articles: { ...articleEntry, finalStatus } },
        $inc: {
          'summary.scraped':  successfulStages.includes('scrape')  ? 1 : 0,
          'summary.labelled': successfulStages.includes('label')   ? 1 : 0,
          'summary.graphed':  successfulStages.includes('graph')   ? 1 : 0,
          'summary.failed':   finalStatus === 'failed'             ? 1 : 0
        }
      }
    );
  }

  async finalise() {
    await this.Model.findOneAndUpdate(
      { runId: this.runId },
      { completedAt: new Date() }
    );
    logger.info(`[MongoDB] Run finalised: ${this.runId}`);
  }
}

// ─── Service Checks ───────────────────────────────────────────────────────────

async function checkServices() {
  log('\n╔════════════════════════════════════════════════════════╗', 'bright');
  log('║         CHECKING SERVICES                              ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');

  const services = [
    { name: 'Scraper',         url: SCRAPER_URL,  port: 3001 },
    { name: 'Labeller',        url: LABELLER_URL, port: 3002 },
    { name: 'Knowledge Graph', url: GRAPH_URL,    port: 3003 }
  ];

  for (const service of services) {
    try {
      await axios.get(`${service.url}/health`, { timeout: 2000 });
      log(`✅ ${service.name} (port ${service.port}): RUNNING`, 'green');
    } catch {
      log(`❌ ${service.name} (port ${service.port}): NOT RUNNING`, 'red');
      log(`   Start with: npm run dev:${service.name.toLowerCase().split(' ')[0]}`, 'yellow');
      return false;
    }
  }

  log('');
  return true;
}

// ─── Pipeline Stages ──────────────────────────────────────────────────────────

async function scrapeArticle(url, index, total) {
  log(`\n[${index + 1}/${total}] 📰 Scraping: ${url}`, 'cyan');
  log('   Please wait 3-5 seconds...', 'yellow');

  const startedAt = new Date();
  const startTime = Date.now();

  try {
    const response = await axios.post(`${SCRAPER_URL}/api/scrape`, { url }, { timeout: 30000 });
    const duration = Date.now() - startTime;
    const article  = response.data.article;

    log(`   ✅ Scraped in ${(duration / 1000).toFixed(2)}s`, 'green');
    log(`      ID: ${article.id}`);
    log(`      Title: ${article.title || 'No title'}`);
    log(`      Content: ${article.content?.length || 0} characters`);

    return {
      success: true,
      article,
      stage: { stage: 'scrape', status: 'success', duration, startedAt, completedAt: new Date(), error: null }
    };
  } catch (error) {
    log(`   ❌ Failed: ${error.message}`, 'red');
    return {
      success: false,
      url,
      error: error.message,
      stage: { stage: 'scrape', status: 'failed', duration: Date.now() - startTime, startedAt, completedAt: new Date(), error: error.message }
    };
  }
}

async function labelArticle(articleId, title) {
  log(`\n   🏷️  Labelling: ${title}`, 'cyan');
  log('      Calling Claude API (5-10 seconds)...', 'yellow');

  const startedAt = new Date();
  const startTime = Date.now();

  try {
    const response = await axios.post(`${LABELLER_URL}/api/label/${articleId}`, {}, { timeout: 30000 });
    const duration = Date.now() - startTime;
    const labels   = response.data.taggedArticle.labels;

    log(`      ✅ Labelled in ${(duration / 1000).toFixed(2)}s`, 'green');
    log(`         Categories: ${labels.categories?.join(', ') || 'none'}`);
    log(`         Topics: ${labels.topics?.slice(0, 3).join(', ') || 'none'}`);
    log(`         Sentiment: ${labels.sentiment || 'unknown'}`);

    return {
      success: true,
      labels,
      stage: { stage: 'label', status: 'success', duration, startedAt, completedAt: new Date(), error: null }
    };
  } catch (error) {
    log(`      ❌ Labelling failed: ${error.message}`, 'red');
    return {
      success: false,
      error: error.message,
      stage: { stage: 'label', status: 'failed', duration: Date.now() - startTime, startedAt, completedAt: new Date(), error: error.message }
    };
  }
}

async function addToGraph(articleId, title) {
  const startedAt = new Date();
  const startTime = Date.now();

  log(`\n   🕸️  Adding to graph: ${title}`, 'cyan');

  try {
    const response = await axios.post(
      `${GRAPH_URL}/api/graph/add/${articleId}`,
      {},
      { timeout: 10000 }
    );
    const duration = Date.now() - startTime;

    log(`      ✅ Added to knowledge graph (${(duration / 1000).toFixed(2)}s)`, 'green');
    log(`         Relationships created: ${response.data.relationshipsCreated}`);

    return {
      success: true,
      relationshipsCreated: response.data.relationshipsCreated,
      stage: { stage: 'graph', status: 'success', duration, startedAt, completedAt: new Date(), error: null }
    };
  } catch (error) {
    log(`      ⚠️  Graph add failed: ${error.message}`, 'yellow');
    return {
      success: false,
      stage: { stage: 'graph', status: 'failed', duration: Date.now() - startTime, startedAt, completedAt: new Date(), error: error.message }
    };
  }
}

// ─── Reporting ────────────────────────────────────────────────────────────────

async function displayResults(results) {
  log('\n╔════════════════════════════════════════════════════════╗', 'bright');
  log('║                 RESULTS SUMMARY                        ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');

  const scraped  = results.filter(r => r.scraped).length;
  const labelled = results.filter(r => r.labelled).length;
  const graphed  = results.filter(r => r.graphed).length;
  const failed   = results.filter(r => !r.scraped).length;

  log(`📊 Statistics:`, 'cyan');
  log(`   Total URLs: ${results.length}`);
  log(`   ✅ Scraped:         ${scraped}`);
  log(`   ✅ Labelled:        ${labelled}`);
  log(`   ✅ Added to Graph:  ${graphed}`);
  log(`   ❌ Failed:          ${failed}\n`);

  if (scraped > 0) {
    log(`📁 Successful Articles:`, 'green');
    results.filter(r => r.scraped).forEach((r, i) => {
      log(`   ${i + 1}. ${r.title}`);
      log(`      ID: ${r.articleId}`);
      log(`      Categories: ${r.categories || 'none'}`);
      log(`      Topics: ${r.topics || 'none'}`);
    });
  }

  if (failed > 0) {
    log(`\n❌ Failed URLs:`, 'red');
    results.filter(r => !r.scraped).forEach((r, i) => {
      log(`   ${i + 1}. ${r.url}`);
      log(`      Reason: ${r.error}`);
    });
  }

  log('');
}

async function displayGraphStats() {
  try {
    const response = await axios.get(`${GRAPH_URL}/api/graph/stats`);
    const stats = response.data.stats;

    log('🕸️  Knowledge Graph Statistics:', 'cyan');
    log(`   Version:     v${stats.currentVersion}`);
    log(`   Total Nodes: ${stats.totalNodes}`);
    log(`   Total Edges: ${stats.totalEdges}`);

    if (stats.nodesByCategory && Object.keys(stats.nodesByCategory).length > 0) {
      log(`\n   Top Categories:`);
      Object.entries(stats.nodesByCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([cat, count]) => log(`      ${cat}: ${count}`));
    }

    if (stats.nodesBySentiment && Object.keys(stats.nodesBySentiment).length > 0) {
      log(`\n   Sentiment Distribution:`);
      Object.entries(stats.nodesBySentiment)
        .forEach(([sent, count]) => log(`      ${sent}: ${count}`));
    }

    log('');
  } catch {
    log('⚠️  Could not fetch graph stats', 'yellow');
  }
}

async function saveReport(results, runId) {
  const testReportDir = join(__dirname, '../../data/local/tests/');
  await fs.mkdir(testReportDir, { recursive: true });

  const filename = join(testReportDir, `test-report-${Date.now()}.json`);
  const report = {
    runId,
    testDate: new Date().toISOString(),
    summary: {
      total:    results.length,
      scraped:  results.filter(r => r.scraped).length,
      labelled: results.filter(r => r.labelled).length,
      graphed:  results.filter(r => r.graphed).length,
      failed:   results.filter(r => !r.scraped).length
    },
    results
  };

  await fs.writeFile(filename, JSON.stringify(report, null, 2));
  log(`💾 Report saved to: ${filename}`, 'green');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('╔════════════════════════════════════════════════════════╗', 'bright');
  log('║       FULL PIPELINE TEST - MULTIPLE URLS              ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝', 'bright');

  await connectAllDatabases();

  const urls  = process.argv.slice(2).length > 0 ? process.argv.slice(2) : TEST_URLS;
  const runId = randomUUID();

  log(`\n📋 Testing ${urls.length} URLs`, 'cyan');
  log(`🔖 Run ID: ${runId}`, 'blue');
  log(`🌍 Environment: ${process.env.NODE_ENV || 'test'}`, 'blue');
  log(`⏱️  Estimated time: ${Math.ceil(urls.length * 10 / 60)} minutes\n`, 'yellow');

  const servicesOk = await checkServices();
  if (!servicesOk) {
    log('\n❌ Please start all services first: npm run dev\n', 'red');
    process.exit(1);
  }

  const observer = new PipelineObserver(runId, urls.length);
  await observer.init();

  const results = [];

  for (let i = 0; i < urls.length; i++) {
      const url          = urls[i];
      const result       = { url, scraped: false, labelled: false, graphed: false };
      const articleEntry = { url, stages: [] };

      const scrapeResult = await scrapeArticle(url, i, urls.length);
      articleEntry.stages.push(scrapeResult.stage);

      if (scrapeResult.success) {
        result.scraped         = true;
        result.articleId       = scrapeResult.article.id;
        result.title           = scrapeResult.article.title;
        articleEntry.articleId = scrapeResult.article.id;
        articleEntry.title     = scrapeResult.article.title;

        const labelResult = await labelArticle(scrapeResult.article.id, scrapeResult.article.title);
        articleEntry.stages.push(labelResult.stage);

        if (labelResult.success) {
          result.labelled   = true;
          result.categories = labelResult.labels.categories?.join(', ');
          result.topics     = labelResult.labels.topics?.slice(0, 3).join(', ');
          result.sentiment  = labelResult.labels.sentiment;

          const graphResult = await addToGraph(scrapeResult.article.id, scrapeResult.article.title);
          articleEntry.stages.push(graphResult.stage);
          result.graphed               = graphResult.success;
          result.relationshipsCreated  = graphResult.relationshipsCreated ?? 0;
        } else {
          articleEntry.stages.push({ stage: 'graph', status: 'skipped', error: null });
        }
      } else {
        result.error = scrapeResult.error;
        articleEntry.stages.push(
          { stage: 'label', status: 'skipped', error: null },
          { stage: 'graph', status: 'skipped', error: null }
        );
      }

      await observer.recordArticle(articleEntry);
      results.push(result);

      // Show live graph snapshot every 3 articles
      if ((i + 1) % 3 === 0 && i < urls.length - 1) {
        log('\n📊 Graph snapshot:', 'blue');
        await displayGraphStats();
      }

      if (i < urls.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

  await observer.finalise();

  // Final sync — picks up anything that failed to graph individually
  log('\n🔄 Running final graph sync...', 'cyan');
  try {
    const syncResponse = await axios.post(
      `${GRAPH_URL}/api/graph/sync`,
      { runId },  // ← add this
      { timeout: 30000 }
    );
    log(`   ✅ Sync complete — ${syncResponse.data.nodesAdded} nodes, ${syncResponse.data.relationshipsCreated} relationships`, 'green');
    log(`   📸 Graph snapshot: v${syncResponse.data.snapshot.version} (checksum: ${syncResponse.data.snapshot.checksum.slice(0, 8)}...)`, 'green');
  } catch (err) {
    log(`   ⚠️  Final sync failed: ${err.message}`, 'yellow');
  }

  log('\n' + '═'.repeat(60) + '\n');
  await displayResults(results);
  await displayGraphStats();
  await saveReport(results, runId);

  log('╔════════════════════════════════════════════════════════╗', 'bright');
  log('║                 PIPELINE COMPLETE!                     ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');

  log('💡 Next steps:', 'cyan');
  log('   • View articles in frontend: http://localhost:3000');
  log('   • Check graph stats:         curl http://localhost:3003/api/graph/stats');
  log('   • Query the graph:           curl "http://localhost:3003/api/graph/query/topic?q=lithium"');
  log(`   • Find this run in MongoDB:  db.${process.env.NODE_ENV || 'test'}.findOne({ runId: "${runId}" })\n`);

  process.exit(0);
}

main().catch(error => {
  log(`\n❌ Test failed: ${error.message}\n`, 'red');
  process.exit(1);
});