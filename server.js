// server.js — FULL VERSION (ready for Render)
// Includes Stripe promo code support + full booking logic

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import pkg from "pg";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ----------------- Stripe -----------------
const STRIPE_SECRET = process.env.STRIPE_SECRET || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
if (!STRIPE_SECRET) console.warn("⚠️ STRIPE_SECRET is not set.");
if (!process.env.SITE_URL) console.warn("⚠️ SITE_URL is not set.");
const stripe = new Stripe(STRIPE_SECRET);

// ----------------- Postgres -----------------
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      start_at TIMESTAMPTZ NOT NULL,
      end_at   TIMESTAMPTZ NOT NULL,
      status   TEXT NOT NULL DEFAULT 'confirmed',
      customer_name  TEXT,
      customer_email TEXT,
      stripe_session_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blackout_dates (
      id BIGSERIAL PRIMARY KEY,
      start_at TIMESTAMPTZ NOT NULL,
      end_at   TIMESTAMPTZ NOT NULL,
      reason   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ Database schema ready");
}
initSchema().catch(e => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// ----------------- Helpers -----------------
function fmtUSD(cents) {
  try { return `$${(Number(cents)/100).toFixed(2)}`; } catch { return "$0.00"; }
}
function inAllowedZip(zip) {
  if (!/^\d{5}$/.test(String(zip))) return false;
  const z = Number(zip);
  const manhattan = (z >= 10000 && z <= 10299);
  const queens111 = (z >= 11100 && z <= 11199);
  const brooklyn  = (z >= 11200 && z <= 11299);
  const queens134 = (z >= 11300 && z <= 11499);
  const queens116 = (z >= 11600 && z <= 11699);
  const nassau    = (z >= 11000 && z <= 11599);
  const suffolk   = (z >= 11700 && z <= 11999);
  return manhattan || queens111 || brooklyn || queens134 || queens116 || nassau || suffolk;
}

// ----------------- Email Helper (Resend) -----------------
async function sendEmail({ to, subject, html }) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) { console.warn("RESEND_API_KEY not set; skipping email."); return; }
    const payload = {
      from: process.env.FROM_EMAIL || "Chef Chris <bookings@privatechefchristopherlamagna.com>",
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: process.env.REPLY_TO || "loomeatery@gmail.com"
    };
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) console.error("Email send failed:", await resp.text());
  } catch (e) {
    console.error("sendEmail error:", e);
  }
}

// ----------------- Webhook (raw body) -----------------
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(200).send("ok");
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const md = session.metadata || {};
      const date = md.event_date;

      if (date) {
        const start = new Date(`${date}T00:00:00.000Z`);
        const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
        await pool.query(`
          INSERT INTO bookings (start_at,end_at,status,customer_name,customer_email,stripe_session_id)
          VALUES ($1,$2,'confirmed',$3,$4,$5)
          ON CONFLICT (stripe_session_id)
          DO UPDATE SET status='confirmed'`,
          [start.toISOString(), end.toISOString(),
           `${md.first_name || ""} ${md.last_name || ""}`.trim(),
           session.customer_details?.email || md.email || "",
           session.id]
        );
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ----------------- Middleware -----------------
app.use(cors());
app.use(express.json());

// ----------------- Booking Logic -----------------
app.post("/api/book", async (req, res) => {
  try {
    if (!STRIPE_SECRET) return res.status(400).json({ error: "Missing STRIPE_SECRET" });
    if (!process.env.SITE_URL) return res.status(400).json({ error: "Missing SITE_URL" });

    const b = req.body || {};
    const date = b.date;
    const time = b.time || "18:00";
    const email = b.email;
    const guests = Number(b.guests || 0);

    if (!date || !email) return res.status(400).json({ error: "Missing required fields." });

    const pkg = b.pkg || "tasting";
    const packages = {
      tasting: { perPerson: 200, depositPct: 0.30 },
      family:  { perPerson: 200, depositPct: 0.30 },
      cocktail:{ perPerson: 125, depositPct: 0.30 }
    };
    const perPerson = packages[pkg].perPerson;
    const depositPct = packages[pkg].depositPct;
    const subtotal = perPerson * guests;
    const depositCents = Math.round(subtotal * depositPct * 100);

    // Optional promo code
    const promoRaw = (b.promo || "").trim();
    let discounts = [];
    if (promoRaw) {
      try {
        const pc = await stripe.promotionCodes.list({ code: promoRaw, active: true, limit: 1 });
        if (pc.data[0]?.id) discounts = [{ promotion_code: pc.data[0].id }];
      } catch (e) { console.warn("Promo lookup failed:", e.message); }
    }

    // Stripe Checkout session
    const sessionCfg = {
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: depositCents,
          product_data: {
            name: `Deposit — ${pkg} (${guests} guests, ${date} ${time})`,
            description: `${date} ${time} • ${pkg} • ${guests} guests`
          }
        }
      }],
      success_url: `${process.env.SITE_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/booking-calendar#cancel`,
      metadata: {
        event_date: date,
        start_time: time,
        package: pkg,
        guests: guests.toString(),
        email
      },
      custom_text: {
        submit: { message: "Remaining balance (pre-tax) due after today's deposit." }
      }
    };
    if (discounts.length) sessionCfg.discounts = discounts;

    const session = await stripe.checkout.sessions.create(sessionCfg);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Book error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Health -----------------
app.get("/healthz", (_req, res) => res.send("ok"));

// ----------------- Start Server -----------------
app.listen(port, () => {
  console.log(`Chef booking server running on port ${port}`);
});
