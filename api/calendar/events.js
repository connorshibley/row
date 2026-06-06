const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  try {
    const url = await lib.getFeed(uid);
    if (!url) { res.status(200).json({ connected: false }); return; }
    const text = await lib.fetchIcs(url);
    const now = Date.now();
    const events = lib.expandWindow(lib.parseIcs(text), now - 86400000, now + 2 * 86400000);
    res.status(200).json({ connected: true, events });
  } catch (e) { res.status(502).json({ error: 'Could not load calendar' }); }
};
