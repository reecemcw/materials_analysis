// src/db/models/pipelineRun.js
import mongoose from 'mongoose';

const stageSchema = new mongoose.Schema({
  stage:      { type: String, enum: ['scrape', 'label', 'graph'] },
  status:     { type: String, enum: ['success', 'failed', 'skipped'] },
  duration:   { type: Number }, // ms
  startedAt:  { type: Date },
  completedAt:{ type: Date },
  error:      { type: String, default: null }
}, { _id: false });

const pipelineRunSchema = new mongoose.Schema({
  runId:           { type: String, required: true, unique: true },
  startedAt:       { type: Date, required: true },
  completedAt:     { type: Date },
  totalUrls:       { type: Number },
  summary: {
    scraped:  { type: Number, default: 0 },
    labelled: { type: Number, default: 0 },
    graphed:  { type: Number, default: 0 },
    failed:   { type: Number, default: 0 }
  },
  articles: [{
    url:       { type: String },
    articleId: { type: String },
    title:     { type: String },
    stages:    [stageSchema],
    finalStatus: { type: String, enum: ['complete', 'partial', 'failed'] }
  }]
}, { timestamps: true });

export default mongoose.model('PipelineRun', pipelineRunSchema);