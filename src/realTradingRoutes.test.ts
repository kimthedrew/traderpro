import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// The flag is read once at module load time (see app.ts), so it must be set
// before app.js is ever imported -- this has to be a dynamic import in its
// own test file/process, not a static import alongside app.test.ts (which
// deliberately runs with the flag unset, see its own 404 test).
process.env.ENABLE_REAL_TRADING = "true";
const { app } = await import("./app.js");
const { createSession, destroySession } = await import("./sessionStore.js");

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("real-trading routes exist (no 404) when ENABLE_REAL_TRADING is set", async () => {
  const res = await fetch(`${baseUrl}/api/real-trading/trades`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { trades: [] });
});

test("POST /proposal without a session cookie is rejected as 401, not 404", async () => {
  const res = await fetch(`${baseUrl}/api/real-trading/proposal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "R_100", direction: "rise", stake: 10, duration: 5 }),
  });
  assert.equal(res.status, 401);
});

test("POST /buy without a session cookie is rejected as 401, not 404", async () => {
  const res = await fetch(`${baseUrl}/api/real-trading/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "R_100", direction: "rise", stake: 10, duration: 5, proposalId: "p1", price: 10 }),
  });
  assert.equal(res.status, 401);
});

test("invalid input is rejected with 400 before any Deriv network call is attempted", async () => {
  const sessionId = await createSession({ loginid: "RTTEST01", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });
  try {
    const cookie = `traderpro_sid=${sessionId}`;
    const cases = [
      { symbol: "NOT_A_SYMBOL", direction: "rise", stake: 10, duration: 5 },
      { symbol: "R_100", direction: "sideways", stake: 10, duration: 5 },
      { symbol: "R_100", direction: "rise", stake: -5, duration: 5 },
      { symbol: "R_100", direction: "rise", stake: 10, duration: 7 }, // not in the fixed [5,10] set
    ];
    for (const body of cases) {
      const res = await fetch(`${baseUrl}/api/real-trading/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  } finally {
    await destroySession(sessionId);
  }
});

// Regression test for a real bug found live: a proposal is only valid on
// the connection it was requested on, so /buy has to be rejected cleanly
// (not attempted against Deriv at all) when there's no live proposal
// pending for this user -- rather than opening a fresh connection and
// getting Deriv's InvalidContractProposal error, which is what used to
// happen before this was fixed.
test("POST /buy with no prior /proposal call is rejected with 409, before any Deriv network call", async () => {
  const sessionId = await createSession({ loginid: "RTTEST02", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });
  try {
    const cookie = `traderpro_sid=${sessionId}`;
    const res = await fetch(`${baseUrl}/api/real-trading/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ symbol: "R_100", direction: "rise", stake: 10, duration: 5, proposalId: "p1", price: 10 }),
    });
    assert.equal(res.status, 409);
  } finally {
    await destroySession(sessionId);
  }
});
