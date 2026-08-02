/**
 * Achieve M.O.O.R.E — Gala Ticket Checkout (Cloudflare Worker)
 *
 * Creates a Stripe Embedded Checkout session and returns its client_secret.
 * The Stripe SECRET key never touches the website — it lives only here as an
 * encrypted Worker secret (set with: wrangler secret put STRIPE_SECRET_KEY).
 *
 * Endpoints:
 *   POST /api/create-checkout-session  -> { clientSecret }
 *   GET  /health                       -> "ok"
 */

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

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

    return json({ error: 'Not found' }, 404, cors);
  }
};

async function createSession(env, cors) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Server not configured' }, 500, cors);
  }

  // Ticket details come from Worker vars so price can't be tampered with client-side.
  const amount = env.TICKET_AMOUNT || '27500';        // cents
  const currency = (env.CURRENCY || 'usd').toLowerCase();
  const name = env.TICKET_NAME || 'Hands of Time Gala — Early Bird Ticket';

  const form = new URLSearchParams();
  form.set('ui_mode', 'embedded');
  form.set('mode', 'payment');
  form.set('redirect_on_completion', 'never'); // we show our own confirmation dialog
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', currency);
  form.set('line_items[0][price_data][unit_amount]', amount);
  form.set('line_items[0][price_data][product_data][name]', name);

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
