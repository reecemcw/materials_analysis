const express = require('express');
const router = express.Router();
const axios = require('axios');
const AILabeller = require('./labeller');
const TaggedArticleStorage = require('./storage');
const logger = require('./utils/logger');

const labeller = new AILabeller();
const storage = new TaggedArticleStorage();

const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3001';

// POST /api/label/:id - Label a single article
router.post('/label/:id', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info(`Fetching article ${id} from scraper service`);
    
    // Fetch article from scraper service
    const response = await axios.get(`${SCRAPER_URL}/api/articles/${id}`);
    const article = response.data.article;

    // Label the article
    const labels = await labeller.labelArticle(article);

    // Create tagged article
    const taggedArticle = {
      ...article,
      labels
    };

    // Save tagged article
    await storage.saveTaggedArticle(taggedArticle);

    res.json({
      success: true,
      taggedArticle,
      message: 'Article labelled successfully'
    });
  } catch (error) {
    logger.error('Label error:', error);
    
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Article not found in scraper service' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// POST /api/label/batch - Label multiple articles
router.post('/label/batch', async (req, res) => {
  try {
    const { articleIds } = req.body;

    if (!articleIds || !Array.isArray(articleIds)) {
      return res.status(400).json({ error: 'articleIds array is required' });
    }

    logger.info(`Batch labelling ${articleIds.length} articles`);

    const articles = [];
    
    // Fetch all articles
    for (const id of articleIds) {
      try {
        const response = await axios.get(`${SCRAPER_URL}/api/articles/${id}`);
        articles.push(response.data.article);
      } catch (error) {
        logger.warn(`Failed to fetch article ${id}:`, error.message);
      }
    }

    // Label all articles
    const results = await labeller.batchLabel(articles);

    // Save successful labels
    const savedArticles = [];
    for (const result of results) {
      if (result.success) {
        const article = articles.find(a => a.id === result.articleId);
        const taggedArticle = {
          ...article,
          labels: result.labels
        };
        await storage.saveTaggedArticle(taggedArticle);
        savedArticles.push(taggedArticle);
      }
    }

    res.json({
      success: true,
      totalArticles: articleIds.length,
      successCount: savedArticles.length,
      failureCount: results.filter(r => !r.success).length,
      taggedArticles: savedArticles,
      errors: results.filter(r => !r.success).map(r => ({
        articleId: r.articleId,
        error: r.error
      }))
    });
  } catch (error) {
    logger.error('Batch label error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tagged/:id - Get tagged article
router.get('/tagged/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const taggedArticle = await storage.getTaggedArticle(id);

    if (!taggedArticle) {
      return res.status(404).json({ error: 'Tagged article not found' });
    }

    res.json({
      success: true,
      taggedArticle
    });
  } catch (error) {
    logger.error('Get tagged article error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tagged - Get all tagged articles
router.get('/tagged', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const articles = await storage.getAllTaggedArticles(parseInt(limit), parseInt(offset));
    
    res.json({
      success: true,
      count: articles.length,
      taggedArticles: articles
    });
  } catch (error) {
    logger.error('Get tagged articles error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tags - Get all unique tags/labels
router.get('/tags', async (req, res) => {
  try {
    const articles = await storage.getAllTaggedArticles();
    
    // Aggregate all tags
    const aggregation = {
      categories: new Set(),
      topics: new Set(),
      keywords: new Set(),
      entities: {
        people: new Set(),
        organizations: new Set(),
        locations: new Set(),
        products: new Set()
      },
      sentiments: {},
      contentTypes: {}
    };

    articles.forEach(article => {
      if (!article.labels) return;

      article.labels.categories?.forEach(c => aggregation.categories.add(c));
      article.labels.topics?.forEach(t => aggregation.topics.add(t));
      article.labels.keywords?.forEach(k => aggregation.keywords.add(k));

      if (article.labels.entities) {
        article.labels.entities.people?.forEach(p => aggregation.entities.people.add(p));
        article.labels.entities.organizations?.forEach(o => aggregation.entities.organizations.add(o));
        article.labels.entities.locations?.forEach(l => aggregation.entities.locations.add(l));
        article.labels.entities.products?.forEach(p => aggregation.entities.products.add(p));
      }

      // Count sentiments and content types
      const sentiment = article.labels.sentiment;
      if (sentiment) {
        aggregation.sentiments[sentiment] = (aggregation.sentiments[sentiment] || 0) + 1;
      }

      const contentType = article.labels.contentType;
      if (contentType) {
        aggregation.contentTypes[contentType] = (aggregation.contentTypes[contentType] || 0) + 1;
      }
    });

    // Convert sets to arrays
    const result = {
      categories: Array.from(aggregation.categories),
      topics: Array.from(aggregation.topics),
      keywords: Array.from(aggregation.keywords),
      entities: {
        people: Array.from(aggregation.entities.people),
        organizations: Array.from(aggregation.entities.organizations),
        locations: Array.from(aggregation.entities.locations),
        products: Array.from(aggregation.entities.products)
      },
      sentiments: aggregation.sentiments,
      contentTypes: aggregation.contentTypes,
      totalArticles: articles.length
    };

    res.json({
      success: true,
      tags: result
    });
  } catch (error) {
    logger.error('Get tags error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;