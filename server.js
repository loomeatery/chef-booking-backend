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

// --- inside app.post("/api/book", ...) right before res.json({ checkoutUrl: session.url }) ---
const PACKAGE_MAP = {
  tasting:  { title: "Tasting Menu",        perPerson: 200, depositPct: 0.30 },
  family:   { title: "Family-Style Dinner", perPerson: 200, depositPct: 0.30 },
  cocktail: { title: "Cocktail & Canapés",  perPerson: 125, depositPct: 0.30 },
};

const sel = PACKAGE_MAP[pkg] || PACKAGE_MAP.tasting;
const subtotal       = sel.perPerson * Number(guests || 0);
const deposit        = Math.round(subtotal * sel.depositPct * 100); // cents
const balanceBeforeTax = (subtotal - Math.round(subtotal * sel.depositPct)); // display only

// Build a clear, concise description that shows on Checkout
const descLines = [
  "What’s included:",
  "• Grocery shopping & prep",
  "• On-site cooking & service",
  "• Kitchen clean-up",
  "",
  "Booking details:",
  `• Party size: ${guests}`,
  `• Menu: ${sel.title}`,
  `• Price: $${sel.perPerson}/guest`,
  `• Subtotal: $${subtotal.toFixed(2)}`,
  `• Deposit (30%): $${(subtotal * sel.depositPct).toFixed(2)}`,
  `• Balance due (before tax): $${balanceBeforeTax.toFixed(2)}`,
  "",
  "Sales tax, if any, is calculated and collected with your final invoice (not on today’s deposit)."
].join("\n");

const session = await stripe.checkout.sessions.create({
  mode: "payment",
  currency: "usd",

  // One line item: the deposit amount only
  line_items: [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: deposit, // deposit in cents
        product_data: {
          // This is the title they see on the left
          name: `Deposit – ${sel.title} (${guests} guests, ${date} ${time})`,
          // This multi-line description shows under the title
          description: descLines,
        },
      },
    },
  ],

  // Collect good contact + address info
  customer_email: email,
  billing_address_collection: "required",
  phone_number_collection: { enabled: true },

  // We do NOT tax deposits. Final tax will be on your later invoice.
  automatic_tax: { enabled: false },

  // Helpful copy at the bottom of the Checkout button area
  custom_text: {
    submit: {
      message:
        "Today you’re paying a 30% deposit only. The remaining balance, including any applicable sales tax, will be invoiced 7 days before your event.",
    },
  },

  // Require their consent to terms (optional, but nice)
  consent_collection: { terms_of_service: "required" },

  // Keep all the context with the payment in your Stripe dashboard
  metadata: {
    pkg,
    package_title: sel.title,
    guests: String(guests),
    event_date: date,
    event_time: time,
    customer_name: name,
    customer_phone: phone,
    event_line1: address?.line1 || "",
    event_city: address?.city || "",
    event_state: address?.state || "",
    event_zip: address?.postal_code || "",
    diet: diet || "",
    subtotal_usd: subtotal.toFixed(2),
    deposit_usd: (subtotal * sel.depositPct).toFixed(2),
    balance_before_tax_usd: balanceBeforeTax.toFixed(2),
  },

  success_url: `${process.env.SITE_URL}/booking-success`,
  cancel_url: `${process.env.SITE_URL}/booking-cancelled`,
});


// --- Start server ---
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
