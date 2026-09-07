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
  getHolidayPerPerson,
  inAllowedZip,
  safeTokenEqual
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
