// GET /api/whoop/start  (called with Authorization: Bearer <supabase jwt>)
// Verifies the signed-in user, mints a signed OAuth `state` carrying their
// user id, and returns the WHOOP authorize URL for the browser to redirect to.
'use strict';

const lib = require('../../lib/whoop-lib');

module.exports = async (req, res) => {
  const cfgErr = lib.configError();
  if (cfgErr) { res.status(500).json({ error: cfgErr }); return; }

  const jwt = lib.bearerFrom(req);
  const userId = await lib.userIdFromJwt(jwt);
  if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }

  const state = lib.signState({ uid: userId, exp: Date.now() + 10 * 60 * 1000 });

  const url = lib.WHOOP.authUrl
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(lib.WHOOP.clientId)
    + '&redirect_uri=' + encodeURIComponent(lib.WHOOP.redirectUri)
    + '&scope=' + encodeURIComponent(lib.WHOOP.scopes)
    + '&state=' + encodeURIComponent(state);

  res.status(200).json({ url });
};
