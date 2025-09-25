// server.js (ESM, minimal + stable)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app  = express();
const port = process.env.PORT || 3000;

// --- Stripe ---
const STRIPE_SECRET = process.env.STRIPE_SECRET || "";
if (!STRIPE_SECRET) {
  console.warn("⚠️ STRIPE_SECRET is not set. Checkout will fail until you add it in Render → Environment.");
}
const stripe = new Stripe(STRIPE_SECRET);

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- In-memory booked dates (demo) ---
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
app.post("/api/quote", (req, res) => {
  try {
    const { pkg, guests } = req.body || {};
    const PKG = {
      tasting:  { perPerson: 200, depositPct: 0.30 },
      family:   { perPerson: 200, depositPct: 0.30 },
      cocktail: { perPerson: 125, depositPct: 0.30 },
    };
    const sel = PKG[pkg] || PKG.tasting;

    const g        = Math.max(1, Number(guests || 0));
    const subtotal = sel.perPerson * g;
    const deposit  = Math.round(subtotal * sel.depositPct); // dollars (for preview)

    res.json({
      subtotal,
      tax: 0,           // no tax on deposit; final invoice later
      total: subtotal,  // preview only
      deposit
    });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// === Book (Stripe Checkout for 30% deposit ONLY; no tax now) ===
app.post("/api/book", async (req, res) => {
  try {
    const {
      date, time, pkg, guests, name, email, phone, address, diet
    } = req.body || {};

    // Basic validation
    if (!STRIPE_SECRET) return res.status(400).json({ error: "Server misconfigured: STRIPE_SECRET is missing." });
    if (!process.env.SITE_URL) return res.status(400).json({ error: "Server misconfigured: SITE_URL is missing." });
    if (!date || !time) return res.status(400).json({ error: "Missing date or time." });
    if (!email) return res.status(400).json({ error: "Email is required." });
    const g = Number(guests);
    if (!Number.isFinite(g) || g < 1) return res.status(400).json({ error: "Guest count is invalid." });

    // Pricing (deposit only)
    const PKG = {
      tasting:  { title: "Tasting Menu",        perPerson: 200, depositPct: 0.30 },
      family:   { title: "Family-Style Dinner", perPerson: 200, depositPct: 0.30 },
      cocktail: { title: "Cocktail & Canapés",  perPerson: 125, depositPct: 0.30 },
    };
    const sel = PKG[pkg] || PKG.tasting;

    const subtotal         = sel.perPerson * g;          // dollars
    const depositDollars   = subtotal * sel.depositPct;  // dollars
    const depositCents     = Math.round(depositDollars * 100);
    const balanceBeforeTax = subtotal - depositDollars;  // dollars (display only)

    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // Keep description concise to avoid any Stripe validation issues
    const shortDesc =
      `Party: ${g} • ${sel.title} • $${sel.perPerson}/guest • ` +
      `Subtotal $${subtotal.toFixed(2)} • Deposit $${depositDollars.toFixed(2)} • ` +
      `Balance (pre-tax) $${balanceBeforeTax.toFixed(2)} • Event ${date} ${time}. ` +
      `Tax, if any, will be added to your final invoice.`;

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
            unit_amount: depositCents, // cents
            product_data: {
              name: `Deposit — ${sel.title} (${g} guests, ${date} ${time})`,
              description: shortDesc
            }
          }
        }
      ],

      // Required URLs
      success_url: `${process.env.SITE_URL}/booking-success`,
      cancel_url:  `${process.env.SITE_URL}/booking-cancelled`,

      // Minimal metadata (safe)
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
      }
    });

    // Mark date booked (demo; replace with DB later)
    if (date) bookedDates.push(date);

    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Unable to create booking.";
    console.error("Book error:", msg);
    return res.status(400).json({ error: msg });
  }
});

// --- Start server ---
app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
  if (!process.env.SITE_URL) {
    console.warn("ℹ️  SITE_URL not set; set it in Render → Environment to your site URL.");
  }
});
