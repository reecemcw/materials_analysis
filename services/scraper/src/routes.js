import { Router } from 'express';
const router = Router();
import { v4 as uuidv4 } from 'uuid';
import Scraper from './scraper.js';
import Storage from '../../../utils/storage.js';
import logger from '../../../utils/logger.js';
import { getRawArticleModel } from '../../../data/models/model_factory.js';
import { getUrlRegistryModel } from '../../../data/models/model_factory.js';

const scraper = new Scraper();
const storage = new Storage();
const UrlModel = await getUrlRegistryModel();

// POST /api/scrape/pending - Scrape unscraped URLs from the registry
router.post('/scrape/pending', async (req, res) => {
  try {
    const { limit = 10 } = req.body;

    // Fetch unscraped URLs from registry
    const pendingUrls = await UrlModel.find({
      lastScraped: null,
      active: true
    }).limit(parseInt(limit)).lean();

    if (pendingUrls.length === 0) {
      return res.json({ success: true, message: 'No pending URLs found', totalUrls: 0, successCount: 0, articles: [] });
    }

    logger.info(`Scraping ${pendingUrls.length} pending URLs from registry`);
    const urls = pendingUrls.map(u => u.url);
    const results = await scraper.scrapeBatch(urls);

    const savedArticles = [];
    for (const result of results) {
      if (result.success) {
        const article = { id: uuidv4(), ...result.article };
        await storage.saveRawArticle(article);
        savedArticles.push(article);

        // Mark as scraped in registry
        await UrlModel.updateOne(
          { url: result.url },
          { $set: { lastScraped: new Date() } }
        );
      }
    }

    res.json({
      success: true,
      totalUrls: pendingUrls.length,
      successCount: savedArticles.length,
      failureCount: results.filter(r => !r.success).length,
      articles: savedArticles,
      errors: results.filter(r => !r.success).map(r => ({ url: r.url, error: r.error }))
    });
  } catch (error) {
    logger.error('Pending scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/scrape - Scrape a single URL
router.post('/scrape', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    logger.info(`Scraping URL: ${url}`);
    
    const result = await scraper.scrapeArticle(url);

    if (result.success) {
      const articleId = uuidv4();
      const article = {
        id: articleId,
        ...result.article
      };

      await storage.saveRawArticle(article);

      res.json({
        success: true,
        article,
        message: 'Article scraped successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    logger.error('Scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/scrape/batch - Scrape multiple URLs
router.post('/scrape/batch', async (req, res) => {
  try {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'URLs array is required' });
    }

    logger.info(`Batch scraping ${urls.length} URLs`);
    
    const results = await scraper.scrapeBatch(urls);

    // Save successful articles
    const savedArticles = [];
    for (const result of results) {
      if (result.success) {
        const articleId = uuidv4();
        const article = {
          id: articleId,
          ...result.article
        };
        await storage.saveRawArticle(article);
        savedArticles.push(article);
      }
    }

    res.json({
      success: true,
      totalUrls: urls.length,
      successCount: savedArticles.length,
      failureCount: results.filter(r => !r.success).length,
      articles: savedArticles,
      errors: results.filter(r => !r.success).map(r => ({
        url: r.url,
        error: r.error
      }))
    });
  } catch (error) {
    logger.error('Batch scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/articles - List all articles
router.get('/articles', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const articles = await storage.getAllArticles(parseInt(limit), parseInt(offset));
    
    res.json({
      success: true,
      count: articles.length,
      articles
    });
  } catch (error) {
    logger.error('Get articles error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/articles/by-url', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const RawArticle = await getRawArticleModel();
    const article    = await RawArticle.findOne({ sourceUrl: url }).lean();

    if (!article) return res.status(404).json({ error: 'Article not found' });

    // Return sourceId as id — this is what the scheduler's dedup check expects
    res.json({ success: true, article: { id: article.sourceId, ...article } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/articles/:id - Get single article
router.get('/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const article = await storage.getArticle(id);

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json({
      success: true,
      article
    });
  } catch (error) {
    logger.error('Get article error:', error);
    res.status(500).json({ error: error.message });
  }
});



// DELETE /api/articles/:id - Delete article
router.delete('/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await storage.deleteArticle(id);

    res.json({
      success: true,
      message: 'Article deleted'
    });
  } catch (error) {
    logger.error('Delete article error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;