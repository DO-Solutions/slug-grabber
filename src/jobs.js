const axios = require('axios');
const store = require('./store');
const { checkAndCreateDroplets } = require('./grabber');

const DO_OAUTH_URL = 'https://cloud.digitalocean.com/v1/oauth';
const POLL_INTERVAL_MS = 30_000;
const MAX_LOG_LINES = 200;

// In-memory job state per account
const jobs = new Map();

function getOrCreate(accountId) {
  if (!jobs.has(accountId)) {
    jobs.set(accountId, { intervalId: null, logLines: [], sseClients: [] });
  }
  return jobs.get(accountId);
}

function pushLog(accountId, line) {
  const job = getOrCreate(accountId);
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  job.logLines.push(entry);
  if (job.logLines.length > MAX_LOG_LINES) job.logLines.shift();
  // Push to all connected SSE clients
  for (const client of job.sseClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { /* disconnected */ }
  }
}

async function refreshToken(accountId) {
  const session = await store.loadSession(accountId);
  if (!session?.refreshToken) return null;

  try {
    const res = await axios.post(`${DO_OAUTH_URL}/token`, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: process.env.DO_CLIENT_ID,
      client_secret: process.env.DO_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token } = res.data;
    await store.saveSession({
      ...session,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenUpdatedAt: new Date().toISOString()
    });
    return access_token;
  } catch (err) {
    pushLog(accountId, `Token refresh failed: ${err.message}`);
    return null;
  }
}

async function runPoll(accountId) {
  let session = await store.loadSession(accountId);
  if (!session || session.status !== 'running' || !session.config) return;

  let token = session.accessToken;

  // Validate token with a lightweight call; refresh if needed
  try {
    await axios.get('https://api.digitalocean.com/v2/account', {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    if (err.response?.status === 401) {
      pushLog(accountId, 'Access token expired, refreshing...');
      token = await refreshToken(accountId);
      if (!token) {
        pushLog(accountId, 'Could not refresh token. Stopping job — please log in again.');
        stopJob(accountId);
        await store.updateSessionStatus(accountId, 'stopped');
        return;
      }
    }
  }

  const config = { ...session.config, token };
  const result = await checkAndCreateDroplets(config, line => pushLog(accountId, line));

  await store.updateSessionStatus(accountId, 'running', {
    lastPollAt: new Date().toISOString(),
    lastResult: result
  });
}

function startJob(accountId, config, accessToken, refreshToken) {
  const job = getOrCreate(accountId);

  if (job.intervalId) clearInterval(job.intervalId);

  // Run immediately, then on interval
  runPoll(accountId);
  job.intervalId = setInterval(() => runPoll(accountId), POLL_INTERVAL_MS);
  pushLog(accountId, `Monitoring started for slug "${config.slug}" in ${config.regions.join(', ')}`);
}

function stopJob(accountId) {
  const job = jobs.get(accountId);
  if (!job) return;
  if (job.intervalId) {
    clearInterval(job.intervalId);
    job.intervalId = null;
  }
  pushLog(accountId, 'Monitoring stopped.');
}

function getJob(accountId) {
  return jobs.get(accountId) || null;
}

function addSseClient(accountId, res) {
  const job = getOrCreate(accountId);
  job.sseClients.push(res);
  res.on('close', () => {
    job.sseClients = job.sseClients.filter(c => c !== res);
  });
  // Send recent log history immediately
  for (const line of job.logLines) {
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { /* skip */ }
  }
}

async function recoverFromStore() {
  const active = await store.listActiveSessions();
  for (const session of active) {
    try {
      const full = await store.loadSession(session.accountId);
      if (full?.config && full?.accessToken) {
        console.log(`Resuming job for account ${full.accountId}`);
        startJob(full.accountId, full.config, full.accessToken, full.refreshToken);
      }
    } catch (err) {
      console.error(`Failed to recover job for ${session.accountId}:`, err.message);
    }
  }
}

module.exports = { startJob, stopJob, getJob, addSseClient, recoverFromStore };
