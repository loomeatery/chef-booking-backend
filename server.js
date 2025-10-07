// server.js — drop-in with service-area enforcement + strict CORS + env fixes
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

  await pool.query(`
    DELETE FROM blackout_dates a
    USING blackout_dates b
    WHERE a.start_at = b.start_at
      AND a.id < b.id;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS blackout_unique_start
      ON blackout_dates (start_at);
  `);

  console.log("✅ Database schema ready");
}
initSchema().catch(e => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// ----------------- Email helper (Resend) -----------------
function fmtUSD(cents){ try { return `$${(Number(cents)/100).toFixed(2)}`; } catch { return "$0.00"; } }

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
    if (!resp.ok) {
      console.error("Email send failed:", await resp.text());
    } else {
      console.log(`✅ Email sent to ${payload.to.join(", ")}`);
    }
  } catch (e) {
    console.error("sendEmail error:", e);
  }
}

// ----------------- Webhook needs raw body -----------------
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
      const md = session.metadata || {};

      const eventDate = md.event_date;
      if (eventDate) {
        const start = new Date(`${eventDate}T00:00:00.000Z`);
        const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

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

        const guestEmail = session.customer_details?.email || md.email || "";
        const fullName   = `${md.first_name || ""} ${md.last_name || ""}`.trim() || "Guest";
        const pkgTitle   = md.package_title || md.package || "Private Event";
        const guests     = md.guests || "";
        const startTime  = md.start_time || "18:00";
        const deposit    = session.amount_total ? fmtUSD(session.amount_total) : "Deposit received";
        const successPage = `${process.env.SITE_URL}/booking-success?session_id=${session.id}`;

        const html = `
          <div style="font-family:ui-sans-serif,system-ui;line-height:1.6">
            <h2 style="margin:0 0 8px">You're booked! 🎉</h2>
            <p>Hi ${fullName},</p>
            <p>Thanks for reserving a <strong>${pkgTitle}</strong> on <strong>${eventDate}</strong> at <strong>${startTime}</strong> for <strong>${guests}</strong> guests.</p>
            <p>We’ve received your deposit: <strong>${deposit}</strong>.</p>
            <p style="margin-top:12px"><strong>What happens next</strong><br>
              I’ll call you to plan the menu, timing, and kitchen setup. Prefer email? Just reply to this message.</p>
            <p style="margin-top:12px">Your confirmation link:<br>
              <a href="${successPage}">${successPage}</a></p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
            <p style="color:#555;font-size:13px">Questions? Reply to this email anytime.</p>
          </div>
        `;

        if (guestEmail) {
          await sendEmail({
            to: [guestEmail, process.env.ADMIN_EMAIL || "loomeatery@gmail.com"],
            subject: `Booking confirmed — ${eventDate} • ${pkgTitle}`,
            html
          });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// ----------------- Normal middleware (strict CORS after webhook) -----------------
app.use(cors({ origin: process.env.SITE_URL || true, methods: ["GET","POST","DELETE"] }));
app.use(express.json());

// ----------------- In-memory fallback -----------------
let bookedDates = [];

// ----------------- Health -----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ----------------- Availability -----------------
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
      return true;
    }
    if (!token) return false;

    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || "" })
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.error("reCAPTCHA verify error:", e);
    return false;
  }
}

// ----------------- SERVICE AREA ENFORCEMENT (server-side) -----------------
const ZIP_ALLOW = /^(10[0-2]\d{2}|11[0-5]\d{2}|11[7-9]\d{2})$/;
function allowedArea(state, zip){
  return (String(state).toUpperCase() === "NY") && ZIP_ALLOW.test(String(zip||"").trim());
}

// ----------------- Quote -----------------
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
    const date  = b.date;
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

    // ✅ 3) AREA CHECK (server authority)
    const state = b.state;
    const zip   = b.zip;
    if (!allowedArea(state, zip)) {
      return res.status(400).json({ error: "We currently serve Manhattan, Nassau & Suffolk (NY) only." });
    }

    // 4) Pricing
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
    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // 5) Stripe Checkout Session
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
          product_data: {
            name: `Deposit — ${packageName} (${guests} guests, ${date} ${time})`,
            description: `${date} ${time} • ${packageName} • ${guests} guests`
          }
        }
      }],

      success_url: `${process.env.SITE_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/booking-calendar#cancel`,

      metadata: {
        event_date: date,
        start_time: time,
        package: packageId,
        package_title: packageName,
        guests: String(guests),
        first_name: b.firstName || "",
        last_name:  b.lastName  || "",
        email:      email,
        phone:      b.phone || "",
        address_line1: b.address1 || b.address_line1 || b.address || "",
        city:          b.city || "",
        state:         b.state || "",
        zip:           b.zip || "",
        country:       "US",
        diet_notes:            b.diet || "",
        ack_kitchen_lead_time: b.ackKitchenLeadTime ? "yes" : "no",
        agreed_to_terms:       b.agreedToTerms ? "yes" : "no"
      },

      payment_intent_data: {
        description: `${date} ${time} — ${packageName} — ${guests} guests — ${email}`
      },

      custom_text: {
        submit: { message: "Remaining balance (pre-tax) is due after today's deposit." }
      }
    });

    if (date) bookedDates.push(date);
    return res.json({ url: session.url, checkoutUrl: session.url });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Unable to create booking.";
    console.error("Book error:", msg);
    return res.status(400).json({ error: msg });
  }
});

// ----------------- Admin protection -----------------
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || key === process.env.ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ----------------- Admin APIs (unchanged below) -----------------
/* ... keep your admin routes exactly as you had them ... */

