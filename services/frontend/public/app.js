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
    this.navLinks.forEach(link => {
      link.classList.toggle('active', link.dataset.page === pageId);
    });
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

    queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        this.handleQuery();
      }
    });
  }

  typewriterAnimate(el, text) {
    if (!el) return;
    el.textContent = '';
    const BASE_DELAY = 38;
    const JITTER = 28;
    let cumulative = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let charDelay = BASE_DELAY + Math.random() * JITTER;
      if (ch === ' ')                             charDelay += 60;
      if (ch === '.' || ch === ',' || ch === '!') charDelay += 90;
      if (ch === '…')                             charDelay += 140;
      cumulative += charDelay;
      const snapshot = cumulative;
      setTimeout(() => { if (el.isConnected) el.textContent += ch; }, snapshot);
    }
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
      // leave default text
    }
  }

  async loadArticles() {
    const tbody = document.getElementById('articles-tbody');

    try {
      const response = await fetch('api/recent?limit=200');
      if (!response.ok) throw new Error('Failed to load articles');

      const data = await response.json();
      this.articles = data.taggedArticles || data.articles || [];

      this.articles.sort((a, b) => {
        const safeDate = v => { const d = new Date(v); return isNaN(d.getTime()) ? 0 : d.getTime(); };
        return safeDate(b.processedAt) - safeDate(a.processedAt);
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
    const date = this.formatDate(article.processedAt);
    const publisher = this.extractPublisher(article.url);
    const title = article.title || 'Untitled';
    const tags = article.labels?.categories || article.labels?.topics || [];
    const url = article.url;
    const orgs = article.labels?.entities?.organizations || [];

    const rawSentiment = article.labels?.sentiment;
    const sentimentLabel = typeof rawSentiment === 'string'
      ? rawSentiment.toLowerCase()
      : (rawSentiment?.label || rawSentiment?.value || '').toLowerCase();

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

    const dateCell = document.createElement('td');
    dateCell.innerHTML = `<span class="article-date">${date}</span>`;

    const publisherCell = document.createElement('td');
    publisherCell.innerHTML = `<span class="article-publisher">${publisher}</span>`;

    const titleCell = document.createElement('td');
    titleCell.innerHTML = `<a href="${url}" target="_blank" class="article-title-link">
      <span class="article-title">${title}</span>
    </a>`;

    const orgsCell = document.createElement('td');
    if (orgs.length > 0) {
      const orgsHtml = orgs.slice(0, 3).map(org =>
        `<span class="org-tag">${org}</span>`
      ).join('');
      orgsCell.innerHTML = `<div class="article-orgs">${orgsHtml}</div>`;
    } else {
      orgsCell.innerHTML = `<span class="article-author">—</span>`;
    }

    const tagsCell = document.createElement('td');
    const tagsHtml = tags.slice(0, 3).map(tag =>
      `<span class="tag">${tag}</span>`
    ).join('');
    tagsCell.innerHTML = `<div class="article-tags">${tagsHtml || '—'}</div>`;

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
    const queryInput        = document.getElementById('query-input');
    const responseContainer = document.getElementById('query-response');
    const submitButton      = document.getElementById('submit-query');

    const query = queryInput.value.trim();
    if (!query) return;

    submitButton.disabled = true;
    submitButton.innerHTML = `<div class="loading-spinner" style="width:15px;height:15px;border-width:2px;border-color:rgba(255,255,255,0.3);border-top-color:rgba(255,255,255,0.9);"></div>`;

    responseContainer.innerHTML = `
      <div class="response-loading">
        <div class="loading-spinner"></div>
        <span id="loading-typewriter"></span>
      </div>
    `;

    const typewriterEl = document.getElementById('loading-typewriter');
    this.typewriterAnimate(typewriterEl, 'Scanning the depths of Moria for information…');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxSources: 5 }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'Query failed');

      this.displayImpactResponse(data);

    } catch (error) {
      clearTimeout(timeoutId);
      console.error('RAG query error:', error);
      const isTimeout = error.name === 'AbortError';
      responseContainer.innerHTML = `
        <div class="error-message">
          <strong>⚠️ ${isTimeout ? 'Request timed out' : 'Error'}:</strong>
          ${isTimeout ? 'The query took too long. Try a shorter question or check service logs.' : error.message}
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

  // ─── Impact card response renderer ─────────────────────────────────────────

  displayImpactResponse(data) {
    const responseContainer = document.getElementById('query-response');
    const { structured, sources, metadata } = data;

    // Severity → colour class mapping
    const severityClass = { high: 'severity-high', medium: 'severity-medium', low: 'severity-low' };
    const directionIcon = { up: '↑', down: '↓', neutral: '→' };
    const directionClass = { up: 'dir-up', down: 'dir-down', neutral: 'dir-neutral' };

    // ── Headline ────────────────────────────────────────────────────────────
    const headlineHTML = structured?.headline
      ? `<p class="impact-headline">${structured.headline}</p>`
      : '';

    // ── Impact cards ────────────────────────────────────────────────────────
    let impactCardsHTML = '';
    if (structured?.impacts?.length > 0) {
      const cards = structured.impacts.map(impact => {
        const sev = impact.severity || 'low';
        const dir = impact.direction || 'neutral';
        return `
          <div class="impact-card ${severityClass[sev]}">
            <div class="impact-card-header">
              <span class="impact-direction ${directionClass[dir]}">${directionIcon[dir]}</span>
              <span class="impact-title">${impact.title}</span>
              <span class="impact-severity-badge ${severityClass[sev]}">${sev}</span>
            </div>
            <p class="impact-detail">${impact.detail}</p>
          </div>
        `;
      }).join('');

      impactCardsHTML = `<div class="impact-cards-grid">${cards}</div>`;
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const summaryHTML = structured?.summary
      ? `<p class="impact-summary">${structured.summary}</p>`
      : '';

    // ── Data gap notice ──────────────────────────────────────────────────────
    const gapHTML = structured?.dataGaps
      ? `<p class="impact-gap">${structured.dataGaps}</p>`
      : '';

    // ── Sources (original card style) ────────────────────────────────────────
    const sourcesHTML = sources?.length > 0 ? `
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
      <div class="impact-response">
        ${headlineHTML}
        ${impactCardsHTML}
        ${summaryHTML}
        ${gapHTML}
        ${sourcesHTML}
        ${metadataHTML}
      </div>
    `;
  }

  // ─── Legacy text renderer (fallback) ───────────────────────────────────────

  displayRAGResponse(data) {
    const responseContainer = document.getElementById('query-response');
    const { answer, sources, metadata } = data;

    const formattedAnswer = answer
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    const sourcesHTML = sources && sources.length > 0 ? `
      <div class="sources-section">
        <h4>Sources (${sources.length})</h4>
        <div class="sources-list">
          ${sources.map((source, idx) => `
            <div class="source-item">
              <div class="source-header">
                <span class="source-number">${idx + 1}</span>
                <a href="${source.url}" target="_blank" class="source-title">${source.title}</a>
                ${source.relevanceScore ? `<span class="relevance-badge">Score: ${source.relevanceScore}</span>` : ''}
              </div>
              ${source.summary ? `<p class="source-summary">${source.summary}</p>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '<p class="text-muted">No specific sources found for this query.</p>';

    responseContainer.innerHTML = `
      <div class="rag-response">
        <div class="answer-section">
          <div class="answer-text"><p>${formattedAnswer}</p></div>
        </div>
        ${sourcesHTML}
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