import axios from 'axios';
import { promises as fs } from 'fs';

const SCRAPER_URL = 'http://localhost:3001';
const LABELLER_URL = 'http://localhost:3002';
const GRAPH_URL = 'http://localhost:3003';

// Test URLs - Mix of different sources
const TEST_URLS = [
  // Supply Chain / Material Risk
  'https://www.supplychaindive.com/news/usgs-releases-2025-list-of-us-essential-minerals/805364/',
  'https://rareearthexchanges.com/news/securing-defense-supply-chains-in-a-rare-earth-world/',
  'https://www.thinkchina.sg/economy/malaysia-becomes-lynchpin-us-led-effort-break-chinas-grip-rare-earths',
  'https://www.proactiveinvestors.co.uk/companies/news/1079569/tech-bytes-antimony-the-obscure-metal-that-could-choke-tech-supply-chains-1079569.html#:~:text=Why%20antimony%20matters%20for%20tech,becomes%20harder%20—%20and%20more%20expensive.',
  'https://www.theaustralian.com.au/business/stockhead/content/pinnacle-ramps-up-exploration-at-adina-east-as-lithium-prices-rebound/news-story/6ba22c20be01303c23368c4d234bcecc',
  'https://www.bbc.co.uk/worklife/article/20251104-the-story-behind-the-scramble-for-greenlands-rare-earths',
  'https://www.juniorminingnetwork.com/junior-miner-news/press-releases/3348-nasdaq/crml/192976-crml-executes-term-sheet-for-50-50-joint-venture-with-eu-and-nato-member-romania-creating-a-fully-integrated-mine-to-processing-supply-chain-for-long-term-security-for-the-european-manufacturing-national-security-sectors.html',
  'https://www.tradingview.com/news/reuters.com,2025:newsml_L4N3XF0ZI:0-critical-metals-partners-with-romania-s-fpcu-to-set-up-rare-earth-processing-plant/',
  'https://renewablesnow.com/news/vulcan-breaks-ground-on-german-lithium-geothermal-project-1286352/'
];

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function checkServices() {
  log('\n╔════════════════════════════════════════════════════════╗', 'bright');
  log('║         CHECKING SERVICES                              ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');
  
  const services = [
    { name: 'Scraper', url: SCRAPER_URL, port: 3001 },
    { name: 'Labeller', url: LABELLER_URL, port: 3002 },
    { name: 'Knowledge Graph', url: GRAPH_URL, port: 3003 }
  ];
  
  for (const service of services) {
    try {
      await axios.get(`${service.url}/health`, { timeout: 2000 });
      log(`✅ ${service.name} (port ${service.port}): RUNNING`, 'green');
    } catch (error) {
      log(`❌ ${service.name} (port ${service.port}): NOT RUNNING`, 'red');
      log(`   Start with: npm run dev:${service.name.toLowerCase().split(' ')[0]}`, 'yellow');
      return false;
    }
  }
  
  log('');
  return true;
}

async function scrapeArticle(url, index, total) {
  log(`\n[${ index + 1}/${total}] 📰 Scraping: ${url}`, 'cyan');
  log('   Please wait 3-5 seconds...', 'yellow');
  
  try {
    const startTime = Date.now();
    const response = await axios.post(`${SCRAPER_URL}/api/scrape`, 
      { url }, 
      { timeout: 30000 }
    );
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    const article = response.data.article;
    
    log(`   ✅ Scraped in ${duration}s`, 'green');
    log(`      ID: ${article.id}`);
    log(`      Title: ${article.title || 'No title'}`);
    log(`      Content: ${article.content?.length || 0} characters`);
    
    return { success: true, article };
  } catch (error) {
    log(`   ❌ Failed: ${error.message}`, 'red');
    if (error.response?.data) {
      log(`      Error: ${error.response.data.error}`, 'red');
    }
    return { success: false, url, error: error.message };
  }
}

async function labelArticle(articleId, title) {
  log(`\n   🏷️  Labelling: ${title}`, 'cyan');
  log('      Calling Claude API (5-10 seconds)...', 'yellow');
  
  try {
    const startTime = Date.now();
    const response = await axios.post(
      `${LABELLER_URL}/api/label/${articleId}`,
      {},
      { timeout: 30000 }
    );
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    const labels = response.data.taggedArticle.labels;
    
    log(`      ✅ Labelled in ${duration}s`, 'green');
    log(`         Categories: ${labels.categories?.join(', ') || 'none'}`);
    log(`         Topics: ${labels.topics?.slice(0, 3).join(', ') || 'none'}`);
    log(`         Sentiment: ${labels.sentiment || 'unknown'}`);
    
    return { success: true, labels };
  } catch (error) {
    log(`      ❌ Labelling failed: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function addToGraph(articleId) {
  try {
    const response = await axios.post(`${GRAPH_URL}/api/graph/add/${articleId}`);
    log(`      ✅ Added to knowledge graph`, 'green');
    log(`         Relationships created: ${response.data.relationshipsCreated}`);
    return { success: true };
  } catch (error) {
    log(`      ⚠️  Graph add failed: ${error.message}`, 'yellow');
    return { success: false };
  }
}

async function displayResults(results) {
  log('\n╔════════════════════════════════════════════════════════╗', 'bright');
  log('║                 RESULTS SUMMARY                        ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');
  
  const scraped = results.filter(r => r.scraped).length;
  const labelled = results.filter(r => r.labelled).length;
  const graphed = results.filter(r => r.graphed).length;
  const failed = results.filter(r => !r.scraped).length;
  
  log(`📊 Statistics:`, 'cyan');
  log(`   Total URLs: ${results.length}`);
  log(`   ✅ Scraped: ${scraped}`);
  log(`   ✅ Labelled: ${labelled}`);
  log(`   ✅ Added to Graph: ${graphed}`);
  log(`   ❌ Failed: ${failed}\n`);
  
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
    log(`   Total Nodes: ${stats.totalNodes}`);
    log(`   Total Edges: ${stats.totalEdges}`);
    
    if (stats.nodesByCategory && Object.keys(stats.nodesByCategory).length > 0) {
      log(`\n   Top Categories:`);
      Object.entries(stats.nodesByCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([cat, count]) => {
          log(`      ${cat}: ${count}`);
        });
    }
    
    if (stats.nodesBySentiment && Object.keys(stats.nodesBySentiment).length > 0) {
      log(`\n   Sentiment Distribution:`);
      Object.entries(stats.nodesBySentiment).forEach(([sent, count]) => {
        log(`      ${sent}: ${count}`);
      });
    }
    
    log('');
  } catch (error) {
    log('⚠️  Could not fetch graph stats', 'yellow');
  }
}

async function saveReport(results) {
  const report = {
    testDate: new Date().toISOString(),
    summary: {
      total: results.length,
      scraped: results.filter(r => r.scraped).length,
      labelled: results.filter(r => r.labelled).length,
      graphed: results.filter(r => r.graphed).length,
      failed: results.filter(r => !r.scraped).length
    },
    results: results
  };
  
  const filename = `test-report-${Date.now()}.json`;
  await fs.writeFile(filename, JSON.stringify(report, null, 2));
  log(`💾 Full report saved to: ${filename}`, 'green');
}

async function main() {
  log('╔════════════════════════════════════════════════════════╗', 'bright');
  log('║       FULL PIPELINE TEST - MULTIPLE URLS              ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝', 'bright');
  
  // Get URLs from command line or use defaults
  const urls = process.argv.slice(2).length > 0 
    ? process.argv.slice(2)
    : TEST_URLS;
  
  log(`\n📋 Testing ${urls.length} URLs`, 'cyan');
  log(`⏱️  Estimated time: ${Math.ceil(urls.length * 10 / 60)} minutes\n`, 'yellow');
  
  // Check services
  const servicesOk = await checkServices();
  if (!servicesOk) {
    log('\n❌ Please start all services first: npm run dev\n', 'red');
    process.exit(1);
  }
  
  // Process each URL
  const results = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = {
      url,
      scraped: false,
      labelled: false,
      graphed: false
    };
    
    // Step 1: Scrape
    const scrapeResult = await scrapeArticle(url, i, urls.length);
    
    if (scrapeResult.success) {
      result.scraped = true;
      result.articleId = scrapeResult.article.id;
      result.title = scrapeResult.article.title;
      
      // Step 2: Label
      const labelResult = await labelArticle(
        scrapeResult.article.id, 
        scrapeResult.article.title
      );
      
      if (labelResult.success) {
        result.labelled = true;
        result.categories = labelResult.labels.categories?.join(', ');
        result.topics = labelResult.labels.topics?.slice(0, 3).join(', ');
        result.sentiment = labelResult.labels.sentiment;
        
        // Step 3: Add to graph
        const graphResult = await addToGraph(scrapeResult.article.id);
        result.graphed = graphResult.success;
      }
    } else {
      result.error = scrapeResult.error;
    }
    
    results.push(result);
    
    // Small delay between URLs
    if (i < urls.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  // Display results
  log('\n' + '═'.repeat(60) + '\n');
  await displayResults(results);
  await displayGraphStats();
  
  // Save report
  await saveReport(results);
  
  log('╔════════════════════════════════════════════════════════╗', 'bright');
  log('║                 TEST COMPLETE!                         ║', 'bright');
  log('╚════════════════════════════════════════════════════════╝\n', 'bright');
  
  log('💡 Next steps:', 'cyan');
  log('   • View articles in frontend: http://localhost:3000');
  log('   • Check graph stats: curl http://localhost:3003/api/graph/stats');
  log('   • Find similar articles: curl http://localhost:3003/api/graph/similar/ARTICLE-ID\n');
}

main().catch(error => {
  log(`\n❌ Test failed: ${error.message}\n`, 'red');
  process.exit(1);
});
