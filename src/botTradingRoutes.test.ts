import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Both flags are read once at module load time (see app.ts/botTrading.ts),
// so they must be set before app.js is ever imported -- same reasoning as
// realTradingRoutes.test.ts, and why this needs its own test file/process
// rather than sharing one with app.test.ts (which deliberately runs with
// both unset, see its own 404 tests).
process.env.ENABLE_REAL_TRADING = "true";
process.env.ENABLE_BOT_TRADING = "true";
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

test("bot-trading routes exist (no 404) when both flags are set", async () => {
  const res = await fetch(`${baseUrl}/api/bot-trading/pending`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { confirmations: [] });
});

test("POST confirm/reject without a session cookie are rejected as 401, not 404", async () => {
  const confirmRes = await fetch(`${baseUrl}/api/bot-trading/confirmations/1/confirm`, { method: "POST" });
  assert.equal(confirmRes.status, 401);
  const rejectRes = await fetch(`${baseUrl}/api/bot-trading/confirmations/1/reject`, { method: "POST" });
  assert.equal(rejectRes.status, 401);
});

test("an invalid confirmation id is rejected with 400 before any database lookup", async () => {
  const sessionId = await createSession({ loginid: "BTTEST01", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });
  try {
    const cookie = `traderpro_sid=${sessionId}`;
    const res = await fetch(`${baseUrl}/api/bot-trading/confirmations/not-a-number/confirm`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 400);
  } finally {
    await destroySession(sessionId);
  }
});

test("confirming/rejecting a confirmation that doesn't exist (or isn't yours) returns 404", async () => {
  const sessionId = await createSession({ loginid: "BTTEST02", currency: "USD", accessToken: "fake-token", expiresInSeconds: 3600 });
  try {
    const cookie = `traderpro_sid=${sessionId}`;
    const confirmRes = await fetch(`${baseUrl}/api/bot-trading/confirmations/999999999/confirm`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(confirmRes.status, 404);
    const rejectRes = await fetch(`${baseUrl}/api/bot-trading/confirmations/999999999/reject`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(rejectRes.status, 404);
  } finally {
    await destroySession(sessionId);
  }
});
