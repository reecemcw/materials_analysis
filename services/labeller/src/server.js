import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import express, { json } from 'express';
import cors from 'cors';
import labellerRoutes from './routes.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const app = express();
const PORT = process.env.LABELLER_PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json( {limit: '10mb' } ));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', labellerRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'labeller',
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY
  });
});

// Error handling
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

app.listen(PORT, () => {
  logger.info(`Labeller service running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    warn('WARNING: ANTHROPIC_API_KEY not configured');
  }
});

export default app;