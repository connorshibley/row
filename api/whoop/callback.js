// GET /api/whoop/callback?code=...&state=...
// WHOOP redirects here after the user authorizes. Verifies the state,
// exchanges the code for tokens, stores them, does a first data pull,
// then bounces the user back to the dashboard.
'use strict';

const lib = require('../../lib/whoop-lib');

function bounce(res, status) {
  res.statusCode = 302;
  res.setHeader('Location', '/health.html?whoop=' + status);
  res.end();
}

module.exports = async (req, res) => {
  const cfgErr = lib.configError();
  if (cfgErr) { res.status(500).send(cfgErr); return; }

  const { code, state, error } = req.query || {};
  if (error) { bounce(res, 'denied'); return; }
  if (!code || !state) { bounce(res, 'error'); return; }

  const payload = lib.verifyState(state);
  if (!payload || !payload.uid) { bounce(res, 'error'); return; }

  try {
    const tok = await lib.exchangeCode(code);
    const acct = {
      user_id: payload.uid,
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    };
    await lib.upsertAccount(acct);
    // Immediate first pull so the card has data the moment we return.
    try { await lib.syncAccount(acct); } catch (e) { /* cron will retry */ }
    bounce(res, 'connected');
  } catch (e) {
    bounce(res, 'error');
  }
};
