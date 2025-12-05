const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');

const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3001';
const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';
const GRAPH_URL = process.env.GRAPH_URL || 'http://localhost:3003';

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

// POST /api/query - Natural language query
router.post('/query', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    logger.info(`Processing query: ${query}`);

    // Get all tagged articles for context
    const articlesResponse = await axios.get(`${LABELLER_URL}/api/tagged?limit=100`);
    const articles = articlesResponse.data.taggedArticles;

    // Get graph stats
    const statsResponse = await axios.get(`${GRAPH_URL}/api/graph/stats`);
    const stats = statsResponse.data.stats;

    // Build context for Claude
    const context = buildQueryContext(articles, stats);

    // Query Claude
    const message = await anthropic.messages.create({
      model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a knowledge base assistant. Answer the user's question based on the article database.

${context}

User Question: ${query}

Provide a helpful answer based on the available articles. If you reference specific articles, mention their titles. Be concise but informative.`
      }]
    });

    const answer = message.content[0].text;

    // Try to find relevant articles
    const relevantArticles = findRelevantArticles(query, articles).slice(0, 5);

    res.json({
      success: true,
      query,
      answer,
      relevantArticles,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to build context for Claude
function buildQueryContext(articles, stats) {
  const articleSummaries = articles.slice(0, 20).map((article, idx) => {
    return `${idx + 1}. "${article.title}" - ${article.labels?.summary || 'No summary'}
   Topics: ${article.labels?.topics?.join(', ') || 'None'}
   Categories: ${article.labels?.categories?.join(', ') || 'None'}`;
  }).join('\n\n');

  return `Article Database Overview:
- Total Articles: ${stats.totalNodes}
- Total Relationships: ${stats.totalEdges}
- Categories: ${Object.keys(stats.nodesByCategory || {}).join(', ')}

Recent Articles:
${articleSummaries}`;
}

// Helper function to find relevant articles
function findRelevantArticles(query, articles) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(' ').filter(w => w.length > 3);

  return articles
    .map(article => {
      let relevance = 0;

      // Check title
      if (article.title?.toLowerCase().includes(queryLower)) {
        relevance += 10;
      }

      // Check topics
      const topicMatches = article.labels?.topics?.filter(topic =>
        topic.toLowerCase().includes(queryLower) ||
        queryWords.some(word => topic.toLowerCase().includes(word))
      ) || [];
      relevance += topicMatches.length * 5;

      // Check keywords
      const keywordMatches = article.labels?.keywords?.filter(keyword =>
        keyword.toLowerCase().includes(queryLower) ||
        queryWords.some(word => keyword.toLowerCase().includes(word))
      ) || [];
      relevance += keywordMatches.length * 3;

      // Check summary
      if (article.labels?.summary?.toLowerCase().includes(queryLower)) {
        relevance += 2;
      }

      return { article, relevance };
    })
    .filter(item => item.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .map(item => ({
      id: item.article.id,
      title: item.article.title,
      summary: item.article.labels?.summary,
      topics: item.article.labels?.topics,
      url: item.article.url,
      relevance: item.relevance
    }));
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

module.exports = router;