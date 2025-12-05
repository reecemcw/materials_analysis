const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const express = require('express');
const cors = require('cors');
const scraperRoutes = require('./routes');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.SCRAPER_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

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

module.exports = app;