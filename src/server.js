const express = require('express');
const session = require('express-session');
const path = require('path');
const store = require('./store');
const jobs = require('./jobs');
const authRouter = require('./auth');
const { parseRegions } = require('./grabber');

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '50', 10);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 45 * 24 * 60 * 60 * 1000 // 45 days
  },
  proxy: true
}));

// Auth routes
app.use('/auth', authRouter);

// Auth guard middleware for /api routes
function requireAuth(req, res, next) {
  if (!req.session.accountId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// --- Job routes ---

app.post('/api/jobs', requireAuth, async (req, res) => {
  const { accountId } = req.session;

  // Enforce max concurrent sessions
  const active = await store.listActiveSessions();
  const alreadyRunning = active.some(s => s.accountId === accountId);
  if (!alreadyRunning && active.length >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'Max concurrent sessions reached. Try again later.' });
  }

  const { slug, region, image, desiredCount, sshKeys, webhookUrl, namePrefix } = req.body;
  const regions = parseRegions(region);

  if (!slug || regions.length === 0 || !image || !desiredCount) {
    return res.status(400).json({ error: 'slug, region, image, and desiredCount are required' });
  }

  const config = {
    slug,
    regions,
    image,
    desiredCount: parseInt(desiredCount, 10),
    sshKeys: sshKeys ? sshKeys.split(',').map(s => s.trim()).filter(Boolean) : [],
    webhookUrl: webhookUrl || '',
    namePrefix: namePrefix || ''
  };

  const session = await store.loadSession(accountId);
  await store.saveSession({
    ...session,
    accountId,
    config,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastPollAt: null,
    lastResult: null
  });

  jobs.startJob(accountId, config, session.accessToken, session.refreshToken);
  res.json({ ok: true });
});

app.delete('/api/jobs', requireAuth, async (req, res) => {
  const { accountId } = req.session;
  jobs.stopJob(accountId);
  await store.updateSessionStatus(accountId, 'stopped');
  res.json({ ok: true });
});

app.get('/api/jobs', requireAuth, async (req, res) => {
  const { accountId } = req.session;
  const session = await store.loadSession(accountId);
  if (!session) return res.json({ status: 'idle', config: null });

  const { encryptedAccessToken, encryptedRefreshToken, accessToken, refreshToken, ...safe } = session;
  res.json(safe);
});

app.get('/api/jobs/logs', requireAuth, (req, res) => {
  const { accountId } = req.session;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  jobs.addSseClient(accountId, res);

  // Keep-alive ping every 20s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 20_000);

  req.on('close', () => clearInterval(ping));
});

// Serve the SPA for all other routes
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server after recovering persisted jobs
async function start() {
  try {
    await jobs.recoverFromStore();
  } catch (err) {
    console.error('Session recovery error (continuing):', err.message);
  }
  app.listen(PORT, () => console.log(`Slug Grabber web server running on port ${PORT}`));
}

start();
