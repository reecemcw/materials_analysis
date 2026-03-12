/**
 * Discovery Service — HTTP Server
 *
 * Runs the URL discovery process on a cron schedule and exposes
 * HTTP endpoints for manual control and status inspection.
 *
 * Ports
 *   DISCOVERY_PORT (default 3005) — chosen to not clash with existing services
 *     3001 scraper | 3002 labeller | 3003 knowledge-graph | 3004 scheduler
 *
 * Routes
 *   GET  /health          Liveness check
 *   GET  /status          Last run summary + next scheduled run
 *   GET  /sources         Show loaded sources config
 *   POST /discover/run    Trigger a discovery run immediately
 */

import path             from "path";
import { fileURLToPath } from "url";
import { dirname }      from "path";
import { promises as fs } from "fs";
import dotenv           from "dotenv";
import express          from "express";
import cors             from "cors";
import cron             from "node-cron";
import logger           from "../../../utils/logger.js";
import { runDiscovery } from "./runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const app  = express();
const PORT = process.env.DISCOVERY_PORT || 3005;

const SOURCES_PATH   = process.env.SOURCES_PATH
  ?? path.join(__dirname, "./sources.json");

// Cron: daily at 05:00 UTC (runs before the scheduler at 06:00)
// services/discovery/src/server.js
const CRON_SCHEDULE = process.env.DISCOVERY_CRON || '38 11 * * *';

app.use(cors());
app.use(express.json());

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  running:   false,
  lastRun:   null,
  lastRunAt: null,
  nextRunAt: null,
  runCount:  0,
};

// ─── Sources loader ────────────────────────────────────────────────────────────

async function loadSources() {
  const raw = await fs.readFile(SOURCES_PATH, "utf8");
  return JSON.parse(raw);
}

// ─── Run orchestration ─────────────────────────────────────────────────────────

async function executeRun() {
  if (state.running) {
    logger.warn("[Discovery] Run skipped — previous run still in progress");
    return;
  }
  state.running = true;
  state.runCount++;
  try {
    const { sources } = await loadSources();
    const since       = state.lastRunAt;
    const summary     = await runDiscovery(sources, { since });
    state.lastRun     = summary;
    state.lastRunAt   = new Date().toISOString();
  } catch (err) {
    logger.error("[Discovery] Run threw an unexpected error:", err);
  } finally {
    state.running = false;
  }
}

// ─── Cron ──────────────────────────────────────────────────────────────────────

cron.schedule(CRON_SCHEDULE, executeRun, {
  scheduled: true,
  timezone: process.env.TZ || "UTC",
});

logger.info("[Discovery] Cron scheduled: \"" + CRON_SCHEDULE + "\" (tz: " + (process.env.TZ || "UTC") + ")");

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status:    "healthy",
    service:   "discovery",
    timestamp: new Date().toISOString(),
    cron:      CRON_SCHEDULE,
    running:   state.running,
    nextRunAt: state.nextRunAt,
  });
});

app.get("/status", (req, res) => {
  res.json({ success: true, ...state, cron: CRON_SCHEDULE });
});

app.get("/sources", async (req, res) => {
  try {
    const data = await loadSources();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/discover/run", async (req, res) => {
  if (state.running) {
    return res.status(409).json({ error: "A discovery run is already in progress" });
  }
  res.json({ success: true, message: "Discovery run triggered", triggeredAt: new Date().toISOString() });
  executeRun();
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info("Discovery service running on port " + PORT);
  logger.info("Cron: \"" + CRON_SCHEDULE + "\" — sources: " + SOURCES_PATH);
});

export default app;