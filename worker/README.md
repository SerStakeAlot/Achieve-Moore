# Gala Checkout Worker

Tiny Cloudflare Worker that powers Stripe Embedded Checkout for the Hands of
Time Gala. It creates a Stripe Checkout Session and returns its `client_secret`.
Your Stripe **secret key** lives only here (as an encrypted secret) — never in
the website.

## Endpoints

- `POST /api/create-checkout-session` → `{ "clientSecret": "..." }` (Stripe checkout)
- `POST /api/notify` → `{ "ok": true }` (early-bird waitlist signup)
- `GET  /health` → `ok`

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

3. Create the D1 database for the early-bird waitlist and apply the schema:
   ```bash
   npx wrangler d1 create gala-waitlist
   # Copy the printed database_id into wrangler.toml (database_id = "...")
   npx wrangler d1 execute gala-waitlist --file=./schema.sql --remote
   ```

4. (Optional) Adjust price / name / allowed origins in `wrangler.toml`.
   `TICKET_AMOUNT` is in cents (27500 = $275.00).

5. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints your Worker URL, e.g.
   `https://gala-checkout.<your-subdomain>.workers.dev`.

## Connect the website

In `gala.html`, update `CHECKOUT_CONFIG`:

```js
// Early-bird waitlist (active now):
notifyEndpoint: 'https://gala-checkout.<your-subdomain>.workers.dev/api/notify',

// Stripe checkout (for when tickets go live):
stripePublishableKey: 'pk_live_...from Stripe dashboard...',
stripeSessionEndpoint: 'https://gala-checkout.<your-subdomain>.workers.dev/api/create-checkout-session',
```

Then uncomment the Stripe SDK line in the `<!-- PAYMENT SDKs -->` block:

```html
<script src="https://js.stripe.com/v3/"></script>
```

## Viewing / exporting waitlist signups

```bash
# Count signups
npx wrangler d1 execute gala-waitlist --remote --command "SELECT COUNT(*) FROM waitlist;"

# List everyone
npx wrangler d1 execute gala-waitlist --remote --command "SELECT email, phone, created_at FROM waitlist ORDER BY created_at DESC;"
```

## Local testing

Create `worker/.dev.vars` (git-ignored) with a test key:

```
STRIPE_SECRET_KEY=sk_test_...
```

Then:

```bash
npx wrangler d1 execute gala-waitlist --file=./schema.sql   # local DB
npx wrangler dev
```

Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC/ZIP.

## Notes

- The ticket price is set server-side in `wrangler.toml`, so it can't be
  altered from the browser.
- Waitlist emails are de-duplicated (unique email); re-signing up just updates
  the phone number.
- Add a webhook later if you want automatic email/attendee tracking beyond the
  Stripe dashboard.
