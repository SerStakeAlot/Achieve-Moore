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
 *   POST /api/scholarship/apply        -> submit a $10K scholarship application
 *   POST /api/scholarship/upload/start    -> begin a chunked video upload to R2
 *   POST /api/scholarship/upload/part     -> upload one chunk (body = bytes)
 *   POST /api/scholarship/upload/complete -> finish the upload -> { videoKey }
 *   GET  /api/scholarship/video?key&k     -> stream/download a video (board only)
 *   POST /api/scholarship/entries      -> { key } -> all entries + reviews (board only)
 *   POST /api/scholarship/review       -> { key, applicationId, reviewer, score, note }
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

    if (request.method === 'POST' && url.pathname === '/api/scholarship/apply') {
      return scholarshipApply(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/scholarship/upload/start') {
      return uploadStart(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/scholarship/upload/part') {
      return uploadPart(request, url, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/scholarship/upload/complete') {
      return uploadComplete(request, env, cors);
    }

    if (request.method === 'GET' && url.pathname === '/api/scholarship/video') {
      return serveVideo(request, url, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/scholarship/entries') {
      return scholarshipEntries(request, env, cors);
    }

    if (request.method === 'POST' && url.pathname === '/api/scholarship/review') {
      return scholarshipReview(request, env, cors);
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

/* ── $10,000 Scholarship ────────────────────────────────────────────────── */

const AUC_SCHOOLS = ['Clark Atlanta University', 'Morehouse College', 'Morris Brown College', 'Spelman College'];

// Direct video uploads: chunked through the Worker into R2 (each part stays
// well under the Workers request-body limit).
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm' };
const MAX_VIDEO_BYTES = 512 * 1024 * 1024; // 512 MB
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;  // 8 MB chunks (R2 multipart min is 5 MB)
const MAX_PART_BYTES = 32 * 1024 * 1024;
const VIDEO_KEY_RE = /^videos\/[\w.-]{8,80}$/;

function pastDeadline(env) {
  const deadline = Date.parse(env.SCHOLARSHIP_DEADLINE || '2026-11-24T04:59:59Z');
  return !Number.isNaN(deadline) && Date.now() > deadline;
}

/**
 * Normalize a YouTube or Google Drive share link into an embeddable URL.
 * Returns null if the link isn't one we can embed (the review page then
 * falls back to showing it as a plain link).
 */
function videoEmbedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    let id = u.searchParams.get('v') || '';
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,20})/);
    if (!id && m) id = m[2];
    return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host === 'drive.google.com') {
    const m = u.pathname.match(/\/file\/d\/([\w-]{10,})/);
    if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
    const id = u.searchParams.get('id');
    if (u.pathname.startsWith('/open') && id && /^[\w-]{10,}$/.test(id)) {
      return `https://drive.google.com/file/d/${id}/preview`;
    }
  }
  return null;
}

/** POST — submit (or re-submit, same email) a scholarship application. */
async function scholarshipApply(request, env, cors) {
  if (!env.DB) return json({ error: 'Server not configured' }, 500, cors);

  // Hard stop after the deadline (set as a var so it's easy to extend).
  if (pastDeadline(env)) {
    return json({ error: 'The application window has closed. Follow @achievemoore for finalist announcements!' }, 400, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const s = (v, max) => (v || '').toString().trim().slice(0, max);
  const firstName = s(body.firstName, 80);
  const lastName = s(body.lastName, 80);
  const email = s(body.email, 254).toLowerCase();
  const phone = s(body.phone, 32);
  const school = s(body.school, 60);
  const major = s(body.major, 120);
  const classification = s(body.classification, 30);
  const gradTerm = s(body.gradTerm, 30);
  const gpa = s(body.gpa, 10);
  const serviceHours = s(body.serviceHours, 10);
  const involvement = s(body.campusInvolvement, 2000);
  const videoUrl = s(body.videoUrl, 500);
  const videoKey = s(body.videoKey, 120);
  const videoName = s(body.videoName, 200);

  if (!firstName || !lastName) return json({ error: 'Please enter your full name.' }, 400, cors);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400, cors);
  if (!AUC_SCHOOLS.includes(school)) return json({ error: 'Please select your AUC institution.' }, 400, cors);

  const gpaNum = Number(gpa);
  if (!Number.isFinite(gpaNum) || gpaNum < 3.0 || gpaNum > 4.0) {
    return json({ error: 'A 3.0+ cumulative GPA is required to apply.' }, 400, cors);
  }
  const hoursNum = Number(serviceHours);
  if (!Number.isFinite(hoursNum) || hoursNum < 200) {
    return json({ error: '200+ community service hours are required to apply.' }, 400, cors);
  }

  // The video: either a file they uploaded to us (videoKey) or a pasted link.
  let embed = null;
  if (videoKey) {
    if (!VIDEO_KEY_RE.test(videoKey) || !env.VIDEOS) {
      return json({ error: 'Video upload not recognized — please try uploading again.' }, 400, cors);
    }
    const head = await env.VIDEOS.head(videoKey);
    if (!head) {
      return json({ error: 'Your video upload didn’t finish — please upload it again.' }, 400, cors);
    }
  } else {
    if (!/^https?:\/\//i.test(videoUrl)) {
      return json({ error: 'Please upload your 90-second video or paste a link to it.' }, 400, cors);
    }
    embed = videoEmbedUrl(videoUrl);
    if (!embed) {
      return json({ error: 'That link doesn’t look like a YouTube or Google Drive video. Please paste a YouTube (unlisted) or Google Drive share link.' }, 400, cors);
    }
  }

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO scholarship_applications
         (first_name, last_name, email, phone, school, major, classification,
          grad_term, gpa, service_hours, campus_involvement, video_url, video_embed,
          video_key, video_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         first_name = excluded.first_name,  last_name = excluded.last_name,
         phone = excluded.phone,            school = excluded.school,
         major = excluded.major,            classification = excluded.classification,
         grad_term = excluded.grad_term,    gpa = excluded.gpa,
         service_hours = excluded.service_hours,
         campus_involvement = excluded.campus_involvement,
         video_url = excluded.video_url,    video_embed = excluded.video_embed,
         video_key = excluded.video_key,    video_name = excluded.video_name,
         updated_at = ?`
    ).bind(firstName, lastName, email, phone || null, school, major || null,
           classification || null, gradTerm || null, gpa, serviceHours,
           involvement || null, videoKey ? null : videoUrl, embed,
           videoKey || null, videoKey ? (videoName || null) : null, now, now).run();
  } catch {
    return json({ error: 'Could not save your application. Please try again.' }, 500, cors);
  }

  // Best-effort confirmation email — never fail the submission over it.
  try { await sendApplicationReceivedEmail(env, email, firstName); } catch {}

  return json({ ok: true }, 200, cors);
}

/** Confirmation email to the applicant (via Resend). */
async function sendApplicationReceivedEmail(env, email, firstName) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: 'Application received — $10,000 Scholarship',
      html: `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
  <h1 style="color:#c8920a;font-weight:600;font-size:26px;margin:0 0 6px;">$10,000 for 10 Years</h1>
  <p style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#999;margin:0 0 24px;">The Achieve M.O.O.R.E Foundation Scholarship</p>
  <p style="font-size:15px;line-height:1.7;">${firstName ? `Dear ${escapeHtml(firstName)},` : 'Hello,'}</p>
  <p style="font-size:15px;line-height:1.7;">We received your scholarship application — thank you for sharing your story with us. Our board reviews every entry, and the <strong>Top 4 finalists</strong> will be announced on <strong>November 25</strong> and invited to the Hands of Time Gala, where the Grand Scholar is revealed live on <strong>December 5, 2026</strong>.</p>
  <p style="font-size:15px;line-height:1.7;">Need to fix something? Just re-submit the form with the same email before November 23 — your newest answers replace the old ones.</p>
  <p style="font-size:15px;line-height:1.7;">Your time is now.<br>— The Achieve M.O.O.R.E Foundation</p>
</div>`
    })
  });
  return resp.ok;
}

/* ── Direct video uploads (chunked, into R2) ─────────────────────────────── */

/** POST { fileName, fileSize, contentType } -> { key, uploadId, partSize } */
async function uploadStart(request, env, cors) {
  if (!env.VIDEOS) return json({ error: 'Uploads not configured' }, 500, cors);
  if (pastDeadline(env)) {
    return json({ error: 'The application window has closed.' }, 400, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const fileName = (body.fileName || '').toString().slice(0, 200);
  const fileSize = Number(body.fileSize);
  const contentType = (body.contentType || '').toString().toLowerCase();

  let ext = VIDEO_EXT[contentType];
  if (!ext) {
    // Some browsers report an empty/odd MIME type — fall back to the extension.
    const m = fileName.toLowerCase().match(/\.(mp4|mov|m4v|webm)$/);
    ext = m && m[1];
  }
  if (!ext) {
    return json({ error: 'Please upload an MP4 or MOV video file.' }, 400, cors);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_VIDEO_BYTES) {
    return json({ error: 'Videos can be up to 512 MB. Try exporting at a lower resolution — 1080p is plenty.' }, 400, cors);
  }

  const key = `videos/${Date.now()}-${randomToken().slice(0, 12)}.${ext}`;
  const mpu = await env.VIDEOS.createMultipartUpload(key, {
    httpMetadata: { contentType: VIDEO_EXT[contentType] ? contentType : 'video/mp4' }
  });
  return json({ key, uploadId: mpu.uploadId, partSize: UPLOAD_PART_SIZE }, 200, cors);
}

/** POST ?key&uploadId&part=N, body = raw chunk bytes -> { partNumber, etag } */
async function uploadPart(request, url, env, cors) {
  if (!env.VIDEOS) return json({ error: 'Uploads not configured' }, 500, cors);

  const key = url.searchParams.get('key') || '';
  const uploadId = (url.searchParams.get('uploadId') || '').slice(0, 512);
  const part = Number(url.searchParams.get('part'));

  if (!VIDEO_KEY_RE.test(key) || !uploadId) return json({ error: 'Invalid upload' }, 400, cors);
  if (!Number.isInteger(part) || part < 1 || part > Math.ceil(MAX_VIDEO_BYTES / UPLOAD_PART_SIZE) + 1) {
    return json({ error: 'Invalid part number' }, 400, cors);
  }

  let data;
  try { data = await request.arrayBuffer(); } catch { return json({ error: 'Invalid request' }, 400, cors); }
  if (!data.byteLength || data.byteLength > MAX_PART_BYTES) {
    return json({ error: 'Invalid chunk size' }, 400, cors);
  }

  try {
    const mpu = env.VIDEOS.resumeMultipartUpload(key, uploadId);
    const p = await mpu.uploadPart(part, data);
    return json({ partNumber: p.partNumber, etag: p.etag }, 200, cors);
  } catch {
    return json({ error: 'Upload interrupted — please try again.' }, 400, cors);
  }
}

/** POST { key, uploadId, parts: [{ partNumber, etag }] } -> { ok, videoKey } */
async function uploadComplete(request, env, cors) {
  if (!env.VIDEOS) return json({ error: 'Uploads not configured' }, 500, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }

  const key = (body.key || '').toString();
  const uploadId = (body.uploadId || '').toString().slice(0, 512);
  const parts = Array.isArray(body.parts) ? body.parts.slice(0, 200).map(p => ({
    partNumber: Number(p.partNumber),
    etag: (p.etag || '').toString().slice(0, 512)
  })) : [];

  if (!VIDEO_KEY_RE.test(key) || !uploadId || parts.length === 0) {
    return json({ error: 'Invalid upload' }, 400, cors);
  }

  try {
    const mpu = env.VIDEOS.resumeMultipartUpload(key, uploadId);
    const obj = await mpu.complete(parts);
    if (obj.size > MAX_VIDEO_BYTES) {
      await env.VIDEOS.delete(key);
      return json({ error: 'Videos can be up to 512 MB.' }, 400, cors);
    }
    return json({ ok: true, videoKey: key }, 200, cors);
  } catch {
    return json({ error: 'Upload could not be completed — please try again.' }, 400, cors);
  }
}

/** GET ?key=videos/...&k=BOARD_KEY[&dl=1] -> stream the video (board only). */
async function serveVideo(request, url, env, cors) {
  if (!env.VIDEOS || !env.BOARD_KEY) return json({ error: 'Not configured' }, 500, cors);

  const k = url.searchParams.get('k') || '';
  if (!timingSafeEqual(k, env.BOARD_KEY)) return json({ error: 'Unauthorized' }, 401, cors);

  const key = url.searchParams.get('key') || '';
  if (!VIDEO_KEY_RE.test(key)) return json({ error: 'Not found' }, 404, cors);

  // Range support so <video> can seek (and Safari will play at all).
  const rangeHeader = request.headers.get('Range') || '';
  const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);

  let obj;
  if (m) {
    const offset = Number(m[1]);
    const end = m[2] ? Number(m[2]) : NaN;
    const range = Number.isFinite(end) ? { offset, length: end - offset + 1 } : { offset };
    obj = await env.VIDEOS.get(key, { range });
  } else {
    obj = await env.VIDEOS.get(key);
  }
  if (!obj) return json({ error: 'Not found' }, 404, cors);

  const headers = {
    ...cors,
    'Content-Type': obj.httpMetadata?.contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600'
  };
  if (url.searchParams.get('dl')) {
    headers['Content-Disposition'] = `attachment; filename="${key.split('/').pop()}"`;
  }

  if (m && obj.range) {
    const start = obj.range.offset;
    const len = obj.range.length ?? (obj.size - start);
    headers['Content-Range'] = `bytes ${start}-${start + len - 1}/${obj.size}`;
    headers['Content-Length'] = String(len);
    return new Response(obj.body, { status: 206, headers });
  }

  headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { status: 200, headers });
}

/** Board access: the shared BOARD_KEY secret guards entries + reviews. */
function boardAuthorized(body, env) {
  return !!env.BOARD_KEY && timingSafeEqual((body?.key || '').toString(), env.BOARD_KEY);
}

/** POST { key } -> every application with all board reviews attached. */
async function scholarshipEntries(request, env, cors) {
  if (!env.DB || !env.BOARD_KEY) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }
  if (!boardAuthorized(body, env)) return json({ error: 'Unauthorized' }, 401, cors);

  const { results: apps } = await env.DB.prepare(
    `SELECT id, first_name, last_name, email, phone, school, major, classification,
            grad_term, gpa, service_hours, campus_involvement, video_url, video_embed,
            video_key, video_name, created_at, updated_at
     FROM scholarship_applications ORDER BY created_at DESC`
  ).all();

  const { results: reviews } = await env.DB.prepare(
    'SELECT application_id, reviewer, score, note, updated_at FROM scholarship_reviews'
  ).all();

  const byApp = new Map();
  for (const r of reviews) {
    if (!byApp.has(r.application_id)) byApp.set(r.application_id, []);
    byApp.get(r.application_id).push({
      reviewer: r.reviewer, score: r.score, note: r.note || '', updatedAt: r.updated_at
    });
  }

  return json({
    entries: apps.map(a => ({
      id: a.id,
      firstName: a.first_name, lastName: a.last_name,
      email: a.email, phone: a.phone || '',
      school: a.school, major: a.major || '',
      classification: a.classification || '', gradTerm: a.grad_term || '',
      gpa: a.gpa, serviceHours: a.service_hours,
      campusInvolvement: a.campus_involvement || '',
      videoUrl: a.video_url || '', videoEmbed: a.video_embed || '',
      videoKey: a.video_key || '', videoName: a.video_name || '',
      createdAt: a.created_at, updatedAt: a.updated_at || '',
      reviews: byApp.get(a.id) || []
    }))
  }, 200, cors);
}

/** POST { key, applicationId, reviewer, score, note } -> upsert one review. */
async function scholarshipReview(request, env, cors) {
  if (!env.DB || !env.BOARD_KEY) return json({ error: 'Not configured' }, 500, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400, cors); }
  if (!boardAuthorized(body, env)) return json({ error: 'Unauthorized' }, 401, cors);

  const appId = Number(body.applicationId);
  const reviewer = (body.reviewer || '').toString().trim().slice(0, 80);
  const note = (body.note || '').toString().trim().slice(0, 2000);
  const score = body.score == null || body.score === '' ? null : Number(body.score);

  if (!Number.isInteger(appId) || appId <= 0) return json({ error: 'Invalid application' }, 400, cors);
  if (!reviewer) return json({ error: 'Please enter your name first.' }, 400, cors);
  if (score != null && (!Number.isInteger(score) || score < 1 || score > 5)) {
    return json({ error: 'Score must be 1-5' }, 400, cors);
  }

  const exists = await env.DB.prepare('SELECT id FROM scholarship_applications WHERE id = ?')
    .bind(appId).first();
  if (!exists) return json({ error: 'Application not found' }, 404, cors);

  await env.DB.prepare(
    `INSERT INTO scholarship_reviews (application_id, reviewer, score, note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(application_id, reviewer) DO UPDATE SET
       score = excluded.score, note = excluded.note, updated_at = excluded.updated_at`
  ).bind(appId, reviewer, score, note || null, new Date().toISOString()).run();

  return json({ ok: true }, 200, cors);
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
