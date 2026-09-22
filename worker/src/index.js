/**
 * Achieve M.O.O.R.E — Gala Ticket Checkout (Cloudflare Worker)
 *
 * Creates a Stripe Embedded Checkout session and returns its client_secret.
 * The Stripe SECRET key never touches the website — it lives only here as an
 * encrypted Worker secret (set with: wrangler secret put STRIPE_SECRET_KEY).
 *
 * Endpoints:
 *   POST /api/create-checkout-session  -> { clientSecret }
 *   POST /api/notify                   -> { ok: true }   (early-bird waitlist)
 *   POST /api/stripe-webhook           -> Stripe calls this on every purchase;
 *                                         records the buyer + emails their seat link
 *   GET  /api/seats                    -> { taken: ["T1-S1", ...] }
 *   POST /api/seats/me                 -> { email, tickets, seats } (magic-link token)
 *   POST /api/seats/claim              -> claim seats (atomic, no double-booking)
 *   POST /api/seats/release            -> un-pick one of your seats
 *   POST /api/seats/resend             -> re-send the magic link to a buyer's email
 *   GET  /api/seats/admin?key=...      -> full seat list w/ emails (place cards)
 *   GET  /health                       -> "ok"
 */

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

// Floor plan: 16 round tables x 10 seats. Seat ids look like "T5-S7".
const SEAT_RE = /^T(1[0-6]|[1-9])-S(10|[1-9])$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }

    if (request.method === 'POST' && url.pathname === '/api/create-checkout-session') {
      return createSession(env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/notify') {
      return addToWaitlist(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/stripe-webhook') {
      return stripeWebhook(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/seats') {
      return listSeats(env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/seats/me') {
      return seatSession(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/seats/claim') {
      return claimSeats(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/seats/release') {
      return releaseSeat(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/seats/resend') {
      return resendLink(request, env, cors);
    }

    if (request.method === 'GET' && url.pathname === '/api/seats/admin') {
      return adminSeats(url, env, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  }
};

async function createSession(env, cors) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Server not configured' }, 500, cors);
  }

  // Ticket details come from Worker vars so price can't be tampered with client-side.
  const amount = env.TICKET_AMOUNT || '30000';        // cents
  const currency = (env.CURRENCY || 'usd').toLowerCase();
  const name = env.TICKET_NAME || 'Hands of Time Gala — Individual Ticket';

  const form = new URLSearchParams();
  form.set('ui_mode', 'embedded');
  form.set('mode', 'payment');
  form.set('redirect_on_completion', 'never'); // we show our own confirmation dialog
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', currency);
  form.set('line_items[0][price_data][unit_amount]', amount);
  form.set('line_items[0][price_data][product_data][name]', name);
  // Auto-generate an invoice (uses the account's default invoice template)
  // and email it to the buyer if "successful payments" emails are enabled.
  form.set('invoice_creation[enabled]', 'true');

  const resp = await fetch(STRIPE_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const data = await resp.json();

  if (!resp.ok) {
    return json({ error: data?.error?.message || 'Stripe error' }, 502, cors);
  }

  return json({ clientSecret: data.client_secret }, 200, cors);
}

async function addToWaitlist(request, env, cors) {
  if (!env.DB) {
    return json({ error: 'Waitlist storage not configured' }, 500, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400, cors);
  }

  const name = (body.name || '').toString().trim().slice(0, 120);
  const email = (body.email || '').toString().trim().toLowerCase();
  const phone = (body.phone || '').toString().trim();
  const source = (body.source || 'gala-early-bird').toString().slice(0, 64);

  if (!email && !phone) {
    return json({ error: 'Email or phone is required' }, 400, cors);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400, cors);
  }
  if (email.length > 254 || phone.length > 32) {
    return json({ error: 'Input too long' }, 400, cors);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO waitlist (name, email, phone, source, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = excluded.phone`
    ).bind(name || null, email || null, phone || null, source, new Date().toISOString()).run();
  } catch (err) {
    return json({ error: 'Could not save. Please try again.' }, 500, cors);
  }

  return json({ ok: true }, 200, cors);
}

/* ── Seat selection ─────────────────────────────────────────────────────── */

/**
 * Stripe calls this on every event we subscribe to. On
 * checkout.session.completed we record the buyer's email + ticket quantity
 * and email them their magic "pick your seats" link. Idempotent across
 * Stripe's webhook retries via the stripe_events table.
 */
async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.DB) {
    return json({ error: 'Server not configured' }, 500, {});
  }

  const payload = await request.text();
  const sig = request.headers.get('Stripe-Signature') || '';
  if (!(await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Invalid signature' }, 400, {});
  }

  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'Bad payload' }, 400, {}); }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true }, 200, {});
  }

  // Skip events we've already processed (Stripe retries on any hiccup).
  try {
    await env.DB.prepare('INSERT INTO stripe_events (event_id, created_at) VALUES (?, ?)')
      .bind(event.id, new Date().toISOString()).run();
  } catch {
    return json({ received: true, duplicate: true }, 200, {});
  }

  const session = event.data.object;
  const email = (session.customer_details?.email || session.customer_email || '')
    .trim().toLowerCase();
  const name = (session.customer_details?.name || '').slice(0, 120);
  if (!email) return json({ received: true }, 200, {});

  const qty = await sessionTicketQuantity(session.id, env);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO purchases (email, name, tickets, token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       tickets   = purchases.tickets + excluded.tickets,
       name      = COALESCE(NULLIF(excluded.name, ''), purchases.name),
       updated_at = excluded.updated_at`
  ).bind(email, name || null, qty, randomToken(), now, now).run();

  const buyer = await env.DB.prepare(
    'SELECT token, tickets FROM purchases WHERE email = ?'
  ).bind(email).first();

  // Best-effort — a failed email must not make Stripe retry (tickets already counted).
  try { await sendSeatLinkEmail(env, email, name, buyer.token, buyer.tickets); } catch {}

  return json({ received: true }, 200, {});
}

/** Verify Stripe's webhook signature (HMAC SHA-256 of "timestamp.payload"). */
async function verifyStripeSignature(payload, header, secret) {
  let timestamp = '';
  const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!timestamp || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // 5-min tolerance

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => timingSafeEqual(s, expected));
}

/** Payment Links can sell quantity > 1 — fetch line items to count tickets. */
async function sessionTicketQuantity(sessionId, env) {
  try {
    const resp = await fetch(`${STRIPE_API}/${sessionId}/line_items?limit=100`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const data = await resp.json();
    if (resp.ok && Array.isArray(data.data)) {
      const total = data.data.reduce((n, li) => n + (li.quantity || 0), 0);
      if (total > 0) return total;
    }
  } catch {}
  return 1;
}

/** Email the buyer their magic seat-selection link (via Resend). */
async function sendSeatLinkEmail(env, email, name, token, tickets) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;

  const site = (env.SITE_URL || 'https://achievemoorefoundation.org').replace(/\/$/, '');
  const link = `${site}/seating?t=${token}`;
  const seatWord = tickets === 1 ? 'seat' : 'seats';
  const first = (name || '').split(' ')[0];

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Choose your seats — Hands of Time Gala',
      html: `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
  <h1 style="color:#c8920a;font-weight:600;font-size:26px;margin:0 0 6px;">Hands of Time Gala</h1>
  <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#999;margin:0 0 24px;">December 5, 2026 · Hyatt Regency Villa Christina</p>
  <p style="font-size:15px;line-height:1.7;">${first ? `Dear ${escapeHtml(first)},` : 'Hello,'}</p>
  <p style="font-size:15px;line-height:1.7;">Thank you for supporting Achieve M.O.O.R.E! You have <strong>${tickets} ${seatWord}</strong> to choose for the gala. Pick exactly where you'd like to sit:</p>
  <p style="text-align:center;margin:30px 0;">
    <a href="${link}" style="background:#c8920a;color:#ffffff;text-decoration:none;padding:14px 34px;border-radius:999px;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,sans-serif;">Choose My Seats</a>
  </p>
  <p style="font-size:12px;color:#888;line-height:1.7;">This link is unique to you — please don't share it. If the button doesn't work, copy this address into your browser:<br><a href="${link}" style="color:#c8920a;">${link}</a></p>
</div>`
    })
  });
  return resp.ok;
}

/** Public map data — which seats are taken (no personal info). */
async function listSeats(env, cors) {
  if (!env.DB) return json({ error: 'Not configured' }, 500, cors);
  const { results } = await env.DB.prepare('SELECT seat_id FROM seats').all();
  return json({ taken: results.map(r => r.seat_id) }, 200, cors);
}

/** Look up a buyer by magic-link token. */
async function findBuyer(env, token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  return env.DB.prepare(
    'SELECT email, name, tickets, token FROM purchases WHERE token = ?'
  ).bind(token).first();
}

/** POST { token } -> the buyer's allowance and current picks. */
async function seatSession(request, env, cors) {
  if (!env.DB) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const buyer = await findBuyer(env, body.token);
  if (!buyer) return json({ error: 'Link not recognized. Try re-sending it below.' }, 404, cors);

  const { results } = await env.DB.prepare(
    'SELECT seat_id, guest_name FROM seats WHERE email = ?'
  ).bind(buyer.email).all();

  return json({
    email: buyer.email,
    name: buyer.name || '',
    tickets: buyer.tickets,
    seats: results.map(r => ({ seatId: r.seat_id, guestName: r.guest_name || '' }))
  }, 200, cors);
}

/** POST { token, seats: [{ seatId, guestName? }] } -> claim seats atomically. */
async function claimSeats(request, env, cors) {
  if (!env.DB) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const buyer = await findBuyer(env, body.token);
  if (!buyer) return json({ error: 'Link not recognized' }, 404, cors);

  const wanted = Array.isArray(body.seats) ? body.seats.slice(0, 20) : [];
  const seen = new Set();
  const picks = [];
  for (const s of wanted) {
    const id = (s?.seatId || '').toString().trim().toUpperCase();
    if (!SEAT_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ id, guest: (s?.guestName || '').toString().trim().slice(0, 80) });
  }
  if (picks.length === 0) return json({ error: 'No valid seats selected' }, 400, cors);

  const already = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM seats WHERE email = ?'
  ).bind(buyer.email).first();
  const remaining = buyer.tickets - (already?.n || 0);
  if (picks.length > remaining) {
    return json({
      error: remaining <= 0
        ? 'You have already chosen all of your seats.'
        : `You can choose ${remaining} more seat${remaining === 1 ? '' : 's'}.`
    }, 400, cors);
  }

  const now = new Date().toISOString();
  try {
    // D1 batch = single transaction: all seats claimed, or none.
    await env.DB.batch(picks.map(p =>
      env.DB.prepare(
        'INSERT INTO seats (seat_id, email, guest_name, claimed_at) VALUES (?, ?, ?, ?)'
      ).bind(p.id, buyer.email, p.guest || null, now)
    ));
  } catch {
    // Someone beat them to at least one seat — report which are now taken.
    const placeholders = picks.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT seat_id FROM seats WHERE seat_id IN (${placeholders})`
    ).bind(...picks.map(p => p.id)).all();
    return json({
      error: 'One or more of those seats was just taken. Please pick again.',
      taken: results.map(r => r.seat_id)
    }, 409, cors);
  }

  return json({ ok: true, claimed: picks.map(p => p.id) }, 200, cors);
}

/** POST { token, seatId } -> release one of the buyer's own seats. */
async function releaseSeat(request, env, cors) {
  if (!env.DB) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const buyer = await findBuyer(env, body.token);
  if (!buyer) return json({ error: 'Link not recognized' }, 404, cors);

  const id = (body.seatId || '').toString().trim().toUpperCase();
  if (!SEAT_RE.test(id)) return json({ error: 'Invalid seat' }, 400, cors);

  await env.DB.prepare('DELETE FROM seats WHERE seat_id = ? AND email = ?')
    .bind(id, buyer.email).run();
  return json({ ok: true }, 200, cors);
}

/** POST { email } -> re-send the magic link. Always responds ok (no email fishing). */
async function resendLink(request, env, cors) {
  if (!env.DB) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: 'Invalid email address' }, 400, cors);
  }

  const buyer = await env.DB.prepare(
    'SELECT email, name, tickets, token FROM purchases WHERE email = ?'
  ).bind(email).first();

  if (buyer) {
    try { await sendSeatLinkEmail(env, buyer.email, buyer.name, buyer.token, buyer.tickets); } catch {}
  }
  // Same response whether or not the email exists.
  return json({ ok: true }, 200, cors);
}

/** GET ?key=ADMIN_KEY -> full seat chart with buyer emails, for place cards. */
async function adminSeats(url, env, cors) {
  if (!env.DB || !env.ADMIN_KEY) return json({ error: 'Not configured' }, 500, cors);
  const key = url.searchParams.get('key') || '';
  if (!timingSafeEqual(key, env.ADMIN_KEY)) return json({ error: 'Unauthorized' }, 401, cors);

  const { results } = await env.DB.prepare(
    `SELECT s.seat_id, s.email, s.guest_name, s.claimed_at, p.name AS buyer_name, p.tickets
     FROM seats s LEFT JOIN purchases p ON p.email = s.email
     ORDER BY s.seat_id`
  ).all();
  return json({ seats: results }, 200, cors);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Echo the origin only if it's in the allow-list; otherwise fall back to the first allowed.
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '');

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
