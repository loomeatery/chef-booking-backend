# Chef Booking Backend

Express/PostgreSQL backend for Private Chef Christopher LaMagna's booking,
Stripe deposit, gift-card, email-confirmation, availability, admin, and calendar
workflows.

## Local setup

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Install dependencies with `npm install`.
3. Run `npm start`.
4. Confirm `GET /healthz` returns `ok`.

Never commit `.env` or copy production credentials into this repository.

## Required production settings

- `DATABASE_URL`
- `SITE_URL`
- `STRIPE_SECRET`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `RECAPTCHA_SECRET`
- `ADMIN_KEY`
- `CALENDAR_FEED_TOKEN`

Existing deployments may continue using the legacy `ADMIN_TOKEN` name; a
dedicated `CALENDAR_FEED_TOKEN` takes precedence when both are configured.

Email identity, allowed origins, consultation scheduling, and minimum-override
codes are documented in `.env.example`.

## Private calendar feeds

The public feed URLs intentionally return redacted busy blocks. Detailed client
names, addresses, guest counts, event types, staff assignments, and blackout
reasons are available only when a valid token is supplied:

```text
https://<backend-host>/calendar.ics?token=<CALENDAR_FEED_TOKEN>
https://<backend-host>/blackouts.ics?token=<CALENDAR_FEED_TOKEN>
```

Use a long random value that is different from `ADMIN_KEY`. Treat the complete
feed URL as confidential because calendar applications store the token in the
subscription URL.

## Deployment checks

- Verify Render has every required environment variable before deploying.
- Confirm the Stripe webhook signs and processes a test event.
- Confirm customer and internal confirmation emails arrive and render correctly.
- Confirm the public calendar feeds are redacted and tokenized feeds show details.
- Test booking, cancellation-return, gift-card, admin, and error paths.

## Remaining-balance payment links

The first balance-link request automatically creates one Stripe product named
**PRIVATE EVENT — REMAINING BALANCE** with no default price. Later requests
reuse that product. No manual Stripe product or extra Render variable is
required. Every generated balance amount becomes a separate one-time price
under this single product. Stripe keeps the links in the Payment Links area and
associates each link with its corresponding price. Existing service and deposit
products remain unchanged.

The protected `/admin` page includes a **Create Remaining Balance Link** tool.
Enter the event date, client name and email, event/package name, and copy the
exact **TOTAL DUE** from the Google invoice. The amount is intentionally never
filled from the booking record: Google invoices can include sales tax, add-ons,
travel, or other adjustments that are not in the original package balance.
The booking ID and invoice number are optional. For bookings already listed in
the dashboard, use **Create balance link** on the booking row to prefill the
client and event fields; the payment amount remains blank for safety.

The backend creates a Stripe Payment Link with `payment_type=balance` metadata
and limits it to one completed payment. After payment:

- Stripe sends the existing `checkout.session.completed` webhook;
- Resend sends a distinct paid-in-full email and the Stripe receipt link;
- the existing booking row records the balance amount, payment time, and Stripe
  session when a booking ID was included;
- the customer sees a paid-in-full success page without deposit or consultation
  instructions.

Copy the generated URL into the existing Google invoice behind **PAY ONLINE —
CLICK HERE**, then send the invoice normally. This uses a Stripe Payment Link;
it does not create a Stripe Invoice.

Website booking deposits continue to use `booking_id` metadata and their
existing reservation email. Unrecognized Checkout payments receive a neutral
payment receipt instead of being mislabeled as deposits.
