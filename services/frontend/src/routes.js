import express from 'express';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../../../utils/logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const router = express.Router();

const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3001';
const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';
const GRAPH_URL = process.env.GRAPH_URL || 'http://localhost:3003';

if (!process.env.ANTHROPIC_API_KEY) {
  logger.error('❌ ANTHROPIC_API_KEY is not set in environment variables!');
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Safe date helper ─────────────────────────────────────────────────────────

function safeDate(val) {
  if (!val) return 0;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// GET /api/recent - Get recent articles
router.get('/recent', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const response = await axios.get(`${LABELLER_URL}/api/tagged?limit=1000`);
    let articles = response.data.taggedArticles;

    articles.sort((a, b) => safeDate(b.processedAt) - safeDate(a.processedAt));
    articles = articles.slice(0, parseInt(limit));
    articles = articles.filter(a => a.title && a.title.trim().length > 0);

    res.json({ success: true, taggedArticles: articles });
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

    const keywords = extractKeywords(query);
    logger.info(`Extracted keywords: ${keywords.join(', ')}`);

    let allArticles = [];

    if (isTemporalQuery(query) || keywords.length === 0) {
      // FIX: sort by processedAt (always populated) rather than publishDate/addedAt
      // which are frequently null in raw articles
      try {
        const response = await axios.get(`${LABELLER_URL}/api/tagged`, {
          params: { limit: maxSources * 4 }
        });
        allArticles = response.data.taggedArticles || [];
        allArticles.sort((a, b) => safeDate(b.processedAt) - safeDate(a.processedAt));
        allArticles = allArticles.slice(0, maxSources);
      } catch (err) {
        logger.warn('Temporal fallback retrieval failed:', err.message);
      }
    } else {
      // FIX: knowledge-graph routes expect ?q= not ?topic= / ?keyword=
      const [topicResults, keywordResults] = await Promise.allSettled([
        axios.get(`${GRAPH_URL}/api/graph/query/topic`, { params: { q: keywords[0], limit: maxSources } }),
        axios.get(`${GRAPH_URL}/api/graph/query/keyword`, { params: { q: keywords[0], limit: maxSources } })
      ]);

      const topicArticles   = topicResults.status   === 'fulfilled' ? topicResults.value.data.results   || [] : [];
      const keywordArticles = keywordResults.status === 'fulfilled' ? keywordResults.value.data.results || [] : [];

      // The graph returns {articleId, title, url, ...} — normalise to labeller shape
      const graphIds = new Set();
      const graphArticles = [];
      for (const item of [...topicArticles, ...keywordArticles]) {
        const id = item.articleId ?? item.id ?? item.sourceId;
        if (id && !graphIds.has(id)) {
          graphIds.add(id);
          graphArticles.push({ id, ...item });
        }
      }

      // Enrich graph results with full labelled data (has summary, sentiment, etc.)
      if (graphArticles.length > 0) {
        const enriched = await Promise.allSettled(
          graphArticles.map(a => axios.get(`${LABELLER_URL}/api/tagged/${a.id}`))
        );
        for (const result of enriched) {
          if (result.status === 'fulfilled') {
            allArticles.push(result.value.data.taggedArticle);
          }
        }
      }

      // Fallback if graph returned nothing or enrichment all failed
      if (allArticles.length === 0) {
        logger.warn('Graph retrieval returned no results, falling back to labeller');
        try {
          const response = await axios.get(`${LABELLER_URL}/api/tagged`, { params: { limit: maxSources * 4 } });
          allArticles = response.data.taggedArticles || [];
        } catch (err) {
          logger.warn('Fallback retrieval also failed:', err.message);
        }
      }
    }

    // Rank — temporal queries already sorted above, keyword queries get relevance scored
    const rankedArticles = isTemporalQuery(query)
      ? allArticles.slice(0, maxSources)
      : rankArticlesByRelevance(query, allArticles)
          .filter(a => a.relevanceScore > 0)
          .slice(0, maxSources);

    logger.info(`Retrieved ${rankedArticles.length} relevant articles`);

    const context = buildRAGContext(query, rankedArticles);

    // Ask Claude for structured impact data
    const message = await anthropic.messages.create({
      model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are an expert materials and supply chain risk analyst. Based ONLY on the provided articles, answer the user's question with structured impact data.

${context}

User Question: ${query}

Respond ONLY with a valid JSON object (no markdown, no code fences) in this exact shape:
{
  "headline": "One sharp sentence summarising the key finding",
  "impacts": [
    {
      "title": "Short impact title (max 6 words)",
      "detail": "One sentence of specifics from the articles",
      "severity": "high|medium|low",
      "direction": "up|down|neutral"
    }
  ],
  "summary": "2-3 sentence synthesis across all impacts",
  "dataGaps": "One sentence on what the articles don't cover, or null"
}

Include 2-5 impacts. severity=high for price/supply shocks, medium for policy/demand shifts, low for background context. direction=up for rising prices/demand/risk, down for falling, neutral for mixed or unclear. Base everything strictly on the provided articles.`
      }]
    });

    let structured;
    try {
      const raw = message.content[0].text
        .replace(/^[\s\S]*?```json\s*/i, '')
        .replace(/```[\s\S]*$/i, '')
        .trim();
      structured = JSON.parse(raw);
    } catch {
      // Fallback to plain text if Claude didn't return valid JSON
      structured = {
        headline: null,
        impacts: [],
        summary: message.content[0].text,
        dataGaps: null
      };
    }

    res.json({
      success: true,
      query,
      structured,
      // Keep legacy `answer` field for any existing callers
      answer: structured.summary || message.content[0].text,
      sources: rankedArticles.map(article => ({
        id: article.id,
        title: article.title,
        url: article.url,
        publishDate: article.publishDate,
        processedAt: article.processedAt,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractKeywords(query) {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for',
    'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on',
    'that', 'the', 'to', 'was', 'will', 'with', 'what', 'when',
    'where', 'who', 'how', 'about', 'can', 'could', 'should',
    'most', 'recent', 'latest', 'last', 'first', 'oldest', 'newest',
    'article', 'articles', 'news', 'story', 'stories', 'post', 'posts',
    'tell', 'show', 'give', 'find', 'get', 'any', 'impact', 'impacts'
  ]);
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 10);
}

function isTemporalQuery(query) {
  const temporalTerms = /\b(recent|latest|last|newest|oldest|first|today|yesterday|this week|this month)\b/i;
  return temporalTerms.test(query);
}

function rankArticlesByRelevance(query, articles) {
  const queryLower = query.toLowerCase();
  const keywords = extractKeywords(query);
  const now = Date.now();
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  return articles.map(article => {
    let score = 0;

    if (article.title?.toLowerCase().includes(queryLower)) score += 10;

    keywords.forEach(keyword => {
      if (article.title?.toLowerCase().includes(keyword)) score += 5;
    });

    const topics = article.labels?.topics || [];
    keywords.forEach(keyword => {
      topics.forEach(topic => { if (topic.toLowerCase().includes(keyword)) score += 3; });
    });

    const categories = article.labels?.categories || [];
    keywords.forEach(keyword => {
      categories.forEach(category => { if (category.toLowerCase().includes(keyword)) score += 2; });
    });

    const articleKeywords = article.labels?.keywords || [];
    keywords.forEach(keyword => {
      articleKeywords.forEach(ak => { if (ak.toLowerCase().includes(keyword)) score += 1; });
    });

    if (article.labels?.summary?.toLowerCase().includes(queryLower)) score += 4;

    // FIX: recency boost — articles processed within the last week get +3
    const articleAge = now - safeDate(article.processedAt);
    if (articleAge > 0 && articleAge < ONE_WEEK_MS) score += 3;

    return { ...article, relevanceScore: score };
  })
  .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function buildRAGContext(query, articles) {
  if (articles.length === 0) return 'No relevant articles found in the knowledge base.';

  const articlesContext = articles.map((article, idx) => {
    const topics     = article.labels?.topics?.slice(0, 5).join(', ') || 'None';
    const categories = article.labels?.categories?.join(', ') || 'None';
    const summary    = article.labels?.summary || 'No summary available';
    const keywords   = article.labels?.keywords?.slice(0, 8).join(', ') || 'None';

    // FIX: prefer processedAt as date fallback — always populated
    const rawDate = article.publishDate || article.processedAt || null;
    const date = rawDate && !isNaN(new Date(rawDate).getTime())
      ? new Date(rawDate).toISOString().split('T')[0]
      : 'Unknown';

    return `[Article ${idx + 1}]
Title: "${article.title}"
Published: ${date}
URL: ${article.url}
Categories: ${categories}
Topics: ${topics}
Key Terms: ${keywords}
Summary: ${summary}
Relevance Score: ${article.relevanceScore || 0}`;
  }).join('\n\n---\n\n');

  return `RETRIEVED ARTICLES FROM KNOWLEDGE BASE:\n\n${articlesContext}\n\nTotal articles retrieved: ${articles.length}`;
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