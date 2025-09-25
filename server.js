// server.js (ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import fetch from "node-fetch";

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

// --- Stripe ---
if (!process.env.STRIPE_SECRET) {
  console.warn("⚠️  STRIPE_SECRET is not set. Checkout will fail until you add it.");
}
const stripe = new Stripe(process.env.STRIPE_SECRET || "");

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Simple in-memory "database" for booked dates ---
let bookedDates = [];

// --- Health checks ---
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// === Availability (one party per day) ===
app.get("/api/availability", (req, res) => {
  const year  = Number(req.query.year);
  const month = Number(req.query.month); // 1–12

  const dates = bookedDates.filter((d) => {
    const dt = new Date(d);
    return dt.getFullYear() === year && dt.getMonth() + 1 === month;
  });

  res.json({ booked: dates });
});

// === Quote (front-end preview only; no tax now) ===
app.post("/api/quote", async (req, res) => {
  try {
    const { pkg, guests } = req.body;

    const perPerson  = pkg === "cocktail" ? 125 : 200;
    const depositPct = 0.30;

    const g         = Math.max(1, Number(guests || 0));
    const subtotal  = perPerson * g;
    const deposit   = Math.round(subtotal * depositPct); // dollars (not cents) for preview

    res.json({
      subtotal,
      tax: 0,           // placeholder (we don't tax the deposit)
      total: subtotal,  // preview only; you’ll tax final invoice later
      deposit          // deposit collected now (in dollars for the preview)
    });
} catch (err) {
  console.error("Book error:", err);
  res.status(400).json({ error: err?.message || "Unable to create booking." });
}
});

// === Book (Stripe Checkout for 30% deposit ONLY; no tax now) ===
app.post("/api/book", async (req, res) => {
  try {
    const {
      date, time, pkg, guests, name, email, phone, address, diet, recaptcha
    } = req.body || {};

    // --- Verify reCAPTCHA only if a secret is configured ---
    if (process.env.RECAPTCHA_SECRET) {
      const verifyURL = `https://www.google.com/recaptcha/api/siteverify?secret=${
        encodeURIComponent(process.env.RECAPTCHA_SECRET)
      }&response=${encodeURIComponent(recaptcha || "")}`;

      const rc = await fetch(verifyURL, { method: "POST" });
      const rcData = await rc.json();
      if (!rcData.success) return res.status(400).json({ error: "reCAPTCHA failed." });
    }

    // --- Pricing (deposit only) ---
    const PACKAGE_MAP = {
      tasting:  { title: "Tasting Menu",        perPerson: 200, depositPct: 0.30 },
      family:   { title: "Family-Style Dinner", perPerson: 200, depositPct: 0.30 },
      cocktail: { title: "Cocktail & Canapés",  perPerson: 125, depositPct: 0.30 },
    };
    const sel = PACKAGE_MAP[pkg] || PACKAGE_MAP.tasting;

    const g                = Math.max(1, Number(guests || 0));
    const subtotal         = sel.perPerson * g;             // dollars
    const depositDollars   = subtotal * sel.depositPct;     // dollars
    const depositCents     = Math.round(depositDollars * 100);
    const balanceBeforeTax = subtotal - depositDollars;     // dollars (display only)

    // --- What shows on Stripe Checkout ---
    const descLines = [
      "What’s included:",
      "• Grocery shopping & prep",
      "• On-site cooking & service",
      "• Kitchen clean-up",
      "",
      "Booking details:",
      `• Party size: ${g}`,
      `• Menu: ${sel.title}`,
      `• Price: $${sel.perPerson}/guest`,
      `• Subtotal: $${subtotal.toFixed(2)}`,
      `• Deposit (${Math.round(sel.depositPct*100)}%): $${depositDollars.toFixed(2)}`,
      `• Balance due (before tax): $${balanceBeforeTax.toFixed(2)}`,
      "",
      "Sales tax, if any, is calculated and collected with your final invoice (not on today’s deposit)."
    ].join("\n");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // We charge **deposit only** now:
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: depositCents, // cents
            product_data: {
              name: `Deposit – ${sel.title} (${g} guests, ${date} ${time})`,
              description: descLines
            }
          }
        }
      ],

      // We do NOT tax deposits. Final tax will be on your later invoice.
      automatic_tax: { enabled: false },

      // Collect contact details
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },

      // Helpful message under the Pay button
      custom_text: {
        submit: {
          message:
            "Today you’re paying a 30% deposit only. The remaining balance, including any applicable sales tax, will be invoiced 7 days before your event."
        }
      },

      // Optional: require agreeing to terms
      consent_collection: { terms_of_service: "required" },

      // Keep all context with the payment in Stripe
      metadata: {
        pkg,
        package_title: sel.title,
        guests: String(g),
        event_date: date,
        event_time: time,
        customer_name: name || "",
        customer_phone: phone || "",
        event_line1: address?.line1 || "",
        event_city:  address?.city  || "",
        event_state: address?.state || "",
        event_zip:   address?.postal_code || "",
        diet: diet || "",
        subtotal_usd: subtotal.toFixed(2),
        deposit_usd: depositDollars.toFixed(2),
        balance_before_tax_usd: balanceBeforeTax.toFixed(2)
      },

      success_url: `${process.env.SITE_URL}/booking-success`,
      cancel_url:  `${process.env.SITE_URL}/booking-cancelled`
    });

    // Mark the date as booked (demo only; replace with DB later)
    if (date) bookedDates.push(date);

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Book error:", err);
    res.status(400).json({ error: "Unable to create booking." });
  }
});

// --- Start server ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
