import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import { getRawArticleModel, getLabelledArticleModel } from '../data/models/model_factory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PATHS = {
  raw:    '/data/local/articles',
  labelled: '/data/local/labelled-articles',
};

const PREFIXES = {
  raw:    'article',
  labelled: 'labelled',
};

class Storage {
  constructor() {
    const projectRoot = join(__dirname, '..');
    this.dataDirs = {
      raw:    join(projectRoot, PATHS.raw),
      labelled: join(projectRoot, PATHS.labelled),
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

  async saveRawArticle(article) {
    const [fileResult, mongoResult] = await Promise.allSettled([
        this._saveRawToFile(article),
        this._saveRawToMongo(article),
    ]);

    if (fileResult.status  === 'rejected') logger.error('[Raw] File write failed:', article.id, fileResult.reason);
    if (mongoResult.status === 'rejected') logger.error('[Raw] MongoDB write failed:', article.id, mongoResult.reason);

    if (fileResult.status === 'rejected' && mongoResult.status === 'rejected') {
        throw new Error(`Failed to save raw article ${article.id} to any storage layer`);
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

  // ─── Labelled Articles ──────────────────────────────────────────────────────

	async saveLabelledArticle(article) {
		const [fileResult, mongoResult] = await Promise.allSettled([
			this._saveLabelledToFile(article),
			this._saveLabelledToMongo(article),
		]);

		if (fileResult.status  === 'rejected') logger.error('[Labelled] File write failed:', article.id, fileResult.reason);
		if (mongoResult.status === 'rejected') logger.error('[Labelled] MongoDB write failed:', article.id, mongoResult.reason);

		if (fileResult.status === 'rejected' && mongoResult.status === 'rejected') {
			throw new Error(`Failed to save labelled article ${article.id} to any storage layer`);
		}

		return article;
	}

  async getTaggedArticle(id) {
		try {
			return await this._readFromFile('labelled', id);
		} catch (err) {
			if (err.code !== 'ENOENT') logger.error('[Labelled] File read failed:', err);
			return this._getLabelledFromMongo(id);
		}
	}

  async getAllTaggedArticles(limit = 1000, offset = 0) {
		try {
			const files = await this._getAllFromFiles('labelled', limit, offset);
			if (files.length > 0) return files;
			// Fall through to Mongo if no files exist
			return this._getAllLabelledFromMongo(limit, offset);
		} catch (err) {
			logger.error('[Labelled] File layer failed, falling back to MongoDB:', err);
			return this._getAllLabelledFromMongo(limit, offset);
		}
	}

  async deleteTaggedArticle(id) {
		await Promise.allSettled([
			this._deleteFromFile('labelled', id),
			this._deleteLabelledFromMongo(id),
		]);
	}

  // ─── Shared File Helpers ──────────────────────────────────────────────────

	async _saveRawToFile(article) {
		const filePath = this._getFilePath('raw', article.id);
		await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
		logger.info(`[File][raw] Saved article: ${article.id}`);
		return article;
	}

	async _saveLabelledToFile(article) {
  	console.log('DEBUG saveLabelledToFile:', { 
    id: article?.id, 
    dataDirs: this.dataDirs,
    filePath: this._getFilePath('labelled', article?.id)
  });
		const filePath = this._getFilePath('labelled', article.id);
		await fs.writeFile(filePath, JSON.stringify(article, null, 2), 'utf8');
		logger.info(`[File][labelled] Saved article: ${article.id}`);
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

  // ─── MongoDB Helpers (Labelled only) ───────────────────────────────────────────

  async _saveLabelledToMongo(article) {
    try {
        const LabelledArticle = await getLabelledArticleModel();

        const doc = {
        sourceId:     article.id,
        rawRef:       article.rawRef ?? undefined,
        enrichedData: {
            categories: article.labels?.categories    ?? [],
            topics:     article.labels?.topics        ?? [],
            entities: {
            people:        article.labels?.entities?.people        ?? [],
            organizations: article.labels?.entities?.organizations ?? [],
            locations:     article.labels?.entities?.locations     ?? [],
            products:      article.labels?.entities?.products      ?? [],
            },
            keywords:    article.labels?.keywords    ?? [],
            sentiment:   article.labels?.sentiment   ?? 'neutral',
            summary:     article.labels?.summary     ?? 'Failed to generate summary',
            readingTime: article.labels?.readingTime ?? 'Unknown',
            complexity:  article.labels?.complexity  ?? 'unknown',
            contentType: article.labels?.contentType ?? 'unknown',
            parseError:  article.labels?.parseError  ?? true,
        },
        modelVersion:    article.modelVersion    ?? undefined,
        promptHash:      article.promptHash      ?? undefined,
        pipelineVersion: article.pipelineVersion ?? undefined,
        processedAt:     article.labels?.labelledAt ?? new Date(),
        };

        const result = await LabelledArticle.findOneAndUpdate(
        { sourceId: doc.sourceId },
        { $set: doc },
        { upsert: true, new: true }
        );

        logger.info(`[MongoDB][labelled] Saved article: ${article.id}`);
        return result;

    } catch (err) {
        logger.error(`[MongoDB][labelled] Failed to save article: ${article.id} — ${err.message}`);
        throw err;
    }
	}

	async _getLabelledFromMongo(id) {
		try {
			const LabelledArticle = await getLabelledArticleModel();
			const RawArticle      = await getRawArticleModel();

			const enriched = await LabelledArticle.findOne({ sourceId: id }).lean();
			if (!enriched) return null;

			// Join raw article data so callers get the full picture
			const raw = await RawArticle.findOne({ sourceId: id }).lean();

			return {
				id:          enriched.sourceId,
				title:       raw?.title       ?? null,
				url:         raw?.sourceUrl   ?? null,
				author:      raw?.author      ?? null,
				publishDate: raw?.publishDate ?? null,
				content:     raw?.content     ?? null,
				excerpt:     raw?.excerpt     ?? null,
				labels:      enriched.enrichedData,
				processedAt: enriched.processedAt,
			};
		} catch (err) {
			logger.error('[MongoDB] Read failed for labelled article:', id, err);
			return null;
		}
	}

	async _getAllLabelledFromMongo(limit, offset) {
		try {
			const LabelledArticle = await getLabelledArticleModel();
			const RawArticle      = await getRawArticleModel();

			const enrichedDocs = await LabelledArticle.find()
				.sort({ processedAt: -1 })
				.skip(offset)
				.limit(limit)
				.lean();

			if (enrichedDocs.length === 0) return [];

			// Batch fetch matching raw articles
			const rawDocs = await RawArticle.find({
				sourceId: { $in: enrichedDocs.map(d => d.sourceId) },
			}).lean();

			const rawMap = Object.fromEntries(rawDocs.map(r => [r.sourceId, r]));

			return enrichedDocs.map(enriched => ({
				id:          enriched.sourceId,
				title:       rawMap[enriched.sourceId]?.title       ?? null,
				url:         rawMap[enriched.sourceId]?.sourceUrl   ?? null,
				author:      rawMap[enriched.sourceId]?.author      ?? null,
				publishDate: rawMap[enriched.sourceId]?.publishDate ?? null,
				content:     rawMap[enriched.sourceId]?.content     ?? null,
				excerpt:     rawMap[enriched.sourceId]?.excerpt     ?? null,
				labels:      enriched.enrichedData,
				processedAt: enriched.processedAt,
			}));
		} catch (err) {
			logger.error('[MongoDB] Failed to get all labelled articles:', err);
			return [];
		}
	}

	async _deleteLabelledFromMongo(id) {
		const LabelledArticle = await getLabelledArticleModel();
		await LabelledArticle.deleteOne({ sourceId: id });
		logger.info(`[MongoDB][labelled] Deleted article: ${id}`);
	}
}

export default Storage;