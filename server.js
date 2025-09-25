// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

/* ---------- Stripe ---------- */
const STRIPE_SECRET = process.env.STRIPE_SECRET || "";
if (!STRIPE_SECRET) {
  console.warn("⚠️ STRIPE_SECRET is not set. Add it in Render → Environment.");
}
const stripe = new Stripe(STRIPE_SECRET);

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

/* ---------- Demo storage for booked dates (replace with DB later) ---------- */
let bookedDates = [];

/* ---------- Health ---------- */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

/* ---------- Availability (one party per day) ---------- */
app.get("/api/availability", (req, res) => {
  const year  = Number(req.query.year);
  const month = Number(req.query.month); // 1–12

  const dates = bookedDates.filter((d) => {
    const dt = new Date(d);
    return dt.getFullYear() === year && dt.getMonth() + 1 === month;
  });

  res.json({ booked: dates });
});

/* ---------- reCAPTCHA v2 (checkbox) verify ---------- */
async function verifyRecaptcha(token, ip) {
  try {
    const secret = process.env.RECAPTCHA_SECRET;
    if (!secret) {
      console.warn("ℹ️ RECAPTCHA_SECRET not set; skipping verification.");
      return true; // allow while you wire it up
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

/* ---------- Helper: pack arbitrary payload → Stripe metadata safely ---------- */
function toStripeMetadata(payload) {
  const metadata = {};
  const SKIP = new Set(["recaptcha", "recaptchaToken"]);
  const MAX_KEYS = 45; // stay safely under Stripe's 50-key limit
  for (const [k, vRaw] of Object.entries(payload || {})) {
    if (SKIP.has(k) || vRaw == null) continue;
    const key = String(k).trim().slice(0, 40).replace(/\s+/g, "_"); // compact key
    const val = String(vRaw).slice(0, 500);                         // Stripe value limit
    if (!val) continue;
    metadata[key] = val;
    if (Object.keys(metadata).length >= MAX_KEYS) break;
  }
  return metadata;
}

/* ---------- Quote (preview only; no tax on deposit) ---------- */
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
    const deposit  = Math.round(subtotal * sel.depositPct); // dollars (preview)

    res.json({ subtotal, tax: 0, total: subtotal, deposit });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

/* ---------- Book (Stripe Checkout for 30% deposit ONLY) ---------- */
app.post("/api/book", async (req, res) => {
  try {
    if (!STRIPE_SECRET) return res.status(400).json({ error: "Server misconfigured: STRIPE_SECRET is missing." });
    if (!process.env.SITE_URL) return res.status(400).json({ error: "Server misconfigured: SITE_URL is missing." });

    // 1) reCAPTCHA
    const token = req.body?.recaptchaToken || req.body?.recaptcha;
    const captchaOK = await verifyRecaptcha(token, req.ip);
    if (!captchaOK) return res.status(400).json({ error: "reCAPTCHA failed. Please retry." });

    // 2) Normalize incoming fields (works with your new footer JS)
    const b = req.body || {};

    const date  = b.date;
    const time  = b.time;
    const email = b.email;

    // Package can arrive as pkg (old) or packageId/packageName (new)
    const packageId   = b.packageId || b.pkg || "tasting";
    const packageName = b.packageName || {
      tasting:  "Tasting Menu",
      family:   "Family-Style Dinner",
      cocktail: "Cocktail & Canapés"
    }[packageId] || "Private Event";

    const guests = Number(b.guests || 0);

    // Validation
    if (!date || !time) return res.status(400).json({ error: "Missing date or time." });
    if (!email) return res.status(400).json({ error: "Email is required." });
    if (!Number.isFinite(guests) || guests < 1) return res.status(400).json({ error: "Guest count is invalid." });

    // 3) Pricing (allow overrides from frontend; else fall back by package)
    const PKG = {
      tasting:  { perPerson: 200, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const perPerson  = Number(b.perPerson ?? PKG[packageId]?.perPerson ?? 200);
    const depositPct = Number(b.depositPct ?? PKG[packageId]?.depositPct ?? 0.30);

    const subtotal         = perPerson * guests;                // dollars
    const depositDollars   = Math.round(subtotal * depositPct); // dollars (rounded)
    const depositCents     = depositDollars * 100;              // cents
    const balanceBeforeTax = Math.max(0, subtotal - depositDollars);

    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // 4) Receipt-like line item text (bulleted with newlines)
    const nameLine = `Deposit — ${packageName} (${guests} guests, ${date} ${time})`;
    const shortDesc = [
      `• $${perPerson}/guest`,
      `• Subtotal: $${subtotal.toFixed(2)}`,
      `• Deposit (${Math.round(depositPct * 100)}%): $${depositDollars.toFixed(2)}`,
      `• Remaining balance (pre-tax) due after deposit: $${balanceBeforeTax.toFixed(2)}`,
      `• Event: ${date} ${time}`,
      `• Sales tax, if any, will be added to your final invoice`
    ].join("\n");

    // 5) Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false }, // no tax on deposit

      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: depositCents,
            product_data: {
              name: nameLine,
              description: shortDesc
            }
          }
        }
      ],

      success_url: `${process.env.SITE_URL}/booking-success`,
      cancel_url:  `${process.env.SITE_URL}/booking-cancelled`,

      // Save EVERYTHING from the form (minus recaptcha) to Stripe metadata
      metadata: toStripeMetadata({
        ...b,
        pkg: packageId,
        package_title: packageName,
        subtotal_usd: subtotal.toFixed(2),
        deposit_usd: depositDollars.toFixed(2),
        balance_before_tax_usd: balanceBeforeTax.toFixed(2)
      }),

      custom_text: {
        submit: { message: "Remaining balance (pre-tax) is due after today's deposit." }
      }
    });

    // Demo-only: mark date as booked
    if (date) bookedDates.push(date);

    // Return URL for your frontend redirect
    return res.json({ url: session.url, checkoutUrl: session.url });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Unable to create booking.";
    console.error("Book error:", msg);
    return res.status(400).json({ error: msg });
  }
});

/* ---------- Start server ---------- */
app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
  if (!process.env.SITE_URL) {
    console.warn("ℹ️  SITE_URL not set; add it in Render → Environment.");
  }
});
