import test, { after, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.STRIPE_SECRET = "sk_test_placeholder";
process.env.SITE_URL = "https://www.privatechefchristopherlamagna.com";
process.env.ADMIN_KEY = "test-admin-key";

const {
  app,
  BOOKING_PACKAGES,
  PACKAGE_TITLES,
  buildBalancePaidEmail,
  buildBalancePaymentLink,
  buildBalancePrice,
  buildBalanceProduct,
  buildGenericPaymentEmail,
  classifyCheckoutPayment,
  getHolidayPerPerson,
  inAllowedZip,
  parseDollarAmount,
  safeTokenEqual,
  STRIPE_BALANCE_PRODUCT_ID
} = await import("../server.js");

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

test("booking package IDs keep their production pricing and titles", () => {
  assert.deepEqual(BOOKING_PACKAGES, {
    tasting: { perPerson: 215, depositPct: 0.30 },
    family: { perPerson: 200, depositPct: 0.30 },
    cocktail: { perPerson: 125, depositPct: 0.30 },
    dinner2: { perPerson: 150, depositPct: 0.30 }
  });
  assert.deepEqual(PACKAGE_TITLES, {
    tasting: "Tasting Menu",
    family: "Family-Style Dinner",
    cocktail: "Cocktail & Canapés",
    dinner2: "At Home Pasta Cooking Class"
  });
});

test("service-area ZIP rules accept supported boroughs and counties", () => {
  for (const zip of ["10001", "11101", "11201", "11354", "11691", "11530", "11706", "11968"]) {
    assert.equal(inAllowedZip(zip), true, zip);
  }
  for (const zip of ["10580", "07030", "1234", "ABCDE", "12000"]) {
    assert.equal(inAllowedZip(zip), false, zip);
  }
});

test("holiday pricing preserves current business rules", () => {
  assert.equal(getHolidayPerPerson("2026-09-07", "tasting", 215), 250);
  assert.equal(getHolidayPerPerson("2026-12-25", "family", 200), 300);
  assert.equal(getHolidayPerPerson("2026-12-25", "cocktail", 125), 125);
  assert.equal(getHolidayPerPerson("2026-10-10", "tasting", 215), 215);
});

test("timing-safe token comparison rejects missing and incorrect values", () => {
  assert.equal(safeTokenEqual("matching-token", "matching-token"), true);
  assert.equal(safeTokenEqual("wrong-token", "matching-token"), false);
  assert.equal(safeTokenEqual("", "matching-token"), false);
  assert.equal(safeTokenEqual(undefined, undefined), false);
});

test("quote endpoint returns the expected live tasting-menu deposit", async () => {
  const response = await fetch(`${baseUrl}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "tasting", guests: 6, date: "2026-10-10" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    subtotal: 1290,
    tax: 0,
    total: 1290,
    deposit: 387
  });
});

test("quote endpoint rejects unknown packages and invalid guest counts", async () => {
  const unknown = await fetch(`${baseUrl}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "unknown", guests: 6 })
  });
  assert.equal(unknown.status, 400);

  const invalidGuests = await fetch(`${baseUrl}/api/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "tasting", guests: 0 })
  });
  assert.equal(invalidGuests.status, 400);
});

test("security headers and CORS remain compatible with the live website", async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-powered-by"), null);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");

  const allowed = await fetch(`${baseUrl}/api/quote`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.privatechefchristopherlamagna.com",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.privatechefchristopherlamagna.com");

  const blocked = await fetch(`${baseUrl}/api/quote`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.invalid",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
});

test("admin APIs fail closed when the admin key is not configured", async () => {
  const original = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  try {
    const response = await fetch(`${baseUrl}/__admin/list-bookings`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Admin access is not configured." });
  } finally {
    process.env.ADMIN_KEY = original;
  }
});

test("checkout payments are routed by explicit purpose without changing deposits", () => {
  assert.equal(classifyCheckoutPayment({ type: "gift_card" }), "gift_card");
  assert.equal(classifyCheckoutPayment({ event_id: "popup-1" }), "popup");
  assert.equal(classifyCheckoutPayment({ payment_type: "balance", booking_id: "42" }), "balance");
  assert.equal(classifyCheckoutPayment({ booking_id: "42" }), "deposit");
  assert.equal(classifyCheckoutPayment({}), "unclassified");
});

test("balance amounts accept normal currency and reject unsafe values", () => {
  assert.equal(parseDollarAmount("903"), 90300);
  assert.equal(parseDollarAmount("903.25"), 90325);
  assert.equal(parseDollarAmount("0.50"), 50);
  assert.equal(parseDollarAmount("0.49"), null);
  assert.equal(parseDollarAmount("100000.01"), null);
  assert.equal(parseDollarAmount("12.345"), null);
  assert.equal(parseDollarAmount("not-money"), null);
});

test("balance payment links are one-use and carry webhook metadata", () => {
  const payload = buildBalancePaymentLink({
    priceId: "price_test_123",
    amountCents: 90300,
    bookingId: 42,
    clientName: "Kayla Client",
    clientEmail: "kayla@example.com",
    eventDate: "2026-09-12",
    packageTitle: "Tasting Menu",
    invoiceNumber: "INV-101",
    successBaseUrl: "https://booking.example.com"
  });

  assert.deepEqual(payload.line_items, [{ price: "price_test_123", quantity: 1 }]);
  assert.deepEqual(payload.restrictions, { completed_sessions: { limit: 1 } });
  assert.equal(payload.metadata.payment_type, "balance");
  assert.equal(payload.metadata.booking_id, "42");
  assert.equal(payload.metadata.amount_cents, "90300");
  assert.match(payload.after_completion.redirect.url, /balance=1/);
  assert.doesNotMatch(JSON.stringify(payload), /consultation/i);

  const price = buildBalancePrice({
    productId: "prod_balance_test",
    amountCents: 90300,
    packageTitle: "Tasting Menu",
    invoiceNumber: "INV-101",
    clientName: "Kayla Client",
    eventDate: "2026-09-12"
  });
  assert.equal(price.unit_amount, 90300);
  assert.equal(price.product, "prod_balance_test");
  assert.equal(price.nickname, "2026-09-12 — Kayla Client — Tasting Menu");
  assert.equal(price.metadata.payment_type, "balance");
  assert.equal(price.metadata.invoice_number, "INV-101");
  assert.equal(price.product_data, undefined);

  const product = buildBalanceProduct();
  assert.equal(product.id, STRIPE_BALANCE_PRODUCT_ID);
  assert.equal(product.name, "PRIVATE EVENT — REMAINING BALANCE");
  assert.equal(product.metadata.payment_type, "balance");
});

test("paid-in-full email is distinct from the deposit email and escapes customer data", () => {
  const html = buildBalancePaidEmail({
    clientName: "<Kayla>",
    amountText: "$903.00",
    eventDate: "2026-09-12",
    packageTitle: "Tasting Menu",
    invoiceNumber: "INV-101",
    receiptUrl: "https://pay.stripe.com/receipt/test"
  });
  assert.match(html, /Your balance is paid in full/);
  assert.match(html, /nothing further due/);
  assert.match(html, /September 12, 2026/);
  assert.match(html, /&lt;Kayla&gt;/);
  assert.doesNotMatch(html, /consultation/i);
  assert.doesNotMatch(html, /Deposit received/i);
});

test("unclassified payments receive a neutral receipt instead of deposit instructions", () => {
  const html = buildGenericPaymentEmail({
    clientName: "Dawn",
    amountText: "$500.00"
  });
  assert.match(html, /Payment received/);
  assert.doesNotMatch(html, /Deposit received/i);
  assert.doesNotMatch(html, /evening is reserved/i);
});

test("balance success page omits booking consultation instructions", async () => {
  const response = await fetch(`${baseUrl}/booking-success?balance=1`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /balance is paid in full/i);
  assert.doesNotMatch(html, /Schedule your consultation/i);
});

test("admin page renders the balance-link tool with valid browser JavaScript", async () => {
  const response = await fetch(`${baseUrl}/admin`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Create Remaining Balance Link/);
  assert.match(html, /id="bpAmount"/);
  assert.match(html, /exact <strong>TOTAL DUE<\/strong> from your Google invoice/i);
  assert.match(html, /\$\("bpAmount"\)\.value = ""/);
  assert.match(html, /\/api\/admin\/balance-links/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "admin script should be present");
  assert.doesNotThrow(() => new Function(script));
});
