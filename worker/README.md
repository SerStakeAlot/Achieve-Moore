# Gala Checkout Worker

Tiny Cloudflare Worker that powers Stripe Embedded Checkout for the Hands of
Time Gala. It creates a Stripe Checkout Session and returns its `client_secret`.
Your Stripe **secret key** lives only here (as an encrypted secret) — never in
the website.

## What the website calls

`POST https://<your-worker-url>/api/create-checkout-session` → `{ "clientSecret": "..." }`

## One-time setup

1. Install Wrangler and log in to Cloudflare:
   ```bash
   cd worker
   npm install
   npx wrangler login
   ```

2. Add your Stripe **secret** key (starts with `sk_live_` for real payments, or
   `sk_test_` while testing). This is stored encrypted by Cloudflare:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

3. (Optional) Adjust price / name / allowed origins in `wrangler.toml`.
   `TICKET_AMOUNT` is in cents (27500 = $275.00).

4. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints your Worker URL, e.g.
   `https://gala-checkout.<your-subdomain>.workers.dev`.

## Connect the website

In `gala.html`, update `CHECKOUT_CONFIG`:

```js
stripePublishableKey: 'pk_live_...from Stripe dashboard...',
stripeSessionEndpoint: 'https://gala-checkout.<your-subdomain>.workers.dev/api/create-checkout-session',
```

Then uncomment the Stripe SDK line in the `<!-- PAYMENT SDKs -->` block:

```html
<script src="https://js.stripe.com/v3/"></script>
```

## Local testing

Create `worker/.dev.vars` (git-ignored) with a test key:

```
STRIPE_SECRET_KEY=sk_test_...
```

Then:

```bash
npx wrangler dev
```

Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC/ZIP.

## Notes

- The ticket price is set server-side in `wrangler.toml`, so it can't be
  altered from the browser.
- Add a webhook later if you want automatic email/attendee tracking beyond the
  Stripe dashboard.
