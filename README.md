# Materials Analysis — Article Knowledge Base

> A Node.js microservices pipeline that ethically scrapes, AI-labels, and graph-connects critical materials articles — making their content queryable via natural language RAG.

---

## Overview

This system automatically discovers, scrapes, enriches, and indexes articles from sources covering rare earth elements, critical minerals, and supply chain risk. Once processed, articles are queryable through a web UI backed by Claude-powered retrieval-augmented generation (RAG).

**The pipeline runs automatically on a cron schedule:**

```
Discovery (05:00 UTC) → Scheduler (06:00 & 18:00 UTC) → Scraper → Labeller → Knowledge Graph → Frontend
```

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌───────────────────┐
│  Discovery   │────▶│  Scheduler   │────▶│   Scraper    │────▶│     Labeller      │
│  Port 3005   │     │  Port 3004   │     │  Port 3001   │     │     Port 3002      │
│  (RSS/XML)   │     │  (Cron)      │     │  (Cheerio)   │     │  (Claude AI)      │
└──────────────┘     └──────────────┘     └──────────────┘     └─────────┬─────────┘
                                                                          │
                      ┌──────────────────────────────────────────────────▼──────────┐
                      │                    Knowledge Graph — Port 3003               │
                      │              (In-memory graph + MongoDB snapshots)           │
                      └──────────────────────────────────────────────────┬──────────┘
                                                                          │
                      ┌───────────────────────────────────────────────────▼─────────┐
                      │                    Frontend — Port 3000                      │
                      │              (Express + RAG query interface)                 │
                      └─────────────────────────────────────────────────────────────┘

                                   ┌─────────────────────┐
                                   │       MongoDB        │
                                   │  articles / labelled │
                                   │  pipelineruns / graph│
                                   └─────────────────────┘
```

---

## Services

### Discovery (`services/discovery` · Port 3005)

Crawls RSS feeds and XML sitemaps to automatically populate the URL registry with new article links — so you rarely need to add URLs manually.

**How it works:**
- Reads a list of sources from `sources.json` (e.g. Rare Earth Exchanges, Supply Chain Dive, Junior Mining Network)
- For each source, fetches RSS/Atom feeds and/or XML sitemaps
- Supports auto-detection: if no feed URLs are configured, it probes the homepage for `<link rel="alternate">` and well-known paths like `/feed`, `/sitemap.xml`
- Applies per-source URL filters (regex) to keep only relevant article URLs
- Upserts discovered URLs into the MongoDB `urls` collection via the shared URL registry — duplicates are safely skipped
- Runs on a cron schedule (default `0 5 * * *` — 05:00 UTC daily, just before the scheduler)

**Key files:**
- `src/url_discoverer.js` — RSS, Atom, and sitemap parsing logic
- `src/runner.js` — orchestrates a full discovery cycle across all sources
- `src/registry_manager.js` — merges discovered URLs into the database
- `src/server.js` — Express HTTP server + cron scheduler
- `src/sources.json` — source registry (edit this to add/remove monitored sites)

---

### Scheduler (`services/scheduler` · Port 3004)

The pipeline conductor. Reads the URL registry, determines which URLs are due for processing based on their frequency (`daily` / `weekly` / `monthly`), and drives each one through the full scrape → label → graph pipeline.

**How it works:**
- Runs on a cron schedule (default `0 6,18 * * *` — 06:00 and 18:00 UTC)
- Performs a health check across all dependent services before starting
- Deduplicates: checks whether a URL has already been scraped and labelled — skips fully processed articles, resumes partially processed ones
- Runs each URL through three sequential stages: **scrape → label → graph**
- After all URLs are processed, triggers a final graph sync and snapshot
- Exposes a `/registry` endpoint showing which URLs are registered and whether they are currently due

**Key files:**
- `src/scheduler.js` — core pipeline logic, dedup checks, stage orchestration
- `src/server.js` — Express server, cron job, HTTP control endpoints

---

### Scraper (`services/scraper` · Port 3001)

Responsible for fetching raw HTML from article URLs and extracting structured content using Cheerio.

**How it works:**
- Implements respectful scraping: a configurable delay between requests, retry with exponential backoff, and a `robots.txt` check before batch scraping
- Extracts title, author, publish date, body content, excerpt, featured image URL, and tags using a cascade of CSS selectors and Open Graph metadata
- Persists raw articles to both a local JSON file store and MongoDB (`articles/raw` collection)
- Assigns each article a UUID and marks it `pending` for labelling

**Key files:**
- `src/scraper.js` — HTTP fetching, HTML parsing, content extraction
- `src/routes.js` — REST endpoints for scraping single and batch URLs, article retrieval
- `src/server.js` — Express server with MongoDB connection

**Endpoints:**
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/scrape` | Scrape a single URL |
| `POST` | `/api/scrape/batch` | Scrape multiple URLs |
| `GET` | `/api/articles` | List raw articles |
| `GET` | `/api/articles/:id` | Get a single article |
| `GET` | `/api/articles/by-url` | Look up article by source URL |

---

### Labeller (`services/labeller` · Port 3002)

Uses the Anthropic Claude API to enrich raw articles with structured metadata, transforming unstructured text into a queryable knowledge base.

**How it works:**
- Sends each article's title, excerpt, and up to 3,000 characters of content to Claude
- Extracts: categories, topics, named entities (people, organisations, locations, products), keywords, sentiment, a 2–3 sentence summary, reading time, complexity level, and content type
- Results are persisted to both the local file store and MongoDB (`articles/labelled` collection)
- Includes a 1-second rate-limit delay between individual label calls and supports batch processing
- Falls back to a default error-flagged structure if the AI response cannot be parsed

**Key files:**
- `src/labeller.js` — Anthropic SDK integration, prompt construction, response parsing
- `src/routes.js` — REST endpoints for labelling and retrieving tagged articles
- `src/server.js` — Express server

**Endpoints:**
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/label/:id` | Label a single article |
| `POST` | `/api/label/batch` | Label multiple articles |
| `GET` | `/api/tagged` | Get all labelled articles |
| `GET` | `/api/tagged/:id` | Get a single labelled article |
| `GET` | `/api/tags` | Get aggregated tag/entity data |

---

### Knowledge Graph (`services/knowledge-graph` · Port 3003)

Maintains an in-memory graph of articles and their relationships, persisted as versioned snapshots to both disk and MongoDB.

**How it works:**
- Each article becomes a **node**; semantically similar articles are connected by **edges** (`RELATES_TO`) based on shared categories, topics, keywords, and named entities
- Similarity is scored: categories carry the most weight (×3), then topics (×2), then keywords (×1), with entity matches (people, organisations) also contributing
- The graph is persisted to `data/graph/graph.json` on disk and to a `graph/snapshots` MongoDB collection with SHA-256 checksums for integrity
- On startup, performs a **parity check** between local disk and MongoDB versions — automatically loads from MongoDB if local is behind, and pushes local to MongoDB if local is ahead
- Auto-snapshots every 10 nodes added; also snapshots after every scheduled pipeline run
- Supports rollback to any previous version

**Key files:**
- `src/graph.js` — in-memory graph, node/edge management, similarity scoring, queries
- `src/graph_persist.js` — versioned persistence (disk + MongoDB), parity checks, rollback
- `src/routes.js` — REST API for adding articles, querying the graph, managing snapshots
- `src/server.js` — Express server

**Endpoints:**
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/graph/add/:id` | Add a labelled article to the graph |
| `POST` | `/api/graph/sync` | Sync all labelled articles and snapshot |
| `GET` | `/api/graph/query/topic` | Query nodes by topic |
| `GET` | `/api/graph/query/keyword` | Query nodes by keyword |
| `GET` | `/api/graph/similar/:id` | Find articles similar to a given one |
| `GET` | `/api/graph/stats` | Graph statistics |
| `GET` | `/api/graph/versions` | List snapshot history |
| `POST` | `/api/graph/snapshot` | Manually trigger a snapshot |
| `POST` | `/api/graph/rollback/:version` | Roll back to a previous version |

---

### Frontend (`services/frontend` · Port 3000)

A minimal web interface for browsing labelled articles and querying the knowledge base in natural language.

**How it works:**
- Serves a single-page app with two views: **Global Intelligence** (article feed + query interface) and **Your Value Chain** (placeholder for supply chain configuration)
- The article table shows each article's thumbnail, publish date, publisher, title, extracted organisations, topic tags, and sentiment badge — sorted newest first
- The query interface accepts natural language questions and runs a multi-strategy RAG retrieval: it queries the knowledge graph by topic and keyword simultaneously, aggregates and deduplicates results, ranks them by relevance to the query, then sends the top sources as context to Claude to generate a grounded answer
- The knowledge graph node count is displayed as a live badge in the query input bar
- Relevance scoring weights title matches highest, then topic/category/keyword matches

**Key files:**
- `src/routes.js` — API routes including the RAG query endpoint and stats aggregation
- `src/server.js` — Express server with static file serving
- `public/index.html` — single-page application shell
- `public/app.js` — client-side JS (article table rendering, RAG query flow)
- `public/style.css` — dark sidebar + warm grey main area design

**Endpoints:**
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/recent` | Recent labelled articles (sorted by date) |
| `POST` | `/api/query` | Natural language RAG query |
| `GET` | `/api/stats` | Article counts and graph stats |

---

## Data Layer

### MongoDB Databases

Three separate MongoDB databases are used, each with its own connection:

| Database | Collections | Contents |
|---|---|---|
| `articles` | `raw`, `labelled`, `urls` | Scraped articles, AI-enriched metadata, URL registry |
| `pipelineruns` | `test` / `stage` / `prod` | Pipeline run history and per-article stage results |
| `graph` | `snapshots` | Versioned knowledge graph snapshots |

### Shared Utilities

- **`utils/storage.js`** — dual-write storage abstraction (local JSON files + MongoDB), with MongoDB fallback on file read failures
- **`utils/url-registry.js`** — MongoDB-backed URL registry shared across scheduler, scraper, and discovery service (replaces direct `url.json` reads)
- **`utils/logger.js`** — Winston-based structured logger used by all services
- **`data/connection.js`** — manages named Mongoose connections per database
- **`data/models/model_factory.js`** — cached Mongoose model factory with all schemas defined in one place

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)
- An Anthropic API key

### Environment Variables

Create a `.env` file in the project root:

```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017

# Anthropic
ANTHROPIC_API_KEY=your-key-here
AI_MODEL=claude-sonnet-4-20250514

# Service ports (optional — these are the defaults)
SCRAPER_PORT=3001
LABELLER_PORT=3002
KG_PORT=3003
SCHEDULER_PORT=3004
DISCOVERY_PORT=3005
FRONTEND_PORT=3000

# Service URLs (used for inter-service HTTP calls)
SCRAPER_URL=http://localhost:3001
LABELLER_URL=http://localhost:3002
GRAPH_URL=http://localhost:3003
DISCOVERY_URL=http://localhost:3005

# Cron schedules (optional overrides)
SCHEDULER_CRON=0 6,18 * * *
DISCOVERY_CRON=0 5 * * *

# Scraper behaviour
REQUEST_DELAY=2000
MAX_RETRIES=3
USER_AGENT=ArticleBot/1.0
```

### Install Dependencies

Each service has its own `package.json`. Install from each service directory:

```bash
cd services/scraper && npm install
cd ../labeller && npm install
cd ../knowledge-graph && npm install
cd ../scheduler && npm install
cd ../discovery && npm install
cd ../frontend && npm install
```

### Start All Services

Open a terminal per service (or use a process manager like `pm2`):

```bash
# Terminal 1 — Scraper
cd services/scraper && npm start

# Terminal 2 — Labeller
cd services/labeller && npm start

# Terminal 3 — Knowledge Graph
cd services/knowledge-graph && npm start

# Terminal 4 — Scheduler
cd services/scheduler && npm start

# Terminal 5 — Discovery
cd services/discovery && npm start

# Terminal 6 — Frontend
cd services/frontend && npm start
```

The web UI will be available at **http://localhost:3000**.

---

## Running Basic Functions

### Manually scrape a single article

```bash
curl -X POST http://localhost:3001/api/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://rareearthexchanges.com/news/example-article"}'
```

### Label a scraped article

```bash
# Replace <article-id> with the UUID returned by the scrape endpoint
curl -X POST http://localhost:3002/api/label/<article-id>
```

### Add a labelled article to the knowledge graph

```bash
curl -X POST http://localhost:3003/api/graph/add/<article-id>
```

### Trigger a full pipeline run immediately (without waiting for cron)

```bash
curl -X POST http://localhost:3004/run
```

### Trigger a discovery run immediately

```bash
curl -X POST http://localhost:3005/discover/run
```

### Query the knowledge base via RAG

```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "What is happening with lithium supply from South America?", "maxSources": 5}'
```

### Check the scheduler registry (which URLs are due)

```bash
curl http://localhost:3004/registry
```

### Take a manual knowledge graph snapshot

```bash
curl -X POST http://localhost:3003/api/graph/snapshot \
  -H "Content-Type: application/json" \
  -d '{"reason": "manual"}'
```

### Roll back the knowledge graph to a previous version

```bash
# List available versions
curl http://localhost:3003/api/graph/versions

# Roll back to version 5
curl -X POST http://localhost:3003/api/graph/rollback/5
```

### Health checks

Every service exposes a `/health` endpoint:

```bash
curl http://localhost:3001/health  # scraper
curl http://localhost:3002/health  # labeller
curl http://localhost:3003/health  # knowledge-graph
curl http://localhost:3004/health  # scheduler
curl http://localhost:3005/health  # discovery
```

---

## Adding New Sources

Edit `services/discovery/src/sources.json` to add a new monitored site:

```json
{
  "name": "My Source",
  "baseUrl": "https://example.com",
  "active": true,
  "autoDiscover": true,
  "feeds": ["https://example.com/feed/"],
  "sitemaps": [],
  "urlFilter": "/articles/",
  "frequency": "daily",
  "notes": "Optional note"
}
```

Set `autoDiscover: true` to let the service probe for feeds/sitemaps automatically if you don't know the feed URL. Set `active: false` to disable a source without removing it.

---

## Development

Each service supports hot-reload via `nodemon`:

```bash
cd services/<service-name> && npm run dev
```

Tests can be run from any service directory with:

```bash
npm test
```

---

## License

MIT