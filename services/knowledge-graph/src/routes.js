import express from 'express';
import axios from 'axios';
import KnowledgeGraph from './graph.js';
import logger from '../../../utils/logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const router      = express.Router();
const graph       = new KnowledgeGraph();
const LABELLER_URL = process.env.LABELLER_URL || 'http://localhost:3002';

// ─── Startup: parity check then load ─────────────────────────────────────────

graph.loadFromDisk().then(loaded => {
  if (loaded) {
    logger.info(`Graph loaded — v${graph.currentVersion}, ${graph.nodes.size} nodes`);
  } else {
    logger.info('Starting with empty graph');
  }
}).catch(err => logger.error('Failed to load graph:', err));

// ─── Article Management ───────────────────────────────────────────────────────

// Two changes:
//   1. POST /graph/add/:id  — remove findSimilarArticles call (was O(n) per add,
//      blocks event loop at scale). Relationships built during sync only.
//   2. POST /graph/sync     — batched edge-building with event loop yields between
//      batches so health/other endpoints stay responsive during long syncs.
router.post('/graph/add/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Accept article from body (fast path) or fetch from labeller (slow fallback)
    let article = req.body.article;
    if (!article) {
      const response = await axios.get(`${LABELLER_URL}/api/tagged/${id}`);
      article = response.data.taggedArticle;
    }

    const node = graph.addArticleNode(article);

    res.json({
      success: true,
      node,
      relationshipsCreated: 0,
      graphVersion: graph.currentVersion,
      message: 'Article added to knowledge graph',
    });
  } catch (error) {
    logger.error('Add to graph error:', error);
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Tagged article not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ─── 2. Batched sync — yields between batches to keep event loop free ─────────
router.post('/graph/sync', async (req, res) => {
  try {
    const { runId = null } = req.body;

    logger.info('Syncing all articles to graph');

    const response = await axios.get(`${LABELLER_URL}/api/tagged?limit=1000`);
    const articles = response.data.taggedArticles;

    let nodesAdded           = 0;
    let relationshipsCreated = 0;

    // ── Pass 1: add all nodes ─────────────────────────────────────────────────
    for (const article of articles) {
      try {
        graph.addArticleNode(article);
        nodesAdded++;
      } catch (error) {
        logger.warn(`Failed to add node ${article.id}:`, error.message);
      }
    }

    // ── Pass 2: build edges in batches, yielding between each ─────────────────
    // findSimilarArticles is O(n) per article → O(n²) total.
    // Yielding every BATCH_SIZE articles keeps the event loop free so health
    // checks and other requests don't time out during a large sync.
    const BATCH_SIZE = 50;

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      const batch = articles.slice(i, i + BATCH_SIZE);

      for (const article of batch) {
        const similarArticles = graph.findSimilarArticles(article.id, 10);
        for (const similar of similarArticles) {
          if (similar.similarity > 3) {
            try {
              graph.addRelationship(article.id, similar.articleId, 'RELATES_TO', {
                strength:       similar.similarity,
                sharedTopics:   similar.sharedTopics,
                sharedKeywords: similar.sharedKeywords.slice(0, 3),
              });
              relationshipsCreated++;
            } catch {
              // edge already exists — idempotent, ignore
            }
          }
        }
      }

      logger.info(`[Sync] Edge pass: ${Math.min(i + BATCH_SIZE, articles.length)}/${articles.length} articles processed`);

      // Yield to event loop between batches
      await new Promise(r => setTimeout(r, 0));
    }

    // ── Snapshot after sync ───────────────────────────────────────────────────
    const snapshot = await graph.saveToDisk({ triggerReason: 'pipeline_run', runId });

    res.json({
      success: true,
      nodesAdded,
      relationshipsCreated,
      snapshot: {
        version:  snapshot.version,
        checksum: snapshot.checksum,
        stats:    snapshot.stats,
      },
      message: 'Graph synchronised and snapshotted',
    });
  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Querying ─────────────────────────────────────────────────────────────────

router.get('/graph/similar/:id', async (req, res) => {
  try {
    const { id }       = req.params;
    const { limit = 5 } = req.query;

    res.json({
      success:   true,
      articleId: id,
      similar:   graph.findSimilarArticles(id, parseInt(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/graph/relationships/:id', async (req, res) => {
  try {
    const { id }   = req.params;
    const { type } = req.query;
    const relationships = graph.getRelationships(id, type || null);

    res.json({
      success:           true,
      articleId:         id,
      relationshipCount: relationships.length,
      relationships,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/graph/query/topic', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    res.json({
      success:     true,
      query:       q,
      resultCount: graph.queryByTopic(q, parseInt(limit)).length,
      results:     graph.queryByTopic(q, parseInt(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/graph/query/keyword', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

    res.json({
      success:     true,
      query:       q,
      resultCount: graph.queryByKeyword(q, parseInt(limit)).length,
      results:     graph.queryByKeyword(q, parseInt(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/graph/nodes', async (req, res) => {
  try {
    const nodes = graph.getAllNodes();
    res.json({ success: true, nodeCount: nodes.length, nodes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/graph/stats', async (req, res) => {
  try {
    res.json({ success: true, stats: graph.getGraphStats() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Version & Snapshot Management ───────────────────────────────────────────

// GET /api/graph/versions - list snapshot history
router.get('/graph/versions', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = await graph.persistence.getVersionHistory(parseInt(limit));

    res.json({
      success:        true,
      currentVersion: graph.currentVersion,
      history,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/graph/parity - check local vs MongoDB parity
router.get('/graph/parity', async (req, res) => {
  try {
    const parity = await graph.persistence.checkParity();
    res.json({ success: true, parity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/snapshot - manually trigger a snapshot
router.post('/graph/snapshot', async (req, res) => {
  try {
    const { reason = 'manual' } = req.body;

    const result = await graph.saveToDisk({ triggerReason: reason });

    res.json({
      success:  true,
      version:  result.version,
      checksum: result.checksum,
      stats:    result.stats,
      message:  `Snapshot v${result.version} saved`,
    });
  } catch (error) {
    logger.error('Snapshot error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/graph/rollback/:version - roll back to a previous version
router.post('/graph/rollback/:version', async (req, res) => {
  try {
    const version = parseInt(req.params.version);

    if (isNaN(version) || version < 1) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    const restoredGraph = await graph.persistence.rollbackToVersion(version);

    // Apply restored graph to in-memory state
    graph.nodes     = restoredGraph.nodes;
    graph.edges     = restoredGraph.edges;
    graph.nodeEdges = restoredGraph.nodeEdges;
    graph.currentVersion     = version;
    graph.nodesSinceSnapshot = 0;

    res.json({
      success: true,
      version,
      stats: graph.getGraphStats(),
      message: `Rolled back to v${version}`,
    });
  } catch (error) {
    logger.error('Rollback error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Maintenance ──────────────────────────────────────────────────────────────

router.get('/graph/info', async (req, res) => {
  try {
    res.json({ success: true, graphInfo: await graph.persistence.getGraphInfo() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/graph/backup', async (req, res) => {
  try {
    const result = await graph.persistence.backupGraph();
    if (result.success) {
      res.json({ success: true, message: 'Graph backed up', backupFile: result.backupFile });
    } else {
      res.status(500).json({ success: false, error: result.message || result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Keep /graph/save as alias for /graph/snapshot for backwards compatibility
router.post('/graph/save', async (req, res) => {
  try {
    const result = await graph.saveToDisk({ triggerReason: 'manual' });
    const info   = await graph.persistence.getGraphInfo();
    res.json({ success: true, message: 'Graph saved', version: result.version, graphInfo: info });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/graph/load', async (req, res) => {
  try {
    const loaded = await graph.loadFromDisk();
    if (loaded) {
      res.json({ success: true, message: 'Graph loaded', stats: graph.getGraphStats() });
    } else {
      res.json({ success: false, message: 'No saved graph found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/graph/clear', async (req, res) => {
  try {
    graph.clear();
    res.json({ success: true, message: 'Graph cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;