/**
 * Material Risk Analysis - Frontend Application
 */

class MaterialRiskApp {
  constructor() {
    this.articles = [];
    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadArticles();
  }

  setupEventListeners() {
    const submitButton = document.getElementById('submit-query');
    const queryInput = document.getElementById('query-input');

    submitButton.addEventListener('click', () => this.handleQuery());
    
    // Allow Enter + Shift to submit
    queryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        this.handleQuery();
      }
    });
  }

  async loadArticles() {
    const tbody = document.getElementById('articles-tbody');
    
    try {
      // Call the labeller service to get tagged articles
      const response = await fetch('http://localhost:3002/api/tagged?limit=50');
      
      if (!response.ok) {
        throw new Error('Failed to load articles');
      }

      const data = await response.json();
      this.articles = data.taggedArticles || data.articles || [];

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

    // Extract data
    const imageUrl = article.imageUrl;
    const date = this.formatDate(article.publishDate || article.scrapedAt);
    const publisher = this.extractPublisher(article.url);
    const author = article.author || '—';
    const title = article.title || 'Untitled';
    const tags = article.labels?.categories || article.labels?.topics || [];
    const url = article.url;

    // Image cell
    const imageCell = document.createElement('td');
    if (imageUrl) {
      imageCell.innerHTML = `<img src="${imageUrl}" alt="" class="article-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
        <div class="article-image-placeholder" style="display: none;">${title.charAt(0).toUpperCase()}</div>`;
    } else {
      imageCell.innerHTML = `<div class="article-image-placeholder">${title.charAt(0).toUpperCase()}</div>`;
    }

    // Date cell
    const dateCell = document.createElement('td');
    dateCell.innerHTML = `<span class="article-date">${date}</span>`;

    // Publisher cell
    const publisherCell = document.createElement('td');
    publisherCell.innerHTML = `<span class="article-publisher">${publisher}</span>`;

    // Author cell
    const authorCell = document.createElement('td');
    authorCell.innerHTML = `<span class="article-author">${author}</span>`;

    // Title cell
    const titleCell = document.createElement('td');
    titleCell.innerHTML = `<a href="${url}" target="_blank" class="article-title-link">
      <span class="article-title">${title}</span>
    </a>`;

    // Tags cell
    const tagsCell = document.createElement('td');
    const tagsHtml = tags.slice(0, 3).map(tag => 
      `<span class="tag">${tag}</span>`
    ).join('');
    tagsCell.innerHTML = `<div class="article-tags">${tagsHtml || '—'}</div>`;

    row.appendChild(imageCell);
    row.appendChild(dateCell);
    row.appendChild(publisherCell);
    row.appendChild(authorCell);
    row.appendChild(titleCell);
    row.appendChild(tagsCell);

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
      
      // Remove www. prefix
      hostname = hostname.replace(/^www\./, '');
      
      // Capitalize first letter
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
    
    if (!query) {
      return;
    }

    // Disable button and show loading
    submitButton.disabled = true;
    submitButton.innerHTML = `
      <span class="button-text">Processing...</span>
      <div class="loading-spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
    `;

    responseContainer.innerHTML = `
      <div class="response-loading">
        <div class="loading-spinner"></div>
        <span>🔍 Searching knowledge base and generating answer...</span>
      </div>
    `;

    try {
      // Call the RAG API endpoint
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, maxSources: 5 })
      });

      if (!response.ok) {
        throw new Error('Failed to process query');
      }

      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Query failed');
      }
      
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
      // Re-enable button
      submitButton.disabled = false;
      submitButton.innerHTML = `
        <span class="button-text">Ask Question</span>
        <svg class="button-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M1 8L15 8M15 8L8 1M15 8L8 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
    }
  }

  displayRAGResponse(data) {
    const responseContainer = document.getElementById('query-response');
    
    const { query, answer, sources, metadata } = data;
    
    // Format the answer with markdown-like styling
    const formattedAnswer = answer
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    
    // Build sources HTML
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
                ${source.categories && source.categories.length > 0 ? `
                  <span class="meta-item">
                    📁 ${source.categories.join(', ')}
                  </span>
                ` : ''}
                ${source.topics && source.topics.length > 0 ? `
                  <span class="meta-item">
                    🏷️ ${source.topics.slice(0, 3).join(', ')}
                  </span>
                ` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '<p class="text-muted">No specific sources found for this query.</p>';
    
    // Build metadata HTML
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
          <div class="answer-text">
            <p>${formattedAnswer}</p>
          </div>
        </div>
        
        ${sourcesHTML}
        
        ${metadataHTML}
      </div>
    `;
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new MaterialRiskApp();
});