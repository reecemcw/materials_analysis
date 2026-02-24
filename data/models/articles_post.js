import mongoose from 'mongoose';
import os from 'os';

const labelledArticleSchema = new mongoose.Schema({
  sourceId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'RawArticle', 
    required: true 
  },
  enrichedData: {
    categories:     { type: [String], default: [] },
    topics:         { type: [String], default: [] },
    entities: {
      people:        { type: [String], default: [] },
      organizations: { type: [String], default: [] },
      locations:     { type: [String], default: [] },
      products:      { type: [String], default: [] }
    },
    keywords:       { type: [String], default: [] },
    sentiment:      { type: String, enum: ['positive', 'negative', 'neutral', 'mixed'], default: 'neutral' },
    summary:        { type: String, default: 'Failed to generate summary' },
    readingTime:    { type: String, default: 'Unknown' },
    complexity:     { type: String, enum: ['low', 'medium', 'high', 'unknown'], default: 'unknown' },
    contentType:    { type: String, default: 'unknown' },
    parseError:     { type: Boolean, default: true }
  },
  modelVersion:    { type: String, required: true },
  promptHash:      { type: String },
  processedAt:     { type: Date, default: Date.now },
  pipelineVersion: { type: String, required: true }
}, { timestamps: true });

labelledArticleSchema.index({ sourceId: 1 });
labelledArticleSchema.index({ modelVersion: 1, pipelineVersion: 1 });

// Useful observability indexes given enriched fields
labelledArticleSchema.index({ 'enrichedData.sentiment': 1 });
labelledArticleSchema.index({ 'enrichedData.parseError': 1 });
labelledArticleSchema.index({ 'enrichedData.categories': 1 });

export default mongoose.model('LabelledArticle', labelledArticleSchema);