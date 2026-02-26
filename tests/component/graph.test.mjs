/**
 * Unit Tests — Knowledge Graph Service
 * Run with: node --test services/knowledge-graph/tests/graph.test.mjs
 */

import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock logger before importing anything that uses it ───────────────────────

const mockLogger = {
  info:  mock.fn(),
  warn:  mock.fn(),
  error: mock.fn(),
};

// Mock the shared logger module so KnowledgeGraph doesn't need the real one
mock.module('../../utils/logger.js', { defaultExport: mockLogger });

// Mock GraphPersistence so graph.test.mjs doesn't touch the filesystem
const mockPersistence = {
  loadGraph:    mock.fn(async () => null),
  saveGraph:    mock.fn(async () => true),
  ensureDataDir: mock.fn(async () => {}),
};

mock.module('../src/graph_persist.js', { defaultExport: class {
  loadGraph()     { return mockPersistence.loadGraph(); }
  saveGraph(...a) { return mockPersistence.saveGraph(...a); }
  ensureDataDir() { return mockPersistence.ensureDataDir(); }
}});

// Import after mocks are registered
const { default: KnowledgeGraph } = await import('../src/graph.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeArticle = (overrides = {}) => ({
  id:     'article-1',
  title:  'Test Article',
  url:    'https://example.com/test',
  labels: {
    categories: ['Technology'],
    topics:     ['AI', 'Machine Learning'],
    keywords:   ['neural network', 'deep learning'],
    sentiment:  'positive',
    entities: {
      people:        ['Sam Altman'],
      organizations: ['OpenAI'],
      locations:     [],
      products:      ['ChatGPT'],
    },
  },
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeGraph', () => {

  describe('addArticleNode', () => {
    let graph;
    beforeEach(() => { graph = new KnowledgeGraph(); });

    it('adds a node and returns node data', () => {
      const article = makeArticle();
      const node = graph.addArticleNode(article);

      assert.equal(node.id, 'article-1');
      assert.equal(node.title, 'Test Article');
      assert.equal(node.url, 'https://example.com/test');
      assert.deepEqual(node.labels, article.labels);
      assert.ok(node.addedAt);
    });

    it('stores the node in the internal map', () => {
      graph.addArticleNode(makeArticle());
      assert.ok(graph.nodes.has('article-1'));
    });

    it('initialises an empty edge set for the new node', () => {
      graph.addArticleNode(makeArticle());
      assert.ok(graph.nodeEdges.has('article-1'));
      assert.equal(graph.nodeEdges.get('article-1').size, 0);
    });

    it('overwrites an existing node with the same id', () => {
      graph.addArticleNode(makeArticle({ title: 'Original' }));
      graph.addArticleNode(makeArticle({ title: 'Updated' }));
      assert.equal(graph.nodes.get('article-1').title, 'Updated');
    });
  });

  describe('addRelationship', () => {
    let graph;
    beforeEach(() => {
      graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'article-1' }));
      graph.addArticleNode(makeArticle({ id: 'article-2' }));
    });

    it('creates an edge between two existing nodes', () => {
      const edge = graph.addRelationship('article-1', 'article-2', 'RELATES_TO', { strength: 5 });

      assert.equal(edge.from, 'article-1');
      assert.equal(edge.to, 'article-2');
      assert.equal(edge.type, 'RELATES_TO');
      assert.equal(edge.strength, 5);
    });

    it('registers the edge on both nodes', () => {
      graph.addRelationship('article-1', 'article-2', 'RELATES_TO');
      const edgeId = 'article-1-RELATES_TO-article-2';

      assert.ok(graph.nodeEdges.get('article-1').has(edgeId));
      assert.ok(graph.nodeEdges.get('article-2').has(edgeId));
    });

    it('throws if the source node does not exist', () => {
      assert.throws(
        () => graph.addRelationship('missing', 'article-2', 'RELATES_TO'),
        /Both nodes must exist/
      );
    });

    it('throws if the target node does not exist', () => {
      assert.throws(
        () => graph.addRelationship('article-1', 'missing', 'RELATES_TO'),
        /Both nodes must exist/
      );
    });
  });

  describe('getRelationships', () => {
    let graph;
    beforeEach(() => {
      graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'article-1' }));
      graph.addArticleNode(makeArticle({ id: 'article-2' }));
      graph.addArticleNode(makeArticle({ id: 'article-3' }));
      graph.addRelationship('article-1', 'article-2', 'RELATES_TO');
      graph.addRelationship('article-1', 'article-3', 'CITES');
    });

    it('returns all relationships for a node', () => {
      const rels = graph.getRelationships('article-1');
      assert.equal(rels.length, 2);
    });

    it('filters by relationship type', () => {
      const rels = graph.getRelationships('article-1', 'CITES');
      assert.equal(rels.length, 1);
      assert.equal(rels[0].type, 'CITES');
    });

    it('returns empty array for a node with no relationships', () => {
      graph.addArticleNode(makeArticle({ id: 'isolated' }));
      assert.deepEqual(graph.getRelationships('isolated'), []);
    });

    it('returns empty array for an unknown node', () => {
      assert.deepEqual(graph.getRelationships('does-not-exist'), []);
    });
  });

  describe('calculateSimilarity', () => {
    let graph;
    before(() => { graph = new KnowledgeGraph(); });

    it('returns 0 for articles with no shared labels', () => {
      const n1 = { labels: { categories: ['Tech'],    topics: ['AI'],       keywords: ['neural'],  entities: { people: [], organizations: [] } } };
      const n2 = { labels: { categories: ['Finance'], topics: ['Trading'],  keywords: ['stocks'],  entities: { people: [], organizations: [] } } };
      assert.equal(graph.calculateSimilarity(n1, n2), 0);
    });

    it('scores shared categories higher than shared topics', () => {
      const base    = { labels: { categories: ['Tech'], topics: [],      keywords: [], entities: { people: [], organizations: [] } } };
      const catMatch = { labels: { categories: ['Tech'], topics: [],      keywords: [], entities: { people: [], organizations: [] } } };
      const topMatch = { labels: { categories: [],       topics: ['AI'],  keywords: [], entities: { people: [], organizations: [] } } };

      const catScore = graph.calculateSimilarity({ labels: { categories: [], topics: ['AI'], keywords: [], entities: { people: [], organizations: [] } } }, topMatch);
      const baseScore = graph.calculateSimilarity(base, catMatch);

      // category weight=3, topic weight=2
      assert.ok(baseScore > catScore);
    });

    it('accumulates scores across multiple shared fields', () => {
      const n1 = { labels: { categories: ['Tech'], topics: ['AI'], keywords: ['neural'], entities: { people: ['Altman'], organizations: ['OpenAI'] } } };
      const n2 = { labels: { categories: ['Tech'], topics: ['AI'], keywords: ['neural'], entities: { people: ['Altman'], organizations: ['OpenAI'] } } };
      // 1 cat×3 + 1 topic×2 + 1 keyword×1 + 1 person×2 + 1 org×2 = 10
      assert.equal(graph.calculateSimilarity(n1, n2), 10);
    });
  });

  describe('findSimilarArticles', () => {
    let graph;
    beforeEach(() => {
      graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'article-1', labels: { categories: ['Tech'], topics: ['AI'], keywords: ['neural'], entities: { people: [], organizations: [] } } }));
      graph.addArticleNode(makeArticle({ id: 'article-2', labels: { categories: ['Tech'], topics: ['AI'], keywords: ['neural'], entities: { people: [], organizations: [] } } }));
      graph.addArticleNode(makeArticle({ id: 'article-3', labels: { categories: ['Finance'], topics: ['Trading'], keywords: ['stocks'], entities: { people: [], organizations: [] } } }));
    });

    it('does not include the source article in results', () => {
      const results = graph.findSimilarArticles('article-1');
      assert.ok(results.every(r => r.articleId !== 'article-1'));
    });

    it('returns articles sorted by similarity descending', () => {
      const results = graph.findSimilarArticles('article-1');
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].similarity >= results[i].similarity);
      }
    });

    it('respects the limit parameter', () => {
      const results = graph.findSimilarArticles('article-1', 1);
      assert.equal(results.length, 1);
    });

    it('returns empty array for unknown article', () => {
      assert.deepEqual(graph.findSimilarArticles('does-not-exist'), []);
    });
  });

  describe('queryByTopic', () => {
    let graph;
    before(() => {
      graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'a1', labels: { categories: ['Tech'],    topics: ['Artificial Intelligence'], keywords: [], entities: { people: [], organizations: [] } } }));
      graph.addArticleNode(makeArticle({ id: 'a2', labels: { categories: ['Science'], topics: ['Biology'],                 keywords: [], entities: { people: [], organizations: [] } } }));
    });

    it('returns articles matching the topic', () => {
      const results = graph.queryByTopic('intelligence');
      assert.equal(results.length, 1);
      assert.equal(results[0].articleId, 'a1');
    });

    it('is case-insensitive', () => {
      assert.equal(graph.queryByTopic('BIOLOGY').length, 1);
    });

    it('returns empty array when no match', () => {
      assert.equal(graph.queryByTopic('quantum computing').length, 0);
    });

    it('respects the limit parameter', () => {
      // Add extra matching article
      graph.addArticleNode(makeArticle({ id: 'a3', labels: { categories: ['Tech'], topics: ['AI'], keywords: [], entities: { people: [], organizations: [] } } }));
      const results = graph.queryByTopic('a', 1); // 'a' matches many
      assert.ok(results.length <= 1);
    });
  });

  describe('queryByKeyword', () => {
    let graph;
    before(() => {
      graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'k1', labels: { categories: [], topics: [], keywords: ['neural network', 'deep learning'], entities: { people: [], organizations: [] } } }));
      graph.addArticleNode(makeArticle({ id: 'k2', labels: { categories: [], topics: [], keywords: ['blockchain', 'crypto'],           entities: { people: [], organizations: [] } } }));
    });

    it('returns articles with matching keywords', () => {
      const results = graph.queryByKeyword('neural');
      assert.equal(results.length, 1);
      assert.equal(results[0].articleId, 'k1');
    });

    it('is case-insensitive', () => {
      assert.equal(graph.queryByKeyword('CRYPTO').length, 1);
    });

    it('returns empty array for no match', () => {
      assert.equal(graph.queryByKeyword('quantum').length, 0);
    });
  });

  describe('getGraphStats', () => {
    it('returns correct node and edge counts', () => {
      const graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'n1' }));
      graph.addArticleNode(makeArticle({ id: 'n2' }));
      graph.addRelationship('n1', 'n2', 'RELATES_TO');

      const stats = graph.getGraphStats();
      assert.equal(stats.totalNodes, 2);
      assert.equal(stats.totalEdges, 1);
    });

    it('aggregates relationship types', () => {
      const graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'n1' }));
      graph.addArticleNode(makeArticle({ id: 'n2' }));
      graph.addArticleNode(makeArticle({ id: 'n3' }));
      graph.addRelationship('n1', 'n2', 'RELATES_TO');
      graph.addRelationship('n1', 'n3', 'CITES');

      const stats = graph.getGraphStats();
      assert.equal(stats.relationshipTypes['RELATES_TO'], 1);
      assert.equal(stats.relationshipTypes['CITES'], 1);
    });
  });

  describe('clear', () => {
    it('removes all nodes, edges and nodeEdges', () => {
      const graph = new KnowledgeGraph();
      graph.addArticleNode(makeArticle({ id: 'n1' }));
      graph.addArticleNode(makeArticle({ id: 'n2' }));
      graph.addRelationship('n1', 'n2', 'RELATES_TO');

      graph.clear();

      assert.equal(graph.nodes.size, 0);
      assert.equal(graph.edges.size, 0);
      assert.equal(graph.nodeEdges.size, 0);
    });
  });

  describe('loadFromDisk', () => {
    it('returns false when persistence returns null', async () => {
      mockPersistence.loadGraph.mock.resetCalls();
      mockPersistence.loadGraph = mock.fn(async () => null);

      const graph = new KnowledgeGraph();
      const result = await graph.loadFromDisk();
      assert.equal(result, false);
    });

    it('restores nodes and edges from persisted data', async () => {
      const nodes     = new Map([['article-1', makeArticle()]]);
      const edges     = new Map();
      const nodeEdges = new Map([['article-1', new Set()]]);

      mockPersistence.loadGraph = mock.fn(async () => ({ nodes, edges, nodeEdges }));

      const graph = new KnowledgeGraph();
      const result = await graph.loadFromDisk();

      assert.equal(result, true);
      assert.ok(graph.nodes.has('article-1'));
    });
  });
});
