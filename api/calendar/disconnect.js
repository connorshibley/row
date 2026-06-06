const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  try { await lib.deleteFeed(uid); res.status(200).json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Disconnect failed' }); }
};
