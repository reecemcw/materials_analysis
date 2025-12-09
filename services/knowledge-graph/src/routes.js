import express from 'express';
import axios from 'axios';
import KnowledgeGraph from './graph.js';
import logger from './utils/logger.js';

const router = express.Router();
const graph = new KnowledgeGraph();

const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';

// Load graph from disk on startup
graph.loadFromDisk().then(loaded => {
  if (loaded) {
    logger.info('Graph loaded from previous session');
  } else {
    logger.info('Starting with empty graph');
  }
}).catch(err => {
  logger.error('Failed to load graph:', err);
});

// POST /api/graph/add - Add article to graph
router.post('/graph/add/:id', async (req, res) => {
  try {
    const { id } = req.params;

    logger.info(`Adding article ${id} to graph`);
    
    // Fetch tagged article from labeller service
    const response = await axios.get(`${LABELLER_URL}/api/tagged/${id}`);
    const article = response.data.taggedArticle;

    // Add node to graph
    const node = graph.addArticleNode(article);

    // Find and create relationships with similar articles
    const similarArticles = graph.findSimilarArticles(id);
    
    for (const similar of similarArticles) {
      if (similar.similarity > 3) { // Threshold for relationship
        graph.addRelationship(id, similar.articleId, 'RELATES_TO', {
          strength: similar.similarity,
          sharedTopics: similar.sharedTopics,
          sharedKeywords: similar.sharedKeywords.slice(0, 3)
        });
      }
    }

    res.json({
      success: true,
      node,
      relationshipsCreated: similarArticles.filter(s => s.similarity > 3).length,
      message: 'Article added to knowledge graph'
    });
  } catch (error) {
    logger.error('Add to graph error:', error);
    
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Tagged article not found' });
    }
    
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/sync - Sync all tagged articles to graph
router.post('/graph/sync', async (req, res) => {
  try {
    logger.info('Syncing all articles to graph');
    
    // Fetch all tagged articles
    const response = await axios.get(`${LABELLER_URL}/api/tagged?limit=1000`);
    const articles = response.data.taggedArticles;

    let nodesAdded = 0;
    let relationshipsCreated = 0;

    // Add all nodes first
    for (const article of articles) {
      try {
        graph.addArticleNode(article);
        nodesAdded++;
      } catch (error) {
        logger.warn(`Failed to add node ${article.id}:`, error.message);
      }
    }

    // Then create relationships
    for (const article of articles) {
      const similarArticles = graph.findSimilarArticles(article.id);
      
      for (const similar of similarArticles) {
        if (similar.similarity > 3) {
          try {
            graph.addRelationship(article.id, similar.articleId, 'RELATES_TO', {
              strength: similar.similarity,
              sharedTopics: similar.sharedTopics,
              sharedKeywords: similar.sharedKeywords.slice(0, 3)
            });
            relationshipsCreated++;
          } catch (error) {
            // Relationship might already exist, ignore
          }
        }
      }
    }

    res.json({
      success: true,
      nodesAdded,
      relationshipsCreated,
      message: 'Graph synchronized'
    });
  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/similar/:id - Find similar articles
router.get('/graph/similar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 5 } = req.query;

    const similarArticles = graph.findSimilarArticles(id, parseInt(limit));

    res.json({
      success: true,
      articleId: id,
      similar: similarArticles
    });
  } catch (error) {
    logger.error('Find similar error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/relationships/:id - Get article relationships
router.get('/graph/relationships/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.query;

    const relationships = graph.getRelationships(id, type || null);

    res.json({
      success: true,
      articleId: id,
      relationshipCount: relationships.length,
      relationships
    });
  } catch (error) {
    logger.error('Get relationships error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/query/topic - Query by topic
router.get('/graph/query/topic', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const results = graph.queryByTopic(q, parseInt(limit));

    res.json({
      success: true,
      query: q,
      resultCount: results.length,
      results
    });
  } catch (error) {
    logger.error('Query by topic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/query/keyword - Query by keyword
router.get('/graph/query/keyword', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const results = graph.queryByKeyword(q, parseInt(limit));

    res.json({
      success: true,
      query: q,
      resultCount: results.length,
      results
    });
  } catch (error) {
    logger.error('Query by keyword error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/stats - Get graph statistics
router.get('/graph/stats', async (req, res) => {
  try {
    const stats = graph.getGraphStats();

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/nodes - Get all nodes
router.get('/graph/nodes', async (req, res) => {
  try {
    const nodes = graph.getAllNodes();

    res.json({
      success: true,
      nodeCount: nodes.length,
      nodes
    });
  } catch (error) {
    logger.error('Get nodes error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/save - Manually save graph to disk
router.post('/graph/save', async (req, res) => {
  try {
    const success = await graph.saveToDisk();
    
    if (success) {
      const info = await graph.persistence.getGraphInfo();
      res.json({
        success: true,
        message: 'Graph saved to disk',
        graphInfo: info
      });
    } else {
      res.status(500).json({ error: 'Failed to save graph' });
    }
  } catch (error) {
    logger.error('Save graph error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/load - Manually load graph from disk
router.post('/graph/load', async (req, res) => {
  try {
    const loaded = await graph.loadFromDisk();
    
    if (loaded) {
      const stats = graph.getGraphStats();
      res.json({
        success: true,
        message: 'Graph loaded from disk',
        stats
      });
    } else {
      res.json({
        success: false,
        message: 'No saved graph found'
      });
    }
  } catch (error) {
    logger.error('Load graph error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/info - Get saved graph file info
router.get('/graph/info', async (req, res) => {
  try {
    const info = await graph.persistence.getGraphInfo();
    res.json({
      success: true,
      graphInfo: info
    });
  } catch (error) {
    logger.error('Get graph info error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/backup - Create backup of current graph
router.post('/graph/backup', async (req, res) => {
  try {
    const result = await graph.persistence.backupGraph();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Graph backed up',
        backupFile: result.backupFile
      });
    } else {
      res.status(500).json({ 
        success: false,
        error: result.message || result.error 
      });
    }
  } catch (error) {
    logger.error('Backup graph error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/graph/clear - Clear entire graph
router.delete('/graph/clear', async (req, res) => {
  try {
    graph.clear();

    res.json({
      success: true,
      message: 'Graph cleared'
    });
  } catch (error) {
    logger.error('Clear graph error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;