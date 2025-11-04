// popups.routes.js
// Express router that provides:
// - /api/popups (CRUD) stored in data/popups.json
// - /admin-popups (passworded admin UI)
//
// ENV required: ADMIN_KEY=yourStrongPassword
// On Render, attach a Persistent Disk so data/popups.json survives deploys

const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();
router.use(express.json());

const DATA_DIR  = path.join(process.cwd(), 'data');
const DATA_PATH = path.join(DATA_DIR, 'popups.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme-local-only';

// Ensure storage exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_PATH)) fs.writeFileSync(DATA_PATH, JSON.stringify({ events: [] }, null, 2));

// Helpers
function readStore() { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')); }
function writeStore(obj) { fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2)); }
function ok(res, data){ res.json(data); }
function bad(res, code, msg){ res.status(code).json({ error: msg }); }

// Public: list all events
router.get('/api/popups', (req, res) => {
  try { ok(res, readStore()); } catch(e){ bad(res, 500, 'read_failed'); }
});

// Public: single event
router.get('/api/popups/:id', (req, res) => {
  try {
    const store = readStore();
    const ev = (store.events||[]).find(e=>e.id===req.params.id);
    if(!ev) return bad(res, 404, 'not_found');
    ok(res, ev);
  } catch(e){ bad(res, 500, 'read_failed'); }
});

// Simple header auth
function requireAdmin(req, res, next){
  const key = req.get('x-admin-key');
  if(!key || key !== ADMIN_KEY) return bad(res, 401, 'unauthorized');
  next();
}

// Create
router.post('/api/popups', requireAdmin, (req, res) => {
  try {
    const store = readStore();
    const ev = req.body || {};
    if(!ev.id) return bad(res, 400, 'id_required');
    if(store.events.some(e=>e.id===ev.id)) return bad(res, 409, 'id_exists');
    store.events.push(ev);
    writeStore(store);
    res.status(201).json(ev);
  } catch(e){ bad(res, 500, 'write_failed'); }
});

// Update
router.put('/api/popups/:id', requireAdmin, (req, res) => {
  try {
    const store = readStore();
    const i = store.events.findIndex(e=>e.id===req.params.id);
    if(i===-1) return bad(res, 404, 'not_found');
    store.events[i] = { ...store.events[i], ...req.body, id: req.params.id };
    writeStore(store);
    ok(res, store.events[i]);
  } catch(e){ bad(res, 500, 'write_failed'); }
});

// Delete
router.delete('/api/popups/:id', requireAdmin, (req, res) => {
  try {
    const store = readStore();
    const before = store.events.length;
    store.events = store.events.filter(e=>e.id!==req.params.id);
    if(store.events.length===before) return bad(res, 404, 'not_found');
    writeStore(store);
    ok(res, { ok:true });
  } catch(e){ bad(res, 500, 'write_failed'); }
});

// Admin UI (single page)
const ADMIN_HTML = `
<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pop-up Admin</title>
<style>
:root{--ink:#183027;--mut:#6b7a71;--bg:#f6f7f5;--card:#fff;--btn:#2f6f4f;}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:var(--bg);color:var(--ink);margin:0;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
h1{margin:0 0 16px}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:16px}
input,textarea{border:1px solid #d7ddd8;border-radius:10px;padding:10px;font-size:14px;width:100%}
label{font-weight:600;font-size:13px;color:var(--mut)}
.grid{display:grid;grid-template-columns:1.2fr 1fr;gap:16px}
.card{background:var(--card);border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.08);padding:16px}
.btn{appearance:none;border:0;border-radius:12px;padding:10px 14px;font-weight:700;cursor:pointer}
.primary{background:var(--btn);color:#fff}.secondary{background:#e9f5ee;color:var(--btn)}
table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;font-size:14px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.smallrow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.mut{color:var(--mut);font-size:12px}
.images textarea{height:80px}.notes textarea{height:70px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
<div class="wrap">
  <h1>Pop-up Classes</h1>
  <div class="bar">
    <input id="key" type="password" placeholder="Admin key (once per session)"/>
    <button class="btn secondary" id="refresh">Refresh</button>
    <button class="btn primary" id="new">New Event</button>
  </div>

  <div class="grid">
    <div class="card">
      <table id="table">
        <thead><tr><th>Title</th><th>Date</th><th>Time</th><th>Price</th><th>Capacity</th><th>Actions</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="card" id="editor" style="display:none">
      <div class="row">
        <div><label>ID (unique, URL-safe)</label><input id="id" placeholder="pasta-bk-dec12-7pm"/></div>
        <div><label>SKU</label><input id="sku" placeholder="PASTA-BK-DEC12"/></div>
      </div>
      <div><label>Title</label><input id="title" placeholder="Brooklyn Pop-Up: Handmade Pasta Night"/></div>
      <div><label>Location</label><input id="location" placeholder="Brooklyn, NY (exact address sent after booking)"/></div>
      <div class="row">
        <div><label>Date (YYYY-MM-DD)</label><input id="date" placeholder="2025-12-12"/></div>
        <div><label>Start → End (24h)</label><input id="time" placeholder="19:00-21:00"/></div>
      </div>
      <div class="smallrow">
        <div><label>Price</label><input id="price" type="number" placeholder="125"/></div>
        <div><label>Capacity</label><input id="capacity" type="number" placeholder="12"/></div>
        <div><label>Min/Order</label><input id="min" type="number" placeholder="1"/></div>
        <div><label>Max/Order</label><input id="max" type="number" placeholder="4"/></div>
      </div>
      <div class="row">
        <div class="images"><label>Image URLs (one per line)</label><textarea id="images" placeholder="https://.../pasta1.jpg\nhttps://.../pasta2.jpg"></textarea></div>
        <div class="notes"><label>Notes (allergens, etc.)</label><textarea id="notes" placeholder="No shellfish. Vegetarian options available."></textarea></div>
      </div>
      <div class="row">
        <div><label>What We’ll Make (one per line)</label><textarea id="make" placeholder="Fresh egg tagliatelle&#10;Ricotta gnudi&#10;Brown butter & sage"></textarea></div>
        <div><label>Includes (one per line)</label><textarea id="includes" placeholder="Hands-on instruction&#10;All ingredients & tools&#10;Tasting + take-home notes"></textarea></div>
      </div>
      <div class="row">
        <div>
          <label>Stripe Payment Link or Checkout URL (optional)</label>
          <input id="fallbackUrl" placeholder="https://buy.stripe.com/.. OR /api/checkout?sku={SKU}&date={DATE}&qty={QTY}"/>
          <div class="mut">If blank, your front-end will call <code>startBooking(...)</code> if available.</div>
        </div>
        <div>
          <label>Hidden? (type "true" to hide)</label>
          <input id="hidden" placeholder="false"/>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="save">Save</button>
        <button class="btn secondary" id="cancel">Cancel</button>
        <button class="btn" style="background:#fee;color:#a00;margin-left:auto" id="del">Delete</button>
      </div>
    </div>
  </div>
</div>
<script>
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s)); const T=id=>document.getElementById(id);
let KEY='', editingId=null;
function setKey(){ if(!KEY) KEY=T('key').value.trim(); if(!KEY) alert('Enter admin key.'); return !!KEY; }
async function fetchJSON(url,opts={}){ const res=await fetch(url,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{}),...(KEY?{'x-admin-key':KEY}:{})}}); if(!res.ok) throw new Error('HTTP '+res.status); return res.json(); }
async function load(){ const data=await fetchJSON('/api/popups'); const tbody=$('#table tbody'); tbody.innerHTML=''; (data.events||[]).forEach(ev=>{ const tr=document.createElement('tr'); tr.innerHTML=\`
<td>\${ev.title||''}</td><td>\${ev.date||''}</td><td>\${(ev.startTime||'')+(ev.endTime?'–'+ev.endTime:'')}</td><td>\${ev.price?('$'+ev.price):''}</td><td>\${ev.capacity||''}</td>
<td><button class="btn secondary" data-edit="\${ev.id}">Edit</button></td>\`; tbody.appendChild(tr); });
$$('button[data-edit]').forEach(b=>b.onclick=()=>edit(b.dataset.edit,(data.events||[]).find(e=>e.id===b.dataset.edit))); }
function edit(id,ev){ editingId=id; T('editor').style.display='block';
T('id').value=ev?.id||''; T('sku').value=ev?.sku||''; T('title').value=ev?.title||''; T('location').value=ev?.location||'';
T('date').value=ev?.date||''; T('time').value=(ev?.startTime&&ev?.endTime)?(ev.startTime+'-'+ev.endTime):'';
T('price').value=ev?.price||''; T('capacity').value=ev?.capacity||''; T('min').value=ev?.minPerOrder||''; T('max').value=ev?.maxPerOrder||'';
T('images').value=(ev?.images||[]).join('\\n'); T('notes').value=ev?.notes||''; T('make').value=(ev?.whatWeMake||[]).join('\\n'); T('includes').value=(ev?.includes||[]).join('\\n');
T('fallbackUrl').value=(ev?.fallbackUrl||''); T('hidden').value=String(!!ev?.hidden); }
function gather(){ const [start,end]=(T('time').value||'').split('-').map(s=>s?.trim());
const ev={ id:T('id').value.trim(), sku:T('sku').value.trim(), title:T('title').value.trim(), location:T('location').value.trim(),
date:T('date').value.trim(), startTime:start||null, endTime:end||null, price:Number(T('price').value||0), capacity:Number(T('capacity').value||0),
minPerOrder:Number(T('min').value||1), maxPerOrder:Number(T('max').value||4),
images:T('images').value.split(/\\n+/).map(s=>s.trim()).filter(Boolean), notes:T('notes').value.trim(),
whatWeMake:T('make').value.split(/\\n+/).map(s=>s.trim()).filter(Boolean),
includes:T('includes').value.split(/\\n+/).map(s=>s.trim()).filter(Boolean),
fallbackUrl:T('fallbackUrl').value.trim()||null, hidden:/^true$/i.test(T('hidden').value.trim()) };
if(!ev.id) throw new Error('ID is required'); if(!/^[a-z0-9-_]+$/i.test(ev.id)) throw new Error('ID must be URL-safe.'); return ev; }
T('refresh').onclick=()=>{ if(setKey()) load().catch(e=>alert(e.message)); };
T('new').onclick=()=>{ if(setKey()){ editingId=null; edit('',{}); } };
T('cancel').onclick=()=>{ T('editor').style.display='none'; editingId=null; };
T('save').onclick=async()=>{ try{ if(!setKey())return; const ev=gather(); const method=editingId?'PUT':'POST'; const url=editingId?('/api/popups/'+encodeURIComponent(editingId)):'/api/popups';
await fetchJSON(url,{method,body:JSON.stringify(ev)}); T('editor').style.display='none'; await load(); alert('Saved.'); }catch(e){ alert(e.message); } };
T('del').onclick=async()=>{ try{ if(!setKey())return; if(!editingId) return alert('Nothing selected.'); if(!confirm('Delete this event?')) return;
await fetchJSON('/api/popups/'+encodeURIComponent(editingId),{method:'DELETE'}); T('editor').style.display='none'; await load(); alert('Deleted.'); }catch(e){ alert(e.message); } };
load().catch(()=>{});
</script>
`;
router.get('/admin-popups', (req, res) => { res.set('Content-Type','text/html; charset=utf-8'); res.send(ADMIN_HTML); });

module.exports = router;
