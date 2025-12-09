import express from 'express';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import logger from './utils/logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Load environment variables (needed for ESM where imports are hoisted)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const router = express.Router();

const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3001';
const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';
const GRAPH_URL = process.env.GRAPH_URL || 'http://localhost:3003';

// Verify API key is loaded
if (!process.env.ANTHROPIC_API_KEY) {
  logger.error('❌ ANTHROPIC_API_KEY is not set in environment variables!');
  logger.error('   Run: npm run set-api-key -- YOUR-API-KEY');
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// GET /api/recent - Get recent articles
router.get('/recent', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Get tagged articles from labeller service
    const response = await axios.get(`${LABELLER_URL}/api/tagged?limit=${limit}`);
    const articles = response.data.taggedArticles;

    // Enrich with graph data (similar articles)
    const enrichedArticles = await Promise.all(
      articles.map(async (article) => {
        try {
          const similarResponse = await axios.get(`${GRAPH_URL}/api/graph/similar/${article.id}?limit=3`);
          return {
            ...article,
            similarArticles: similarResponse.data.similar
          };
        } catch (error) {
          return article;
        }
      })
    );

    res.json({
      success: true,
      articles: enrichedArticles
    });
  } catch (error) {
    logger.error('Get recent articles error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/query - Natural language query with RAG
router.post('/query', async (req, res) => {
  try {
    const { query, maxSources = 5 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    logger.info(`Processing RAG query: ${query}`);

    // Step 1: Extract keywords from query for better retrieval
    const keywords = extractKeywords(query);
    logger.info(`Extracted keywords: ${keywords.join(', ')}`);

    // Step 2: Multi-strategy retrieval from knowledge graph
    const retrievalResults = await Promise.allSettled([
      // Search by topics
      axios.get(`${GRAPH_URL}/api/graph/query/topic`, {
        params: { q: keywords.join(' '), limit: 10 }
      }),
      // Search by keywords
      axios.get(`${GRAPH_URL}/api/graph/query/keyword`, {
        params: { q: keywords.join(' '), limit: 10 }
      }),
      // Get recent articles as fallback
      axios.get(`${LABELLER_URL}/api/tagged`, {
        params: { limit: 10 }
      })
    ]);

    // Step 3: Aggregate and deduplicate results
    const allArticles = [];
    const seenIds = new Set();

    retrievalResults.forEach(result => {
      if (result.status === 'fulfilled') {
        const articles = result.value.data.results || result.value.data.taggedArticles || [];
        articles.forEach(article => {
          if (!seenIds.has(article.id)) {
            seenIds.add(article.id);
            allArticles.push(article);
          }
        });
      }
    });

    // Step 4: Rank articles by relevance to query
    const rankedArticles = rankArticlesByRelevance(query, allArticles)
      .slice(0, maxSources);

    logger.info(`Retrieved ${rankedArticles.length} relevant articles`);

    // Step 5: Build rich context for Claude
    const context = buildRAGContext(query, rankedArticles);

    // Step 6: Generate answer with Claude
    const message = await anthropic.messages.create({
      model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are an expert research assistant with access to a knowledge base of articles. Your task is to provide accurate, well-sourced answers based on the retrieved articles.

${context}

IMPORTANT INSTRUCTIONS:
1. Answer ONLY based on the information in the provided articles
2. If the articles don't contain enough information, acknowledge the limitation
3. Cite specific articles when referencing information (use article titles)
4. Be concise but comprehensive
5. If multiple articles provide different perspectives, acknowledge this
6. Synthesize information across articles when relevant

User Question: ${query}

Provide your answer:`
      }]
    });

    const answer = message.content[0].text;

    // Step 7: Return response with sources
    res.json({
      success: true,
      query,
      answer,
      sources: rankedArticles.map(article => ({
        id: article.id,
        title: article.title,
        url: article.url,
        categories: article.labels?.categories || [],
        topics: article.labels?.topics || [],
        summary: article.labels?.summary || null,
        relevanceScore: article.relevanceScore || 0
      })),
      metadata: {
        totalArticlesSearched: allArticles.length,
        sourcesUsed: rankedArticles.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('RAG query error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      query: req.body.query
    });
  }
});

// Helper: Extract keywords from query
function extractKeywords(query) {
  // Remove common stop words
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 
    'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on',
    'that', 'the', 'to', 'was', 'will', 'with', 'what', 'when',
    'where', 'who', 'how', 'about', 'can', 'could', 'should'
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 10); // Limit to 10 keywords
}

// Helper: Rank articles by relevance
function rankArticlesByRelevance(query, articles) {
  const queryLower = query.toLowerCase();
  const keywords = extractKeywords(query);

  return articles.map(article => {
    let score = 0;

    // Title match (highest weight)
    if (article.title?.toLowerCase().includes(queryLower)) {
      score += 10;
    }

    // Keyword matches in title
    keywords.forEach(keyword => {
      if (article.title?.toLowerCase().includes(keyword)) {
        score += 5;
      }
    });

    // Topic matches
    const topics = article.labels?.topics || [];
    keywords.forEach(keyword => {
      topics.forEach(topic => {
        if (topic.toLowerCase().includes(keyword)) {
          score += 3;
        }
      });
    });

    // Category matches
    const categories = article.labels?.categories || [];
    keywords.forEach(keyword => {
      categories.forEach(category => {
        if (category.toLowerCase().includes(keyword)) {
          score += 2;
        }
      });
    });

    // Keyword matches
    const articleKeywords = article.labels?.keywords || [];
    keywords.forEach(keyword => {
      articleKeywords.forEach(articleKeyword => {
        if (articleKeyword.toLowerCase().includes(keyword)) {
          score += 1;
        }
      });
    });

    // Summary match
    if (article.labels?.summary?.toLowerCase().includes(queryLower)) {
      score += 4;
    }

    return {
      ...article,
      relevanceScore: score
    };
  })
  .filter(article => article.relevanceScore > 0)
  .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// Helper: Build RAG context
function buildRAGContext(query, articles) {
  if (articles.length === 0) {
    return 'No relevant articles found in the knowledge base.';
  }

  const articlesContext = articles.map((article, idx) => {
    const topics = article.labels?.topics?.slice(0, 5).join(', ') || 'None';
    const categories = article.labels?.categories?.join(', ') || 'None';
    const summary = article.labels?.summary || 'No summary available';
    const keywords = article.labels?.keywords?.slice(0, 8).join(', ') || 'None';

    return `[Article ${idx + 1}]
Title: "${article.title}"
URL: ${article.url}
Categories: ${categories}
Topics: ${topics}
Key Terms: ${keywords}
Summary: ${summary}
Relevance Score: ${article.relevanceScore || 0}`;
  }).join('\n\n---\n\n');

  return `RETRIEVED ARTICLES FROM KNOWLEDGE BASE:

${articlesContext}

Total articles retrieved: ${articles.length}`;
}

// GET /api/stats - Get overall system stats
router.get('/stats', async (req, res) => {
  try {
    const [scraperResponse, labellerResponse, graphResponse] = await Promise.all([
      axios.get(`${SCRAPER_URL}/api/articles?limit=1`).catch(() => ({ data: { count: 0 } })),
      axios.get(`${LABELLER_URL}/api/tagged?limit=1`).catch(() => ({ data: { count: 0 } })),
      axios.get(`${GRAPH_URL}/api/graph/stats`).catch(() => ({ data: { stats: {} } }))
    ]);

    res.json({
      success: true,
      stats: {
        scrapedArticles: scraperResponse.data.count || 0,
        taggedArticles: labellerResponse.data.count || 0,
        graphNodes: graphResponse.data.stats.totalNodes || 0,
        graphEdges: graphResponse.data.stats.totalEdges || 0
      }
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;