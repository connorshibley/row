// /api/coach.js — AI daily coach. Auth-gated (Supabase JWT) + config-gated (ANTHROPIC_API_KEY).
// Sends a compact recovery+calendar+workout context to Claude; returns structured JSON.
'use strict';

const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://ygeeeplqpudlodoquwly.supabase.co';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-haiku-4-5-20251001';

function bearerFrom(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1] : null;
}
async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt } });
    if (!r.ok) return null;
    const u = await r.json(); return u && u.id ? u.id : null;
  } catch { return null; }
}

const SYSTEM = [
  'You are a sharp, evidence-based strength & conditioning coach for one athlete.',
  'You receive a JSON context with: recovery (WHOOP recovery score 0-100, hrv_ms, rhr, sleep_perf, day_strain), today\'s calendar events, and the athlete\'s prescribed gym day + program week.',
  'Give a practical daily plan. Be specific and concise; no fluff, no medical claims.',
  'Recovery guide: >=67 green (push hard), 34-66 yellow (moderate, train smart), <34 red (prioritize recovery).',
  'Respond with ONLY valid minified JSON (no markdown, no prose) matching exactly:',
  '{"verdict":{"level":"green|yellow|red","headline":"<=90 chars","reasons":["short bullet",...]},"events":[{"title":"event title","guidance":"how hard / how to approach it"}],"workout":{"note":"load/intensity guidance for the prescribed session given recovery; empty string if no workout"}}',
  'Include an events[] entry for each provided calendar event (omit if none). Keep reasons to 2-4 bullets. If recovery data is missing, say so and give general guidance.',
].join(' ');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!ANTHROPIC_KEY) { res.status(200).json({ configured: false }); return; }
  const uid = await userIdFromJwt(bearerFrom(req));
  if (!uid) { res.status(401).json({ error: 'Not signed in' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const ctx = (body && body.context) || body || {};

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: "Today's context (JSON):\n" + JSON.stringify(ctx) + "\n\nReturn the JSON plan." }],
      }),
    });
    if (!r.ok) { res.status(502).json({ error: 'coach upstream ' + r.status }); return; }
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    let coach;
    try { coach = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      try { coach = JSON.parse(m[0]); }
      catch { coach = { verdict: { level: 'yellow', headline: 'Coach', reasons: [String(text).slice(0, 300)] }, events: [], workout: { note: '' } }; }
    }
    res.status(200).json({ configured: true, coach });
  } catch (e) {
    res.status(502).json({ error: 'coach failed' });
  }
};
