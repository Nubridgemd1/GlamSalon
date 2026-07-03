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
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, 'public');
const BOOKING_EMAIL = process.env.BOOKING_EMAIL || 'info@glamsalondebeaute.com';
const BOOKING_PHONE = process.env.BOOKING_PHONE || '+12815412536';
// AT&T email-to-SMS gateway → delivers booking alerts as a text via Resend (no Twilio needed)
const BOOKING_SMS_EMAIL = process.env.BOOKING_SMS_EMAIL || '2815412536@txt.att.net';
const MAIL_FROM = process.env.GLAM_MAIL_FROM || 'Glam Salon de Beauté <no-reply@glamsalon.app>';

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

http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url === '/api/book' && req.method === 'POST') return handleBook(req, res);
  // static
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { fs.readFile(path.join(ROOT, 'index.html'), (e2, idx) => { if (e2) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx); }); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Glam Salon site running on http://localhost:${PORT}  (bookings → ${BOOKING_EMAIL} / ${BOOKING_PHONE})`));
