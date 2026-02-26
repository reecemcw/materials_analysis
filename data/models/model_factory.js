import mongoose from 'mongoose';
import { getArticlesDB, getPipelineRunsDB } from '../connection.js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

// ─── Schemas ──────────────────────────────────────────────────────────────────

const rawArticleSchema = new mongoose.Schema({
  sourceId:    { type: String, required: true, unique: true },
  sourceUrl:   { type: String, required: true },
  title:       { type: String },
  author:      { type: String },
  publishDate: { type: String },
  content:     { type: String },
  excerpt:     { type: String },
  imageUrl:    { type: String },
  tags:        { type: [String], default: [] },
  scrapedAt:   { type: Date },
  status: {
    type:    String,
    enum:    ['pending', 'processing', 'enriched', 'failed'],
    default: 'pending'
  }
}, { timestamps: true });

const labelledArticleSchema = new mongoose.Schema({
  sourceId: {
    type:     String,
    required: true,
    unique:   true
  },
  rawRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'RawArticle'
  },
  enrichedData: {
    categories: { type: [String], default: [] },
    topics:     { type: [String], default: [] },
    entities: {
      people:        { type: [String], default: [] },
      organizations: { type: [String], default: [] },
      locations:     { type: [String], default: [] },
      products:      { type: [String], default: [] }
    },
    keywords:    { type: [String], default: [] },
    sentiment:   { type: String, enum: ['positive', 'negative', 'neutral', 'mixed'], default: 'neutral' },
    summary:     { type: String, default: 'Failed to generate summary' },
    readingTime: { type: String, default: 'Unknown' },
    complexity:  { type: String, enum: ['low', 'medium', 'high', 'unknown'], default: 'unknown' },
    contentType: { type: String, default: 'unknown' },
    parseError:  { type: Boolean, default: true }
  },
  modelVersion:    { type: String },
  promptHash:      { type: String },
  pipelineVersion: { type: String },
  processedAt:     { type: Date, default: Date.now }
}, { timestamps: true });

labelledArticleSchema.index({ sourceId: 1 });
labelledArticleSchema.index({ 'enrichedData.sentiment': 1 });
labelledArticleSchema.index({ 'enrichedData.parseError': 1 });
labelledArticleSchema.index({ 'enrichedData.categories': 1 });

const stageSchema = new mongoose.Schema({
  stage:       { type: String, enum: ['scrape', 'label', 'graph'] },
  status:      { type: String, enum: ['success', 'failed', 'skipped'] },
  duration:    { type: Number },
  startedAt:   { type: Date },
  completedAt: { type: Date },
  error:       { type: String, default: null }
}, { _id: false });

const pipelineRunSchema = new mongoose.Schema({
  runId:       { type: String, required: true, unique: true },
  startedAt:   { type: Date, required: true },
  completedAt: { type: Date },
  totalUrls:   { type: Number },
  summary: {
    scraped:  { type: Number, default: 0 },
    labelled: { type: Number, default: 0 },
    graphed:  { type: Number, default: 0 },
    failed:   { type: Number, default: 0 }
  },
  articles: [{
    url:         { type: String },
    articleId:   { type: String },
    title:       { type: String },
    stages:      [stageSchema],
    finalStatus: { type: String, enum: ['complete', 'partial', 'failed'] }
  }]
}, { timestamps: true });

// ─── Model Factory ────────────────────────────────────────────────────────────

const ENV = process.env.NODE_ENV || 'test'; // 'test' | 'stage' | 'prod'

const modelCache = {};

const getModel = (conn, name, schema, collection) => {
  const key = `${conn.name}:${name}`;
  if (!modelCache[key]) {
    modelCache[key] = conn.model(name, schema, collection);
  }
  return modelCache[key];
};

export const getRawArticleModel = async () => {
  const conn = await getArticlesDB();
  return getModel(conn, 'RawArticle', rawArticleSchema, 'raw');
};

export const getLabelledArticleModel = async () => {
  const conn = await getArticlesDB();
  return getModel(conn, 'LabelledArticle', labelledArticleSchema, 'labelled');
};

export const getPipelineRunModel = async () => {
  const conn = await getPipelineRunsDB();
  return getModel(conn, 'PipelineRun', pipelineRunSchema, ENV); // collection = test | stage | prod
};