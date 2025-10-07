// server.js — COMPLETE DROP-IN (ESM)
// Service area: Manhattan, Brooklyn, Queens, Nassau, Suffolk
// Emails: guest + admin via Resend (logo + confirmation code + Stripe receipt link)
// Stripe webhook uses RAW body (keep route before express.json)

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
      status   TEXT NOT NULL DEFAULT 'confirmed', -- pending|confirmed|canceled
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

  // SAFE DEDUPE before unique index
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

// ----------------- Helpers -----------------
function fmtUSD(cents){ try { return `$${(Number(cents)/100).toFixed(2)}`; } catch { return "$0.00"; } }

function inAllowedZip(zip) {
  // Manhattan 10000–10299; Queens partial 111xx, 113–114xx, 116xx; Brooklyn 112xx; Nassau 110–115xx; Suffolk 117–119xx
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

function shortCodeFromSessionId(sessionId = '') {
  // Last 8 safe uppercase chars as a friendly confirmation code
  return (sessionId || '').replace(/[^a-zA-Z0-9]/g,'').slice(-8).toUpperCase();
}

// ----------------- Email helper (Resend) -----------------
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

// =============== IMPORTANT ===============
// Stripe requires the *raw* body on the webhook route.
// Define the webhook route BEFORE the JSON body parser.
// =========================================

// ----------------- Stripe Webhook (auto-book + emails) -----------------
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

      const eventDate = md.event_date; // "YYYY-MM-DD"
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

        console.log(`✅ Auto-booked ${eventDate} from Stripe session ${session.id}`);

        // Try to fetch receipt URL + deposit amount
        let receiptUrl = "";
        let depositText = "Deposit received";
        try {
          if (session.payment_intent) {
            const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
            const ch = pi.charges?.data?.[0];
            if (ch?.receipt_url) receiptUrl = ch.receipt_url;
            if (pi.amount_received) depositText = fmtUSD(pi.amount_received);
          }
        } catch (e) {
          console.warn("Could not fetch receipt URL", e.message);
        }

        // ------ Send confirmation email (guest + admin copy) ------
        const guestEmail = session.customer_details?.email || md.email || "";
        const fullName   = `${md.first_name || ""} ${md.last_name || ""}`.trim() || "Guest";
        const pkgTitle   = md.package_title || md.package || "Private Event";
        const guests     = md.guests || "";
        const startTime  = md.start_time || "18:00";
        const successPage = `${process.env.SITE_URL}/booking-success`; // simple success page link
        const confCode   = shortCodeFromSessionId(session.id);
        const logoUrl    = process.env.EMAIL_LOGO_URL || "";

        const logoBlock = logoUrl
          ? `<img src="${logoUrl}" alt="Chef Chris" width="48" height="48" style="border-radius:50%;display:block;margin-bottom:8px"/>`
          : "";

        const html = `
          <div style="font-family:ui-sans-serif,system-ui;line-height:1.6;max-width:600px;margin:0 auto">
            ${logoBlock}
            <h2 style="margin:0 0 8px">You're booked! 🎉</h2>
            <p>Hi ${fullName},</p>
            <p>Thanks for reserving a <strong>${pkgTitle}</strong> on <strong>${md.event_date}</strong> at <strong>${startTime}</strong> for <strong>${guests}</strong> guests.</p>
            <p>We’ve received your deposit: <strong>${depositText}</strong>.</p>

            <div style="margin:12px 0;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#f9faf9">
              <div style="font-size:13px;color:#555">Confirmation code</div>
              <div style="font-weight:800;font-size:20px;letter-spacing:1px">${confCode}</div>
            </div>

            ${receiptUrl ? `<p><a href="${receiptUrl}">View your Stripe receipt</a></p>` : ""}

            <p style="margin-top:12px"><strong>What happens next</strong><br>
              I’ll call you to plan the menu, timing, and kitchen setup. Prefer email? Just reply to this message.</p>

            <p style="margin-top:12px"><a href="${successPage}">${successPage}</a></p>

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
        // -----------------------------------------------------------
      }
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

// ----------------- In-memory fallback -----------------
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

    // 2.5) Service area enforcement (NY only, allowed zips)
    const st = (b.state || '').toUpperCase();
    const postal = String(b.zip || b.postal || '').trim();
    if (st !== 'NY' || !inAllowedZip(postal)) {
      return res.status(400).json({
        error: "We currently serve Manhattan, Brooklyn, Queens, Nassau & Suffolk (NY zips 100–102, 111, 112–114, 116, 110–115, 117–119). For other locations, please email loomeatery@gmail.com."
      });
    }

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
    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // 4) Create Stripe Checkout Session
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

// ----------------- Admin APIs -----------------

// Bulk add blackout dates — { dates: ["YYYY-MM-DD", ...], reason?: "text" }
app.post("/api/admin/blackouts/bulk", requireAdmin, async (req, res) => {
  try {
    const dates = Array.isArray(req.body?.dates) ? req.body.dates : [];
    const reason = (req.body?.reason || "").trim();
    if (dates.length === 0) return res.status(400).json({ error: "Provide dates: string[] YYYY-MM-DD" });
    if (dates.length > 365)  return res.status(400).json({ error: "Too many dates (limit 365 per request)." });

    const starts = [], ends = [];
    for (const d of dates) {
      const start = new Date(`${d}T00:00:00.000Z`);
      if (isNaN(start)) return res.status(400).json({ error: `Invalid date: ${d}` });
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
      starts.push(start.toISOString());
      ends.push(end.toISOString());
    }

    const vals = [];
    const params = [];
    for (let i = 0; i < dates.length; i++) {
      const a = params.length + 1;
      const b = params.length + 2;
      const c = params.length + 3;
      vals.push(`($${a}, $${b}, $${c})`);
      params.push(starts[i], ends[i], reason || null);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sql = `
        INSERT INTO blackout_dates (start_at, end_at, reason)
        VALUES ${vals.join(",")}
        ON CONFLICT (start_at)
        DO UPDATE SET
          end_at = EXCLUDED.end_at,
          reason = COALESCE(EXCLUDED.reason, blackout_dates.reason)
        RETURNING (xmax = 0) AS inserted;
      `;
      const r = await client.query(sql, params);
      await client.query("COMMIT");

      const inserted = r.rows.filter(row => row.inserted === true).length;
      const updated  = r.rows.length - inserted;
      return res.json({ ok: true, inserted, updated });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      return res.status(500).json({ error: "Bulk insert failed" });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create bulk blackouts" });
  }
});

app.post("/api/admin/blackouts", requireAdmin, async (req, res) => {
  try {
    const { date, reason } = req.body || {};
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

    const r = await pool.query(
      `INSERT INTO blackout_dates (start_at, end_at, reason)
       VALUES ($1,$2,$3)
       ON CONFLICT (start_at) DO UPDATE
         SET end_at = EXCLUDED.end_at,
             reason = COALESCE(EXCLUDED.reason, blackout_dates.reason)
       RETURNING id,start_at,end_at,reason`,
      [start.toISOString(), end.toISOString(), (reason || "").trim() || null]
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

// Month-filtered list for BLACKOUTS (for /admin)
app.get("/__admin/list-blackouts", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(400).json([]);
    const start = new Date(Date.UTC(year, month-1, 1, 0,0,0));
    const end   = new Date(Date.UTC(year, month,   1, 0,0,0));
    const r = await pool.query(
      `SELECT id,start_at,end_at,reason,created_at
         FROM blackout_dates
        WHERE tstzrange(start_at,end_at,'[)') && tstzrange($1,$2,'[)')
        ORDER BY start_at ASC`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e); res.status(500).json([]);
  }
});

// Month-filtered list for BOOKINGS (admin page)
app.get("/__admin/list-bookings", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(400).json([]);
    const start = new Date(Date.UTC(year, month-1, 1, 0,0,0));
    const end   = new Date(Date.UTC(year, month,   1, 0,0,0));
    const r = await pool.query(
      `SELECT id,start_at,end_at,status,customer_name,customer_email
         FROM bookings
        WHERE tstzrange(start_at,end_at,'[)') && tstzrange($1,$2,'[)')
        ORDER BY start_at ASC`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e); res.status(500).json([]);
  }
});

// ----------------- Simple Admin Page (/admin) -----------------
app.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Calendar Admin</title>

<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
<style>
  :root{--ink:#222;--mut:#666;--bg:#fafafa;--card:#fff;--b:#eee;--btn:#7B8B74;--btn2:#444;}
  html,body{height:100%}
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:var(--bg);color:#000;margin:0;padding:24px;overflow:auto}
  .wrap{max-width:900px;margin:0 auto}
  h1{margin:0 0 8px}
  .card{background:var(--card);border:1px solid var(--b);border-radius:12px;padding:16px;margin:12px 0}
  .row{display:grid;grid-template-columns:1fr;gap:12px}
  @media(min-width:720px){.row.two{grid-template-columns:1fr 1fr}}
  label{font-size:13px;color:var(--mut);margin-bottom:4px;display:block}
  input,select,button{font-size:14px}
  input,select{width:100%;padding:10px;border:1px solid #ddd;border-radius:10px;background:#fff;box-sizing:border-box}
  .btn{display:inline-block;background:var(--btn);color:#fff;border:none;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer}
  .btn.gray{background:var(--btn2)}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
  .mut{color:var(--mut);font-size:12px}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #ddd;font-size:12px}
  .tag.ok{border-color:#cfead2;background:#eef9ef}
  .tag.warn{border-color:#f3e3cc;background:#fff6ea}
  .table-wrap{overflow:auto}
</style>
</head>
<body>
<div class="wrap">
  <h1>Calendar Admin</h1>
  <div class="mut">Enter your admin key once, then manage blackouts and manual bookings.</div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Admin Key</label>
        <input id="k" type="password" placeholder="Enter ADMIN_KEY (saved locally)" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" onclick="saveKey()">Save Key</button>
        <button class="btn gray" onclick="clearKey()">Clear</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Date(s) to Blackout</label>
        <input id="dates" placeholder="Click dates to select multiple" />
        <div class="mut" style="margin-top:6px">Tip: click multiple days to select; click again to unselect.</div>
      </div>
      <div>
        <label>Reason / Name (optional)</label>
        <input id="note" placeholder="Travel, Private, Client name..." />
      </div>
    </div>
    <div style="margin-top:12px">
      <button class="btn" onclick="addBulk()">+ Add Blackout(s)</button>
    </div>
  </div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Manual Booking — Date</label>
        <input id="dateOne" placeholder="Pick one date" />
      </div>
      <div>
        <label>Customer / Note</label>
        <input id="noteOne" placeholder="Name, email (optional)" />
      </div>
    </div>
    <div style="margin-top:12px">
      <button class="btn gray" onclick="addBooking()">+ Add Manual Booking</button>
    </div>
  </div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Month</label>
        <input id="month" type="month" />
      </div>
      <div>
        <label>&nbsp;</label>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn" onclick="loadMonth()">Load Month</button>
          <button class="btn gray" onclick="shiftMonth(-1)">◀︎ Prev</button>
          <button class="btn gray" onclick="shiftMonth(1)">Next ▶︎</button>
        </div>
      </div>
    </div>

    <h3 style="margin:16px 0 8px">Blackouts</h3>
    <div class="table-wrap">
      <table id="tblBlackouts"><thead>
        <tr><th>ID</th><th>Date(s)</th><th>Reason</th><th></th></tr>
      </thead><tbody></tbody></table>
    </div>

    <h3 style="margin:16px 0 8px">Bookings</h3>
    <div class="table-wrap">
      <table id="tblBookings"><thead>
        <tr><th>ID</th><th>Date(s)</th><th>Status</th><th>Customer</th><th></th></tr>
      </thead><tbody></tbody></table>
    </div>
  </div>

  <p class="mut">Tip: after adding a blackout or booking, reload your public calendar. The date should show as <span class="tag warn">Booked</span>.</p>
</div>

<script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
<script>
const API = location.origin;
const hdrs = () => ({ "Content-Type": "application/json", "x-admin-key": localStorage.getItem("ADMIN_KEY") || "" });

function saveKey(){ const v = document.getElementById('k').value.trim(); localStorage.setItem('ADMIN_KEY', v); alert('Saved'); }
function clearKey(){ localStorage.removeItem('ADMIN_KEY'); alert('Cleared'); }

const fpMulti = flatpickr("#dates", { mode: "multiple", dateFormat: "Y-m-d", altInput: true, altFormat: "M j, Y", disableMobile: false });
const fpOne   = flatpickr("#dateOne", { mode: "single", dateFormat: "Y-m-d", altInput: true, altFormat: "M j, Y", defaultDate: new Date() });

async function addBulk(){
  const reason = document.getElementById('note').value || '';
  const dates = fpMulti.selectedDates.map(d => fpMulti.formatDate(d, "Y-m-d"));
  if (!dates.length) return alert("Pick at least one date.");
  const res = await fetch(\`\${API}/api/admin/blackouts/bulk\`, { method:"POST", headers:hdrs(), body:JSON.stringify({ dates, reason }) });
  if (!res.ok) return alert("Error adding blackouts");
  alert(\`\${dates.length} blackout date(s) added.\`);
  fpMulti.clear(); loadMonth();
}

async function addBooking(){
  const sel = fpOne.selectedDates[0];
  if (!sel) return alert("Pick a date.");
  const date = fpOne.formatDate(sel, "Y-m-d");
  const note = document.getElementById('noteOne').value || '';
  const r = await fetch(\`\${API}/api/admin/bookings\`, { method:'POST', headers:hdrs(), body:JSON.stringify({ date, name: note, email: '' }) });
  if(!r.ok){ return alert('Error adding booking'); }
  alert('Booking added'); loadMonth();
}

function fmtRange(s,e){
  const sd = new Date(s), ed = new Date(e);
  const pad = n => String(n).padStart(2,'0');
  const one = \`\${sd.getUTCFullYear()}-\${pad(sd.getUTCMonth()+1)}-\${pad(sd.getUTCDate())}\`;
  const eday = new Date(ed); eday.setUTCDate(eday.getUTCDate()-1);
  const two = \`\${eday.getUTCFullYear()}-\${pad(eday.getUTCMonth()+1)}-\${pad(eday.getUTCDate())}\`;
  return one===two ? one : \`\${one} → \${two}\`;
}

function getMonthParts(){
  const m = document.getElementById('month').value;
  if(!m){ return null; }
  const [yy,mm] = m.split('-');
  return { yy, mm };
}

function shiftMonth(delta){
  const parts = getMonthParts(); if(!parts){ return; }
  const d = new Date(Number(parts.yy), Number(parts.mm)-1, 1);
  d.setMonth(d.getMonth() + delta);
  document.getElementById('month').value = d.toISOString().slice(0,7);
  loadMonth();
}

async function loadMonth(){
  const parts = getMonthParts();
  if(!parts){ return alert('Pick a month'); }
  const yy = parts.yy, mm = parts.mm;

  const q1 = await fetch(\`\${API}/__admin/list-blackouts?year=\${yy}&month=\${Number(mm)}\`, {headers:hdrs()});
  const blackouts = q1.ok ? await q1.json() : [];

  const q2 = await fetch(\`\${API}/__admin/list-bookings?year=\${yy}&month=\${Number(mm)}\`, {headers:hdrs()});
  const bookings = q2.ok ? await q2.json() : [];

  const tb1 = document.querySelector('#tblBlackouts tbody'); tb1.innerHTML='';
  if(blackouts.length===0){
    const tr=document.createElement('tr'); tr.innerHTML = '<td colspan="4" class="mut">No blackouts this month.</td>'; tb1.appendChild(tr);
  } else {
    blackouts.forEach(b=>{
      const tr=document.createElement('tr');
      tr.innerHTML = \`<td>\${b.id}</td><td>\${fmtRange(b.start_at,b.end_at)}</td><td>\${b.reason||''}</td>
        <td><button class="btn gray" onclick="delBlackout(\${b.id})">Delete</button></td>\`;
      tb1.appendChild(tr);
    });
  }

  const tb2 = document.querySelector('#tblBookings tbody'); tb2.innerHTML='';
  if(bookings.length===0){
    const tr=document.createElement('tr'); tr.innerHTML = '<td colspan="5" class="mut">No bookings this month.</td>'; tb2.appendChild(tr);
  } else {
    bookings.forEach(b=>{
      const tag = b.status==='confirmed' ? '<span class="tag ok">confirmed</span>' : '<span class="tag">'+b.status+'</span>';
      const who = (b.customer_name||'') + (b.customer_email? ' • '+b.customer_email : '');
      const tr=document.createElement('tr');
      tr.innerHTML = \`<td>\${b.id}</td><td>\${fmtRange(b.start_at,b.end_at)}</td><td>\${tag}</td><td>\${who}</td>
        <td><button class="btn gray" onclick="delBooking(\${b.id})">Delete</button></td>\`;
      tb2.appendChild(tr);
    });
  }
}

async function delBlackout(id){
  if(!confirm('Delete blackout '+id+'?')) return;
  const r = await fetch(\`\${API}/api/admin/blackouts/\${id}\`, {method:'DELETE', headers:hdrs()});
  if(!r.ok) return alert('Delete failed');
  loadMonth();
}
async function delBooking(id){
  if(!confirm('Delete booking '+id+'?')) return;
  const r = await fetch(\`\${API}/api/admin/bookings/\${id}\`, {method:'DELETE', headers:hdrs()});
  if(!r.ok) return alert('Delete failed');
  loadMonth();
}

(function(){
  const d = new Date();
  document.getElementById('month').value = d.toISOString().slice(0,7);
  loadMonth();
})();
</script>
</body>
</html>`);
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

// ----------------- Success page (confetti) -----------------
app.get("/booking-success", async (req, res) => {
  const session_id = req.query.session_id || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>You're Booked!</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root{--ink:#1f2937;--mut:#6b7280;--btn:#7B8B74;--bg:#fafaf7;}
  body{font-family:Inter,ui-sans-serif;background:var(--bg);color:var(--ink);margin:0}
  .wrap{max-width:720px;margin:0 auto;padding:40px 20px;text-align:center}
  .card{background:#fff;border:1px solid #eee;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.05)}
  h1{font-size:34px;margin:0 0 10px}
  p{margin:8px 0;color:var(--mut)}
  .cta{display:inline-block;margin-top:18px;background:var(--btn);color:#fff;padding:12px 20px;border-radius:999px;font-weight:700;text-decoration:none}
  .row{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:16px}
  .pill{background:#f3f8f3;border:1px solid #e5efe5;border-radius:999px;padding:8px 12px;font-size:13px}
</style></head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Congratulations! You’re all booked 🎉</h1>
    <p>We’ve emailed your confirmation and next steps.</p>
    <div class="row">
      <div class="pill">Personal call to plan your menu</div>
      <div class="pill">Day-of kitchen prep included</div>
      <div class="pill">We handle all the details</div>
    </div>
    <a class="cta" href="/contact">Need anything? Get in touch</a>
    <p style="margin-top:12px;font-size:13px">Booking ID: ${session_id}</p>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
<script>
  confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
  const end = Date.now() + 800;
  (function frame(){ confetti({particleCount:3, spread:70, origin:{y:0.6}}); if(Date.now()<end) requestAnimationFrame(frame); })();
</script>
</body></html>`);
});

// ----------------- Start server -----------------
app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
});
