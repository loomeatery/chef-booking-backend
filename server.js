// server.js — COMPLETE DROP-IN (ESM, fixed)

// ----------------- Imports & setup -----------------
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGSERIAL PRIMARY KEY,
      start_at TIMESTAMPTZ NOT NULL,
      end_at   TIMESTAMPTZ NOT NULL,
      status   TEXT NOT NULL DEFAULT 'confirmed', -- pending|confirmed|canceled
      customer_name  TEXT,
      customer_email TEXT,
      stripe_session_id TEXT UNIQUE,
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

  console.log("✅ Database schema ready");
}
initSchema().catch(e => {
  console.error("DB init failed:", e);
  process.exit(1);
});

// =============== IMPORTANT ===============
// Stripe requires the *raw* body on the webhook route.
// Define the webhook route BEFORE the JSON body parser.
// =========================================

// ----------------- Stripe Webhook (auto-book on payment) -----------------
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

      const eventDate = md.event_date;             // "YYYY-MM-DD"
      // For now we book full days; start_time is optional
      if (eventDate) {
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

// ----------------- In-memory fallback (leave intact) -----------------
let bookedDates = [];

// ----------------- Health -----------------
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

// ----------------- Availability (reads DB + fallback) -----------------
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
          AND tstzrange(start_at, end_at, '[)') AND tstzrange(start_at, end_at, '[)') && tstzrange($1, $2, '[)')`,
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

    const fromDb = [
      ...expandDates(qBookings.rows),
      ...expandDates(qBlackouts.rows)
    ];

    const fromMem = (bookedDates || []).filter((d) => {
      const dt = new Date(d);
      return dt.getUTCFullYear() === year && (dt.getUTCMonth() + 1) === month;
    });

    const booked = Array.from(new Set([...fromDb, ...fromMem])).sort();
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

// ----------------- Quote -----------------
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
    const deposit  = Math.round(subtotal * sel.depositPct);

    res.json({ subtotal, tax: 0, total: subtotal, deposit });
  } catch (err) {
    console.error("Quote error:", err);
    res.status(400).json({ error: "Unable to create quote." });
  }
});

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
    const balanceBeforeTax = Math.max(0, subtotal - depositDollars);
    if (!Number.isFinite(depositCents) || depositCents < 50) {
      return res.status(400).json({ error: "Calculated deposit is too small or invalid." });
    }

    // 4) Create Stripe Checkout Session (CLEAN METADATA)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      billing_address_collection: "required",
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },

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

      // Send people back to the calendar with a success/cancel flag (no 404)
      success_url: `${process.env.SITE_URL}/booking-calendar#success`,
      cancel_url:  `${process.env.SITE_URL}/booking-calendar#cancel`,

      // Only user-entered fields in metadata
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

    // Keep your old behavior: mark in-memory as "booked" immediately
    if (date) bookedDates.push(date);

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
  if (!process.env.ADMIN_KEY || key === process.env.ADMIN_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ----------------- Admin APIs -----------------
app.post("/api/admin/blackouts", requireAdmin, async (req, res) => {
  try {
    const { date, reason } = req.body || {};
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);

    const r = await pool.query(
      `INSERT INTO blackout_dates (start_at, end_at, reason)
       VALUES ($1,$2,$3) RETURNING id,start_at,end_at,reason`,
      [start.toISOString(), end.toISOString(), reason || ""]
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

// Internal list for admin page
app.get("/__admin/list-bookings", requireAdmin, async (req, res) => {
  try {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!year || !month) return res.status(400).json([]);
    const start = new Date(Date.UTC(year, month-1, 1, 0,0,0));
    const end   = new Date(Date.UTC(year, month,   1, 0,0,0));
    const r = await pool.query(
      `SELECT id,start_at,end_at,status,customer_name,customer_email
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

// ----------------- Simple Admin Page (/admin) -----------------
app.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Calendar Admin</title>
<style>
  :root{--ink:#222;--mut:#666;--bg:#fafafa;--card:#fff;--b:#eee;--btn:#7B8B74;--btn2:#444;}
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:var(--bg);color:var(--ink);margin:0;padding:24px}
  .wrap{max-width:900px;margin:0 auto}
  h1{margin:0 0 8px}
  .card{background:var(--card);border:1px solid var(--b);border-radius:12px;padding:16px;margin:12px 0}
  .row{display:grid;grid-template-columns:1fr;gap:12px}
  @media(min-width:720px){.row.two{grid-template-columns:1fr 1fr}}
  label{font-size:13px;color:var(--mut);margin-bottom:4px;display:block}
  input,select,button{font-size:14px}
  input,select{width:100%;padding:10px;border:1px solid #ddd;border-radius:10px;background:#fff;box-sizing:border-box}
  .btn{display:inline-block;background:var(--btn);color:#fff;border:none;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer}
  .btn.gray{background:var(--btn2)}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid #eee;text-align:left}
  .mut{color:var(--mut);font-size:12px}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #ddd;font-size:12px}
  .tag.ok{border-color:#cfead2;background:#eef9ef}
  .tag.warn{border-color:#f3e3cc;background:#fff6ea}
</style>
</head>
<body>
<div class="wrap">
  <h1>Calendar Admin</h1>
  <div class="mut">Enter your admin key once, then manage blackouts and manual bookings.</div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Admin Key</label>
        <input id="k" type="password" placeholder="Enter ADMIN_KEY (saved locally)" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" onclick="saveKey()">Save Key</button>
        <button class="btn gray" onclick="clearKey()">Clear</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Date</label>
        <input id="date" type="date" />
      </div>
      <div>
        <label>Reason / Name (optional)</label>
        <input id="note" placeholder="Travel, Private, Client name..." />
      </div>
    </div>
    <div style="margin-top:12px">
      <button class="btn" onclick="addBlackout()">+ Add Blackout</button>
      <button class="btn gray" onclick="addBooking()">+ Add Manual Booking</button>
    </div>
  </div>

  <div class="card">
    <div class="row two">
      <div>
        <label>Month</label>
        <input id="month" type="month" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" onclick="loadMonth()">Load Month</button>
      </div>
    </div>

    <h3 style="margin:16px 0 8px">Blackouts</h3>
    <table id="tblBlackouts"><thead>
      <tr><th>ID</th><th>Date(s)</th><th>Reason</th><th></th></tr>
    </thead><tbody></tbody></table>

    <h3 style="margin:16px 0 8px">Bookings</h3>
    <table id="tblBookings"><thead>
      <tr><th>ID</th><th>Date(s)</th><th>Status</th><th>Customer</th><th></th></tr>
    </thead><tbody></tbody></table>
  </div>

  <p class="mut">Tip: after adding a blackout or booking, reload your public calendar. The date should show as <span class="tag warn">Booked</span>.</p>
</div>

<script>
const API = location.origin;
const hdrs = () => ({ "Content-Type": "application/json", "x-admin-key": localStorage.getItem("ADMIN_KEY") || "" });

function saveKey(){ const v = document.getElementById('k').value.trim(); localStorage.setItem('ADMIN_KEY', v); alert('Saved'); }
function clearKey(){ localStorage.removeItem('ADMIN_KEY'); alert('Cleared'); }

async function addBlackout(){
  const d = document.getElementById('date').value;
  const reason = document.getElementById('note').value;
  if(!d) return alert('Pick a date');
  const r = await fetch(\`\${API}/api/admin/blackouts\`, {method:'POST', headers:hdrs(), body:JSON.stringify({date:d, reason})});
  if(!r.ok){ return alert('Error adding blackout'); }
  alert('Blackout added'); loadMonth();
}
async function addBooking(){
  const d = document.getElementById('date').value;
  const note = document.getElementById('note').value;
  if(!d) return alert('Pick a date');
  const r = await fetch(\`\${API}/api/admin/bookings\`, {method:'POST', headers:hdrs(), body:JSON.stringify({date:d, name:note, email:''})});
  if(!r.ok){ return alert('Error adding booking'); }
  alert('Booking added'); loadMonth();
}

function fmtRange(s,e){
  const sd = new Date(s), ed = new Date(e);
  const pad = n => String(n).padStart(2,'0');
  const one = \`\${sd.getUTCFullYear()}-\${pad(sd.getUTCMonth()+1)}-\${pad(sd.getUTCDate())}\`;
  const eday = new Date(ed); eday.setUTCDate(eday.getUTCDate()-1);
  const two = \`\${eday.getUTCFullYear()}-\${pad(eday.getUTCMonth()+1)}-\${pad(eday.getUTCDate())}\`;
  return one===two ? one : \`\${one} → \${two}\`;
}

async function loadMonth(){
  const m = document.getElementById('month').value;
  if(!m){ return alert('Pick a month'); }
  const [yy,mm] = m.split('-');

  const cal = await fetch(\`\${API}/api/availability?year=\${yy}&month=\${Number(mm)}\`);
  const calData = await cal.json();

  const q1 = await fetch(\`\${API}/api/dev/blackouts\`);
  const blackouts = q1.ok ? await q1.json() : [];

  const q2 = await fetch(\`\${API}/__admin/list-bookings?year=\${yy}&month=\${Number(mm)}\`,{headers:hdrs()});
  const bookings = q2.ok ? await q2.json() : [];

  const tb1 = document.querySelector('#tblBlackouts tbody'); tb1.innerHTML='';
  blackouts.forEach(b=>{
    const tr=document.createElement('tr');
    tr.innerHTML = \`<td>\${b.id}</td><td>\${fmtRange(b.start_at,b.end_at)}</td><td>\${b.reason||''}</td>
      <td><button class="btn gray" onclick="delBlackout(\${b.id})">Delete</button></td>\`;
    tb1.appendChild(tr);
  });

  const tb2 = document.querySelector('#tblBookings tbody'); tb2.innerHTML='';
  bookings.forEach(b=>{
    const tag = b.status==='confirmed' ? '<span class="tag ok">confirmed</span>' : '<span class="tag">'+b.status+'</span>';
    const who = (b.customer_name||'') + (b.customer_email? ' • '+b.customer_email : '');
    const tr=document.createElement('tr');
    tr.innerHTML = \`<td>\${b.id}</td><td>\${fmtRange(b.start_at,b.end_at)}</td><td>\${tag}</td><td>\${who}</td>
      <td><button class="btn gray" onclick="delBooking(\${b.id})">Delete</button></td>\`;
    tb2.appendChild(tr);
  });
}

async function delBlackout(id){
  if(!confirm('Delete blackout '+id+'?')) return;
  const r = await fetch(\`\${API}/api/admin/blackouts/\${id}\`, {method:'DELETE', headers:hdrs()});
  if(!r.ok) return alert('Delete failed');
  loadMonth();
}
async function delBooking(id){
  if(!confirm('Delete booking '+id+'?')) return;
  const r = await fetch(\`\${API}/api/admin/bookings/\${id}\`, {method:'DELETE', headers:hdrs()});
  if(!r.ok) return alert('Delete failed');
  loadMonth();
}

(function(){
  const d = new Date();
  document.getElementById('month').value = d.toISOString().slice(0,7);
  document.getElementById('date').value  = d.toISOString().slice(0,10);
})();
</script>
</body>
</html>`);
});

// ----------------- Dev helpers (optional) -----------------
app.get("/api/dev/seed-blackout", async (_req, res) => {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const end   = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    const r = await pool.query(
      `INSERT INTO blackout_dates (start_at, end_at, reason)
       VALUES ($1,$2,'Test blackout') RETURNING *`,
      [start.toISOString(), end.toISOString()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/dev/blackouts", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, start_at, end_at, reason, created_at
         FROM blackout_dates
        ORDER BY id DESC LIMIT 5`
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start server -----------------
app.listen(port, () => {
  console.log(`Chef booking server listening on ${port}`);
});
