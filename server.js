'use strict';

/**
 * Glam Salon de Beauté — static site + real-time booking notifications.
 * Zero npm dependencies (uses built-in http + global fetch).
 *
 * Booking requests (POST /api/book) are delivered in real time to:
 *   • Email  -> BOOKING_EMAIL (default info@glamsalondebeaute.com) via Resend
 *   • SMS    -> BOOKING_PHONE (default +12815412536) via Twilio
 * Each channel activates only when its env keys are present:
 *   Email: RESEND_API_KEY (+ GLAM_MAIL_FROM, a verified Resend sender)
 *   SMS:   TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, 'public');
const BOOKING_EMAIL = process.env.BOOKING_EMAIL || 'info@glamsalondebeaute.com';
const BOOKING_PHONE = process.env.BOOKING_PHONE || '+12815412536';
// AT&T email-to-SMS gateway → delivers booking alerts as a text via Resend (no Twilio needed)
const BOOKING_SMS_EMAIL = process.env.BOOKING_SMS_EMAIL || '2815412536@txt.att.net';
const MAIL_FROM = process.env.GLAM_MAIL_FROM || 'Glam Salon de Beauté <no-reply@glamsalon.app>';

// ── Admin (braid-style photo manager) ──────────────────────────────
const STYLES_FILE = path.join(ROOT, 'styles.json');
const COOKIE = 'glam_admin';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_STYLES = 40;
const MAX_IMG_BYTES = 1_600_000; // per compressed image data URL (~1.6MB)

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.json': 'application/json', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function sendEmail(subject, lines) {
  if (!process.env.RESEND_API_KEY) return { skipped: true };
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px"><h2 style="color:#33102a;font-family:Georgia,serif">New appointment request</h2>`
    + lines.map(([k, val]) => `<p style="margin:4px 0"><b>${esc(k)}:</b> ${esc(val) || '—'}</p>`).join('')
    + `<p style="color:#999;font-size:12px;margin-top:16px">Sent from Glam Salon de Beauté booking form.</p></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: BOOKING_EMAIL, reply_to: undefined, subject, html }),
  });
  if (!res.ok) throw new Error('email ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return { ok: true };
}
// SMS via carrier email-to-text gateway (uses Resend; activates with RESEND_API_KEY)
async function sendGatewaySMS(text) {
  if (!process.env.RESEND_API_KEY || !BOOKING_SMS_EMAIL) return { skipped: true };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: BOOKING_SMS_EMAIL, subject: 'New booking', text }),
  });
  if (!res.ok) throw new Error('gateway-sms ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return { ok: true };
}
async function sendSMS(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) return { skipped: true };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: BOOKING_PHONE, From: process.env.TWILIO_FROM, Body: body }).toString(),
  });
  if (!res.ok) throw new Error('sms ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); });
}

async function handleBook(req, res) {
  try {
    const d = JSON.parse((await readBody(req)) || '{}');
    const name = String(d.name || '').trim(), phone = String(d.phone || '').trim();
    if (!name || !phone) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"name and phone are required"}'); }
    const fields = [['Name', name], ['Phone', phone], ['Email', d.email], ['Service', d.service], ['Date', d.date], ['Time', d.time], ['Notes', d.notes]];
    const smsText = `New booking — Glam Salon\n${name} · ${phone}\n${d.service || ''} ${d.date || ''} ${d.time || ''}`.trim();
    const results = await Promise.allSettled([
      sendEmail(`New booking: ${name} — ${d.service || 'appointment'}`, fields),
      sendGatewaySMS(smsText),   // text via AT&T email-to-SMS gateway
      sendSMS(smsText),          // text via Twilio (if configured)
    ]);
    console.log('[booking]', JSON.stringify({ name, phone, service: d.service, date: d.date, time: d.time }));
    const delivered = results.some(r => r.status === 'fulfilled' && r.value && r.value.ok);
    if (!delivered) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"booking notifications are not configured yet"}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
  }
}

/* ── admin: auth helpers ─────────────────────────────────────────── */
function sendJson(res, status, obj, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function verifyPassword(password) {
  const stored = process.env.ADMIN_PASSWORD_HASH || '';
  const idx = stored.indexOf(':');
  if (idx < 0) return false;
  const salt = stored.slice(0, idx), hash = stored.slice(idx + 1);
  let calc;
  try { calc = crypto.scryptSync(String(password), salt, 32).toString('hex'); } catch (e) { return false; }
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  const secret = process.env.SESSION_SECRET || '';
  if (!token || !secret) return null;
  const i = token.lastIndexOf('.'); if (i < 0) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sb = Buffer.from(sig), eb = Buffer.from(expect);
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); if (!p.exp || Date.now() > p.exp) return null; return p; }
  catch (e) { return null; }
}
function getCookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : null; }
function currentUser(req) { return verifyToken(getCookie(req, COOKIE)); }
function sameOrigin(req) { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } }
function readJsonBody(req, cap) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => { d += c; if (d.length > (cap || 12e6)) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve(null); } }); req.on('error', () => resolve(null)); });
}
const attempts = new Map();
function throttled(ip) { const a = attempts.get(ip); return a && a.until > Date.now(); }
function noteFail(ip) { const a = attempts.get(ip) || { n: 0, until: 0 }; a.n += 1; if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; } attempts.set(ip, a); }
function clearFail(ip) { attempts.delete(ip); }

/* ── admin: styles data ──────────────────────────────────────────── */
function readStyles() { try { return JSON.parse(fs.readFileSync(STYLES_FILE, 'utf8')); } catch (e) { return { styles: [] }; } }
function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('style-' + Date.now()); }
function validImage(v) {
  if (typeof v !== 'string' || !v) return '';
  if (/^https?:\/\//i.test(v) || v.startsWith('/')) return v.slice(0, 500);            // URL or site path
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(v) && v.length <= MAX_IMG_BYTES) return v; // uploaded photo
  return '';
}
function sanitizeStyles(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const CTRL = /[\u0000-\u001F\u007F]/g;
  for (const it of arr.slice(0, MAX_STYLES)) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || '').replace(CTRL, '').trim().slice(0, 80);
    if (!name) continue;
    out.push({
      id: slugify(it.id || name),
      name,
      price: String(it.price || '').replace(CTRL, '').trim().slice(0, 20),
      duration: String(it.duration || '').replace(CTRL, '').trim().slice(0, 40),
      desc: String(it.desc || '').replace(CTRL, '').trim().slice(0, 220),
      image: validImage(it.image),
    });
  }
  return out;
}

/* ── admin: GitHub commit (persistence across redeploys) ─────────── */
function githubApi(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({ hostname: 'api.github.com', path: urlPath, method,
      headers: Object.assign({ 'User-Agent': 'glam-admin', 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function commitFile(cpath, contentStr, message) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { committed: false, reason: 'no_token' };
  const repo = process.env.GIT_REPO || 'Nubridgemd1/GlamSalon';
  const branch = process.env.GIT_BRANCH || 'main';
  let sha;
  try {
    const get = await githubApi('GET', `/repos/${repo}/contents/${encodeURIComponent(cpath)}?ref=${branch}`, null, token);
    if (get.status === 200) { try { sha = JSON.parse(get.body).sha; } catch (e) {} }
  } catch (e) { return { committed: false, reason: 'github_unreachable' }; }
  try {
    const put = await githubApi('PUT', `/repos/${repo}/contents/${encodeURIComponent(cpath)}`, {
      message, content: Buffer.from(contentStr).toString('base64'), branch, ...(sha ? { sha } : {}) }, token);
    if (put.status === 200 || put.status === 201) return { committed: true };
    return { committed: false, reason: 'github_status_' + put.status };
  } catch (e) { return { committed: false, reason: 'github_unreachable' }; }
}

/* ── admin: routing ──────────────────────────────────────────────── */
async function handleAdmin(req, res, pathname) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (pathname === '/admin' || pathname === '/admin/') return serveStatic(res, '/admin.html');

  if (pathname === '/admin/api/session') {
    const u = currentUser(req);
    const configured = !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH && process.env.SESSION_SECRET);
    return sendJson(res, 200, { authed: !!u, email: u ? u.email : null, configured, persists: !!process.env.GITHUB_TOKEN });
  }
  if (pathname === '/admin/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'bad_origin' });
    if (throttled(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
    const body = await readJsonBody(req, 1e5);
    const email = (body && String(body.email || '')).trim().toLowerCase();
    const okEmail = email && email === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!okEmail || !verifyPassword(body && body.password)) { noteFail(ip); return sendJson(res, 401, { error: 'invalid_credentials' }); }
    clearFail(ip);
    const token = signToken({ email, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
    return sendJson(res, 200, { authed: true, email }, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
  }
  if (pathname === '/admin/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { authed: false }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
  }
  if (pathname === '/admin/api/styles' && req.method === 'GET') {
    if (!currentUser(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, readStyles());
  }
  if (pathname === '/admin/api/styles' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'unauthorized' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'bad_origin' });
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { error: 'bad_body' });
    const styles = sanitizeStyles(body.styles);
    const jsonStr = JSON.stringify({ styles }, null, 2) + '\n';
    try { fs.writeFileSync(STYLES_FILE, jsonStr); } catch (e) { return sendJson(res, 500, { error: 'write_failed' }); }
    const result = await commitFile(process.env.STYLES_PATH || 'public/styles.json', jsonStr, `admin: update braid styles (${u.email})`);
    return sendJson(res, 200, { saved: true, count: styles.length, committed: result.committed,
      note: result.committed ? 'Saved and published.' : 'Saved on this server; add GITHUB_TOKEN so it survives the next redeploy.', reason: result.reason });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url === '/api/book' && req.method === 'POST') return handleBook(req, res);
  const pn = req.url.split('?')[0];
  if (pn === '/api/styles' && req.method === 'GET') {
    return fs.readFile(STYLES_FILE, (e, d) => { res.writeHead(e ? 200 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(e ? '{"styles":[]}' : d); });
  }
  if (pn === '/admin' || pn.startsWith('/admin/')) { handleAdmin(req, res, pn).catch(() => { try { sendJson(res, 500, { error: 'server_error' }); } catch (e) {} }); return; }
  return serveStatic(res, req.url);
}).listen(PORT, () => console.log(`Glam Salon site running on http://localhost:${PORT}  (bookings → ${BOOKING_EMAIL} / ${BOOKING_PHONE})`));

function serveStatic(res, rawPath) {
  let p = decodeURIComponent(rawPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => { if (e2) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx); }); return; }
    const noStore = file === STYLES_FILE;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': noStore ? 'no-store' : 'public, max-age=300' });
    res.end(data);
  });
}
