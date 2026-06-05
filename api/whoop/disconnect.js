// POST /api/whoop/disconnect  (Authorization: Bearer <supabase jwt>)
// Removes the user's stored WHOOP tokens and their synced whoop data row.
'use strict';

const lib = require('../../lib/whoop-lib');

module.exports = async (req, res) => {
  const cfgErr = lib.configError();
  if (cfgErr) { res.status(500).json({ error: cfgErr }); return; }

  const userId = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }

  try {
    await lib.deleteAccount(userId);
    await lib.deleteAppState(userId);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Disconnect failed' });
  }
};
