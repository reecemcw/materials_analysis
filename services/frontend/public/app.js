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
      this.articles = data.taggedArticles || [];

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
        <span>Analyzing articles and generating response...</span>
      </div>
    `;

    try {
      // Call the frontend API which uses Claude
      const response = await fetch('http://localhost:3000/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      });

      if (!response.ok) {
        throw new Error('Failed to process query');
      }

      const data = await response.json();
      
      this.displayResponse(data.response, data.relevantArticles);
    } catch (error) {
      console.error('Query error:', error);
      responseContainer.innerHTML = `
        <div style="color: #ef4444;">
          <strong>Error:</strong> ${error.message}
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

  displayResponse(responseText, relevantArticles = []) {
    const responseContainer = document.getElementById('query-response');
    
    // Format the response text
    const paragraphs = responseText
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => `<p>${p}</p>`)
      .join('');

    let html = paragraphs;

    // Add relevant articles if provided
    if (relevantArticles && relevantArticles.length > 0) {
      html += `
        <div class="relevant-articles">
          <h4>Relevant Articles</h4>
          ${relevantArticles.slice(0, 5).map(article => `
            <div class="relevant-article-item">
              <div class="relevant-article-title">${article.title || 'Untitled'}</div>
              <div class="relevant-article-meta">
                ${this.extractPublisher(article.url)} • ${this.formatDate(article.scrapedAt)}
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    responseContainer.innerHTML = html;
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new MaterialRiskApp();
});