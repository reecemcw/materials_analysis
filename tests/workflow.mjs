import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES modules need __dirname created manually
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRAPER_URL = 'http://localhost:3001';
const LABELLER_URL = 'http://localhost:3002';

// Test URLs - good for testing
const TEST_URLS = [
  "https://www.supplychaindive.com/news/usgs-releases-2025-list-of-us-essential-minerals/805364/",
  "https://rareearthexchanges.com/news/securing-defense-supply-chains-in-a-rare-earth-world/"
];

async function checkServices() {
  console.log('🔍 Checking services...\n');
  
  try {
    const scraper = await axios.get(`${SCRAPER_URL}/health`);
    console.log('✅ Scraper service: healthy');
  } catch (error) {
    console.error('❌ Scraper service: NOT RUNNING');
    console.log('   Start with: npm run dev:scraper\n');
    return false;
  }
  
  try {
    const labeller = await axios.get(`${LABELLER_URL}/health`);
    console.log('✅ Labeller service: healthy');
    
    if (!labeller.data.apiKeyConfigured) {
      console.log('❌ API key not configured!');
      console.log('   Run: npm run diagnose\n');
      return false;
    }
  } catch (error) {
    console.error('❌ Labeller service: NOT RUNNING');
    console.log('   Start with: npm run dev:labeller\n');
    return false;
  }
  
  console.log('');
  return true;
}

async function scrapeArticle(url) {
  console.log(`📰 Scraping article from: ${url}`);
  console.log('   This may take 3-5 seconds...\n');
  
  try {
    const response = await axios.post(`${SCRAPER_URL}/api/scrape`, {
      url: url
    });
    
    const article = response.data.article;
    
    console.log('✅ Article scraped successfully!');
    console.log(`   ID: ${article.id}`);
    console.log(`   Title: ${article.title}`);
    console.log(`   Author: ${article.author || 'Unknown'}`);
    console.log(`   Content length: ${article.content?.length || 0} characters`);
    console.log(`   Scraped at: ${article.scrapedAt}\n`);
    
    return article;
  } catch (error) {
    console.error('❌ Failed to scrape article:', error.message);
    if (error.response?.data) {
      console.error('   Error:', error.response.data.error);
    }
    return null;
  }
}

async function labelArticle(articleId) {
  console.log(`🏷️  Labelling article: ${articleId}`);
  console.log('   Calling Claude API...');
  console.log('   This may take 5-10 seconds...\n');
  
  const startTime = Date.now();
  
  try {
    const response = await axios.post(`${LABELLER_URL}/api/label/${articleId}`);
    const duration = Date.now() - startTime;
    
    const tagged = response.data.taggedArticle;
    const labels = tagged.labels;
    
    console.log('✅ Article labelled successfully!');
    console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Model: ${labels.modelUsed}\n`);
    
    return tagged;
  } catch (error) {
    console.error('❌ Failed to label article:', error.message);
    if (error.response?.data) {
      console.error('   Error:', error.response.data);
    }
    return null;
  }
}

function displayLabels(labels) {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║              EXTRACTED METADATA                        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  console.log('📊 CATEGORIES:');
  if (labels.categories?.length > 0) {
    labels.categories.forEach(cat => console.log(`   • ${cat}`));
  } else {
    console.log('   (none)');
  }
  
  console.log('\n🔖 TOPICS:');
  if (labels.topics?.length > 0) {
    labels.topics.forEach(topic => console.log(`   • ${topic}`));
  } else {
    console.log('   (none)');
  }
  
  console.log('\n🔑 KEYWORDS:');
  if (labels.keywords?.length > 0) {
    console.log(`   ${labels.keywords.join(', ')}`);
  } else {
    console.log('   (none)');
  }
  
  console.log('\n👥 NAMED ENTITIES:');
  
  if (labels.entities?.people?.length > 0) {
    console.log(`   People: ${labels.entities.people.join(', ')}`);
  }
  
  if (labels.entities?.organizations?.length > 0) {
    console.log(`   Organizations: ${labels.entities.organizations.join(', ')}`);
  }
  
  if (labels.entities?.locations?.length > 0) {
    console.log(`   Locations: ${labels.entities.locations.join(', ')}`);
  }
  
  if (labels.entities?.products?.length > 0) {
    console.log(`   Products: ${labels.entities.products.join(', ')}`);
  }
  
  console.log('\n📝 ANALYSIS:');
  console.log(`   Sentiment: ${labels.sentiment || 'unknown'}`);
  console.log(`   Content Type: ${labels.contentType || 'unknown'}`);
  console.log(`   Complexity: ${labels.complexity || 'unknown'}`);
  console.log(`   Reading Time: ${labels.readingTime || 'unknown'}`);
  
  if (labels.summary) {
    console.log('\n📄 SUMMARY:');
    console.log(`   ${labels.summary}`);
  }
  
  console.log('\n');
}

function saveToFile(taggedArticle) {
  const filename = `test-output-${taggedArticle.id}.json`;
  const filepath = path.join(__dirname, './', 'data/', filename);
  
  fs.writeFileSync(filepath, JSON.stringify(taggedArticle, null, 2));
  console.log(`💾 Full output saved to: ${filename}\n`);
}

async function testSingleArticle(url) {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         SINGLE ARTICLE LABELLING TEST                  ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  // Step 1: Check services
  const servicesOk = await checkServices();
  if (!servicesOk) {
    process.exit(1);
  }
  
  // Step 2: Scrape article
  const article = await scrapeArticle(url);
  if (!article) {
    process.exit(1);
  }
  
  // Step 3: Label article
  const tagged = await labelArticle(article.id);
  if (!tagged) {
    process.exit(1);
  }
  
  // Step 4: Display results
  displayLabels(tagged.labels);
  
  // Step 5: Save to file
  saveToFile(tagged);
  
  // Step 6: Show file location
  console.log('📁 Files created:');
  console.log(`   Scraped: data/articles/article-${article.id}.json`);
  console.log(`   Tagged: data/tagged-articles/tagged-${article.id}.json`);
  console.log(`   Test output: test-output-${article.id}.json\n`);
  
  console.log('✅ Test complete!\n');
}

async function testBatchArticles(urls) {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         BATCH ARTICLE LABELLING TEST                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  const servicesOk = await checkServices();
  if (!servicesOk) {
    process.exit(1);
  }
  
  const articleIds = [];
  
  // Scrape all articles
  console.log(`📰 Scraping ${urls.length} articles...\n`);
  for (const url of urls) {
    const article = await scrapeArticle(url);
    if (article) {
      articleIds.push(article.id);
    }
    // Small delay between scrapes
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log(`\n✅ Scraped ${articleIds.length} articles\n`);
  
  // Label all articles
  console.log(`🏷️  Labelling ${articleIds.length} articles...`);
  console.log(`   This will take about ${articleIds.length * 6} seconds...\n`);
  
  const tagged = [];
  let success = 0;
  let failed = 0;
  
  for (let i = 0; i < articleIds.length; i++) {
    console.log(`   [${i + 1}/${articleIds.length}] Labelling ${articleIds[i]}...`);
    const result = await labelArticle(articleIds[i]);
    if (result) {
      tagged.push(result);
      success++;
    } else {
      failed++;
    }
  }
  
  console.log('\n' + '═'.repeat(60));
  console.log(`\n✅ Batch labelling complete!`);
  console.log(`   Success: ${success}`);
  console.log(`   Failed: ${failed}\n`);
  
  // Show summary of all labels
  console.log('📊 SUMMARY OF LABELS:\n');
  
  const allCategories = new Set();
  const allTopics = new Set();
  const sentiments = {};
  const contentTypes = {};
  
  tagged.forEach(article => {
    article.labels.categories?.forEach(c => allCategories.add(c));
    article.labels.topics?.forEach(t => allTopics.add(t));
    
    const sent = article.labels.sentiment;
    if (sent) sentiments[sent] = (sentiments[sent] || 0) + 1;
    
    const type = article.labels.contentType;
    if (type) contentTypes[type] = (contentTypes[type] || 0) + 1;
  });
  
  console.log(`   Unique Categories: ${allCategories.size}`);
  console.log(`   Categories: ${Array.from(allCategories).join(', ')}\n`);
  
  console.log(`   Unique Topics: ${allTopics.size}`);
  console.log(`   Sample Topics: ${Array.from(allTopics).slice(0, 10).join(', ')}\n`);
  
  console.log('   Sentiments:');
  Object.entries(sentiments).forEach(([k, v]) => {
    console.log(`     ${k}: ${v}`);
  });
  
  console.log('\n   Content Types:');
  Object.entries(contentTypes).forEach(([k, v]) => {
    console.log(`     ${k}: ${v}`);
  });
  
  console.log('\n✅ Batch test complete!\n');
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Labeller Workflow Test\n');
  console.log('Usage:');
  console.log('  node scripts/test-labeller-workflow.js [URL]           # Test single article');
  console.log('  node scripts/test-labeller-workflow.js --batch         # Test 5 articles');
  console.log('  node scripts/test-labeller-workflow.js --help          # Show help\n');
  console.log('Examples:');
  console.log('  node scripts/test-labeller-workflow.js https://bbc.com/news');
  console.log('  node scripts/test-labeller-workflow.js --batch\n');
} else if (args.includes('--batch')) {
  testBatchArticles(TEST_URLS);
} else if (args.length > 0) {
  testSingleArticle(args[0]);
} else {
  // Default: test single article with default URL
  testSingleArticle(TEST_URLS[0]);
}