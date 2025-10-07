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

    // 3.5) Optional: auto-apply promotion code if provided
    const promoRaw = (b.promo || b.promotionCode || b.code || "").trim();
    let discounts = [];
    if (promoRaw) {
      try {
        const pc = await stripe.promotionCodes.list({ code: promoRaw, active: true, limit: 1 });
        if (pc.data[0]?.id) discounts = [{ promotion_code: pc.data[0].id }];
      } catch (e) {
        console.warn("Promo lookup failed:", e.message);
      }
    }

    // 4) Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },

      // 👇 This shows the "Add promotion code" box on Stripe's hosted page
      allow_promotion_codes: true,

      // 👇 If a valid promo code was passed, it gets auto-applied
      ...(discounts.length ? { discounts } : {}),

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
