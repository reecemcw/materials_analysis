#!/usr/bin/env node

/**
 * Debug RAG Query Endpoint (ES Modules)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function debugQuery() {
  console.log('🔍 Debugging RAG Query System\n');
  
  // Step 1: Check all services
  console.log('Step 1: Checking Services...');
  const services = [
    { name: 'Frontend', url: 'http://localhost:3000/health' },
    { name: 'Labeller', url: 'http://localhost:3002/health' },
    { name: 'Graph', url: 'http://localhost:3003/health' }
  ];
  
  for (const service of services) {
    try {
      await axios.get(service.url, { timeout: 2000 });
      console.log(`✅ ${service.name}: Running`);
    } catch (error) {
      console.log(`❌ ${service.name}: NOT RUNNING`);
      console.log(`   Start with: npm run dev:${service.name.toLowerCase()}`);
    }
  }
  
  // Step 2: Check if articles exist
  console.log('\nStep 2: Checking Articles...');
  try {
    const response = await axios.get('http://localhost:3002/api/tagged?limit=5');
    const count = response.data.taggedArticles?.length || 0;
    console.log(`✅ Found ${count} tagged articles`);
    if (count === 0) {
      console.log('⚠️  No articles found! Run: npm run test-pipeline');
    }
  } catch (error) {
    console.log(`❌ Could not check articles: ${error.message}`);
  }
  
  // Step 3: Check knowledge graph
  console.log('\nStep 3: Checking Knowledge Graph...');
  try {
    const response = await axios.get('http://localhost:3003/api/graph/stats');
    const stats = response.data.stats;
    console.log(`✅ Graph has ${stats.totalNodes} nodes, ${stats.totalEdges} edges`);
    if (stats.totalNodes === 0) {
      console.log('⚠️  Graph is empty! Run: curl -X POST http://localhost:3003/api/graph/sync');
    }
  } catch (error) {
    console.log(`❌ Could not check graph: ${error.message}`);
  }
  
  // Step 4: Check API key
  console.log('\nStep 4: Checking API Key...');
  try {
    const envPath = path.join(__dirname, '../.env');
    
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const hasKey = envContent.includes('ANTHROPIC_API_KEY=sk-ant-');
      
      if (hasKey) {
        console.log('✅ API key configured');
      } else {
        console.log('❌ API key not configured or invalid');
        console.log('   Run: npm run set-api-key -- YOUR-KEY');
      }
    } else {
      console.log('❌ .env file not found');
    }
  } catch (error) {
    console.log(`⚠️  Could not check API key: ${error.message}`);
  }
  
  // Step 5: Test query endpoint
  console.log('\nStep 5: Testing Query Endpoint...');
  try {
    console.log('Sending test query...');
    const response = await axios.post(
      'http://localhost:3000/api/query',
      { query: 'test query', maxSources: 3 },
      { timeout: 30000 }
    );
    
    console.log('✅ Query endpoint working!');
    console.log(`   Answer length: ${response.data.answer?.length || 0} chars`);
    console.log(`   Sources: ${response.data.sources?.length || 0}`);
  } catch (error) {
    console.log('❌ Query endpoint failed!');
    console.log(`   Error: ${error.message}`);
    
    if (error.response) {
      console.log(`   Status: ${error.response.status}`);
      console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    
    if (error.code === 'ECONNREFUSED') {
      console.log('   → Frontend service not running or wrong port');
    } else if (error.code === 'ETIMEDOUT') {
      console.log('   → Request timed out (Claude API slow?)');
    }
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════');
  console.log('Summary & Next Steps:');
  console.log('═══════════════════════════════════════\n');
  console.log('1. Make sure all services are running:');
  console.log('   npm run dev\n');
  console.log('2. Make sure you have articles:');
  console.log('   npm run test-pipeline\n');
  console.log('3. Make sure graph is populated:');
  console.log('   curl -X POST http://localhost:3003/api/graph/sync\n');
  console.log('4. Check browser console for detailed errors:');
  console.log('   Open http://localhost:3000');
  console.log('   Press F12 → Console tab');
  console.log('   Try a query and check for errors\n');
}

debugQuery().catch(console.error);