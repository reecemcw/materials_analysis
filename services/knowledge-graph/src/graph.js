import logger from '../../../utils/logger.js';
import GraphPersistence from './graph_persist.js';

class KnowledgeGraph {
  constructor() {
    this.nodes       = new Map();
    this.edges       = new Map();
    this.nodeEdges   = new Map();
    this.persistence = new GraphPersistence();
    this.autoSave    = true;

    // Version tracking
    this.currentVersion   = 0;
    this.nodesSinceSnapshot = 0;
    this.SNAPSHOT_INTERVAL  = 10; // auto-snapshot every N nodes added
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  async loadFromDisk() {
    const graph = await this.persistence.loadGraph();
    if (graph) {
      this.nodes     = graph.nodes;
      this.edges     = graph.edges;
      this.nodeEdges = graph.nodeEdges;
      this.currentVersion = await this.persistence._getLocalVersion();
      logger.info(`Graph restored — v${this.currentVersion}, ${this.nodes.size} nodes, ${this.edges.size} edges`);
      return true;
    }
    return false;
  }

  async saveToDisk(options = {}) {
    const result = await this.persistence.saveGraph(
      this.nodes,
      this.edges,
      this.nodeEdges,
      options
    );
    this.currentVersion     = result.version;
    this.nodesSinceSnapshot = 0;
    return result;
  }

  // ─── Nodes ───────────────────────────────────────────────────────────────────

  addArticleNode(article) {
    try {
      const nodeData = {
        id:      article.id,
        title:   article.title,
        url:     article.url,
        labels:  article.labels || {},
        addedAt: new Date().toISOString(),
      };

      this.nodes.set(article.id, nodeData);

      if (!this.nodeEdges.has(article.id)) {
        this.nodeEdges.set(article.id, new Set());
      }

      this.nodesSinceSnapshot++;
      logger.info(`Added node: ${article.id} (${this.nodesSinceSnapshot} since last snapshot)`);

      // Auto-snapshot at interval
      if (this.autoSave && this.nodesSinceSnapshot >= this.SNAPSHOT_INTERVAL) {
        this.saveToDisk({ triggerReason: 'scheduled' })
          .catch(err => logger.error('Auto-snapshot failed:', err));
      }

      return nodeData;
    } catch (error) {
      logger.error('Failed to add node:', error);
      throw error;
    }
  }

  // ─── Edges ───────────────────────────────────────────────────────────────────

  addRelationship(fromId, toId, relationshipType, metadata = {}) {
    try {
      if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
        throw new Error('Both nodes must exist before creating relationship');
      }

      const edgeId = `${fromId}-${relationshipType}-${toId}`;

      // Idempotent — don't duplicate existing edges
      if (this.edges.has(edgeId)) return this.edges.get(edgeId);

      const edge = {
        id:   edgeId,
        from: fromId,
        to:   toId,
        type: relationshipType,
        ...metadata,
        createdAt: new Date().toISOString(),
      };

      this.edges.set(edgeId, edge);
      this.nodeEdges.get(fromId).add(edgeId);
      this.nodeEdges.get(toId).add(edgeId);

      logger.info(`Added relationship: ${edgeId}`);
      return edge;
    } catch (error) {
      logger.error('Failed to add relationship:', error);
      throw error;
    }
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────

  getNode(articleId) {
    return this.nodes.get(articleId);
  }

  getAllNodes() {
    return Array.from(this.nodes.values());
  }

  getRelationships(articleId, relationshipType = null) {
    const edgeIds = this.nodeEdges.get(articleId) || new Set();
    const relationships = [];

    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (!relationshipType || edge.type === relationshipType) {
        relationships.push(edge);
      }
    }

    return relationships;
  }

  findSimilarArticles(articleId, limit = 5) {
    const sourceNode = this.nodes.get(articleId);
    if (!sourceNode) return [];

    const similarities = [];

    for (const [id, node] of this.nodes.entries()) {
      if (id === articleId) continue;

      const similarity = this.calculateSimilarity(sourceNode, node);

      if (similarity > 0) {
        similarities.push({
          articleId: id,
          title: node.title,
          similarity,
          sharedTopics: this.findSharedItems(
            sourceNode.labels.topics || [],
            node.labels.topics || []
          ),
          sharedKeywords: this.findSharedItems(
            sourceNode.labels.keywords || [],
            node.labels.keywords || []
          ),
        });
      }
    }

    return similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  calculateSimilarity(node1, node2) {
    let score = 0;

    const sharedCategories = this.findSharedItems(node1.labels.categories || [], node2.labels.categories || []);
    score += sharedCategories.length * 3;

    const sharedTopics = this.findSharedItems(node1.labels.topics || [], node2.labels.topics || []);
    score += sharedTopics.length * 2;

    const sharedKeywords = this.findSharedItems(node1.labels.keywords || [], node2.labels.keywords || []);
    score += sharedKeywords.length * 1;

    if (node1.labels.entities && node2.labels.entities) {
      score += this.findSharedItems(node1.labels.entities.people || [], node2.labels.entities.people || []).length * 2;
      score += this.findSharedItems(node1.labels.entities.organizations || [], node2.labels.entities.organizations || []).length * 2;
    }

    return score;
  }

  findSharedItems(arr1, arr2) {
    const set1 = new Set(arr1.map(item => item.toLowerCase()));
    return arr2.filter(item => set1.has(item.toLowerCase()));
  }

  queryByTopic(topic, limit = 10) {
    const topicLower = topic.toLowerCase();
    const results    = [];

    for (const node of this.nodes.values()) {
      const topics     = node.labels.topics     || [];
      const categories = node.labels.categories || [];

      const hasMatchingTopic    = topics.some(t => t.toLowerCase().includes(topicLower));
      const hasMatchingCategory = categories.some(c => c.toLowerCase().includes(topicLower));

      if (hasMatchingTopic || hasMatchingCategory) {
        results.push({
          articleId:     node.id,
          title:         node.title,
          url:           node.url,
          relevance:     hasMatchingTopic ? 2 : 1,
          matchedTopics: topics.filter(t => t.toLowerCase().includes(topicLower)),
        });
      }
    }

    return results.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
  }

  queryByKeyword(keyword, limit = 10) {
    const keywordLower = keyword.toLowerCase();
    const results      = [];

    for (const node of this.nodes.values()) {
      const keywords        = node.labels.keywords || [];
      const matchingKeywords = keywords.filter(k => k.toLowerCase().includes(keywordLower));

      if (matchingKeywords.length > 0) {
        results.push({
          articleId:       node.id,
          title:           node.title,
          url:             node.url,
          matchCount:      matchingKeywords.length,
          matchedKeywords: matchingKeywords,
        });
      }
    }

    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getGraphStats() {
    return {
      totalNodes:        this.nodes.size,
      totalEdges:        this.edges.size,
      currentVersion:    this.currentVersion,
      nodesSinceSnapshot: this.nodesSinceSnapshot,
      relationshipTypes: this.getRelationshipTypes(),
      nodesByCategory:   this.aggregateByField('categories'),
      nodesBySentiment:  this.aggregateByField('sentiment'),
    };
  }

  getRelationshipTypes() {
    const types = {};
    for (const edge of this.edges.values()) {
      types[edge.type] = (types[edge.type] || 0) + 1;
    }
    return types;
  }

  aggregateByField(field) {
    const aggregation = {};
    for (const node of this.nodes.values()) {
      if (field === 'categories') {
        (node.labels.categories || []).forEach(cat => {
          aggregation[cat] = (aggregation[cat] || 0) + 1;
        });
      } else if (field === 'sentiment') {
        const sentiment = node.labels.sentiment;
        if (sentiment) aggregation[sentiment] = (aggregation[sentiment] || 0) + 1;
      }
    }
    return aggregation;
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.nodeEdges.clear();
    this.currentVersion     = 0;
    this.nodesSinceSnapshot = 0;
    logger.info('Graph cleared');
  }
}

export default KnowledgeGraph;