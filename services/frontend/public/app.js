/**
 * Material Risk Analysis - Frontend Application
 */

// ===================================
// Sidebar Navigation
// ===================================

class SidebarNav {
  constructor() {
    this.navLinks = document.querySelectorAll('.nav-link');
    this.pages = document.querySelectorAll('.page');
    this.init();
  }

  init() {
    this.navLinks.forEach(link => {
      link.addEventListener('click', () => {
        const targetPage = link.dataset.page;
        this.navigateTo(targetPage);
      });
    });
  }

  navigateTo(pageId) {
    // Update nav links
    this.navLinks.forEach(link => {
      link.classList.toggle('active', link.dataset.page === pageId);
    });

    // Update pages
    this.pages.forEach(page => {
      const isTarget = page.id === `page-${pageId}`;
      page.classList.toggle('active', isTarget);
    });
  }
}


// ===================================
// Main App
// ===================================

class MaterialRiskApp {
  constructor() {
    this.articles = [];
    this.init();
  }

  async init() {
    this.setupEventListeners();
    await Promise.all([this.loadArticles(), this.loadGraphVersion()]);
  }

  setupEventListeners() {
    const submitButton = document.getElementById('submit-query');
    const queryInput = document.getElementById('query-input');

    submitButton.addEventListener('click', () => this.handleQuery());

    // Allow Shift+Enter to submit
    queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        this.handleQuery();
      }
    });
  }

  async loadGraphVersion() {
    const badge = document.getElementById('kg-version-badge');
    if (!badge) return;
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error();
      const data = await res.json();
      const nodes = data.stats?.graphNodes;
      const edges = data.stats?.graphEdges;
      if (nodes !== undefined) {
        badge.textContent = `knowledge-graph · ${nodes.toLocaleString()} nodes`;
        badge.title = `${nodes.toLocaleString()} nodes · ${(edges || 0).toLocaleString()} edges`;
      }
    } catch {
      // leave default text in place
    }
  }


  async loadArticles() {
    const tbody = document.getElementById('articles-tbody');

    try {
      const response = await fetch('http://localhost:3002/api/tagged?limit=50');

      if (!response.ok) {
        throw new Error('Failed to load articles');
      }

      const data = await response.json();
      this.articles = data.taggedArticles || data.articles || [];

      // Sort by date descending (newest first)
      this.articles.sort((a, b) => {
        const dateA = new Date(a.publishDate || a.scrapedAt || 0);
        const dateB = new Date(b.publishDate || b.scrapedAt || 0);
        return dateB - dateA;
      });

      if (this.articles.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="6">
              <div class="empty-state">
                <p>No articles available yet.</p>
                <p class="text-muted text-small">Start by scraping and labelling some articles.</p>
              </div>
            </td>
          </tr>
        `;
        return;
      }

      this.renderArticles();
    } catch (error) {
      console.error('Error loading articles:', error);
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">
            <div class="empty-state">
              <p>Failed to load articles</p>
              <p class="text-muted text-small">${error.message}</p>
            </div>
          </td>
        </tr>
      `;
    }
  }

  renderArticles() {
    const tbody = document.getElementById('articles-tbody');
    tbody.innerHTML = '';
    this.articles.forEach(article => {
      const row = this.createArticleRow(article);
      tbody.appendChild(row);
    });
  }

  createArticleRow(article) {
    const row = document.createElement('tr');

    const imageUrl = article.imageUrl;
    const date = this.formatDate(article.publishDate || article.scrapedAt);
    const publisher = this.extractPublisher(article.url);
    const title = article.title || 'Untitled';
    const tags = article.labels?.categories || article.labels?.topics || [];
    const url = article.url;

    // Organizations — handle array or nested object
    const orgs = article.labels?.entities?.organizations || [];

    // Sentiment — handle string ("positive") or object ({ label: "positive", score: 0.9 })
    const rawSentiment = article.labels?.sentiment;
    const sentimentLabel = typeof rawSentiment === 'string'
      ? rawSentiment.toLowerCase()
      : (rawSentiment?.label || rawSentiment?.value || '').toLowerCase();

    // --- Image cell (larger, rectangular card style) ---
    const imageCell = document.createElement('td');
    imageCell.className = 'td-image';
    if (imageUrl) {
      imageCell.innerHTML = `
        <img src="${imageUrl}" alt="" class="article-image"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="article-image-placeholder" style="display:none;">${title.charAt(0).toUpperCase()}</div>`;
    } else {
      imageCell.innerHTML = `<div class="article-image-placeholder">${title.charAt(0).toUpperCase()}</div>`;
    }

    // --- Date ---
    const dateCell = document.createElement('td');
    dateCell.innerHTML = `<span class="article-date">${date}</span>`;

    // --- Publisher ---
    const publisherCell = document.createElement('td');
    publisherCell.innerHTML = `<span class="article-publisher">${publisher}</span>`;

    // --- Title ---
    const titleCell = document.createElement('td');
    titleCell.innerHTML = `<a href="${url}" target="_blank" class="article-title-link">
      <span class="article-title">${title}</span>
    </a>`;

    // --- Organizations ---
    const orgsCell = document.createElement('td');
    if (orgs.length > 0) {
      const orgsHtml = orgs.slice(0, 3).map(org =>
        `<span class="org-tag">${org}</span>`
      ).join('');
      orgsCell.innerHTML = `<div class="article-orgs">${orgsHtml}</div>`;
    } else {
      orgsCell.innerHTML = `<span class="article-author">—</span>`;
    }

    // --- Tags ---
    const tagsCell = document.createElement('td');
    const tagsHtml = tags.slice(0, 3).map(tag =>
      `<span class="tag">${tag}</span>`
    ).join('');
    tagsCell.innerHTML = `<div class="article-tags">${tagsHtml || '—'}</div>`;

    // --- Sentiment ---
    const sentimentCell = document.createElement('td');
    sentimentCell.innerHTML = sentimentLabel
      ? `<span class="sentiment-badge sentiment-${sentimentLabel}">${sentimentLabel}</span>`
      : `<span class="article-author">—</span>`;

    row.appendChild(imageCell);
    row.appendChild(dateCell);
    row.appendChild(publisherCell);
    row.appendChild(titleCell);
    row.appendChild(orgsCell);
    row.appendChild(tagsCell);
    row.appendChild(sentimentCell);

    return row;
  }

  formatDate(dateString) {
    if (!dateString) return '—';

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffTime = Math.abs(now - date);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays} days ago`;
      if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;

      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      });
    } catch (e) {
      return '—';
    }
  }

  extractPublisher(url) {
    try {
      const urlObj = new URL(url);
      let hostname = urlObj.hostname;
      hostname = hostname.replace(/^www\./, '');
      const parts = hostname.split('.');
      if (parts.length > 0) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
      return hostname;
    } catch (e) {
      return '—';
    }
  }

  async handleQuery() {
    const queryInput = document.getElementById('query-input');
    const responseContainer = document.getElementById('query-response');
    const submitButton = document.getElementById('submit-query');

    const query = queryInput.value.trim();
    if (!query) return;

    submitButton.disabled = true;
    submitButton.innerHTML = `<div class="loading-spinner" style="width:15px;height:15px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:rgba(255,255,255,0.9);"></div>`;

    responseContainer.innerHTML = `
      <div class="response-loading">
        <div class="loading-spinner"></div>
        <span>🔍 Searching knowledge base and generating answer...</span>
      </div>
    `;

    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxSources: 5 })
      });

      if (!response.ok) throw new Error('Failed to process query');

      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Query failed');

      this.displayRAGResponse(data);
    } catch (error) {
      console.error('RAG query error:', error);
      responseContainer.innerHTML = `
        <div class="error-message">
          <strong>⚠️ Error:</strong> ${error.message}
          <p class="text-muted text-small" style="margin-top: 0.5rem;">
            Make sure all services are running and the Anthropic API key is configured.
          </p>
        </div>
      `;
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 13V3M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
  }

  displayRAGResponse(data) {
    const responseContainer = document.getElementById('query-response');
    const { answer, sources, metadata } = data;

    const formattedAnswer = answer
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    const sourcesHTML = sources && sources.length > 0 ? `
      <div class="sources-section">
        <h4>📚 Sources (${sources.length})</h4>
        <div class="sources-list">
          ${sources.map((source, idx) => `
            <div class="source-item">
              <div class="source-header">
                <span class="source-number">${idx + 1}</span>
                <a href="${source.url}" target="_blank" class="source-title">${source.title}</a>
                ${source.relevanceScore ? `<span class="relevance-badge">Score: ${source.relevanceScore}</span>` : ''}
              </div>
              ${source.summary ? `<p class="source-summary">${source.summary}</p>` : ''}
              <div class="source-meta">
                ${source.categories?.length ? `<span class="meta-item">📁 ${source.categories.join(', ')}</span>` : ''}
                ${source.topics?.length ? `<span class="meta-item">🏷️ ${source.topics.slice(0, 3).join(', ')}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '<p class="text-muted">No specific sources found for this query.</p>';

    const metadataHTML = metadata ? `
      <div class="query-metadata">
        <span>Searched ${metadata.totalArticlesSearched} articles</span>
        <span>•</span>
        <span>Used ${metadata.sourcesUsed} sources</span>
        <span>•</span>
        <span>${new Date(metadata.timestamp).toLocaleTimeString()}</span>
      </div>
    ` : '';

    responseContainer.innerHTML = `
      <div class="rag-response">
        <div class="answer-section">
          <h3 class="response-title">💡 Answer</h3>
          <div class="answer-text"><p>${formattedAnswer}</p></div>
        </div>
        ${sourcesHTML}
        ${metadataHTML}
      </div>
    `;
  }
}

// ===================================
// Boot
// ===================================

document.addEventListener('DOMContentLoaded', () => {
  new SidebarNav();
  new MaterialRiskApp();
});