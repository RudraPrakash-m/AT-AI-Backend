import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { getOllamaStatus } from './services/ollamaService.js';
import chatRoutes from './routes/chatRoutes.js';
import authRoutes from './routes/authRoutes.js';
import conversationRoutes from './routes/conversationRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust proxy for Render / Cloudflare / reverse proxies (important for rate limiting and secure cookies)
app.set('trust proxy', 1);

// Security Headers
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // Allows flexible API calls & SSE
  })
);

// Gzip Compression (Bypass SSE / chat streams to prevent buffering)
app.use(
  compression({
    filter: (req, res) => {
      if (req.headers.accept?.includes('text/event-stream') || req.url.includes('/chat')) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
);

// Connect to MongoDB
connectDB();

// CORS Configuration
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim().replace(/\/+$/, ''))
  : ['*'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      const normalizedOrigin = origin.trim().replace(/\/+$/, '');
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  })
);

// Body Parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Auth Rate Limiting (Protects auth endpoints against brute force & spam)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 auth requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
});

// General API Rate Limiter
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);

// Root & Health check routes for Render / Uptime monitors
app.get('/', (req, res) => {
  res.json({
    name: 'AT AI Backend API',
    status: 'healthy',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api', chatRoutes);

// 404 Route Handler
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// Global Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Server Error:', err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: isProduction ? 'Internal server error occurred.' : (err.message || 'Internal server error'),
  });
});

const server = app.listen(PORT, async () => {
  console.log(`🚀 AT AI Backend running on port ${PORT} [Mode: ${process.env.NODE_ENV || 'development'}]`);
  const ollama = await getOllamaStatus();
  if (ollama.connected) {
    console.log(`🟢 Connected to Ollama at ${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}. Models: ${ollama.models.map((m) => m.name).join(', ') || 'None'}. Active: ${ollama.defaultModel}`);
  } else {
    console.log(`🟡 Ollama status: ${ollama.error || 'Not connected'}. Base URL: ${process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'}`);
  }
});

// Graceful Shutdown for Render & Container environments
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force close if graceful close takes longer than 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception thrown:', err);
  // Keep process alive if possible or graceful shutdown in prod
});

