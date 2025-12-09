import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class GraphPersistence {
  constructor() {
    // Store graph in project root data directory
    const projectRoot = path.join(__dirname, '../../../..');
    this.dataDir = path.join(projectRoot, 'data', 'graph');
    this.graphFile = path.join(this.dataDir, 'graph.json');
    this.ensureDataDir();
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      logger.info(`Graph data directory: ${this.dataDir}`);
    } catch (error) {
      logger.error('Failed to create graph data directory:', error);
    }
  }

  /**
   * Save graph to disk
   * @param {Map} nodes - Map of nodes
   * @param {Map} edges - Map of edges
   * @param {Map} nodeEdges - Map of node edges
   */
  async saveGraph(nodes, edges, nodeEdges) {
    try {
      const graphData = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        nodes: Array.from(nodes.entries()),
        edges: Array.from(edges.entries()),
        nodeEdges: Array.from(nodeEdges.entries()).map(([key, value]) => [
          key,
          Array.from(value)
        ]),
        stats: {
          nodeCount: nodes.size,
          edgeCount: edges.size
        }
      };

      await fs.writeFile(
        this.graphFile,
        JSON.stringify(graphData, null, 2),
        'utf8'
      );

      logger.info(`Graph saved: ${nodes.size} nodes, ${edges.size} edges`);
      return true;
    } catch (error) {
      logger.error('Failed to save graph:', error);
      return false;
    }
  }

  /**
   * Load graph from disk
   * @returns {Object} Graph data with nodes, edges, nodeEdges
   */
  async loadGraph() {
    try {
      // Check if file exists
      try {
        await fs.access(this.graphFile);
      } catch {
        logger.info('No saved graph found, starting fresh');
        return null;
      }

      const data = await fs.readFile(this.graphFile, 'utf8');
      const graphData = JSON.parse(data);

      // Convert arrays back to Maps
      const nodes = new Map(graphData.nodes);
      const edges = new Map(graphData.edges);
      const nodeEdges = new Map(
        graphData.nodeEdges.map(([key, value]) => [key, new Set(value)])
      );

      logger.info(
        `Graph loaded: ${nodes.size} nodes, ${edges.size} edges from ${graphData.savedAt}`
      );

      return { nodes, edges, nodeEdges };
    } catch (error) {
      logger.error('Failed to load graph:', error);
      return null;
    }
  }

  /**
   * Check if saved graph exists
   */
  async graphExists() {
    try {
      await fs.access(this.graphFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get graph file info
   */
  async getGraphInfo() {
    try {
      const exists = await this.graphExists();
      if (!exists) {
        return { exists: false };
      }

      const stats = await fs.stat(this.graphFile);
      const data = await fs.readFile(this.graphFile, 'utf8');
      const graphData = JSON.parse(data);

      return {
        exists: true,
        path: this.graphFile,
        size: stats.size,
        modified: stats.mtime,
        savedAt: graphData.savedAt,
        nodeCount: graphData.stats.nodeCount,
        edgeCount: graphData.stats.edgeCount
      };
    } catch (error) {
      logger.error('Failed to get graph info:', error);
      return { exists: false, error: error.message };
    }
  }

  /**
   * Create backup of current graph
   */
  async backupGraph() {
    try {
      const exists = await this.graphExists();
      if (!exists) {
        return { success: false, message: 'No graph to backup' };
      }

      const timestamp = Date.now();
      const backupFile = path.join(
        this.dataDir,
        `graph-backup-${timestamp}.json`
      );

      await fs.copyFile(this.graphFile, backupFile);
      logger.info(`Graph backed up to: ${backupFile}`);

      return { success: true, backupFile };
    } catch (error) {
      logger.error('Failed to backup graph:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete saved graph
   */
  async deleteGraph() {
    try {
      await fs.unlink(this.graphFile);
      logger.info('Saved graph deleted');
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to delete graph:', error);
      }
      return false;
    }
  }
}

export default GraphPersistence;