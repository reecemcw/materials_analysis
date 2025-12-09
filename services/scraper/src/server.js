import {join, dirname} from 'path';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { json } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import scraperRoutes from './routes.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const app = express();
const PORT = process.env.SCRAPER_PORT || 3001;

// Middleware
app.use(cors());
app.use(json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', scraperRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'scraper',
    timestamp: new Date().toISOString()
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
  logger.info(`Scraper service running on port ${PORT}`);
});

export default app;