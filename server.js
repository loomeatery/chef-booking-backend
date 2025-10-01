// server.js — COMPLETE DROP-IN (ESM)

// ----------------- Imports & setup -----------------
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import pkg from "pg";

dotenv.config();

const app  = express();
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
  // Confirmed/pending/canceled bookings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      start_at TIMESTAMPTZ NOT NULL,
      end_at   TIMESTAMPTZ NOT NULL,
      status   TEXT NOT NULL DEFAULT 'confirmed', -- pending|confirmed|canceled
      customer_name  TEXT,
      customer_email TEXT,
      stripe_session_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Manual blackouts
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

// =============== IMPORTANT ===============
// Stripe requires the *raw* body on the webhook route.
// Define the webhook route BEFORE the JSON body parser.
// =========================================

// ----------------- Stripe Webhook (auto-book on payment) -----------------
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.warn("⚠️ STRIPE_WEBHOOK_SECRET not set; ignoring webhook.");
      return res.status(200).send("ok");
    }

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // We sent clean metadata when creating the session
      const md = session.metadata || {};
      const eventDate = md.event_date;             // "YYYY-MM-DD"
      const startTime = md.start_time || "18:00";  // optional (not required for full-day blocking)

      if (eventDate) {
        // Treat booking as *full day*: [YYYY-MM-DD 00:00Z, next day 00:00Z)
        const start = new Date(`${eventDate}T00:00:00.000Z`);
        const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

        // Upsert by Stripe session id → confirmed
        await pool.query(
          `INSERT INTO bookings (start_at, end_at, status, customer_name, customer_email, stripe_session_id)
           VALUES ($1, $2, 'confirmed', $3, $4, $5)
           ON CONFLICT (stripe_session_id)
           DO UPDATE SET status='confirmed'`,
          [
            start.toISOString(),
            end.toISOString(),
            `${md.first_name || ""} ${md.last_name || ""}`.trim(),
            session.customer_details?.email || md.email || "",
            session.id
          ]
        );

        console.log(`✅ Auto-booked ${eventDate} from Stripe session ${session.id}`);
      }
    }

    // Optional: handle refunds/cancellations to reopen dates
    if (event.type === "charge.refunded") {
      // best effort: we don't always get checkout session id here
      console.log("ℹ️ charge.refunded received; consider mapping to canceled if needed.");
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// ----------------- Normal middleware (after webhook) -----------------
app.use(cors());
app.use(express.json());

// ----------------- In-memory fallback (leave intact) -----------------
let bookedDates = [];

// ----------------- Health -----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ----------------- Availability (reads DB + fallback) -----------------
app.get("/api/availability", async (req, res) => {
  try {
    const year  = Number(req.query.year);
    const month = Number(req.query.month); // 1–12
    if (!year || !month) return res.status(400).json({ error: "Missing year or month" });

    const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const monthEnd   = new Date(Date.UTC(year, month, 1, 0, 0, 0)); // first of next month

    const qBookings = await pool.query(
      `SELECT start_at, end_at
         FROM bookings
        WHERE status='confirmed'
          AND tstzrange(start_at, end_at, '[)') && tstzrange($1, $2, '[)')`,
      [monthStart.toISOString(), monthEnd.toISOString()]
    );

    const qBlackouts = await pool.query(
      `SELECT start_at, end_at
         FROM blackout_dates
        WHERE tstzrange(start_at, end_at, '[)') && tstzrange($1, $2, '[)')`,
      [monthStart.toISOString(), monthEnd.toISOString()]
    );

    const expandDates = (rows) => {
      const set = new Set();
      rows.forEach(r => {
        const s = new Date(r.start_at);
        const e = new Date(r.end_at);
        for (let d = new Date(s); d < e; d.setUTCDate(d.getUTCDate() + 1)) {
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, "0");
          const day = String(d.getUTCDate()).padStart(2, "0");
          set.add(`${y}-${m}-${day}`);
        }
      });
      return Array.from(set);
    };

    const fromDb = [
      ...expandDates(qBookings.rows),
      ...expandDates(qBlackouts.rows)
    ];

    const fromMem = (bookedDates || []).filter((d) => {
      const dt = new Date(d);
      return dt.getUTCFullYear() === year && (dt.getUTCMonth() + 1) === month;
    });

    const booked = Array.from(new Set([...fromDb, ...fromMem])).sort();
    res.json({ booked });
  } catch (err) {
    console.error("Availability error:", err);
    res.status(500).json({ error: "Unable to load availability." });
  }
});

// ----------------- reCAPTCHA verify -----------------
async function verifyRecaptcha(token, ip) {
  try {
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      console.warn("ℹ️ RECAPTCHA_SECRET not set; skipping verification.");
      return true; // allow while wiring up
    }
    if (!token) return false;

    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: ip || ""
      })
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.error("reCAPTCHA verify error:", e);
    return false;
  }
}

// ----------------- Quote (unchanged) -----------------
app.post("/api/quote", (req, res) => {
  try {
    const { pkg } = req.body || {};
    const guests = Number(req.body?.guests || 0);

    const PKG = {
      tasting:  { perPerson: 200, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const sel = PKG[pkg] || PKG.tasting;

    const g        = Math.max(1, guests);
    const subtotal = sel.perPerson * g;
    const deposit  = Math.round(subtotal * sel.depositPct);

    res.json({ subtotal, tax: 0, total: subtotal, deposit });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// ----------------- Book (Stripe Checkout) -----------------
app.post("/api/book", async (req, res) => {
  try {
    if (!STRIPE_SECRET) return res.status(400).json({ error: "Server misconfigured: STRIPE_SECRET is missing." });
    if (!process.env.SITE_URL) return res.status(400).json({ error: "Server misconfigured: SITE_URL is missing." });

    // 1) reCAPTCHA
    const token = req.body?.recaptchaToken || req.body?.recaptcha;
    const captchaOK = await verifyRecaptcha(token, req.ip);
    if (!captchaOK) return res.status(400).json({ error: "reCAPTCHA failed. Please retry." });

    // 2) Normalize incoming fields
    const b = req.body || {};
    const date  = b.date;                    // "YYYY-MM-DD"
    const time  = b.time || "18:00";
    const email = b.email;

    const packageId   = b.packageId || b.pkg || "tasting";
    const packageName = b.packageName || ({
      tasting:  "Tasting Menu",
      family:   "Family-Style Dinner",
      cocktail: "Cocktail & Canapés"
    }[packageId] || "Private Event");

    const guests = Number(b.guests || 0);

    if (!date || !time) return res.status(400).json({ error: "Missing date or time." });
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!Number.isFinite(guests) || guests < 1) return res.status(400).json({ error: "Guest count is invalid." });

    // 3) Pricing
    const PKG = {
      tasting:  { perPerson: 200, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const perPerson  = Number(b.perPerson ?? PKG[packageId]?.perPerson ?? 200);
    const depositPct = Number(b.depositPct ?? PKG[packageId]?.depositPct ?? 0.30);

    const subtotal         = perPerson * guests;
    const depositDollars   = Math.round(subtotal * depositPct);
    const depositCents     = depositDollars * 100;
    const balanceBeforeTax = Math.max(0, subtotal - depositDollars);
    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    const nameLine = `Deposit — ${packageName} (${guests} guests, ${date} ${time})`;
    const shortDesc = [
      `• $${perPerson}/guest`,
      `• Subtotal: $${subtotal.toFixed(2)}`,
      `• Deposit (${Math.round(depositPct * 100)}%): $${depositDollars.toFixed(2)}`,
      `• Remaining balance (pre-tax): $${balanceBeforeTax.toFixed(2)}`,
      `• Event: ${date} ${time}`,
      `• Sales tax will be added to your final invoice`
    ].join("\n");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },

      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: depositCents,
          product_data: { name: nameLine, description: shortDesc }
        }
      }],

      success_url: `${process.env.SITE_URL}/booking-success`,
      cancel_url:  `${process.env.SITE_URL}/booking-cancelled`,

      metadata: {
        // booking
        event_date: date,
        start_time: time,
        package: packageId,
        package_title: packageName,
        guests: String(guests),

        // contact
        first_name: b.firstName || "",
        last_name:  b.lastName  || "",
        email:      email,
        phone:      b.phone || "",

        // address
        address_line1: b.address1 || b.address_line1 || b.address || "",
        city:          b.city || "",
        state:         b.state || "",
        zip:           b.zip || "",
        country:       "US",

        // notes/acks
        diet_notes:            b.diet || "",
        ack_kitchen_lead_time: b.ackKitchenLeadTime ? "yes" : "no",
        agreed_to_terms:       b.agreedToTerms ? "yes" : "no",

        // money (display)
        per_person_usd:            `$${perPerson.toFixed(2)}`,
        deposit_pct:               `${Math.round(depositPct * 100)}%`,
        subtotal_usd:              `$${subtotal.toFixed(2)}`,
        deposit_usd:               `$${depositDollars.toFixed(2)}`,
        remaining_balance_pre_tax: `$${balanceBeforeTax.toFixed(2)}`
      },

      custom_text: {
        submit: { message: "Remaining balance (pre-tax) is due after today's deposit." }
      }
    });

    // Keep your old behavior: mark in-memory as "booked" immediately
    if (date) bookedDates.push(date);

    return res.json({ url: session.url, checkoutUrl: session.url });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Unable to create booking.";
    console.error("Book error:", msg);
    return res.status(400).json({ error: msg });
  }
});

// ----------------- Admin (very simple) -----------------
// Protect with ADMIN_KEY in headers:  x-admin-key: <ADMIN_KEY>
// These let you block dates or add manual bookings quickly.

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || key === process.env.ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// Block a full day
app.post("/api/admin/blackouts", requireAdmin, async (req, res) => {
  try {
    const { date, reason } = req.body || {}; // "YYYY-MM-DD"
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

    const r = await pool.query(
      `INSERT INTO blackout_dates (start_at, end_at, reason)
       VALUES ($1,$2,$3) RETURNING id,start_at,end_at,reason`,
      [start.toISOString(), end.toISOString(), reason || ""]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create blackout" });
  }
});

app.delete("/api/admin/blackouts/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM blackout_dates WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete blackout" });
  }
});

// Manual booking for a day
app.post("/api/admin/bookings", requireAdmin, async (req, res) => {
  try {
    const { date, name, email } = req.body || {};
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

    const r = await pool.query(
      `INSERT INTO bookings (start_at,end_at,status,customer_name,customer_email)
       VALUES ($1,$2,'confirmed',$3,$4)
       RETURNING id,start_at,end_at,status,customer_name,customer_email`,
      [start.toISOString(), end.toISOString(), name || "", email || ""]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

app.delete("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bookings WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete booking" });
  }
});

// ----------------- Dev helpers (optional) -----------------
app.get("/api/dev/seed-blackout", async (_req, res) => {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    const r = await pool.query(
      `INSERT INTO blackout_dates (start_at, end_at, reason)
       VALUES ($1,$2,'Test blackout') RETURNING *`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/dev/blackouts", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, start_at, end_at, reason, created_at
         FROM blackout_dates
        ORDER BY id DESC LIMIT 5`
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start server -----------------
app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
});
