import mongoose from 'mongoose';
import { getArticlesDB, getPipelineRunsDB, getGraphDB } from '../connection.js';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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


// ─── Graph Snapshot Schema ────────────────────────────────────────────────────

const graphSnapshotSchema = new mongoose.Schema({
  version: {
    type:     Number,
    required: true,
    unique:   true,
  },
  triggerReason: {
    type: String,
    enum: ['pipeline_run', 'manual', 'scheduled', 'startup_recovery'],
    required: true,
  },
  runId: {
    type:    String,
    default: null,   // links back to pipelineRun.runId when triggered by a pipeline
  },
  stats: {
    nodeCount: { type: Number, required: true },
    edgeCount: { type: Number, required: true },
  },
  graph: {
    nodes:     { type: mongoose.Schema.Types.Mixed, required: true }, // serialised Map entries
    edges:     { type: mongoose.Schema.Types.Mixed, required: true },
    nodeEdges: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  checksum: {
    type:     String,
    required: true,   // SHA-256 of JSON.stringify(graph)
  },
  localPath: {
    type:    String,
    default: null,    // absolute path of the local graph.json at time of snapshot
  },
}, { timestamps: true });

graphSnapshotSchema.index({ version: -1 });
graphSnapshotSchema.index({ triggerReason: 1 });
graphSnapshotSchema.index({ createdAt: -1 });

// ─── Article Registry Schema ─────────────────────────────────────
const urlRegistrySchema = new mongoose.Schema({
  url: {
    type:     String,
    required: true,
    unique:   true,
    trim:     true,
  },
  label: {
    type:    String,
    default: '',
  },
  frequency: {
    type:    String,
    enum:    ['daily', 'weekly', 'monthly'],
    default: 'daily',
  },
  active: {
    type:    Boolean,
    default: true,
  },
  lastScraped: {
    type:    Date,
    default: null,
  },
  notes: {
    type:    String,
    default: '',
  },
  // Discovery metadata — populated by discovery service, null for manually added URLs
  discoveredAt: {
    type:    Date,
    default: null,
  },
  discoveredFrom: {
    type:    String,   // base URL of the source that led to discovery
    default: null,
  },
  sourceType: {
    type:    String,
    enum:    ['rss', 'sitemap', 'manual', null],
    default: null,
  },
  publishedAt: {
    type:    Date,
    default: null,
  },
}, { timestamps: true });  // adds createdAt + updatedAt automatically

urlRegistrySchema.index({ active: 1, frequency: 1 });   // scheduler query
urlRegistrySchema.index({ url: 1 }, { unique: true });   // dedup lookups
urlRegistrySchema.index({ lastScraped: 1 });             // due-for-scrape queries
urlRegistrySchema.index({ discoveredAt: -1 });           // discovery audit

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

export const getGraphSnapshotModel = async () => {
  const conn = await getGraphDB();   // see connection.js addition below
  return getModel(conn, 'GraphSnapshot', graphSnapshotSchema, 'snapshots');
};

export const computeChecksum = (graphData) => {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(graphData))
    .digest('hex');
};

export const getUrlRegistryModel = async () => {
  const conn = await getArticlesDB();
  return getModel(conn, 'UrlRegistry', urlRegistrySchema, 'urls');
};