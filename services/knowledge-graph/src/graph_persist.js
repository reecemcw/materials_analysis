import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import logger from '../../../utils/logger.js';
import { getGraphSnapshotModel, computeChecksum } from '../../../data/models/model_factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

class GraphPersistence {
  constructor() {
    const projectRoot  = path.join(__dirname, '../../..');
    this.dataDir       = path.join(projectRoot, 'data', 'graph');
    this.graphFile     = path.join(this.dataDir, 'graph.json');
    this.versionFile   = path.join(this.dataDir, 'version.json'); // tracks local version
    this.ensureDataDir();
  }

  // ─── Setup ──────────────────────────────────────────────────────────────────

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create graph data directory:', error);
    }
  }

  // ─── Version Helpers ────────────────────────────────────────────────────────

  async _getLocalVersion() {
    try {
      const data = await fs.readFile(this.versionFile, 'utf8');
      return JSON.parse(data).version ?? 0;
    } catch {
      return 0; // no version file = fresh start
    }
  }

  async _setLocalVersion(version, checksum) {
    await fs.writeFile(
      this.versionFile,
      JSON.stringify({ version, checksum, savedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  }

  async _getLatestMongoVersion() {
    try {
      const GraphSnapshot = await getGraphSnapshotModel();
      const latest = await GraphSnapshot.findOne().sort({ version: -1 }).lean();
      return latest?.version ?? 0;
    } catch (err) {
      logger.error('[GraphPersistence] Failed to get latest MongoDB version:', err);
      return 0;
    }
  }

  // ─── Parity Check ───────────────────────────────────────────────────────────

  /**
   * Compares local version against MongoDB.
   * Returns { inParity, localVersion, mongoVersion, action }
   * action: 'ok' | 'load_from_mongo' | 'fresh_start'
   */
  async checkParity() {
    const localVersion = await this._getLocalVersion();
    const mongoVersion = await this._getLatestMongoVersion();

    logger.info(`[GraphPersistence] Parity check — local: v${localVersion}, mongo: v${mongoVersion}`);

    if (localVersion === mongoVersion) {
      return { inParity: true, localVersion, mongoVersion, action: 'ok' };
    }

    if (mongoVersion > localVersion) {
      logger.warn(`[GraphPersistence] Local graph is behind MongoDB (v${localVersion} vs v${mongoVersion}) — will load from MongoDB`);
      return { inParity: false, localVersion, mongoVersion, action: 'load_from_mongo' };
    }

    // localVersion > mongoVersion — local is ahead, snapshot to mongo
    logger.warn(`[GraphPersistence] Local graph is ahead of MongoDB (v${localVersion} vs v${mongoVersion}) — will snapshot to MongoDB`);
    return { inParity: false, localVersion, mongoVersion, action: 'snapshot_to_mongo' };
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  /**
   * Save graph to both disk and MongoDB as a new versioned snapshot.
   */
  async saveGraph(nodes, edges, nodeEdges, options = {}) {
    const {
      triggerReason = 'manual',
      runId         = null,
    } = options;

    const graphData = {
      nodes:     Array.from(nodes.entries()),
      edges:     Array.from(edges.entries()),
      nodeEdges: Array.from(nodeEdges.entries()).map(([key, value]) => [
        key,
        Array.from(value),
      ]),
    };

    const checksum   = computeChecksum(graphData);
    const nextVersion = (await this._getLatestMongoVersion()) + 1;

    const fullSnapshot = {
      version:   nextVersion,
      savedAt:   new Date().toISOString(),
      checksum,
      stats: {
        nodeCount: nodes.size,
        edgeCount: edges.size,
      },
      graph: graphData,
    };

    // ── Write to disk ──────────────────────────────────────────────────────────
    const [fileResult, mongoResult] = await Promise.allSettled([
      this._saveToDisk(fullSnapshot),
      this._saveToMongo(fullSnapshot, triggerReason, runId),
    ]);

    if (fileResult.status  === 'rejected') logger.error('[GraphPersistence] Disk write failed:', fileResult.reason);
    if (mongoResult.status === 'rejected') logger.error('[GraphPersistence] MongoDB write failed:', mongoResult.reason);

    if (fileResult.status === 'rejected' && mongoResult.status === 'rejected') {
      throw new Error('Graph save failed on both disk and MongoDB');
    }

    // Update local version file only if disk write succeeded
    if (fileResult.status === 'fulfilled') {
      await this._setLocalVersion(nextVersion, checksum);
    }

    logger.info(`[GraphPersistence] Saved v${nextVersion} — ${nodes.size} nodes, ${edges.size} edges (${triggerReason})`);
    return { version: nextVersion, checksum, stats: fullSnapshot.stats };
  }

  async _saveToDisk(snapshot) {
    await fs.writeFile(this.graphFile, JSON.stringify(snapshot, null, 2), 'utf8');
    logger.info(`[GraphPersistence] Written to disk: ${this.graphFile}`);
  }

  async _saveToMongo(snapshot, triggerReason, runId) {
    const GraphSnapshot = await getGraphSnapshotModel();

    await GraphSnapshot.findOneAndUpdate(
      { version: snapshot.version },
      {
        $setOnInsert: {
          version:       snapshot.version,
          triggerReason,
          runId,
          stats:         snapshot.stats,
          graph:         snapshot.graph,
          checksum:      snapshot.checksum,
          localPath:     this.graphFile,
        }
      },
      { upsert: true, new: true }
    );

    logger.info(`[GraphPersistence] Snapshot v${snapshot.version} written to MongoDB`);
  }

  // ─── Load ────────────────────────────────────────────────────────────────────

  /**
   * Load graph — checks parity first, loads from MongoDB if local is behind.
   */
  async loadGraph() {
    const parity = await this.checkParity();

    if (parity.action === 'load_from_mongo') {
      logger.info('[GraphPersistence] Loading from MongoDB (local is behind)');
      return this._loadFromMongo();
    }

    if (parity.action === 'ok' || parity.action === 'snapshot_to_mongo') {
      // Try disk first
      const diskResult = await this._loadFromDisk();
      if (diskResult) {
        if (parity.action === 'snapshot_to_mongo') {
          // Local is ahead — push to mongo to resync
          logger.info('[GraphPersistence] Pushing local graph to MongoDB to restore parity');
          await this._saveToMongo(
            { version: parity.localVersion, stats: diskResult.stats, graph: diskResult.rawGraph, checksum: diskResult.checksum },
            'startup_recovery',
            null
          );
        }
        return diskResult.graph;
      }
      // Disk failed — fall back to MongoDB
      logger.warn('[GraphPersistence] Disk load failed, falling back to MongoDB');
      return this._loadFromMongo();
    }

    // fresh_start
    return null;
  }

  async _loadFromDisk() {
    try {
      await fs.access(this.graphFile);
      const data     = await fs.readFile(this.graphFile, 'utf8');
      const snapshot = JSON.parse(data);

      // ── Handle legacy format (pre-versioning) ──────────────────────────────
      // Old format had nodes/edges/nodeEdges at the top level, no graph wrapper
      const isLegacy = !snapshot.graph && snapshot.nodes;
      if (isLegacy) {
        logger.warn('[GraphPersistence] Legacy graph.json detected — migrating to versioned format');
        const legacyGraph = {
          nodes:     snapshot.nodes,
          edges:     snapshot.edges,
          nodeEdges: snapshot.nodeEdges,
        };
        const graph = this._deserialiseGraph(legacyGraph);
        logger.info(`[GraphPersistence] Migrated legacy graph — ${graph.nodes.size} nodes, ${graph.edges.size} edges`);
        return { graph, stats: snapshot.stats ?? { nodeCount: graph.nodes.size, edgeCount: graph.edges.size }, checksum: null, rawGraph: legacyGraph };
      }

      // ── Handle new versioned format ────────────────────────────────────────
      const checksum = computeChecksum(snapshot.graph);
      if (snapshot.checksum && checksum !== snapshot.checksum) {
        logger.error('[GraphPersistence] Checksum mismatch on disk — file may be corrupt');
        return null;
      }

      const graph = this._deserialiseGraph(snapshot.graph);
      logger.info(`[GraphPersistence] Loaded v${snapshot.version} from disk — ${graph.nodes.size} nodes, ${graph.edges.size} edges`);

      return {
        graph,
        stats:    snapshot.stats,
        checksum: snapshot.checksum,
        rawGraph: snapshot.graph,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error('[GraphPersistence] Disk load error:', err);
      return null;
    }
  }

  async _loadFromMongo(version = null) {
    try {
      const GraphSnapshot = await getGraphSnapshotModel();

      const query  = version ? { version } : {};
      const latest = await GraphSnapshot
        .findOne(query)
        .sort({ version: -1 })
        .lean();

      if (!latest) {
        logger.info('[GraphPersistence] No snapshots in MongoDB — starting fresh');
        return null;
      }

      // Verify checksum
      const checksum = computeChecksum(latest.graph);
      if (checksum !== latest.checksum) {
        logger.error(`[GraphPersistence] Checksum mismatch on MongoDB snapshot v${latest.version}`);
        return null;
      }

      const graph = this._deserialiseGraph(latest.graph);
      logger.info(`[GraphPersistence] Loaded v${latest.version} from MongoDB — ${graph.nodes.size} nodes, ${graph.edges.size} edges`);

      // Sync back to disk so local is up to date
      await this._saveToDisk({ ...latest, graph: latest.graph });
      await this._setLocalVersion(latest.version, latest.checksum);

      return graph;
    } catch (err) {
      logger.error('[GraphPersistence] MongoDB load error:', err);
      return null;
    }
  }

  _deserialiseGraph(graphData) {
    return {
      nodes:     new Map(graphData.nodes),
      edges:     new Map(graphData.edges),
      nodeEdges: new Map(
        graphData.nodeEdges.map(([key, value]) => [key, new Set(value)])
      ),
    };
  }

  // ─── Version History ─────────────────────────────────────────────────────────

  async getVersionHistory(limit = 20) {
    try {
      const GraphSnapshot = await getGraphSnapshotModel();
      return await GraphSnapshot
        .find({}, { graph: 0 }) // exclude heavy graph field
        .sort({ version: -1 })
        .limit(limit)
        .lean();
    } catch (err) {
      logger.error('[GraphPersistence] Failed to get version history:', err);
      return [];
    }
  }

  async rollbackToVersion(version) {
    logger.info(`[GraphPersistence] Rolling back to v${version}`);
    const graph = await this._loadFromMongo(version);
    if (!graph) throw new Error(`Version ${version} not found in MongoDB`);
    return graph;
  }

  // ─── Info / Backup (backwards compatible) ────────────────────────────────────

  async getGraphInfo() {
    try {
      const [localVersion, mongoVersion] = await Promise.all([
        this._getLocalVersion(),
        this._getLatestMongoVersion(),
      ]);

      const exists = await this.graphExists();
      const stats  = exists ? await fs.stat(this.graphFile) : null;

      return {
        exists,
        localVersion,
        mongoVersion,
        inParity:  localVersion === mongoVersion,
        path:      this.graphFile,
        size:      stats?.size ?? null,
        modified:  stats?.mtime ?? null,
      };
    } catch (err) {
      logger.error('[GraphPersistence] Failed to get graph info:', err);
      return { exists: false, error: err.message };
    }
  }

  async graphExists() {
    try {
      await fs.access(this.graphFile);
      return true;
    } catch {
      return false;
    }
  }

  async backupGraph() {
    try {
      const exists = await this.graphExists();
      if (!exists) return { success: false, message: 'No local graph to backup' };

      const timestamp  = Date.now();
      const backupFile = path.join(this.dataDir, `graph-backup-${timestamp}.json`);
      await fs.copyFile(this.graphFile, backupFile);
      logger.info(`[GraphPersistence] Backed up to: ${backupFile}`);

      return { success: true, backupFile };
    } catch (err) {
      logger.error('[GraphPersistence] Backup failed:', err);
      return { success: false, error: err.message };
    }
  }

  async deleteGraph() {
    try {
      await fs.unlink(this.graphFile);
      logger.info('[GraphPersistence] Local graph deleted');
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error('[GraphPersistence] Delete failed:', err);
      return false;
    }
  }
}

export default GraphPersistence;