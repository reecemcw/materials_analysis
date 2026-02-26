import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getRawArticleModel, getLabelledArticleModel } from '../data/models/model_factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PATHS = {
  raw:    '/data/local/articles',
  tagged: '/data/local/tagged-articles',
};

const PREFIXES = {
  raw:    'article',
  tagged: 'tagged',
};

class Storage {
  constructor() {
    const projectRoot = join(__dirname, '..');
    this.dataDirs = {
      raw:    join(projectRoot, PATHS.raw),
      tagged: join(projectRoot, PATHS.tagged),
    };
    this._ensureDataDirs();
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  async _ensureDataDirs() {
    await Promise.all(
      Object.values(this.dataDirs).map(dir =>
        fs.mkdir(dir, { recursive: true }).catch(err =>
          logger.error(`Failed to create directory ${dir}:`, err)
        )
      )
    );
  }

  _getFilePath(type, id) {
    return join(this.dataDirs[type], `${PREFIXES[type]}-${id}.json`);
  }

  // ─── Raw Articles ─────────────────────────────────────────────────────────

  async saveArticle(article) {
    const [fileResult, mongoResult] = await Promise.allSettled([
      this._saveToFile('raw', article),
      this._saveRawToMongo(article),
    ]);

    if (fileResult.status  === 'rejected') logger.error('[Raw] File write failed:', article.id, fileResult.reason);
    if (mongoResult.status === 'rejected') logger.error('[Raw] MongoDB write failed:', article.id, mongoResult.reason);

    if (fileResult.status === 'rejected' && mongoResult.status === 'rejected') {
      throw new Error(`Failed to save article ${article.id} to any storage layer`);
    }

    return article;
  }

  async getArticle(id) {
    try {
      return await this._readFromFile('raw', id);
    } catch (err) {
      if (err.code !== 'ENOENT') logger.error('[Raw] File read failed, falling back to MongoDB:', err);
      return this._getRawFromMongo(id);
    }
  }

  async getAllArticles(limit = 50, offset = 0) {
    try {
      return await this._getAllFromFiles('raw', limit, offset);
    } catch (err) {
      logger.error('[Raw] File layer failed for getAllArticles, falling back to MongoDB:', err);
      return this._getAllRawFromMongo(limit, offset);
    }
  }

  async deleteArticle(id) {
    await Promise.allSettled([
      this._deleteFromFile('raw', id),
      this._deleteRawFromMongo(id),
    ]);
  }

  async articleExists(id) {
    try {
      await fs.access(this._getFilePath('raw', id));
      return true;
    } catch {
      const LabelledArticle = await getLabelledArticleModel();
      return (await LabelledArticle.countDocuments({ sourceId: id })) > 0;
    }
  }

  // ─── Tagged Articles ──────────────────────────────────────────────────────

  async saveTaggedArticle(article) {
    return this._saveToFile('tagged', article);
  }

  async getTaggedArticle(id) {
    return this._readFromFile('tagged', id).catch(err => {
      if (err.code === 'ENOENT') return null;
      logger.error('[Tagged] Failed to read tagged article:', err);
      throw err;
    });
  }

  async getAllTaggedArticles(limit = 1000, offset = 0) {
    try {
      return await this._getAllFromFiles('tagged', limit, offset);
    } catch (err) {
      logger.error('[Tagged] Failed to get all tagged articles:', err);
      return [];
    }
  }

  async deleteTaggedArticle(id) {
    return this._deleteFromFile('tagged', id);
  }

  // ─── Shared File Helpers ──────────────────────────────────────────────────

  async _saveToFile(type, article) {
    const filePath = this._getFilePath(type, article.id);
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
    logger.info(`[File][${type}] Saved article: ${article.id}`);
    return article;
  }

  async _readFromFile(type, id) {
    const filePath = this._getFilePath(type, id);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  }

  async _getAllFromFiles(type, limit, offset) {
    const prefix = PREFIXES[type];
    const files = await fs.readdir(this.dataDirs[type]);
    const articleFiles = files.filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.json'));

    const filesWithStats = await Promise.all(
      articleFiles.map(async file => {
        const filePath = join(this.dataDirs[type], file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime };
      })
    );

    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    return Promise.all(
      filesWithStats
        .slice(offset, offset + limit)
        .map(async ({ file }) => {
          const data = await fs.readFile(join(this.dataDirs[type], file), 'utf8');
          return JSON.parse(data);
        })
    );
  }

  async _deleteFromFile(type, id) {
    try {
      await fs.unlink(this._getFilePath(type, id));
      logger.info(`[File][${type}] Deleted article: ${id}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ─── MongoDB Helpers (Raw only) ───────────────────────────────────────────

  async _saveRawToMongo(article) {
    const RawArticle = await getRawArticleModel();
    const raw = await RawArticle.findOneAndUpdate(
        { sourceId: article.id },
        {
        $set: {
            sourceId:    article.id,
            sourceUrl:   article.url,
            title:       article.title,
            author:      article.author,
            publishDate: article.publishDate,
            content:     article.content,
            excerpt:     article.excerpt,
            imageUrl:    article.imageUrl,
            tags:        article.tags,
            scrapedAt:   new Date(article.scrapedAt),
            status:      'pending',
        }
        },
        { upsert: true, new: true }
    );
    logger.info(`[MongoDB] Written to articles/raw: ${article.id}`);
    return raw;
    }

  async _getRawFromMongo(id) {
    try {
      const RawArticle     = await getRawArticleModel();
      const LabelledArticle = await getLabelledArticleModel();
      const crawled = await RawArticle.findOne({ sourceId: id }).lean();
      if (!crawled) return null;
      const enriched = await LabelledArticle.findOne({ sourceId: crawled._id }).lean();
      return { ...crawled, enrichedData: enriched?.enrichedData ?? null };
    } catch (err) {
      logger.error('[MongoDB] Read failed for article:', id, err);
      return null;
    }
  }

  async _getAllRawFromMongo(limit, offset) {
    const RawArticle      = await getRawArticleModel();
    const LabelledArticle = await getLabelledArticleModel();

    const rawDocs = await RawArticle.find()
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    const enrichedDocs = await LabelledArticle.find({
      sourceId: { $in: rawDocs.map(d => d._id) },
    }).lean();

    const enrichedMap = Object.fromEntries(
      enrichedDocs.map(e => [e.sourceId.toString(), e.enrichedData])
    );

    return rawDocs.map(doc => ({
      ...doc,
      enrichedData: enrichedMap[doc._id.toString()] ?? null,
    }));
  }

  async _deleteRawFromMongo(id) {
    const RawArticle      = await getRawArticleModel();
    const LabelledArticle = await getLabelledArticleModel();
    const crawled = await RawArticle.findOneAndDelete({ sourceId: id });
    if (crawled) {
      await LabelledArticle.deleteOne({ sourceId: crawled._id });
      logger.info(`[MongoDB] Deleted article: ${id}`);
    }
  }
}

export default Storage;