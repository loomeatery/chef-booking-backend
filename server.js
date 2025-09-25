import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET);

// Middleware
app.use(cors());
app.use(express.json());

// Simple in-memory "database" for booked dates
let bookedDates = [];

// === Availability Endpoint ===
app.get("/api/availability", (req, res) => {
  const year = req.query.year;
  const month = req.query.month;

  const dates = bookedDates.filter(d => {
    const dt = new Date(d);
    return dt.getFullYear() == year && dt.getMonth() + 1 == month;
  });

  res.json({ booked: dates });
});

// === Quote Endpoint ===
app.post("/api/quote", async (req, res) => {
  try {
    const { pkg, guests, address } = req.body;
    const subtotal = pkg === "cocktail" ? guests * 125 : guests * 200;
    const depositPct = pkg === "cocktail" ? 0.3 : 0.3;

    // Stripe Tax (automatic)
    const tax = 0; // Placeholder – Stripe will handle in checkout
    const total = subtotal + tax;
    const deposit = Math.round(total * depositPct);

    res.json({ subtotal, tax, total, deposit });
  } catch (err) {
    res.status(400).json({ error: "Unable to create quote." });
  }
});

// === Book Endpoint ===
app.post("/api/book", async (req, res) => {
  try {
    const {
      date, time, pkg, guests, name, email, phone, address, diet, recaptcha
    } = req.body;

    // Verify reCAPTCHA
    const r = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${recaptcha}`,
      { method: "POST" }
    );
    const data = await r.json();
    if (!data.success) return res.status(400).json({ error: "reCAPTCHA failed." });

    // Create Stripe Checkout Session
    const lineItems = [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `${pkg} - ${guests} guests` },
          unit_amount: pkg === "cocktail" ? 12500 : 20000, // cents
        },
        quantity: guests,
      },
    ];

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      automatic_tax: { enabled: true },
      customer_email: email,
      success_url: `${process.env.SITE_URL}/booking-success`,
      cancel_url: `${process.env.SITE_URL}/booking-cancelled`,
    });

    // Mark date as booked (in memory – replace with DB later)
    bookedDates.push(date);

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Unable to create booking." });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
