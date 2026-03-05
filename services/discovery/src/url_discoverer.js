/**
 * URL Discoverer
 *
 * Discovers new article URLs from two sources:
 *   1. RSS / Atom feeds
 *   2. XML sitemaps (including sitemap index files)
 *
 * Discovered URL shape:
 * {
 *   url:          string
 *   label:        string | null
 *   sourceType:   'rss' | 'sitemap'
 *   sourceFeed:   string
 *   publishedAt:  string | null  (ISO)
 * }
 */

import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import logger from '../../../utils/logger.js';

// ─── HTTP client ───────────────────────────────────────────────────────────────

const http = axios.create({
  timeout: 15_000,
  headers: {
    'User-Agent': process.env.USER_AGENT || 'ArticleBot/1.0 (materials-analysis-discovery)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  },
});

async function fetchXml(url) {
  const response = await http.get(url);
  return parseStringPromise(response.data, {
    explicitArray: false,
    ignoreAttrs: false,
    mergeAttrs: true,
  });
}

// ─── RSS / Atom ────────────────────────────────────────────────────────────────

export async function discoverFromFeed(feedUrl) {
  logger.info(`[Discoverer] Fetching feed: ${feedUrl}`);

  let parsed;
  try {
    parsed = await fetchXml(feedUrl);
  } catch (err) {
    logger.error(`[Discoverer] Feed fetch failed (${feedUrl}): ${err.message}`);
    return [];
  }

  const discovered = [];

  // RSS 2.0
  const channel = parsed?.rss?.channel;
  if (channel) {
    const items = toArray(channel.item);
    for (const item of items) {
      const url = item.link || item.guid?._ || item.guid;
      if (!isValidHttpUrl(url)) continue;
      discovered.push({
        url: normaliseUrl(url),
        label: item.title || url,
        sourceType: 'rss',
        sourceFeed: feedUrl,
        publishedAt: parseDate(item.pubDate || item['dc:date']) ?? null,
      });
    }
    logger.info(`[Discoverer] RSS: found ${discovered.length} items in ${feedUrl}`);
    return discovered;
  }

  // Atom
  const feed = parsed?.feed;
  if (feed) {
    const entries = toArray(feed.entry);
    for (const entry of entries) {
      const links = toArray(entry.link);
      const altLink = links.find(l => !l.rel || l.rel === 'alternate') ?? links[0];
      const url = altLink?.href || altLink;
      if (!isValidHttpUrl(url)) continue;
      discovered.push({
        url: normaliseUrl(url),
        label: entry.title?._ || entry.title || url,
        sourceType: 'rss',
        sourceFeed: feedUrl,
        publishedAt: parseDate(entry.published || entry.updated) ?? null,
      });
    }
    logger.info(`[Discoverer] Atom: found ${discovered.length} entries in ${feedUrl}`);
    return discovered;
  }

  logger.warn(`[Discoverer] Unrecognised feed format at ${feedUrl}`);
  return [];
}

// ─── Sitemap ───────────────────────────────────────────────────────────────────

export async function discoverFromSitemap(sitemapUrl, { maxDepth = 2, depth = 0 } = {}) {
  logger.info(`[Discoverer] Fetching sitemap${depth > 0 ? ` (depth ${depth})` : ''}: ${sitemapUrl}`);

  let parsed;
  try {
    parsed = await fetchXml(sitemapUrl);
  } catch (err) {
    logger.error(`[Discoverer] Sitemap fetch failed (${sitemapUrl}): ${err.message}`);
    return [];
  }

  // Sitemap index — recurse into children
  const index = parsed?.sitemapindex;
  if (index) {
    if (depth >= maxDepth) {
      logger.warn(`[Discoverer] Sitemap index depth limit reached at ${sitemapUrl}`);
      return [];
    }
    const childSitemaps = toArray(index.sitemap).map(s => s.loc).filter(Boolean);
    logger.info(`[Discoverer] Sitemap index: ${childSitemaps.length} child sitemaps`);
    const nested = await Promise.all(
      childSitemaps.map(child => discoverFromSitemap(child, { maxDepth, depth: depth + 1 }))
    );
    return nested.flat();
  }

  // Urlset — leaf sitemap with actual URLs
  const urlset = parsed?.urlset;
  if (urlset) {
    const entries = toArray(urlset.url);
    const discovered = [];
    for (const entry of entries) {
      const url = entry.loc;
      if (!isValidHttpUrl(url)) continue;
      discovered.push({
        url: normaliseUrl(url),
        label: null,
        sourceType: 'sitemap',
        sourceFeed: sitemapUrl,
        publishedAt: parseDate(entry.lastmod) ?? null,
      });
    }
    logger.info(`[Discoverer] Sitemap: found ${discovered.length} URLs in ${sitemapUrl}`);
    return discovered;
  }

  logger.warn(`[Discoverer] Unrecognised sitemap format at ${sitemapUrl}`);
  return [];
}

// ─── Auto-detect feeds and sitemaps from a homepage ───────────────────────────

export async function autoDiscover(siteUrl) {
  const base = new URL(siteUrl);
  const result = { feeds: [], sitemaps: [] };

  try {
    const { data: html } = await http.get(siteUrl, { headers: { Accept: 'text/html' } });

    const linkRe = /<link[^>]+>/gi;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const tag = match[0];
      if (/rel=["']alternate["']/i.test(tag) && /type=["'][^"']*(?:rss|atom)[^"']*["']/i.test(tag)) {
        const href = extractHref(tag, base);
        if (href) result.feeds.push(href);
      }
      if (/rel=["']sitemap["']/i.test(tag)) {
        const href = extractHref(tag, base);
        if (href) result.sitemaps.push(href);
      }
    }
  } catch (err) {
    logger.warn(`[Discoverer] HTML fetch failed for ${siteUrl}: ${err.message}`);
  }

  // Fallback to well-known paths if nothing found in HTML
  if (result.feeds.length === 0) {
    for (const path of ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml']) {
      const url = new URL(path, base).href;
      if (await isReachable(url, ['application/rss', 'application/atom', 'text/xml', 'application/xml'])) {
        result.feeds.push(url);
        break;
      }
    }
  }

  if (result.sitemaps.length === 0) {
    for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']) {
      const url = new URL(path, base).href;
      if (await isReachable(url, ['application/xml', 'text/xml'])) {
        result.sitemaps.push(url);
        break;
      }
    }
  }

  logger.info(
    `[Discoverer] Auto-discover for ${siteUrl}: ${result.feeds.length} feeds, ${result.sitemaps.length} sitemaps`
  );
  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normaliseUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractHref(tag, base) {
  const m = /href=["']([^"']+)["']/i.exec(tag);
  if (!m) return null;
  try {
    return new URL(m[1], base).href;
  } catch {
    return null;
  }
}

async function isReachable(url, acceptedContentTypes = []) {
  try {
    const res = await http.head(url, { timeout: 5000 });
    if (res.status < 200 || res.status >= 400) return false;
    if (acceptedContentTypes.length === 0) return true;
    const ct = res.headers['content-type'] || '';
    return acceptedContentTypes.some(t => ct.includes(t));
  } catch {
    return false;
  }
}