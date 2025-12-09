import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';

// Create __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ArticleStorage {
  constructor() {
    const projectRoot = join(__dirname, '../../..');
    this.dataDir = join(projectRoot, 'data', 'articles');
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

  async saveArticle(article) {
    try {
      const filePath = this.getArticlePath(article.id);
      await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
      logger.info(`Saved article: ${article.id}`);
      return article;
    } catch (error) {
      logger.error('Failed to save article:', error);
      throw error;
    }
  }

  async getArticle(id) {
    try {
      const filePath = this.getArticlePath(id);
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      logger.error('Failed to read article:', error);
      throw error;
    }
  }

  async getAllArticles(limit = 50, offset = 0) {
    try {
      const files = await fs.readdir(this.dataDir);
      const articleFiles = files.filter(f => f.startsWith('article-') && f.endsWith('.json'));

      // Sort by modified time (newest first)
      const filesWithStats = await Promise.all(
        articleFiles.map(async (file) => {
          const filePath = join(this.dataDir, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime };
        })
      );

      filesWithStats.sort((a, b) => b.mtime - a.mtime);

      // Apply pagination
      const paginatedFiles = filesWithStats
        .slice(offset, offset + limit)
        .map(item => item.file);

      // Read articles
      const articles = await Promise.all(
        paginatedFiles.map(async (file) => {
          const filePath = join(this.dataDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          return JSON.parse(data);
        })
      );

      return articles;
    } catch (error) {
      logger.error('Failed to get all articles:', error);
      throw error;
    }
  }

  async deleteArticle(id) {
    try {
      const filePath = this.getArticlePath(id);
      await fs.unlink(filePath);
      logger.info(`Deleted article: ${id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to delete article:', error);
        throw error;
      }
    }
  }

  async articleExists(id) {
    try {
      await fs.access(this.getArticlePath(id));
      return true;
    } catch {
      return false;
    }
  }
}

export default ArticleStorage;