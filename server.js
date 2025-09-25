// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// --- Stripe ---
if (!process.env.STRIPE_SECRET) {
  console.warn("⚠️  Missing STRIPE_SECRET in environment.");
}
const stripe = new Stripe(process.env.STRIPE_SECRET);

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Simple in-memory 'database' for booked dates ---
let bookedDates = [];

// --- Health check (useful for Render) ---
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// === Availability Endpoint ===
app.get("/api/availability", (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1-12

  const dates = bookedDates.filter((d) => {
    const dt = new Date(d);
    return dt.getFullYear() === year && dt.getMonth() + 1 === month;
  });

  res.json({ booked: dates });
});

// === Quote Endpoint (front-end preview only; tax is computed at Checkout) ===
app.post("/api/quote", async (req, res) => {
  try {
    const { pkg, guests } = req.body;

    const perPerson = pkg === "cocktail" ? 125 : 200;
    const depositPct = 0.30;

    const g = Math.max(1, Number(guests || 0));
    const subtotal = perPerson * g;             // e.g. 200 * 6 = 1200
    const deposit  = Math.round(subtotal * depositPct);

    // We do NOT compute tax here—Stripe calculates it at Checkout from the buyer's address.
    res.json({
      subtotal,
      tax: 0,                                   // placeholder
      total: subtotal,
      deposit                                   // before tax; tax added in Checkout
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// === Book Endpoint (creates Stripe Checkout Session for 30% deposit + tax) ===
app.post("/api/book", async (req, res) => {
  try {
    const {
      date, time, pkg, guests, name, email, phone, address, diet, recaptcha
    } = req.body;

    // --- Verify reCAPTCHA ---
    if (!process.env.RECAPTCHA_SECRET) {
      console.warn("⚠️  Missing RECAPTCHA_SECRET in environment.");
    }
    const rc = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${recaptcha}`,
      { method: "POST" }
    );
    const rcData = await rc.json();
    if (!rcData.success) return res.status(400).json({ error: "reCAPTCHA failed." });

    // --- Pricing (deposit only) ---
    const perPerson = pkg === "cocktail" ? 125 : 200;
    const depositPct = 0.30;

    const g = Math.max(1, Number(guests || 0));
    const subtotal = perPerson * g;                  // e.g. 1200
    const depositBase = subtotal * depositPct;       // e.g. 360
    const depositCents = Math.round(depositBase * 100);

    // --- Create Stripe Checkout Session ---
    if (!process.env.SITE_URL) {
      console.warn("⚠️  Missing SITE_URL in environment.");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // Let Stripe apply tax at checkout using buyer's address
      automatic_tax: { enabled: true },

      // Require a billing address to compute tax
      billing_address_collection: "required",
      customer_creation: "if_required",

      customer_email: email,

      // One line item = the DEPOSIT amount only (tax added on top)
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: depositCents,               // *** ONLY the 30% deposit ***
            tax_behavior: "exclusive",               // allow tax to be added
            product_data: {
              name: `Deposit – ${pkg} (${g} guests, ${date})`,
              // Food for Immediate Consumption
              tax_code: "txcd_40060003"
            }
          },
          quantity: 1
        }
      ],

      // Keep booking details as metadata
      metadata: {
        event_date: date || "",
        event_time: time || "",
        package: pkg || "",
        guests: String(g),
        customer_name: name || "",
        customer_phone: phone || "",
        diet: diet || "",
        event_address_line1: address?.line1 || "",
        event_address_city: address?.city || "",
        event_address_state: address?.state || "",
        event_address_zip: address?.postal_code || ""
      },

      success_url: `${process.env.SITE_URL}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/booking-cancelled`
    });

    // NOTE: In production, you should mark the date as booked after payment succeeds via a webhook.
    // For now we mirror your original behavior:
    if (date) bookedDates.push(date);

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Unable to create booking." });
  }
});

// --- Start server ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
