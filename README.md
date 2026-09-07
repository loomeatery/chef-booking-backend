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
