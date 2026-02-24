import mongoose from 'mongoose';  

const rawArticleSchema = new mongoose.Schema({
  url: { type: String, required: true },
  title: { type: String, required: true },
  author: { type: String },
  publishDate: { type: Date },
  content: { type: String, required: true },
  excerpt: { type: String },
  imageUrl: { type: String },
  tags: { type: [String] },
  scrapedAt: { type: Date, default: Date.now, required: true },
}, { timestamps: true });

export default mongoose.model('RawArticle', rawArticleSchema);