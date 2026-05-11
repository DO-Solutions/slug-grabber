const { Router } = require('express');
const axios = require('axios');
const store = require('./store');

const DO_OAUTH_URL = 'https://cloud.digitalocean.com/v1/oauth';

const router = Router();

router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DO_CLIENT_ID,
    redirect_uri: `${process.env.APP_URL}/auth/callback`,
    response_type: 'code',
    scope: 'write'
  });
  res.redirect(`${DO_OAUTH_URL}/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=missing_code');

  try {
    // Exchange authorization code for tokens
    const tokenRes = await axios.post(`${DO_OAUTH_URL}/token`, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.DO_CLIENT_ID,
      client_secret: process.env.DO_CLIENT_SECRET,
      redirect_uri: `${process.env.APP_URL}/auth/callback`
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token } = tokenRes.data;

    // Fetch account info to get stable accountId
    const accountRes = await axios.get('https://api.digitalocean.com/v2/account', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const { uuid: accountId, email } = accountRes.data.account;

    // Persist tokens encrypted in Spaces (preserve existing job config if present)
    const existing = await store.loadSession(accountId);
    await store.saveSession({
      ...(existing || { config: null, status: 'idle' }),
      accountId,
      email,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenUpdatedAt: new Date().toISOString()
    });

    req.session.accountId = accountId;
    req.session.email = email;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

router.get('/logout', async (req, res) => {
  const { accountId } = req.session;
  if (accountId) {
    // Stop the polling loop via the jobs module (imported lazily to avoid circular deps)
    const jobs = require('./jobs');
    jobs.stopJob(accountId);
    await store.updateSessionStatus(accountId, 'stopped');
  }
  req.session.destroy(() => res.redirect('/'));
});

router.get('/status', (req, res) => {
  if (!req.session.accountId) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    account: { id: req.session.accountId, email: req.session.email }
  });
});

module.exports = router;
