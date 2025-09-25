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
const stripe = new Stripe(process.env.STRIPE_SECRET);

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Simple in-memory 'database' for booked dates ---
let bookedDates = [];

// --- Health check (Render uses this sometimes) ---
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// === Availability (one party per day) ===
app.get("/api/availability", (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month); // 1-12

  const dates = bookedDates.filter((d) => {
    const dt = new Date(d);
    return dt.getFullYear() === year && dt.getMonth() + 1 === month;
  });

  res.json({ booked: dates });
});

// === Quote (front-end preview only; Stripe calculates real tax at final invoice) ===
app.post("/api/quote", async (req, res) => {
  try {
    const { pkg, guests } = req.body;

    const perPerson = pkg === "cocktail" ? 125 : 200;
    const depositPct = 0.30;

    const g = Math.max(1, Number(guests || 0));
    const subtotal = perPerson * g;
    const deposit  = Math.round(subtotal * depositPct);

    res.json({
      subtotal,
      tax: 0,            // placeholder (no tax collected in this session)
      total: subtotal,   // estimate shown on your site; final tax comes later
      deposit            // deposit before tax; deposit is what we collect now
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// === Book (creates Stripe Checkout session for 30% deposit ONLY; no tax now) ===
app.post("/api/book", async (req, res) => {
  try {
    const {
      date, time, pkg, guests, name, email, phone, address, diet, recaptcha
    } = req.body;

    // Verify reCAPTCHA
    const rc = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${recaptcha}`,
      { method: "POST" }
    );
    const rcData = await rc.json();
    if (!rcData.success) return res.status(400).json({ error: "reCAPTCHA failed." });

    // Pricing – deposit only
    const perPerson = pkg === "cocktail" ? 125 : 200;
    const depositPct = 0.30;
    const g = Math.max(1, Number(guests || 0));
    const subtotal = perPerson * g;
    const depositBase = subtotal * depositPct;
    const depositCents = Math.round(depositBase * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // We are NOT collecting tax on the deposit
      automatic_tax: { enabled: false },

      billing_address_collection: "required",
      customer_creation: "if_required",
      customer_email: email,

      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: depositCents, // 30% deposit only
            product_data: {
              name: `Deposit – ${pkg} (${g} guests, ${date})`,
              // Food for Immediate Consumption (for reporting consistency)
              tax_code: "txcd_40060003"
            }
          },
          quantity: 1
        }
      ],

      // Helpful note shown on Checkout
      custom_text: {
        submit: {
          message:
            "Today you’re paying a 30% deposit only. The remaining balance, including any applicable sales tax, will be invoiced 7 days before your event."
        }
      },

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

    // TEMP: mark date as booked now (replace w/ webhook in production)
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
