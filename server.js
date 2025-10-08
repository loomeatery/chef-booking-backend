// server.js — COMPLETE DROP-IN (ESM)
// Flow: Create PENDING booking -> Stripe Checkout -> webhook CONFIRMS & emails
// Service area: Manhattan, Brooklyn, Queens, Nassau, Suffolk

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
  // Base tables (keep names the same)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      start_at TIMESTAMPTZ NOT NULL,
      end_at   TIMESTAMPTZ NOT NULL,
      status   TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|canceled
      customer_name  TEXT,
      customer_email TEXT,
      stripe_session_id TEXT UNIQUE,
      created_via TEXT DEFAULT 'online',
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

  // Dedupe + index for blackouts (unchanged)
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

  // --- Ensure new columns exist on existing 'bookings' tables (idempotent) ---
  const alters = [
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_via TEXT DEFAULT 'online'`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS package_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS package_title TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS address_line1 TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS zip TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS diet_notes TEXT`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS subtotal_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bartender BOOLEAN DEFAULT false`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tablescape BOOLEAN DEFAULT false`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bartender_fee_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tablescape_fee_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_reference_id TEXT`
  ];
  for (const sql of alters) { await pool.query(sql); }

  console.log("✅ Database schema ready");
}
initSchema().catch(e => { console.error("DB init failed:", e); process.exit(1); });

// ----------------- Helpers -----------------
function fmtUSD(cents){ try { return `$${(Number(cents)/100).toFixed(2)}`; } catch { return "$0.00"; } }

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

function shortCodeFromSessionId(sessionId = '') {
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

// -------------- STRIPE WEBHOOK (raw body) --------------
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
      const bookingId = md.booking_id ? Number(md.booking_id) : null;
      const eventDate = md.event_date; // "YYYY-MM-DD"

      // Try to fetch receipt URL + deposit amount
      let receiptUrl = "";
      let depositText = "Deposit received";
      try {
        if (session.payment_intent) {
          const PI = await stripe.paymentIntents.retrieve(session.payment_intent);
          const ch = PI.charges?.data?.[0];
          if (ch?.receipt_url) receiptUrl = ch.receipt_url;
          if (PI.amount_received) depositText = fmtUSD(PI.amount_received);
        }
      } catch (e) {
        console.warn("Could not fetch receipt URL", e.message);
      }

      if (bookingId) {
        // ✅ Backfill any fields that might be null on older rows
        await pool.query(
          `UPDATE bookings
             SET status='confirmed',
                 stripe_session_id = $2,
                 customer_name     = $3,
                 customer_email    = $4,
                 phone             = COALESCE(phone, $5),
                 address_line1     = COALESCE(address_line1, $6),
                 city              = COALESCE(city, $7),
                 state             = COALESCE(state, $8),
                 zip               = COALESCE(zip, $9),
                 diet_notes        = COALESCE(diet_notes, $10)
           WHERE id=$1`,
          [
            bookingId,
            session.id,
            `${md.first_name || ""} ${md.last_name || ""}`.trim(),
            session.customer_details?.email || md.email || "",
            md.phone || "",
            md.address_line1 || "",
            md.city || "",
            md.state || "",
            md.zip || "",
            md.diet_notes || ""
          ]
        );
        console.log(`✅ Confirmed booking #${bookingId} from Stripe session ${session.id}`);
      } else if (eventDate) {
        // Fallback: create if pending booking was not created (shouldn't happen)
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
      }

      // ------ Send confirmation email (guest + admin copy) ------
      const guestEmail = session.customer_details?.email || md.email || "";
      const fullName   = `${md.first_name || ""} ${md.last_name || ""}`.trim() || "Guest";
      const pkgTitle   = md.package_title || md.package || "Private Event";
      const guests     = md.guests || "";
      const startTime  = md.start_time || "18:00";
      const successPage = `${process.env.SITE_URL}/booking-success`;
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
          <p>Thanks for reserving a <strong>${pkgTitle}</strong> on <strong>${md.event_date || ""}</strong> at <strong>${startTime}</strong> for <strong>${guests}</strong> guests.</p>
          <p>We’ve received your deposit: <strong>${depositText}</strong>.</p>

          <div style="margin:12px 0;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#f9faf9">
            <div style="font-size:13px;color:#555">Confirmation code</div>
            <div style="font-weight:800;font-size:20px;letter-spacing:1px">${confCode}</div>
          </div>

          ${receiptUrl ? `<p><a href="${receiptUrl}" style="display:inline-block;background:#7B8B74;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600">View Stripe Receipt</a></p>` : ""}

          <p style="margin-top:12px;font-weight:600">What Happens Next,</p>
          <p>I’ll call you to plan the menu, timing, and kitchen setup. Prefer email? Just reply to this message with <strong>“Email Me”</strong>.</p>

          <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
          <p style="color:#555;font-size:13px">Questions? Reply to this email anytime.</p>
        </div>
      `;

      if (guestEmail) {
        await sendEmail({
          to: [guestEmail, process.env.ADMIN_EMAIL || "loomeatery@gmail.com"],
          subject: `Booking confirmed — ${md.event_date || ""} • ${pkgTitle}`,
          html
        });
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

// ----------------- Health -----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ----------------- Availability (reads DB) -----------------
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

    const booked = Array.from(new Set([
      ...expandDates(qBookings.rows),
      ...expandDates(qBlackouts.rows)
    ])).sort();

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
      body: new URLSearchParams({ secret, response: token, remoteip: ip || "" })
    });
    const data = await resp.json();
    console.log("reCAPTCHA verify -> {",
      "\n  success:", !!data.success + ",",
      "\n  hostname:", data.hostname ? `'${data.hostname}'` : "undefined,",
      "\n  errors:", Array.isArray(data["error-codes"]) ? JSON.stringify(data["error-codes"]) : "[]",
      "\n}");
    return data.success === true;
  } catch (e) {
    console.error("reCAPTCHA verify error:", e);
    return false;
  }
}

// ----------------- Quote (kept, if you use it elsewhere) -----------------
app.post("/api/quote", (req, res) => {
  try {
    const guests = Number(req.body?.guests || 0);
    const PKG = {
      tasting:  { perPerson: 215, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const sel = PKG[req.body?.pkg] || PKG.tasting;

    const g        = Math.max(1, guests);
    const subtotal = sel.perPerson * g;
    const deposit  = Math.round(subtotal * sel.depositPct);
    res.json({ subtotal, tax: 0, total: subtotal, deposit });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// ----------------- Book (Stripe Checkout, saves PENDING) -----------------
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

    // 3) Pricing (per-person + upsells)
    const PKG = {
      tasting:  { perPerson: 215, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const perPerson  = Number(b.perPerson ?? PKG[packageId]?.perPerson ?? 215);
    const depositPct = Number(b.depositPct ?? PKG[packageId]?.depositPct ?? 0.30);

    // Upsells from form (booleans)
    const bartender  = String(b.bartender || "").toLowerCase() === "yes" || b.bartender === true;
    const tablescape = String(b.tablescape || "").toLowerCase() === "yes" || b.tablescape === true;

    const bartenderFeeCents  = bartender  ? 300 * 100 : 0;          // flat $300
    const tablescapeFeeCents = tablescape ? (15 * guests) * 100 : 0; // $15 per guest

    const baseSubtotalCents  = Math.round(perPerson * guests * 100);
    const subtotalCents      = baseSubtotalCents + bartenderFeeCents + tablescapeFeeCents;
    const depositCents       = Math.round(subtotalCents * depositPct);
    const balanceCents       = subtotalCents - depositCents;
    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // 3.5) Create PENDING booking row (so we own the ID)
    const start = new Date(`${date}T00:00:00.000Z`);
    const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

    const pending = await pool.query(
      `INSERT INTO bookings
         (start_at, end_at, status, customer_name, customer_email,
          package_id, package_title, guests, phone,
          address_line1, city, state, zip, diet_notes,
          subtotal_cents, deposit_cents, balance_cents,
          bartender, tablescape, bartender_fee_cents, tablescape_fee_cents,
          created_via)
       VALUES
         ($1,$2,'pending',$3,$4,
          $5,$6,$7,$8,
          $9,$10,$11,$12,$13,
          $14,$15,$16,
          $17,$18,$19,$20,
          'online')
       RETURNING id`,
      [
        start.toISOString(), end.toISOString(),
        `${b.firstName||''} ${b.lastName||''}`.trim(), email,
        packageId, packageName, guests, b.phone || '',
        b.address1 || b.address_line1 || b.address || '', b.city || '', b.state || '', b.zip || '',
        b.diet || '',
        subtotalCents, depositCents, balanceCents,
        bartender, tablescape, bartenderFeeCents || null, tablescapeFeeCents || null
      ]
    );
    const bookingId = pending.rows[0].id;

    // 4) Create Stripe Checkout Session (deposit only)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },
      allow_promotion_codes: true,

      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: depositCents,
          product_data: {
            name: `Deposit — ${packageName} (${guests} guests, ${date} ${time})`,
            description: `${date} ${time} • ${packageName} • ${guests} guests` +
              (bartender ? " • Bartender" : "") +
              (tablescape ? " • Tablescape & Styling" : "")
          }
        }
      }],

      success_url: `${process.env.SITE_URL}/booking-success?booking_id=${bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/booking-calendar#cancel`,

      client_reference_id: String(bookingId),
      metadata: {
        booking_id: String(bookingId),
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
        bartender:             bartender ? "yes" : "no",
        tablescape:            tablescape ? "yes" : "no",
        bartender_fee_cents:   String(bartenderFeeCents || 0),
        tablescape_fee_cents:  String(tablescapeFeeCents || 0),
        base_subtotal_cents:   String(baseSubtotalCents),
        subtotal_cents:        String(subtotalCents),
        deposit_cents:         String(depositCents),
        balance_cents:         String(balanceCents),
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
  if (!process.env.ADMIN_KEY) return next(); // if unset, allow (dev); set ADMIN_KEY in prod!
  if (key === process.env.ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ----------------- Admin APIs -----------------
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

// ----------------- Admin list pages (JSON for admin.html) -----------------
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

app.get("/__admin/list-bookings", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(400).json([]);
    const start = new Date(Date.UTC(year, month-1, 1, 0,0,0));
    const end   = new Date(Date.UTC(year, month,   1, 0,0,0));
    const r = await pool.query(
      `SELECT id,start_at,end_at,status,customer_name,customer_email,
              package_title, guests,
              phone, address_line1, city, state, zip, diet_notes,
              bartender, tablescape,
              subtotal_cents, deposit_cents, balance_cents
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

// ----------------- Admin UI (green page) -----------------
app.get("/admin", (_req, res) => {
  const BASE = ""; // same origin
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Chef Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root{--ink:#2c3e2f;--mut:#6b7280;--bg:#f3f7f3;--panel:#fff;--line:#e5e7eb;--green:#1c7a1c;--btn:#7B8B74;--pill:#e9f3ea;--bad:#c62828;}
  *{box-sizing:border-box}
  body{font-family:Inter,ui-sans-serif;background:var(--bg);color:var(--ink);margin:0}
  header{background:#265f2f;color:#fff;padding:14px 16px;font-weight:800}
  .wrap{max-width:1100px;margin:0 auto;padding:16px}
  .row{display:grid;grid-template-columns:1fr 360px;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px}
  .head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);font-weight:700}
  .pad{padding:12px 14px}
  .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
  select,input[type="month"],input[type="text"],input[type="date"]{border:1px solid var(--line);border-radius:10px;padding:8px 10px}
  button{background:var(--btn);color:#fff;border:none;border-radius:10px;padding:8px 12px;font-weight:700;cursor:pointer}
  button.secondary{background:#e8eee7;color:#2c3e2f;border:1px solid var(--line)}
  .list{display:flex;flex-direction:column}
  .rowb{display:grid;grid-template-columns:120px 1fr 120px 64px 110px 120px;gap:12px;padding:12px 14px;border-top:1px solid var(--line)}
  .rowb.hidden{display:none}
  .pill{background:var(--pill);color:var(--green);padding:4px 8px;border-radius:999px;font-size:12px;display:inline-block}
  .pill.gray{background:#f1f1f1;color:#555}
  .pill.bad{background:#fde7e7;color:#9a1b1b}
  .meta{background:#f7faf7;border-top:1px solid var(--line);padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .money div{font-size:22px;font-weight:800}
  .small{font-size:12px;color:#666}
  .danger{background:#fff;border:1px solid #f4caca;color:#9a1b1b}
  .right{display:flex;gap:8px;justify-content:flex-end}
  .flex{display:flex;gap:8px;align-items:center}
  .mt8{margin-top:8px}
  .wide{width:100%}
</style>
</head>
<body>
<header>Chef Admin</header>
<div class="wrap">

  <div class="toolbar">
    <label>Month</label>
    <select id="mSel"></select>
    <label>Year</label>
    <select id="ySel"></select>
    <button id="refresh">Refresh</button>
    <input id="admKey" class="wide" style="max-width:260px;margin-left:auto" type="password" placeholder="Admin key (x-admin-key header)"/>
    <button id="saveKey" class="secondary">Save</button>
    <button id="clearKey" class="secondary">Clear</button>
  </div>

  <div class="row">
    <div class="card">
      <div class="head">Bookings</div>
      <div class="list" id="bookings"></div>
    </div>

    <div class="card">
      <div class="head">Blackout Dates</div>
      <div class="pad">
        <div class="flex">
          <input type="date" id="bd-date"/>
          <input type="text" id="bd-reason" placeholder="Reason (optional)" style="flex:1"/>
          <button id="bd-add">Add blackout</button>
        </div>
        <div class="flex mt8">
          <input type="text" id="bd-bulk" placeholder="Bulk add: YYYY-MM-DD,YYYY-MM-DD,…" class="wide"/>
          <button id="bd-add-bulk">Add bulk</button>
        </div>
      </div>
      <div class="list" id="blackouts"></div>
    </div>
  </div>
</div>

<script>
  const BASE = ${JSON.stringify(BASE)};

  const mSel = document.getElementById("mSel");
  const ySel = document.getElementById("ySel");
  const refreshBtn = document.getElementById("refresh");
  const keyInput = document.getElementById("admKey");
  const saveKey = document.getElementById("saveKey");
  const clearKey = document.getElementById("clearKey");

  // month/year selectors
  const now = new Date();
  for (let i=1;i<=12;i++){
    const o = document.createElement("option");
    o.value = i; o.textContent = new Date(2025, i-1, 1).toLocaleString("en-US", {month:"long"});
    mSel.appendChild(o);
  }
  const yearStart = now.getFullYear() - 1;
  for (let y=yearStart; y<=yearStart+3; y++){
    const o = document.createElement("option");
    o.value = y; o.textContent = y; ySel.appendChild(o);
  }
  mSel.value = String(now.getMonth()+1);
  ySel.value = String(now.getFullYear());

  // admin key in localStorage
  keyInput.value = localStorage.getItem("chef_admin_key") || "";
  saveKey.onclick = () => { localStorage.setItem("chef_admin_key", keyInput.value || ""); alert("Saved."); };
  clearKey.onclick = () => { localStorage.removeItem("chef_admin_key"); keyInput.value=""; alert("Cleared."); };

  function hdrs(){
    const h = {"Content-Type":"application/json"};
    const k = localStorage.getItem("chef_admin_key");
    if (k) h["x-admin-key"] = k;
    return h;
  }
  async function fetchJson(url, opts){ const r = await fetch(url, opts); try{ return await r.json(); }catch{ return null; } }

  function usd(c){ return (Number(c||0)/100).toLocaleString("en-US",{style:"currency",currency:"USD"}); }
  function dstr(ts){ const d = new Date(ts); return d.toLocaleDateString("en-US", {month:"short", day:"2-digit", year:"numeric"}); }

  // ------- BOOKING LOADER -------
  async function loadBookings(){
    const y = ySel.value, m = mSel.value;
    const data = await fetchJson(\`\${BASE}/__admin/list-bookings?year=\${y}&month=\${m}\`, { headers: hdrs() });
    const wrap = document.getElementById("bookings");
    wrap.innerHTML = "";
    if (!Array.isArray(data) || data.length === 0){
      const empty = document.createElement("div");
      empty.className = "pad small";
      empty.textContent = "No bookings this month.";
      wrap.appendChild(empty);
      return;
    }

    data.forEach(b => {
      const row = document.createElement("div");
      row.className = "rowb";

      const date = document.createElement("div");
      date.innerHTML = \`<div style="font-weight:800">\${new Date(b.start_at).toLocaleDateString("en-US",{month:"short", day:"2-digit"})}</div><div class="small">\${new Date(b.start_at).getFullYear()}</div>\`;

      const cust = document.createElement("div");
      cust.innerHTML = \`<div style="font-weight:700">\${b.customer_name || "—"}</div><div class="small">\${b.customer_email || "—"}</div>\`;

      const pkg = document.createElement("div");
      pkg.textContent = b.package_title || "—";

      const guests = document.createElement("div");
      guests.textContent = b.guests ?? "—";

      const dep = document.createElement("div");
      dep.textContent = usd(b.deposit_cents);

      const status = document.createElement("div");
      status.innerHTML = \`<span class="pill \${b.status==="confirmed"?"":"gray"}">\${b.status||"—"}</span>\`;

      row.append(date, cust, pkg, guests, dep, status);
      wrap.appendChild(row);

      const meta = document.createElement("div");
      meta.className = "meta";

      const left = document.createElement("div");
      left.innerHTML = \`
        <div style="font-weight:800;margin-bottom:6px">Address</div>
        <div class="small">\${[b.address_line1,b.city,b.state,b.zip].filter(Boolean).join(", ") || "—"}</div>
        <div style="font-weight:800;margin:12px 0 6px">Phone</div>
        <div class="small">\${b.phone || "—"}</div>
        <div style="font-weight:800;margin:12px 0 6px">Diet notes</div>
        <div class="small" style="white-space:pre-wrap">\${b.diet_notes || "—"}</div>
        <div style="margin-top:12px;display:flex;gap:8px">
          \${b.bartender ? '<span class="pill">Bartender</span>' : ''}
          \${b.tablescape ? '<span class="pill">Tablescape</span>' : ''}
        </div>
      \`;

      const right = document.createElement("div");
      right.className = "money";
      right.innerHTML = \`
        <div class="small" style="font-weight:800;margin-bottom:6px">Amounts</div>
        <div>Subtotal: \${usd(b.subtotal_cents)}</div>
        <div>Deposit: \${usd(b.deposit_cents)}</div>
        <div>Balance: \${usd(b.balance_cents)}</div>
        <div class="right mt8">
          <button class="secondary" data-hide>Hide</button>
          <button class="danger" data-del-booking data-id="\${b.id}">Delete</button>
        </div>
      \`;

      meta.append(left, right);
      wrap.appendChild(meta);

      right.querySelector('[data-hide]').onclick = () => { meta.style.display = meta.style.display==="none"?"grid":"none"; };
    });

    // wire delete buttons
    wrap.querySelectorAll('[data-del-booking]').forEach(btn=>{
      btn.onclick = async () => {
        if (!confirm("Delete this booking? (Use for test rows only)")) return;
        const id = btn.getAttribute("data-id");
        const r = await fetch(\`\${BASE}/api/admin/bookings/\${id}\`, { method:"DELETE", headers: hdrs() });
        if (r.ok) { alert("Deleted"); loadBookings(); } else { alert("Failed"); }
      };
    });
  }

  // ------- BLACKOUT LOADER -------
  async function loadBlackouts(){
    const y = ySel.value, m = mSel.value;
    const data = await fetchJson(\`\${BASE}/__admin/list-blackouts?year=\${y}&month=\${m}\`, { headers: hdrs() });
    const wrap = document.getElementById("blackouts");
    wrap.innerHTML = "";
    if (!Array.isArray(data) || data.length === 0){
      const empty = document.createElement("div");
      empty.className = "pad small";
      empty.textContent = "No blackouts this month.";
      wrap.appendChild(empty);
      return;
    }
    data.forEach(d => {
      const row = document.createElement("div");
      row.className = "rowb";
      row.style.gridTemplateColumns = "1fr 1fr 100px";
      row.innerHTML = \`
        <div>\${dstr(d.start_at)}</div>
        <div class="small">\${(d.reason||"—")}</div>
        <div class="right"><button class="danger" data-del data-id="\${d.id}">Delete</button></div>
      \`;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('[data-del]').forEach(btn=>{
      btn.onclick = async () => {
        if (!confirm("Delete this blackout date?")) return;
        const id = btn.getAttribute("data-id");
        const r = await fetch(\`\${BASE}/api/admin/blackouts/\${id}\`, { method:"DELETE", headers: hdrs() });
        if (r.ok) { loadBlackouts(); } else { alert("Failed"); }
      };
    });
  }

  refreshBtn.onclick = () => { loadBookings(); loadBlackouts(); };

  // Add blackout (single)
  document.getElementById("bd-add").onclick = async () => {
    const date = document.getElementById("bd-date").value;
    const reason = document.getElementById("bd-reason").value;
    if (!date) return alert("Pick a date");
    const r = await fetch(\`\${BASE}/api/admin/blackouts\`, { method:"POST", headers: hdrs(), body: JSON.stringify({ date, reason }) });
    if (r.ok) { document.getElementById("bd-date").value=""; document.getElementById("bd-reason").value=""; loadBlackouts(); }
    else alert("Failed");
  };

  // Add blackout (bulk)
  document.getElementById("bd-add-bulk").onclick = async () => {
    const raw = (document.getElementById("bd-bulk").value||"").trim();
    if (!raw) return alert("Enter comma-separated YYYY-MM-DD dates");
    const dates = raw.split(",").map(s=>s.trim()).filter(Boolean);
    const r = await fetch(\`\${BASE}/api/admin/blackouts/bulk\`, { method:"POST", headers: hdrs(), body: JSON.stringify({ dates }) });
    if (r.ok) { document.getElementById("bd-bulk").value=""; loadBlackouts(); }
    else alert("Failed");
  };

  // initial load
  loadBookings(); loadBlackouts();
</script>
</body></html>`);
});

// ----------------- Success page (unchanged visuals) -----------------
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
  .cta{display:inline-block;margin-top:18px;background:#7B8B74;color:#fff;padding:12px 20px;border-radius:999px;font-weight:700;text-decoration:none}
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
    <p style="margin-top:12px;font-size:13px">Booking ID (Stripe session): ${session_id}</p>
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
