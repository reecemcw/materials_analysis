import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import { getRawArticleModel, getLabelledArticleModel } from '../../../data/models/model_factory.js';


// Create __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _articleDump = 'data/locals/articles'

class ArticleStorage {
  constructor() {
    const projectRoot = join(__dirname, '../../..');
    this.dataDir = join(projectRoot, _articleDump);
    this.ensureDataDir();
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create data directory:', error);
    }
  }

  getArticlePath(id) {
    return join(this.dataDir, `article-${id}.json`);
  }

  // -------- WRITE ---------
  async saveArticle(article) {
    const [fileResult, mongoResult] = await Promise.allSettled([
      this._saveToFile(article),
      this._saveToMongo(article)
    ]);

    if (fileResult.status === 'rejected') {
      logger.error('File write failed for article:', article.id, fileResult.reason);
    }
    if (mongoResult.status === 'rejected') {
      logger.error('MongoDB write failed for article:', article.id, mongoResult.reason);
    }

    // Fail loudly only if both transports failed
    if (fileResult.status === 'rejected' && mongoResult.status === 'rejected') {
      throw new Error(`Failed to save article ${article.id} to any storage layer`);
    }

    return article;
  }

  async _saveToMongo(article) {
    const RawArticle = await getRawArticleModel();

    const raw = await RawArticle.findOneAndUpdate(
      { sourceId: article.id },
      {
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
        status:      'pending'
      },
      { upsert: true, new: true }
    );

    logger.info(`[MongoDB] Written to articles/raw: ${article.id}`);
    return raw;
  }

  async _saveToFile(article) {
    const filePath = this.getArticlePath(article.id);
    await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
    logger.info(`[File] Saved article: ${article.id}`);
  }


  // -------- READ ---------
  async getArticle(id) {
    // Try file first, fall back to MongoDB
    try {
      const filePath = this.getArticlePath(id);
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (fileError) {
      if (fileError.code !== 'ENOENT') {
        logger.error('File read failed, falling back to MongoDB:', fileError);
      }
      return this._getFromMongo(id);
    }
  }

  async _getFromMongo(id) {
    try {
      const crawled = await RawArticle.findOne({ sourceId: id }).lean();
      if (!crawled) return null;

      const enriched = await LabelledArticle.findOne({ sourceId: crawled._id }).lean();
      return { ...crawled, enrichedData: enriched?.enrichedData ?? null };
    } catch (error) {
      logger.error('MongoDB read failed for article:', id, error);
      return null;
    }
  }

  async getAllArticles(limit = 50, offset = 0) {
    try {
      const files = await fs.readdir(this.dataDir);
      const articleFiles = files.filter(f => f.startsWith('article-') && f.endsWith('.json'));

      const filesWithStats = await Promise.all(
        articleFiles.map(async (file) => {
          const filePath = join(this.dataDir, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime };
        })
      );

      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      const paginatedFiles = filesWithStats
        .slice(offset, offset + limit)
        .map(item => item.file);

      const articles = await Promise.all(
        paginatedFiles.map(async (file) => {
          const filePath = join(this.dataDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          return JSON.parse(data);
        })
      );

      return articles;
    } catch (error) {
      logger.error('File layer failed for getAllArticles, falling back to MongoDB:', error);
      return this._getAllFromMongo(limit, offset);
    }
  }

  async _getAllFromMongo(limit, offset) {
    const preDocs = await RawArticle.find()
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    const postDocs = await LabelledArticle.find({
      sourceId: { $in: RawArticle.map(d => d._id) }
    }).lean();

    const enrichedMap = Object.fromEntries(
      enrichedDocs.map(e => [e.sourceId.toString(), e.enrichedData])
    );

    return crawledDocs.map(doc => ({
      ...doc,
      enrichedData: enrichedMap[doc._id.toString()] ?? null
    }));
  }

  // -------- DELETE ---------

  async deleteArticle(id) {
    await Promise.allSettled([
      this._deleteFromFile(id),
      this._deleteFromMongo(id)
    ]);
  }

  async _deleteFromFile(id) {
    try {
      await fs.unlink(this.getArticlePath(id));
      logger.info(`[File] Deleted article: ${id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async _deleteFromMongo(id) {
    const crawled = await RawArticle.findOneAndDelete({ sourceId: id });
    if (crawled) {
      await LabelledArticle.deleteOne({ sourceId: crawled._id });
      logger.info(`[MongoDB] Deleted article: ${id}`);
    }
  }

  // -------- EXISTS ---------
  async articleExists(id) {
    try {
      await fs.access(this.getArticlePath(id));
      return true;
    } catch {
      const count = await LabelledArticle.countDocuments({ sourceId: id });
      return count > 0;
    }
  }
}

export default ArticleStorage;