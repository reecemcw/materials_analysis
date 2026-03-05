import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import logger from '../../../utils/logger.js';
import { runScheduledPipeline, checkServices, isDue } from './scheduler.js';
import { getAllUrls } from '../../../utils/url-registry.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const app  = express();
const PORT = process.env.SCHEDULER_PORT || 3004;
console.log('PORT resolving to:', process.env.SCHEDULER_PORT, '| .env path:', path.join(__dirname, '../../../.env'));

app.use(cors());
app.use(express.json());

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  running:     false,   // true while a pipeline run is in progress
  lastRun:     null,    // summary of the last completed run
  lastRunAt:   null,
  nextRunAt:   null,
  runCount:    0,
};

// ─── Cron Schedule ────────────────────────────────────────────────────────────

// Default: run at 06:00 and 18:00 every day
// Override with SCHEDULER_CRON env var, e.g. "0 6 * * *" for once daily at 6am
const CRON_SCHEDULE = process.env.SCHEDULER_CRON || '0 6,18 * * *';

function getNextRunAt(schedule) {
  // Rough next-run estimate based on cron expression (not exact, good enough for display)
  try {
    const interval = cron.schedule(schedule, () => {}, { scheduled: false });
    return interval.nextDate()?.toISO() ?? null;
  } catch {
    return null;
  }
}

async function executeRun() {
  if (state.running) {
    logger.warn('[Scheduler] Run skipped — previous run still in progress');
    return;
  }

  state.running = true;
  state.runCount++;

  try {
    const summary    = await runScheduledPipeline();
    state.lastRun    = summary;
    state.lastRunAt  = new Date().toISOString();
    state.nextRunAt  = getNextRunAt(CRON_SCHEDULE);
  } catch (err) {
    logger.error('[Scheduler] Run threw an unexpected error:', err);
  } finally {
    state.running = false;
  }
}

const job = cron.schedule(CRON_SCHEDULE, executeRun, {
  scheduled: true,
  timezone:  process.env.TZ || 'UTC',
});

logger.info(`[Scheduler] Cron scheduled: "${CRON_SCHEDULE}" (tz: ${process.env.TZ || 'UTC'})`);
state.nextRunAt = getNextRunAt(CRON_SCHEDULE);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({
    status:    'healthy',
    service:   'scheduler',
    timestamp: new Date().toISOString(),
    cron:      CRON_SCHEDULE,
    running:   state.running,
    nextRunAt: state.nextRunAt,
  });
});

// Status — full state including last run summary
app.get('/status', (req, res) => {
  res.json({
    success: true,
    ...state,
    cron: CRON_SCHEDULE,
  });
});

// Registry — show which URLs are registered and whether they're due
app.get('/registry', async (req, res) => {
  try {
    const urls     = await getAllUrls();
    const enriched = urls.map(entry => ({
      ...entry,
      due: isDue(entry),
      nextDue: entry.lastScraped && entry.active
        ? new Date(new Date(entry.lastScraped).getTime() + ({
            daily:   86400000,
            weekly:  604800000,
            monthly: 2592000000,
          }[entry.frequency] ?? 86400000)).toISOString()
        : entry.active ? 'now' : 'inactive',
    }));

    res.json({
      success: true,
      total:   enriched.length,
      active:  enriched.filter(e => e.active).length,
      due:     enriched.filter(e => e.due).length,
      urls:    enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Services — health check across all dependent services
app.get('/services', async (req, res) => {
  try {
    const health = await checkServices();
    res.json({ success: true, ...health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger — run the pipeline immediately outside the cron schedule
app.post('/run', async (req, res) => {
  if (state.running) {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  // Fire and return immediately — don't await the full run
  res.json({ success: true, message: 'Pipeline run triggered', runningAt: new Date().toISOString() });
  executeRun();
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`Scheduler service running on port ${PORT}`);
  logger.info(`Cron: "${CRON_SCHEDULE}" — next run: ${state.nextRunAt ?? 'unknown'}`);
});

export default app;