const fs = require('fs').promises;
const path = require('path');
const logger = require('./utils/logger');

class TaggedArticleStorage {
  constructor() {
    // Find project root (where package.json is located)
    const projectRoot = path.join(__dirname, '../../../');
    this.dataDir = path.join(projectRoot, 'data', 'tagged-articles');
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
    return path.join(this.dataDir, `tagged-${id}.json`);
  }

  async saveTaggedArticle(article) {
    try {
      const filePath = this.getArticlePath(article.id);
      await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
      logger.info(`Saved tagged article: ${article.id}`);
      return article;
    } catch (error) {
      logger.error('Failed to save tagged article:', error);
      throw error;
    }
  }

  async getTaggedArticle(id) {
    try {
      const filePath = this.getArticlePath(id);
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      logger.error('Failed to read tagged article:', error);
      throw error;
    }
  }

  async getAllTaggedArticles(limit = 1000, offset = 0) {
    try {
      const files = await fs.readdir(this.dataDir);
      const articleFiles = files.filter(f => f.startsWith('tagged-') && f.endsWith('.json'));
      
      // Sort by modified time (newest first)
      const filesWithStats = await Promise.all(
        articleFiles.map(async (file) => {
          const filePath = path.join(this.dataDir, file);
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
          const filePath = path.join(this.dataDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          return JSON.parse(data);
        })
      );

      return articles;
    } catch (error) {
      logger.error('Failed to get all tagged articles:', error);
      return [];
    }
  }

  async deleteTaggedArticle(id) {
    try {
      const filePath = this.getArticlePath(id);
      await fs.unlink(filePath);
      logger.info(`Deleted tagged article: ${id}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to delete tagged article:', error);
        throw error;
      }
    }
  }
}

module.exports = TaggedArticleStorage;