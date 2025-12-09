import axios from 'axios';
import { load } from 'cheerio';
import logger from './utils/logger.js';

class ArticleScraper {
  constructor(config = {}) {
    this.config = {
      requestDelay: parseInt(process.env.REQUEST_DELAY) || 2000,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      timeout: 10000,
      userAgent: process.env.USER_AGENT || 'ArticleBot/1.0',
      ...config
    };
    this.lastRequestTime = 0;
  }

  async respectfulDelay() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.config.requestDelay) {
      const waitTime = this.config.requestDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  async checkRobotsTxt(baseUrl) {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).href;
      const response = await axios.get(robotsUrl, {  
        timeout: this.config.timeout,
        headers: { 'User-Agent': this.config.userAgent }
      });
      
      logger.info(`Checked robots.txt for ${baseUrl}`);  
      return response.data;
    } catch (error) {
      logger.warn(`No robots.txt found for ${baseUrl}`);
      return null;
    }
  }

  async fetchUrl(url, retries = 0) {
    await this.respectfulDelay();
    
    try {
      logger.info(`Fetching: ${url}`);
      
      const response = await axios.get(url, {  
        timeout: this.config.timeout,
        headers: {
          'User-Agent': this.config.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      
      return response.data;
    } catch (error) {
      if (retries < this.config.maxRetries) {
        logger.warn(`Retry ${retries + 1}/${this.config.maxRetries} for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (retries + 1)));
        return this.fetchUrl(url, retries + 1);
      }
      
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  parseArticle(html, url) {
    const $ = load(html);
    
    // Remove unwanted elements
    $('script, style, nav, footer, aside, .advertisement').remove();
    
    const article = {
      url: url,
      title: this.extractTitle($),
      author: this.extractAuthor($),
      publishDate: this.extractDate($),
      content: this.extractContent($),
      excerpt: this.extractExcerpt($),
      imageUrl: this.extractImage($, url),
      tags: this.extractTags($),
      scrapedAt: new Date().toISOString()
    };

    return article;
  }

  extractTitle($) {
    return (
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      null
    );
  }

  extractAuthor($) {
    return (
      $('meta[name="author"]').attr('content') ||
      $('[rel="author"]').text().trim() ||
      $('.author-name, .author').first().text().trim() ||
      null
    );
  }

  extractDate($) {
    return (
      $('meta[property="article:published_time"]').attr('content') ||
      $('time').attr('datetime') ||
      $('.publish-date, .date').first().text().trim() ||
      null
    );
  }

  extractContent($) {
    const selectors = [
      'article',
      '.article-content',
      '.post-content',
      '.entry-content',
      'main article',
      '[itemprop="articleBody"]'
    ];

    for (const selector of selectors) {
      const content = $(selector).first();
      if (content.length) {
        return content.text().trim();
      }
    }

    return $('body').text().trim();
  }

  extractExcerpt($) {
    return (
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      null
    );
  }

  extractImage($, baseUrl) {
    const imageUrl = (
      $('meta[property="og:image"]').attr('content') ||
      $('article img').first().attr('src') ||
      $('.featured-image img').first().attr('src')
    );

    if (imageUrl && !imageUrl.startsWith('http')) {
      try {
        return new URL(imageUrl, baseUrl).href;
      } catch {
        return null;
      }
    }

    return imageUrl || null;
  }

  extractTags($) {
    const tags = [];
    $('a[rel="tag"], .tag, .category, [class*="tag"]').each((i, elem) => {
      const tag = $(elem).text().trim();
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    });
    return tags;
  }

  async scrapeArticle(url) {
    try {
      const html = await this.fetchUrl(url);
      const article = this.parseArticle(html, url);
      
      logger.info(`Successfully scraped: ${article.title}`);  
      return { success: true, article };
    } catch (error) {
      logger.error(`Failed to scrape ${url}:`, error);
      return { 
        success: false, 
        error: error.message,
        url 
      };
    }
  }

  async scrapeBatch(urls) {
    const results = [];
    
    // Check robots.txt for first URL's domain
    if (urls.length > 0) {
      const firstUrl = new URL(urls[0]);
      await this.checkRobotsTxt(firstUrl.origin);
    }

    for (const url of urls) {
      const result = await this.scrapeArticle(url);
      results.push(result);
    }

    return results;
  }
}

export default ArticleScraper;