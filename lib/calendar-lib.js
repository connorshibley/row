// lib/calendar-lib.js — zero-dep ICS fetch + parse for the calendar card.
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ygeeeplqpudlodoquwly.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function supaHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json',
  }, extra || {});
}
function bearerFrom(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h); return m ? m[1] : null;
}
function configError() { return SERVICE_KEY ? null : 'Missing env: SUPABASE_SERVICE_ROLE_KEY'; }

async function userIdFromJwt(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt } });
    if (!r.ok) return null;
    const u = await r.json(); return u && u.id ? u.id : null;
  } catch { return null; }
}
async function getFeed(userId) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?user_id=eq.' + encodeURIComponent(userId) + '&select=ics_url', { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0].ics_url : null;
}
async function saveFeed(userId, icsUrl) {
  await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?on_conflict=user_id', {
    method: 'POST', headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ user_id: userId, ics_url: icsUrl, updated_at: new Date().toISOString() }),
  });
}
async function deleteFeed(userId) {
  await fetch(SUPABASE_URL + '/rest/v1/calendar_feeds?user_id=eq.' + encodeURIComponent(userId), {
    method: 'DELETE', headers: supaHeaders({ Prefer: 'return=minimal' }),
  });
}
async function fetchIcs(url) {
  const r = await fetch(url, { headers: { Accept: 'text/calendar' } });
  if (!r.ok) throw new Error('ICS fetch ' + r.status);
  return r.text();
}

// ---- ICS parsing ----
function pad(n) { return (n < 10 ? '0' : '') + n; }
function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function parseDt(value, params) {
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4), mo = +value.slice(4, 6), d = +value.slice(6, 8);
    return { allDay: true, floating: false, y, mo, d, hh: 0, mi: 0, ss: 0, ms: Date.UTC(y, mo - 1, d) };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5], ss = +m[6], utc = !!m[7];
  return { allDay: false, floating: !utc, y, mo, d, hh, mi, ss, ms: Date.UTC(y, mo - 1, d, hh, mi, ss) };
}
function fmtDt(dt) {
  if (dt.allDay) return dt.y + '-' + pad(dt.mo) + '-' + pad(dt.d);
  return dt.y + '-' + pad(dt.mo) + '-' + pad(dt.d) + 'T' + pad(dt.hh) + ':' + pad(dt.mi) + ':' + pad(dt.ss) + (dt.floating ? '' : 'Z');
}
function fmtInstant(ms, floating) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + (floating ? '' : 'Z');
}
function shiftDays(dt, n) {
  const b = new Date(Date.UTC(dt.y, dt.mo - 1, dt.d, dt.hh, dt.mi, dt.ss));
  b.setUTCDate(b.getUTCDate() + n);
  const y = b.getUTCFullYear(), mo = b.getUTCMonth() + 1, d = b.getUTCDate();
  return { allDay: dt.allDay, floating: dt.floating, y, mo, d, hh: dt.hh, mi: dt.mi, ss: dt.ss, ms: Date.UTC(y, mo - 1, d, dt.hh, dt.mi, dt.ss) };
}

function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = line.indexOf(':'); if (ci < 0) continue;
    const left = line.slice(0, ci), value = line.slice(ci + 1);
    const parts = left.split(';'); const name = parts[0].toUpperCase();
    const params = {};
    for (let p = 1; p < parts.length; p++) { const kv = parts[p].split('='); if (kv.length === 2) params[kv[0].toUpperCase()] = kv[1]; }
    if (name === 'SUMMARY') cur.summary = value;
    else if (name === 'UID') cur.uid = value;
    else if (name === 'DTSTART') cur.start = parseDt(value, params);
    else if (name === 'DTEND') cur.end = parseDt(value, params);
    else if (name === 'RRULE') cur.rrule = value;
  }
  return events.filter(e => e.start);
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function weekdayOf(dt) { return new Date(Date.UTC(dt.y, dt.mo - 1, dt.d)).getUTCDay(); }

function expandWindow(events, winStart, winEnd) {
  const out = [];
  for (const ev of events) {
    const s = ev.start; if (!s) continue;
    const durMs = ev.end ? Math.max(0, ev.end.ms - s.ms) : (s.allDay ? 86400000 : 3600000);
    let occ = [];
    if (!ev.rrule) {
      occ.push(s);
    } else {
      const r = {};
      ev.rrule.split(';').forEach(kv => { const x = kv.split('='); if (x.length === 2) r[x[0].toUpperCase()] = x[1]; });
      const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
      const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
      let untilMs = null;
      if (r.UNTIL) { const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(r.UNTIL); if (u) untilMs = Date.UTC(+u[1], +u[2] - 1, +u[3], u[4] ? +u[4] : 23, u[5] ? +u[5] : 59, u[6] ? +u[6] : 59); }
      const byday = r.BYDAY ? r.BYDAY.split(',').map(x => WD[x.replace(/^[+-]?\d*/, '')]).filter(v => v != null) : null;
      if (freq !== 'DAILY' && freq !== 'WEEKLY') { occ.push(s); }
      else {
        const s0 = Date.UTC(s.y, s.mo - 1, s.d); let made = 0, cur = s, guard = 0;
        while (guard++ < 1500) {
          const curDay = Date.UTC(cur.y, cur.mo - 1, cur.d);
          if (curDay > winEnd) break;
          if (untilMs != null && cur.ms > untilMs) break;
          const dd = Math.round((curDay - s0) / 86400000);
          let include = false;
          if (freq === 'DAILY') include = (dd % interval === 0);
          else { const weekOk = (Math.floor(dd / 7) % interval === 0); const wd = weekdayOf(cur); include = weekOk && (byday ? byday.indexOf(wd) >= 0 : wd === weekdayOf(s)); }
          if (include) { made++; if (cur.ms + durMs >= winStart && curDay <= winEnd) occ.push(cur); if (count != null && made >= count) break; }
          cur = shiftDays(cur, 1);
        }
      }
    }
    for (const o of occ) {
      const oDay = Date.UTC(o.y, o.mo - 1, o.d);
      if (o.ms + durMs < winStart || oDay > winEnd) continue;
      out.push({ title: ev.summary || '(busy)', allDay: !!o.allDay, start: fmtDt(o), end: o.allDay ? null : fmtInstant(o.ms + durMs, o.floating) });
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : (a.start > b.start ? 1 : 0)));
  return out;
}

module.exports = {
  configError, bearerFrom, userIdFromJwt,
  getFeed, saveFeed, deleteFeed, fetchIcs,
  parseIcs, expandWindow,
};
