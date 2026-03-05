/**
 * migrate-urls.mjs
 *
 * One-time migration: seeds the MongoDB urls collection from url.json.
 * Safe to re-run — uses upsert so existing docs are never duplicated.
 *
 * Usage:
 *   node scripts/migrate-urls.mjs
 *   node scripts/migrate-urls.mjs --dry-run
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const projectRoot = join(__dirname, '..');

dotenv.config({ path: join(projectRoot, '.env') });

// ─── Inline model bootstrap (avoids circular import issues in scripts) ────────

import mongoose from 'mongoose';

const urlRegistrySchema = new mongoose.Schema({
  url:           { type: String, required: true, unique: true, trim: true },
  label:         { type: String, default: '' },
  frequency:     { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'daily' },
  active:        { type: Boolean, default: true },
  lastScraped:   { type: Date, default: null },
  notes:         { type: String, default: '' },
  discoveredAt:  { type: Date, default: null },
  discoveredFrom:{ type: String, default: null },
  sourceType:    { type: String, enum: ['rss', 'sitemap', 'manual', null], default: null },
  publishedAt:   { type: Date, default: null },
}, { timestamps: true });

const dryRun = process.argv.includes('--dry-run');

async function migrate() {
  // ── Load url.json ────────────────────────────────────────────────────────────
  const urlJsonPath = join(projectRoot, 'url.json');
  let urlJson;
  try {
    urlJson = JSON.parse(await readFile(urlJsonPath, 'utf8'));
  } catch (err) {
    console.error(`❌ Could not read url.json at ${urlJsonPath}:`, err.message);
    process.exit(1);
  }

  const urls = urlJson.urls || [];
  if (urls.length === 0) {
    console.log('⚠️  url.json contains no URLs — nothing to migrate.');
    process.exit(0);
  }

  console.log(`\n📋 Found ${urls.length} URLs in url.json`);
  if (dryRun) console.log('🔍 DRY RUN — no writes will be made\n');

  // ── Connect ──────────────────────────────────────────────────────────────────
  const baseUri = process.env.MONGODB_URI;
  if (!baseUri) {
    console.error('❌ MONGODB_URI not set in .env');
    process.exit(1);
  }

  const uri = baseUri.replace(/\/?$/, '/urls');

  if (!dryRun) {
    await mongoose.connect(uri);
    console.log(`✅ Connected to MongoDB: ${uri}\n`);
  }

  const UrlRegistry = dryRun
    ? null
    : mongoose.model('UrlRegistry', urlRegistrySchema, 'urls');

  // ── Upsert each URL ──────────────────────────────────────────────────────────
  let inserted = 0;
  let updated  = 0;
  let skipped  = 0;

  for (const entry of urls) {
    if (!entry.url) {
      console.warn(`  ⚠️  Skipping entry with no URL:`, entry);
      skipped++;
      continue;
    }

    const doc = {
      url:         entry.url.trim(),
      label:       entry.label       || '',
      frequency:   entry.frequency   || 'daily',
      active:      entry.active      ?? true,
      lastScraped: entry.lastScraped ? new Date(entry.lastScraped) : null,
      notes:       entry.notes       || '',
      // Discovery metadata from url.json (if present)
      discoveredAt:   entry._discoveredAt   ? new Date(entry._discoveredAt)   : null,
      discoveredFrom: entry._discoveredFrom || null,
      sourceType:     entry._sourceType     || 'manual',
      publishedAt:    entry._publishedAt    ? new Date(entry._publishedAt)    : null,
    };

    if (dryRun) {
      console.log(`  → Would upsert: ${doc.url} (${doc.label})`);
      inserted++;
      continue;
    }

    const result = await UrlRegistry.findOneAndUpdate(
      { url: doc.url },
      { $setOnInsert: doc },   // only set fields on first insert — never overwrite lastScraped etc.
      { upsert: true, new: true, rawResult: true }
    );

    if (result.lastErrorObject?.updatedExisting) {
      console.log(`  ↩️  Already exists: ${doc.url}`);
      updated++;
    } else {
      console.log(`  ✅ Inserted: ${doc.url} (${doc.label})`);
      inserted++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n=== Migration complete ===');
  console.log(`  Inserted: ${inserted}`);
  if (!dryRun) console.log(`  Already existed: ${updated}`);
  console.log(`  Skipped:  ${skipped}`);

  if (!dryRun) await mongoose.disconnect();
  console.log('\nDone.\n');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
