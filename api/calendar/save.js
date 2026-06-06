const lib = require('../../lib/calendar-lib');
module.exports = async (req, res) => {
  const cfg = lib.configError(); if (cfg) { res.status(500).json({ error: cfg }); return; }
  const uid = await lib.userIdFromJwt(lib.bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = ((body && body.ics_url) || '').trim();
  if (!/^https:\/\//i.test(url) || !(/\.ics(\?|$)/i.test(url) || /ical/i.test(url))) {
    res.status(400).json({ error: "That doesn't look like an iCal URL" }); return;
  }
  try { await lib.saveFeed(uid, url); res.status(200).json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Save failed' }); }
};
