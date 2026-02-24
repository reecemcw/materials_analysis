import * as mongoose from 'mongoose';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: join(__dirname, '../.env') });


const connections = {};

const createConnection = async (name, uri) => {
  if (connections[name]) return connections[name];

  try {
    const conn = await mongoose.createConnection(uri).asPromise();
    connections[name] = conn;
    logger.info(`[MongoDB] Connected to database: ${name}`);
    return conn;
  } catch (err) {
    logger.error(`[MongoDB] Failed to connect to ${name}:`, err);
    process.exit(1);
  }
};

export const getArticlesDB = () => {
  const uri = process.env.MONGODB_URI_ARTICLES || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined — check your .env path');
  return createConnection('articles', uri.replace(/\/?$/, '/articles'));
};

export const getPipelineRunsDB = () => {
  const uri = process.env.MONGODB_URI_PIPELINERUNS || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined — check your .env path');
  return createConnection('pipelineruns', uri.replace(/\/?$/, '/pipelineruns'));
};


export const connectAllDatabases = async () => {
  await Promise.all([getArticlesDB(), getPipelineRunsDB()]);
  logger.info('[MongoDB] All database connections established');
};