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
  // Base tables
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
    CREATE TABLE IF NOT EXISTS gift_cards (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      amount_cents INTEGER NOT NULL,
      original_amount_cents INTEGER NOT NULL,
      buyer_name TEXT,
      buyer_email TEXT,
      recipient_name TEXT,
      recipient_email TEXT,
      message TEXT,
      deliver_on DATE,
      with_basket BOOLEAN DEFAULT false,
      stripe_session_id TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS gift_cards_code_idx ON gift_cards (code);`);

    // One-time safety fix for old tables missing columns
  await pool.query(`
    ALTER TABLE gift_cards
      ADD COLUMN IF NOT EXISTS with_basket BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS original_amount_cents INTEGER NOT NULL DEFAULT 0;
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

  // Dedupe + index for blackouts
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

  // Add new/nullable booking columns idempotently
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
  for (const sql of alters) await pool.query(sql);

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

// ---- Access code helpers ----
function parseCodes() {
  const raw = (process.env.MIN_OVERRIDE_CODES || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase());
}
function codeOK(code) {
  if (!code) return false;
  const set = parseCodes();
  return set.includes(String(code).trim().toUpperCase());
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
      
      // GIFT CARD — FINAL FIXED VERSION
      if (md.type === "gift_card") {
        const code = `CHRIS-GIFT-${Math.random().toString(36).substring(2,10).toUpperCase()}`;

        await pool.query(`
          INSERT INTO gift_cards (
            code, amount_cents, original_amount_cents, with_basket,
            buyer_name, buyer_email, recipient_name, recipient_email,
            message, deliver_on, stripe_session_id, status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
          code,
          md.amount_cents,
          md.amount_cents,
          md.with_basket === "true",
          md.buyer_name,
          md.buyer_email,
          md.recipient_name,
          md.recipient_email,
          md.message || null,
          md.deliver_on || null,
          session.id,
          'active'
        ]);

        await sendEmail({
          to: md.buyer_email,
          subject: `Gift Card $${(Number(md.amount_cents)/100).toFixed(2)} Confirmed`,
          html: `
            <div style="font-family:ui-sans-serif,system-ui;line-height:1.6;max-width:600px;margin:0 auto">
              ${logoBlock}
              <h2 style="margin:0 0 8px">You're In.</h2>
              <p>Hi ${md.buyer_name.split(" ")[0]},</p>
              <p>Thanks for sending a Private Chef Chris gift card${md.with_basket === "true" ? " + Fresh-Baked Gift Basket" : ""}.</p>
              <p>We’ve received your payment: <strong>$${(Number(md.amount_cents)/100).toFixed(2)}</strong>.</p>

              <div style="margin:12px 0;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#f9faf9">
                <div style="font-size:13px;color:#555">Redeem code</div>
                <div style="font-weight:800;font-size:20px;letter-spacing:1px">${code}</div>
              </div>

              <p style="margin-top:12px;font-weight:600">What Happens Next,</p>
              <p>Chef Chris will personally prepare and send the PDF gift card within 24 hours.</p>

              <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
              <p style="color:#555;font-size:13px">Questions? Reply to this email anytime.</p>
            </div>
          `
        });

        return res.json({received: true});
      }
      
      const bookingId = md.booking_id ? Number(md.booking_id) : null;
      const eventDate = md.event_date; // "YYYY-MM-DD"

      // --- NEW: pull buyer/contact info from Checkout (works for pop-up flow too)
      const cd       = session.customer_details || {};
      const fullName = (cd.name || `${md.first_name || ""} ${md.last_name || ""}`).trim();
      const phone    = cd.phone || md.phone || "";
      const addr     = cd.address || {};
      const address1 = addr.line1 || md.address_line1 || "";
      const city     = addr.city  || md.city || "";
      const state    = (addr.state || md.state || "").toString();
      const zip      = (addr.postal_code || md.zip || "").toString();

      // Custom fields collected on Checkout (dietary, guest names, referral)
      const cfs = Array.isArray(session.custom_fields) ? session.custom_fields : [];
      const cf  = (key) => cfs.find(f => f.key === key)?.text?.value || "";
      const dietary  = cf("dietary");
      const guestsNm = cf("guest_names");
      const referral = cf("referral");
      const combinedNotes = [dietary, referral, guestsNm].filter(Boolean).join(" • ");

      // Try to fetch receipt URL + paid amount
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
        // ✅ Backfill and confirm (keeps your calendar flow intact)
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
            fullName || "—",
            (cd.email || md.email || ""),
            phone,
            address1,
            city,
            state,
            zip,
            combinedNotes || md.diet_notes || ""
          ]
        );
        console.log(`✅ Confirmed booking #${bookingId} from Stripe session ${session.id}`);
      } else if (eventDate) {
        // Fallback: create if no pending existed (pop-up flow)
        const start = new Date(`${eventDate}T00:00:00.000Z`);
        const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
        await pool.query(
          `INSERT INTO bookings (start_at, end_at, status, customer_name, customer_email,
                                 phone, address_line1, city, state, zip, diet_notes, stripe_session_id)
           VALUES ($1, $2, 'confirmed', $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (stripe_session_id)
           DO UPDATE SET status='confirmed'`,
          [
            start.toISOString(),
            end.toISOString(),
            fullName || "—",
            (cd.email || md.email || ""),
            phone,
            address1,
            city,
            state,
            zip,
            combinedNotes,
            session.id
          ]
        );
        console.log(`✅ Auto-booked ${eventDate} from Stripe session ${session.id}`);
      }

      // 🔥 POP-UP EVENT SEAT UPDATE (idempotent)
      try {
        if (md.event_id) {
          const events = loadEvents();
          const idx = events.findIndex(e => e.id === md.event_id);
          if (idx !== -1) {
            const qty = Math.max(1, Number(md.quantity || 1));
            const sessions = Array.isArray(events[idx].sessions) ? events[idx].sessions : [];
            if (!sessions.includes(session.id)) {
              const prev = Number(events[idx].sold || 0);
              events[idx].sold = prev + qty;
              sessions.push(session.id);
              events[idx].sessions = sessions;
              saveEvents(events);
              console.log(`🎟️ Pop-up '${events[idx].title || md.event_id}' — sold +${qty} (now ${events[idx].sold}) [session ${session.id}]`);
            } else {
              console.log(`↩️ Pop-up seat update skipped (duplicate webhook) [session ${session.id}]`);
            }
          } else {
            console.warn(`⚠️ Pop-up event not found for id='${md.event_id}'`);
          }
        }
      } catch (e) {
        console.error("❌ Pop-up seat update failed:", e);
      }

      // ------ Send confirmation email (guest + admin copy)
      const guestEmail = cd.email || md.email || "";
      const safeName   = fullName || "Guest";
      const pkgTitle   = md.package_title || md.package || (md.event_title || "Private Event");
      const guests     = md.guests || md.quantity || "";
      const startTime  = md.start_time || "18:00";
      const confCode   = shortCodeFromSessionId(session.id);
      const logoUrl    = process.env.EMAIL_LOGO_URL || "";

      const logoBlock = logoUrl
        ? `<img src="${logoUrl}" alt="Chef Chris" width="48" height="48" style="border-radius:50%;display:block;margin-bottom:8px"/>`
        : "";

      const html = `
        <div style="font-family:ui-sans-serif,system-ui;line-height:1.6;max-width:600px;margin:0 auto">
          ${logoBlock}
          <h2 style="margin:0 0 8px">You're booked! 🎉</h2>
          <p>Hi ${safeName},</p>
          <p>Thanks for reserving a <strong>${pkgTitle}</strong> on <strong>${md.event_date || ""}</strong>${bookingId ? ` at <strong>${startTime}</strong>` : ""}${guests ? ` for <strong>${guests}</strong> ${md.event_id ? "seat(s)" : "guests"}` : ""}.</p>
          <p>We’ve received your ${md.event_id ? "payment" : "deposit"}: <strong>${depositText}</strong>.</p>

          <div style="margin:12px 0;padding:10px 12px;border:1px solid #eee;border-radius:10px;background:#f9faf9">
            <div style="font-size:13px;color:#555">Confirmation code</div>
            <div style="font-weight:800;font-size:20px;letter-spacing:1px">${confCode}</div>
          </div>

          ${receiptUrl ? `<p><a href="${receiptUrl}" style="display:inline-block;background:#7B8B74;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600">View Stripe Receipt</a></p>` : ""}

          <p style="margin-top:12px;font-weight:600">What Happens Next,</p>
          <p>${md.event_id
            ? "We’ll email final class details and what to bring. Questions? Reply here anytime."
            : "I’ll call you to plan the menu, timing, and kitchen setup. Prefer email? Just reply to this message with <strong>“Email Me”</strong>."
          }</p>

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

// ----------------- Access code validation (for frontend badge) -----------------
app.get("/api/validate-code", (req, res) => {
  try {
    const code = (req.query.code || "").toString();
    return res.json({ ok: codeOK(code) });
  } catch {
    return res.json({ ok: false });
  }
});

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

// ----------------- Quote -----------------
app.post("/api/quote", (req, res) => {
  try {
    const guests = Number(req.body?.guests || 0);
    const PKG = {
      tasting:  { perPerson: 215, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
      dinner2:  { perPerson: 250, depositPct: 0.30 }, // added for completeness
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
    const accessCode = (b.accessCode || "").toString().trim();

    const packageId   = b.packageId || b.pkg || "tasting";
    const packageName = b.packageName || ({
      tasting:  "Tasting Menu",
      family:   "Family-Style Dinner",
      cocktail: "Cocktail & Canapés",
      dinner2:  "Dinner for 2 (Wed/Thu only)"
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

    // 2.6) Package rules
    // Tasting menu min: 6 normally, 4 if access code valid
    if (packageId === "tasting") {
      const min = codeOK(accessCode) ? 4 : 6;
      if (guests < min) {
        return res.status(400).json({ error: `Tasting Menu requires a minimum of ${min} guests${codeOK(accessCode) ? " with your access code" : ""}.` });
      }
    }
    // Dinner for 2: exactly 2 guests; only Wed/Thu
    if (packageId === "dinner2") {
      if (guests !== 2) return res.status(400).json({ error: "Dinner for 2 requires exactly 2 guests." });
      const d = new Date(`${date}T00:00:00`);
      const dow = d.getDay(); // 0 Sun ... 6 Sat
      if (!(dow === 3 || dow === 4)) {
        return res.status(400).json({ error: "Dinner for 2 can only be booked on Wednesday or Thursday." });
      }
    }

    // 3) Pricing (per-person + upsells)
    const PKG = {
      tasting:  { perPerson: 215, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
      dinner2:  { perPerson: 250, depositPct: 0.30 }, // ✅ ensure correct Stripe amount
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
        agreed_to_terms:       b.agreedToTerms ? "yes" : "no",
        access_code:           accessCode || ""   // ✅ keep for audit
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
  if (!process.env.ADMIN_KEY) return next(); // allow if unset (dev)
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
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); // ✅ day, not year

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

// ----------------- Admin list pages (JSON for admin UI) -----------------
app.get("/__admin/list-blackouts", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(200).json([]);
    const start = new Date(Date.UTC(year, month-1, 1, 0,0,0));
    const end   = new Date(Date.UTC(year, month,   1, 0,0,0));
    const r = await pool.query(
      `SELECT id,start_at,end_at,reason,created_at
         FROM blackout_dates
        WHERE tstzrange(start_at,end_at,'[)') && tstzrange($1,$2,'[)')
        ORDER BY start_at ASC`,
      [start.toISOString(), end.toISOString()]
    );
    res.status(200).json(r.rows);
  } catch (e) {
    console.error("list-blackouts error:", e);
    res.status(200).json([]); // stay green
  }
});

app.get("/__admin/list-bookings", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(200).json([]);
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
    res.status(200).json(r.rows);
  } catch (e) {
    console.error("list-bookings error:", e);
    res.status(200).json([]); // stay green
  }
});

// ----------------- Admin UI (robust UI with Delete booking + Pop-Up Events seats) -----------------
app.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Private Chef Christopher LaMagna Database</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
&nbsp;&nbsp;:root{--ink:#203227;--mut:#6b7280;--bg:#f3f7f3;--panel:#fff;--line:#e5e7eb;--btn:#2f6f4f;--pill:#e9f5ee;--bad:#c62828;--ok:#1b5e20}
&nbsp;&nbsp;*{box-sizing:border-box}
&nbsp;&nbsp;body{font-family:Inter,ui-sans-serif;background:var(--bg);color:var(--ink);margin:0}
&nbsp;&nbsp;header{background:#265f2f;color:#fff;padding:14px 16px;font-weight:800}
&nbsp;&nbsp;.wrap{max-width:1100px;margin:0 auto;padding:16px}
&nbsp;&nbsp;.row{display:grid;grid-template-columns:1fr 360px;gap:16px}
&nbsp;&nbsp;.card{background:var(--panel);border:1px solid var(--line);border-radius:12px}
&nbsp;&nbsp;.head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);font-weight:700}
&nbsp;&nbsp;.pad{padding:12px 14px}
&nbsp;&nbsp;.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
&nbsp;&nbsp;select,input[type="text"],input[type="date"],input[type="password"]{border:1px solid var(--line);border-radius:10px;padding:8px 10px}
&nbsp;&nbsp;button{background:var(--btn);color:#fff;border:none;border-radius:10px;padding:8px 12px;font-weight:700;cursor:pointer}
&nbsp;&nbsp;button.secondary{background:#eef3ef;color:#223;border:1px solid var(--line)}
&nbsp;&nbsp;button.danger{background:#c62828}
&nbsp;&nbsp;.list{display:flex;flex-direction:column}
&nbsp;&nbsp;.rowb{display:grid;grid-template-columns:120px 1fr 120px 70px 110px 110px;gap:12px;padding:12px 14px;border-top:1px solid var(--line)}
&nbsp;&nbsp;.meta{background:#f7faf7;border-top:1px solid var(--line);padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
&nbsp;&nbsp;.pill{background:var(--pill);color:var(--ok);padding:4px 8px;border-radius:999px;font-size:12px;display:inline-block;border:1px solid #dcefe3}
&nbsp;&nbsp;.pill.gray{background:#f1f1f1;color:#555;border-color:#e5e7eb}
&nbsp;&nbsp;.small{font-size:12px;color:#666}
&nbsp;&nbsp;.right{display:flex;gap:8px;justify-content:flex-end}
&nbsp;&nbsp;.empty{padding:12px 14px;color:#6b7280}
&nbsp;&nbsp;#toast{font-size:13px;margin-left:8px}
&nbsp;&nbsp;.ok{color:var(--ok)} .bad{color:var(--bad)}
&nbsp;&nbsp;/* Pop-Up Events rows */
&nbsp;&nbsp;.evtrow{display:grid;grid-template-columns:1.4fr 140px 210px 1fr;gap:12px;align-items:center;padding:12px 14px;border-top:1px solid var(--line)}
&nbsp;&nbsp;.badge{display:inline-block;background:var(--pill);border:1px solid #dcefe3;border-radius:999px;padding:4px 8px;font-size:12px;color:var(--ok)}
&nbsp;&nbsp;.btns{display:flex;gap:8px;align-items:center}
&nbsp;&nbsp;input.spin{width:70px;padding:6px 8px;border:1px solid var(--line);border-radius:10px}
</style>
</head>
<body>
<header>Private Chef Christopher LaMagna Database</header>
<div class="wrap">
&nbsp;&nbsp;<div class="toolbar">
&nbsp;&nbsp;&nbsp;&nbsp;<label>Month</label>
&nbsp;&nbsp;&nbsp;&nbsp;<select id="mSel" aria-label="Month"></select>
&nbsp;&nbsp;&nbsp;&nbsp;<label>Year</label>
&nbsp;&nbsp;&nbsp;&nbsp;<select id="ySel" aria-label="Year"></select>
&nbsp;&nbsp;&nbsp;&nbsp;<button id="refresh" type="button">Refresh</button>
&nbsp;&nbsp;&nbsp;&nbsp;<input id="admKey" class="wide" style="max-width:260px;margin-left:auto" type="password" placeholder="Admin key (x-admin-key)"/>
&nbsp;&nbsp;&nbsp;&nbsp;<button id="saveKey" type="button" class="secondary">Save</button>
&nbsp;&nbsp;&nbsp;&nbsp;<button id="clearKey" type="button" class="secondary">Clear</button>
&nbsp;&nbsp;&nbsp;&nbsp;<span id="toast"></span>
&nbsp;&nbsp;</div>
&nbsp;&nbsp;<div class="row">
&nbsp;&nbsp;&nbsp;&nbsp;<div class="card">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="head">Bookings</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="list" id="bookings"></div>
&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;&nbsp;&nbsp;<div class="card">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="head">Blackout Dates</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="pad">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div style="display:flex;gap:8px;align-items:center">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<input type="date" id="bdDate"/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<input type="text" id="bdReason" placeholder="Reason (optional)" style="flex:1"/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<button id="bdAdd" type="button">Add blackout</button>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<input type="text" id="bdBulk" placeholder="Bulk add: YYYY-MM-DD,YYYY-MM-DD" style="flex:1"/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<button id="bdBulkBtn" type="button">Add bulk</button>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="list" id="blackouts"></div>
&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;</div>
&nbsp;&nbsp;<!-- Pop-Up Events Card -->
&nbsp;&nbsp;<div class="card" style="margin-top:16px">
&nbsp;&nbsp;&nbsp;&nbsp;<div class="head">Pop-Up Events (Seats)</div>
&nbsp;&nbsp;&nbsp;&nbsp;<div class="pad">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="small" style="color:#666;margin-bottom:8px">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Adjust seats when you add/remove a guest manually or issue a refund. Changes reflect on the site immediately.
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="list" id="events"></div>
&nbsp;&nbsp;&nbsp;&nbsp;</div>
&nbsp;&nbsp;</div>
</div>
<script>
(function(){
&nbsp;&nbsp;const BASE = "";
&nbsp;&nbsp;const $ = (id) => document.getElementById(id);
&nbsp;&nbsp;const toast = (t, ok) => { const el=$("toast"); el.textContent=t||""; el.className= ok===true?"ok": ok===false?"bad":""; };
&nbsp;&nbsp;// UTC-safe date renderers (avoid TZ drift)
&nbsp;&nbsp;function dUTC(iso){ if(!iso) return ""; const [y,m,d]=String(iso).slice(0,10).split("-"); const mm=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return mm[Number(m)-1]+" "+Number(d)+", "+y; }
&nbsp;&nbsp;function dMD(iso){ if(!iso) return ""; const [y,m,d]=String(iso).slice(0,10).split("-"); const mm=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return mm[Number(m)-1]+" "+Number(d); }
&nbsp;&nbsp;const usd = (c) => (Number(c||0)/100).toLocaleString("en-US",{style:"currency",currency:"USD"});
&nbsp;&nbsp;function headers(){
&nbsp;&nbsp;&nbsp;&nbsp;const h={"Content-Type":"application/json"};
&nbsp;&nbsp;&nbsp;&nbsp;const k=localStorage.getItem("chef_admin_key");
&nbsp;&nbsp;&nbsp;&nbsp;if(k) h["x-admin-key"]=k;
&nbsp;&nbsp;&nbsp;&nbsp;return h;
&nbsp;&nbsp;}
&nbsp;&nbsp;async function getJSON(path){
&nbsp;&nbsp;&nbsp;&nbsp;const r = await fetch(BASE + path, { headers: headers() });
&nbsp;&nbsp;&nbsp;&nbsp;if (r.status === 401) throw new Error("unauthorized");
&nbsp;&nbsp;&nbsp;&nbsp;try { return await r.json(); } catch { return []; }
&nbsp;&nbsp;}
&nbsp;&nbsp;// Init month/year
&nbsp;&nbsp;(function(){
&nbsp;&nbsp;&nbsp;&nbsp;const mSel = $$ ("mSel"), ySel= $$("ySel");
&nbsp;&nbsp;&nbsp;&nbsp;for(let i=1;i<=12;i++){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const o=document.createElement("option");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;o.value=String(i);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;o.textContent=new Date(2025,i-1,1).toLocaleString("en-US",{month:"long"});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;mSel.appendChild(o);
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;const now=new Date(), y0=now.getFullYear()-1;
&nbsp;&nbsp;&nbsp;&nbsp;for(let y=y0;y<=y0+3;y++){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const o=document.createElement("option");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;o.value=String(y); o.textContent=String(y); ySel.appendChild(o);
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;mSel.value=String(now.getMonth()+1); ySel.value=String(now.getFullYear());
&nbsp;&nbsp;})();
&nbsp;&nbsp;// Key field
&nbsp;&nbsp;$("admKey").value = localStorage.getItem("chef_admin_key") || "";
&nbsp;&nbsp;$("saveKey").addEventListener("click", ()=>{ localStorage.setItem("chef_admin_key", $("admKey").value || ""); toast("Key saved ✓", true); });
&nbsp;&nbsp;$("clearKey").addEventListener("click", ()=>{ localStorage.removeItem("chef_admin_key"); $("admKey").value=""; toast("Key cleared", true); });
&nbsp;&nbsp;$("refresh").addEventListener("click", ()=> loadAll());
&nbsp;&nbsp;async function deleteBooking(id){
&nbsp;&nbsp;&nbsp;&nbsp;if(!confirm("Delete this booking? (Use with care)")) return;
&nbsp;&nbsp;&nbsp;&nbsp;const r = await fetch(BASE + "/api/admin/bookings/" + id, { method:"DELETE", headers: headers() });
&nbsp;&nbsp;&nbsp;&nbsp;if(r.status===401){ toast("Unauthorized — check your key", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;if(r.ok){ toast("Booking deleted ✓", true); loadBookings(); }
&nbsp;&nbsp;&nbsp;&nbsp;else { toast("Delete failed", false); }
&nbsp;&nbsp;}
&nbsp;&nbsp;async function loadBookings(){
&nbsp;&nbsp;&nbsp;&nbsp;const y=$$ ("ySel").value, m= $$("mSel").value;
&nbsp;&nbsp;&nbsp;&nbsp;const wrap=$("bookings"); wrap.innerHTML="";
&nbsp;&nbsp;&nbsp;&nbsp;try{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const data = await getJSON("/__admin/list-bookings?year="+y+"&month="+m);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(!Array.isArray(data)||data.length===0){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.textContent="No bookings this month.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); return;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;data.forEach(b=>{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const row=document.createElement("div"); row.className="rowb";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col1=document.createElement("div"); col1.innerHTML = '<div style="font-weight:800">'+dMD(b.start_at)+'</div><div class="small">'+new Date(b.start_at).getUTCFullYear()+'</div>';
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col2=document.createElement("div"); col2.innerHTML = '<div style="font-weight:700">'+(b.customer_name||"—")+'</div><div class="small">'+(b.customer_email||"—")+'</div>';
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col3=document.createElement("div"); col3.textContent = b.package_title || "—";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col4=document.createElement("div"); col4.textContent = (b.guests!=null?b.guests:"—");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col5=document.createElement("div"); col5.textContent = usd(b.deposit_cents);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const col6=document.createElement("div"); col6.innerHTML = '<span class="pill '+(b.status==="confirmed"?'':'gray')+'">'+(b.status||"—")+'</span>';
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;row.append(col1,col2,col3,col4,col5,col6);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(row);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const meta=document.createElement("div"); meta.className="meta";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const left=document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;left.innerHTML = '<div style="font-weight:800;margin-bottom:6px">Address</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div class="small">'+[b.address_line1,b.city,b.state,b.zip].filter(Boolean).join(", ")+'</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div style="font-weight:800;margin:12px 0 6px">Phone</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div class="small">'+(b.phone||"—")+'</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div style="font-weight:800;margin:12px 0 6px">Diet notes</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div class="small" style="white-space:pre-wrap">'+(b.diet_notes||"—")+'</div>'
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ '<div style="margin-top:12px;display:flex;gap:8px">'+(b.bartender?'<span class="pill">Bartender</span>':'')+(b.tablescape?'<span class="pill">Tablescape</span>':'')+'</div>';
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const right=document.createElement("div"); right.className="right";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const delBtn=document.createElement("button"); delBtn.className="danger"; delBtn.type="button"; delBtn.textContent="Delete";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;delBtn.addEventListener("click", ()=>deleteBooking(b.id));
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;right.appendChild(delBtn);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;meta.append(left,right);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(meta);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;toast("");
&nbsp;&nbsp;&nbsp;&nbsp;}catch(e){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(String(e.message).toLowerCase()==="unauthorized"){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.style.color="var(--bad)"; div.textContent="Unauthorized — enter your admin key, Save, then Refresh.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); toast("Unauthorized — check your key", false);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}else{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.style.color="var(--bad)"; div.textContent="Error loading bookings.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); toast("Error loading bookings", false);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;}
&nbsp;&nbsp;async function loadBlackouts(){
&nbsp;&nbsp;&nbsp;&nbsp;const y=$$ ("ySel").value, m= $$("mSel").value;
&nbsp;&nbsp;&nbsp;&nbsp;const wrap=$("blackouts"); wrap.innerHTML="";
&nbsp;&nbsp;&nbsp;&nbsp;try{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const data = await getJSON("/__admin/list-blackouts?year="+y+"&month="+m);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(!Array.isArray(data)||data.length===0){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.textContent="No blackouts this month.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); return;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;data.forEach(b=>{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const row=document.createElement("div"); row.className="rowb"; row.style.gridTemplateColumns="1fr 1fr 100px";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const d=document.createElement("div"); d.textContent = dUTC(b.start_at);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const r=document.createElement("div"); r.className="small"; r.textContent = (b.reason || "—");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const c=document.createElement("div"); c.className="right";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const del=document.createElement("button"); del.className="danger"; del.type="button"; del.textContent="Delete";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;del.addEventListener("click", async ()=>{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(!confirm("Delete this blackout date?")) return;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const resp = await fetch(BASE+"/api/admin/blackouts/"+b.id,{method:"DELETE",headers:headers()});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(resp.status===401){ toast("Unauthorized — check your key", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(resp.ok){ loadBlackouts(); } else { toast("Delete failed", false); }
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;c.appendChild(del);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;row.append(d,r,c);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(row);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;toast("");
&nbsp;&nbsp;&nbsp;&nbsp;}catch(e){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if(String(e.message).toLowerCase()==="unauthorized"){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.style.color="var(--bad)"; div.textContent="Unauthorized — enter your admin key, Save, then Refresh.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); toast("Unauthorized — check your key", false);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}else{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div=document.createElement("div"); div.className="empty"; div.style.color="var(--bad)"; div.textContent="Error loading blackouts.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div); toast("Error loading blackouts", false);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;}
&nbsp;&nbsp;// ---------- Pop-Up Events Admin ----------
&nbsp;&nbsp;async function adjustSold(eventId, delta){
&nbsp;&nbsp;&nbsp;&nbsp;try{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const r = await fetch("/api/admin/events/"+encodeURIComponent(eventId)+"/adjust-sold", {
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;method: "POST",
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;headers: headers(),
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;body: JSON.stringify({ delta: Number(delta) })
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;});
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (r.status === 401) { toast("Unauthorized — check your key", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (!r.ok) { toast("Seat adjust failed", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;await r.json();
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;toast("Seats updated ✓", true);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;loadEventsAdmin();
&nbsp;&nbsp;&nbsp;&nbsp;}catch(e){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;toast("Seat adjust error", false);
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;}
&nbsp;&nbsp;async function loadEventsAdmin(){
&nbsp;&nbsp;&nbsp;&nbsp;const wrap = $("events");
&nbsp;&nbsp;&nbsp;&nbsp;if (!wrap) return;
&nbsp;&nbsp;&nbsp;&nbsp;wrap.innerHTML = "";
&nbsp;&nbsp;&nbsp;&nbsp;try{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const list = await (await fetch("/api/events")).json();
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (!Array.isArray(list) || list.length === 0) {
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div = document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;div.className = "empty";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;div.textContent = "No visible pop-up events.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;list.forEach(ev=>{
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const row = document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;row.className = "evtrow";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Title + date/location
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const c1 = document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const d = (ev.dateISO||"").slice(0,10);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;c1.innerHTML = \`<div style="font-weight:800">\${ev.title || ev.id || "Pop-Up"}</div>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<div class="small">\${d || ""} • \${ev.location || "Location TBA"}</div>\`;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Seats
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const c2 = document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const sold = Number(ev.sold || 0), cap = Number(ev.capacity || 0);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;c2.innerHTML = \`<span class="badge">Sold \${sold} / \${cap}</span>\`;
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Quick –1 / +1
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const c3 = document.createElement("div"); c3.className = "btns";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const minus = document.createElement("button"); minus.className = "secondary"; minus.textContent = "–1";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const plus = document.createElement("button"); plus.className = "secondary"; plus.textContent = "+1";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;minus.addEventListener("click", ()=> adjustSold(ev.id, -1));
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;plus.addEventListener("click", ()=> adjustSold(ev.id, +1));
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;c3.append(minus, plus);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Custom delta
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const c4 = document.createElement("div"); c4.className = "btns";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const inp = document.createElement("input"); inp.className="spin"; inp.type="number"; inp.value="1";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;inp.min="-10"; inp.max="10"; inp.step="1";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const apply = document.createElement("button"); apply.className="secondary"; apply.textContent="Apply ±";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;apply.addEventListener("click", ()=> adjustSold(ev.id, Number(inp.value || 0)));
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;c4.append(inp, apply);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;row.append(c1,c2,c3,c4);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(row);
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;});
&nbsp;&nbsp;&nbsp;&nbsp;}catch(e){
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const div = document.createElement("div");
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;div.className = "empty"; div.style.color="var(--bad)";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;div.textContent = "Error loading events.";
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;wrap.appendChild(div);
&nbsp;&nbsp;&nbsp;&nbsp;}
&nbsp;&nbsp;}
&nbsp;&nbsp;async function loadAll(){ await Promise.all([loadBookings(), loadBlackouts()]); await loadEventsAdmin(); }
&nbsp;&nbsp;loadAll();
&nbsp;&nbsp;// Add blackout actions
&nbsp;&nbsp;$("bdAdd").addEventListener("click", async ()=>{
&nbsp;&nbsp;&nbsp;&nbsp;const date=$$ ("bdDate").value, reason= $$("bdReason").value;
&nbsp;&nbsp;&nbsp;&nbsp;if(!date){ toast("Pick a date", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;const r = await fetch(BASE+"/api/admin/blackouts",{method:"POST",headers:headers(),body:JSON.stringify({date,reason})});
&nbsp;&nbsp;&nbsp;&nbsp;if(r.status===401) return toast("Unauthorized — check your key", false);
&nbsp;&nbsp;&nbsp;&nbsp;if(r.ok){ $("bdDate").value=""; $("bdReason").value=""; loadBlackouts(); toast("Blackout added ✓", true); }
&nbsp;&nbsp;&nbsp;&nbsp;else toast("Add failed", false);
&nbsp;&nbsp;});
&nbsp;&nbsp;$("bdBulkBtn").addEventListener("click", async ()=>{
&nbsp;&nbsp;&nbsp;&nbsp;const raw=($("bdBulk").value||"").trim();
&nbsp;&nbsp;&nbsp;&nbsp;if(!raw){ toast("Enter comma-separated YYYY-MM-DD dates", false); return; }
&nbsp;&nbsp;&nbsp;&nbsp;const dates = raw.split(",").map(s=>s.trim()).filter(Boolean);
&nbsp;&nbsp;&nbsp;&nbsp;const r = await fetch(BASE+"/api/admin/blackouts/bulk",{method:"POST",headers:headers(),body:JSON.stringify({dates})});
&nbsp;&nbsp;&nbsp;&nbsp;if(r.status===401) return toast("Unauthorized — check your key", false);
&nbsp;&nbsp;&nbsp;&nbsp;if(r.ok){ $("bdBulk").value=""; loadBlackouts(); toast("Bulk added ✓", true); }
&nbsp;&nbsp;&nbsp;&nbsp;else toast("Bulk add failed", false);
&nbsp;&nbsp;});
})();
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

// ======================================================
// =============== POP-UP EVENTS MODULE ==================
// ======================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const eventsFile = path.join(__dirname, "events.json");

function loadEvents() {
  try {
    const raw = fs.readFileSync(eventsFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function saveEvents(events) {
  fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
}

// --------- API: Get All Events (for frontend display)
app.get("/api/events", async (_req, res) => {
  try {
    const events = loadEvents();
    res.json(events.filter(e => e.visible !== false));
  } catch (err) {
    console.error("Error loading events:", err);
    res.status(500).json({ error: "Unable to load events." });
  }
});

// --------- API: Create Stripe Checkout for a specific event
app.post("/api/events/:id/book", async (req, res) => {
  try {
    const { id } = req.params;
    const events = loadEvents();
    const ev = events.find(e => e.id === id);
    if (!ev) return res.status(404).json({ error: "Event not found." });
    if (ev.sold >= ev.capacity) {
      return res.status(400).json({ error: "Event is sold out." });
    }

    const qty = Math.min(Number(req.body.quantity || 1), ev.capacity - ev.sold);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      phone_number_collection: { enabled: true },
      billing_address_collection: "auto",
      allow_promotion_codes: true,

      // Stripe will charge for exactly the quantity chosen on your site
      line_items: [{
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount: Number(ev.price || 11500), // cents
          product_data: {
            name: ev.title || "Pop-Up Class",
            description: `${(ev.dateISO || "").slice(0,10)} • ${ev.location || "Brooklyn, NY"}`
          }
        }
      }],

      // After payment, send them to your success page
      success_url: `${process.env.SITE_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.SITE_URL}/popup#cancel`,

      // Custom questions that will appear on Checkout
      custom_fields: [
        {
          key: "dietary",
          label: { type: "custom", custom: "Dietary Restrictions or Allergies" },
          type: "text",
          text: { maximum_length: 255 },
          optional: true
        },
        {
          key: "guest_names",
          label: { type: "custom", custom: "Guests Name(s)" },
          type: "text",
          text: { maximum_length: 255 },
          optional: true
        },
        {
          key: "referral",
          label: { type: "custom", custom: "How Did You Hear About Us?" },
          type: "text",
          text: { maximum_length: 200 },
          optional: true
        }
      ],

      // Used by the webhook to record and reconcile
      metadata: {
        event_id: id,
        quantity: String(qty),
        event_date: (ev.dateISO || "").slice(0, 10), // "YYYY-MM-DD"
        event_title: ev.title || "Pop-Up Class",
        event_price_cents: String(ev.price || 0)
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating event checkout:", err);
    res.status(500).json({ error: "Unable to create checkout session." });
  }
});

// --------- API: Admin — adjust sold seats (+/-)
// Use with x-admin-key header. Example to add one seat back:
// curl -X POST https://<your-host>/api/admin/events/brooklyn-nov14/adjust-sold \
//   -H 'Content-Type: application/json' -H 'x-admin-key: ULTRACHRIS2022' -d '{"delta":1}'
app.post("/api/admin/events/:id/adjust-sold", requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const delta   = Number(req.body?.delta || 0);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "Provide non-zero numeric 'delta'." });
    }
    const events = loadEvents();
    const ev = events.find(e => e.id === id);
    if (!ev) return res.status(404).json({ error: "Event not found." });

    const cap  = Number(ev.capacity || 0);
    const oldS = Number(ev.sold || 0);
    const next = Math.max(0, Math.min(cap, oldS + delta));
    ev.sold = next;
    saveEvents(events);

    res.json({ ok: true, sold: ev.sold, capacity: cap });
  } catch (e) {
    console.error("adjust-sold error:", e);
    res.status(500).json({ error: "Unable to adjust seats." });
  }
});

// ======================================================
// =============== END POP-UP EVENTS MODULE ==============
// ======================================================


// ----------------- Start server -----------------
// GIFT CARD CHECKOUT
app.post("/api/giftcards/create-checkout", express.json(), async (req, res) => {
  try {
    const { amount, basket = false, buyer_name, buyer_email, recipient_name, recipient_email, message = "", deliver_on } = req.body;
    if (amount < 25 || !buyer_name || !buyer_email || !recipient_name || !recipient_email) return res.status(400).json({error: "Invalid"});

    const amountCents = Math.round(amount * 100);
    const basketCents = basket ? 12500 : 0;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        { price_data: { currency: "usd", product_data: { name: `Gift Card – $${amount}` }, unit_amount: amountCents }, quantity: 1 },
        ...(basket ? [{ price_data: { currency: "usd", product_data: { name: "Gift Basket (+$125)" }, unit_amount: 12500 }, quantity: 1 }] : [])
      ],
      success_url: `${process.env.SITE_URL}/gift-card-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/gift-cards`,
      customer_email: buyer_email,
      metadata: {
        type: "gift_card",
        amount_cents: amountCents,
        with_basket: String(basket),
        buyer_name, buyer_email, recipient_name, recipient_email,
        message, deliver_on: deliver_on || ""
      }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: "Failed"});
  }
});

// GIFT CARD SUCCESS PAGE
app.get("/gift-card-success", (req, res) => {
  res.send(`<!doctype html><html><head><title>Gift Card - Thank You!</title>
  <style>body{font-family:system-ui;background:#000;color:#fff;text-align:center;padding:80px;line-height:1.6}
  h1{font-size:42px;margin:0 0 16px}a{color:#bfa87c;text-decoration:none;font-weight:600}</style></head><body>
  <h1>Thank You! 🎁</h1>
  <p>Your gift card purchase is complete.</p>
  <p>You’ll receive a confirmation email shortly.</p>
  <p>Chef Chris will prepare and send the PDF gift card to the recipient within 24 hours.</p>
  <br><a href="/">← Back Home</a>
  <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
  <script>confetti({particleCount:180,spread:70,origin:{y:0.6}});</script>
  </body></html>`);
});

app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
});
