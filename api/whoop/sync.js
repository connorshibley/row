// /api/whoop/sync
// Two callers:
//   • Vercel Cron (daily) — authorized by `Authorization: Bearer <CRON_SECRET>`.
//     Syncs every connected account.
//   • The dashboard "Sync now" button — authorized by a Supabase user JWT.
//     Syncs only that user's account.
'use strict';

const lib = require('../../lib/whoop-lib');

module.exports = async (req, res) => {
  const cfgErr = lib.configError();
  if (cfgErr) { res.status(500).json({ error: cfgErr }); return; }

  const bearer = lib.bearerFrom(req);
  const isCron = !!lib.CRON_SECRET && bearer === lib.CRON_SECRET;

  try {
    if (isCron) {
      const accts = await lib.getAllAccounts();
      let ok = 0, failed = 0;
      for (const a of accts) {
        try { await lib.syncAccount(a); ok++; } catch (e) { failed++; }
      }
      res.status(200).json({ synced: ok, failed });
      return;
    }

    // On-demand: must be a signed-in user, sync only their account.
    const userId = await lib.userIdFromJwt(bearer);
    if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }
    const acct = await lib.getAccount(userId);
    if (!acct) { res.status(404).json({ error: 'WHOOP not connected' }); return; }
    const summary = await lib.syncAccount(acct);
    res.status(200).json({ ok: true, summary });
  } catch (e) {
    res.status(502).json({ error: 'Sync failed', detail: String(e && e.message || e) });
  }
};
