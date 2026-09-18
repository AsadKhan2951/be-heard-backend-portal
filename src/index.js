// Must be the first import: loads .env before any other module reads process.env.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import { connectDB } from './db.js';
import { authMiddleware, signup, login, getMe, updateMe, deleteAccount } from './auth.js';
import { createBrand, getBrands, getBrand, updateBrand, deleteBrand, prefillBrand, regenerateBrandProfile } from './brands.js';
import { generateContent, regenerateImage } from './ai.js';
import { createContent, getContent, getContentById, updateContent, deleteContent, getDashboardStats } from './content.js';
import { publishContent, scheduleContent, checkScheduledContent, recoverStuckPublishing, fetchContentAnalytics } from './publishing.js';
import { generateCampaignPlan, createCampaign, getCampaigns, getCampaignById, generateCampaignContent, getCalendarEvents, updateCalendarEvent, recoverStuckCampaigns } from './campaigns.js';
import { generatePR, getPRPieces, getPRById, updatePR, deletePR } from './pr.js';
import { generateCreative, getCreativeGallery, regenerateCreative, deleteCreative } from './creative.js';
import { getAnalytics, syncAnalytics, getAnalyticsHistory } from './analytics.js';
import { uploadMiddleware, handleUpload } from './upload.js';
import { getMetaOAuthUrl, handleMetaCallback } from './meta.js';
import { serveMedia } from './media.js';
import { loginLimiter, aiLimiter } from './ratelimit.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ----- CORS -----
// On DigitalOcean the frontend is served from the same domain, so browsers do
// not need CORS at all. CLIENT_URL (comma-separated) allow-lists extra origins;
// with no CLIENT_URL (local dev) every origin is allowed.
const allowedOrigins = (process.env.CLIENT_URL || '')
  .split(',')
  .map(o => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// ----- Health check -----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ----- Public media (images stored in MongoDB) -----
app.get('/api/media/:kind/:id', serveMedia);

// ----- Auth -----
app.post('/api/auth/signup', signup);
app.post('/api/auth/login', loginLimiter, login);
app.get('/api/auth/me', authMiddleware, getMe);
app.patch('/api/auth/me', authMiddleware, updateMe);
app.delete('/api/auth/account', authMiddleware, deleteAccount);

// ----- Brands -----
app.post('/api/brands', authMiddleware, createBrand);
app.get('/api/brands', authMiddleware, getBrands);
app.get('/api/brands/:brandId', authMiddleware, getBrand);
app.put('/api/brands/:brandId', authMiddleware, updateBrand);
app.delete('/api/brands/:brandId', authMiddleware, deleteBrand);
app.post('/api/brands/:brandId/prefill', authMiddleware, aiLimiter, prefillBrand);
app.post('/api/brands/:brandId/regenerate-profile', authMiddleware, aiLimiter, regenerateBrandProfile);

// Upload route (returns a base64 data URI)
app.post('/api/upload', authMiddleware, uploadMiddleware, handleUpload);

// ----- AI -----
app.post('/api/content/generate', authMiddleware, aiLimiter, generateContent);
app.post('/api/images/regenerate', authMiddleware, aiLimiter, regenerateImage);

// ----- Content -----
app.post('/api/content', authMiddleware, createContent);
app.get('/api/content', authMiddleware, getContent);
app.get('/api/content/:contentId', authMiddleware, getContentById);
app.patch('/api/content/:contentId', authMiddleware, updateContent);
app.delete('/api/content/:contentId', authMiddleware, deleteContent);

// ----- Dashboard -----
app.get('/api/dashboard/stats', authMiddleware, getDashboardStats);

// ----- Publishing -----
app.post('/api/content/:contentId/publish', authMiddleware, publishContent);
app.post('/api/content/:contentId/schedule', authMiddleware, scheduleContent);
app.get('/api/content/:contentId/analytics', authMiddleware, fetchContentAnalytics);

// ----- Campaigns -----
app.post('/api/campaigns/generate', authMiddleware, aiLimiter, generateCampaignPlan);
app.post('/api/campaigns', authMiddleware, createCampaign);
app.get('/api/campaigns', authMiddleware, getCampaigns);
app.get('/api/campaigns/:campaignId', authMiddleware, getCampaignById);
app.post('/api/campaigns/:campaignId/generate-content', authMiddleware, aiLimiter, generateCampaignContent);
app.get('/api/calendar', authMiddleware, getCalendarEvents);
app.patch('/api/calendar/:contentId', authMiddleware, updateCalendarEvent);

// ----- PR -----
app.post('/api/pr/generate', authMiddleware, aiLimiter, generatePR);
app.get('/api/pr', authMiddleware, getPRPieces);
app.get('/api/pr/:prId', authMiddleware, getPRById);
app.patch('/api/pr/:prId', authMiddleware, updatePR);
app.delete('/api/pr/:prId', authMiddleware, deletePR);

// ----- Creative Studio -----
app.post('/api/creative/generate', authMiddleware, aiLimiter, generateCreative);
app.get('/api/creative/gallery', authMiddleware, getCreativeGallery);
app.post('/api/creative/:creativeId/regenerate', authMiddleware, aiLimiter, regenerateCreative);
app.delete('/api/creative/:creativeId', authMiddleware, deleteCreative);

// ----- Analytics -----
app.get('/api/analytics', authMiddleware, getAnalytics);
app.post('/api/analytics/sync', authMiddleware, syncAnalytics);
app.get('/api/analytics/history', authMiddleware, getAnalyticsHistory);

// ----- Meta OAuth -----
app.get('/api/meta/oauth-url', authMiddleware, getMetaOAuthUrl);
app.get('/api/meta/callback', handleMetaCallback);

// ----- Root -----
app.get('/', (req, res) => {
  res.json({ name: 'BeHeard API', status: 'running', docs: '/api/health' });
});

// Unknown API routes get JSON, not Express's HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// ----- Error handling -----
app.use((err, req, res, next) => {
  // Client errors from middleware (bad JSON, payload too large, upload limits)
  const status = err.status || err.statusCode || (err.name === 'MulterError' ? 400 : 500);
  if (status < 500) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5MB)' : err.message;
    return res.status(status).json({ error: message });
  }
  if (err.message?.startsWith('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ----- Start -----
async function start() {
  await connectDB();
  await Promise.all([recoverStuckPublishing(), recoverStuckCampaigns()]);

  // Scheduled publishing check every minute
  cron.schedule('* * * * *', () => {
    checkScheduledContent();
  });

  app.listen(PORT, () => {
    console.log(`\n🚀 BeHeard API running on port ${PORT}`);
    console.log(`⏰ Scheduled publishing check enabled\n`);
  });
}

start();
