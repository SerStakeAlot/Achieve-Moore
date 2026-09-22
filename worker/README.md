# Gala Checkout Worker

Tiny Cloudflare Worker that powers Stripe Embedded Checkout for the Hands of
Time Gala. It creates a Stripe Checkout Session and returns its `client_secret`.
Your Stripe **secret key** lives only here (as an encrypted secret) — never in
the website. It also powers **seat selection** (`seating.html`): a Stripe
webhook records every ticket purchase and emails the buyer a magic
"choose your seats" link automatically.

## Endpoints

- `POST /api/create-checkout-session` → `{ "clientSecret": "..." }` (Stripe checkout)
- `POST /api/notify` → `{ "ok": true }` (early-bird waitlist signup)
- `POST /api/stripe-webhook` → called by Stripe on each purchase; records buyer + emails seat link
- `GET  /api/seats` → `{ "taken": ["T1-S1", ...] }` (public, no personal info)
- `POST /api/seats/me` → buyer's allowance + picks (requires magic-link token)
- `POST /api/seats/claim` → claim seats (transactional — double-booking impossible)
- `POST /api/seats/release` → un-pick one of your own seats
- `POST /api/seats/resend` → re-send the magic link to a buyer's email
- `GET  /api/seats/admin?key=ADMIN_KEY` → full seat chart w/ emails (for place cards)
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
   `TICKET_AMOUNT` is in cents (30000 = $300.00).

5. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints your Worker URL, e.g.
   `https://gala-checkout.<your-subdomain>.workers.dev`.

## Seat selection setup

Seat picking works like a movie-theater checkout: buyers get an emailed magic
link, open `/seating`, and claim seats on a live map (16 tables × 10 seats).
The D1 `seats` table's primary key makes double-booking impossible.

1. **Apply the updated schema** (adds `purchases`, `seats`, `stripe_events`):
   ```bash
   npx wrangler d1 execute gala-waitlist --file=./schema.sql --remote
   ```

2. **Stripe webhook** — Stripe Dashboard → Developers → Webhooks → *Add endpoint*:
   - Endpoint URL: `https://gala-checkout.<your-subdomain>.workers.dev/api/stripe-webhook`
   - Events: select only `checkout.session.completed`
   - Copy the *Signing secret* (`whsec_...`) and store it:
     ```bash
     npx wrangler secret put STRIPE_WEBHOOK_SECRET
     ```
   This fires for your existing Payment Link (`buy.stripe.com/...`) too — no
   changes needed to the link itself.

3. **Email sending (Resend)** — sign up at [resend.com](https://resend.com)
   (free tier: 100 emails/day), verify the `achievemoorefoundation.org` domain
   (they give you 2–3 DNS records to add), create an API key, then:
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
   The from-address is `EMAIL_FROM` in `wrangler.toml`.

4. **Admin key** (for the seat-chart export):
   ```bash
   npx wrangler secret put ADMIN_KEY     # any long random string
   ```

5. **Point the website at the Worker** — in `seating.html`, set
   `SEATING_CONFIG.apiBase` to your Worker URL.

6. Redeploy: `npx wrangler deploy`

### Backfill buyers who purchased before the webhook existed

Find their emails in the Stripe Dashboard (Payments), then for each buyer run
(one seat-claimable ticket per unit of `tickets`):

```bash
npx wrangler d1 execute gala-waitlist --remote --command \
  "INSERT INTO purchases (email, name, tickets, token, created_at) VALUES \
   ('buyer@example.com', 'Buyer Name', 2, lower(hex(randomblob(24))), datetime('now'));"
```

Then send them their link either by asking them to use the *Email My Seat
Link* box on `/seating`, or trigger it yourself:

```bash
curl -X POST https://gala-checkout.<your-subdomain>.workers.dev/api/seats/resend \
  -H 'Content-Type: application/json' -d '{"email":"buyer@example.com"}'
```

### Viewing the seat chart (place cards)

```bash
curl "https://gala-checkout.<your-subdomain>.workers.dev/api/seats/admin?key=YOUR_ADMIN_KEY"
# or straight from D1:
npx wrangler d1 execute gala-waitlist --remote --command \
  "SELECT seat_id, email, guest_name FROM seats ORDER BY seat_id;"
```

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
