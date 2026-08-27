import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "./app.js";

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

test("GET /api/config returns the OAuth2 client pieces the frontend needs to build a PKCE authorize URL", async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.authUrl, /^https:\/\/auth\.deriv\.com\//);
  assert.ok(body.redirectUri);
  assert.ok(body.scope);
});

test("GET /api/session with no cookie reports loggedIn: false", async () => {
  const res = await fetch(`${baseUrl}/api/session`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { loggedIn: false });
});

test("POST /api/session without a code/codeVerifier is rejected before touching Deriv", async () => {
  const res = await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("DELETE /api/session clears the cookie even with no active session", async () => {
  const res = await fetch(`${baseUrl}/api/session`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /traderpro_sid=;/);
});

test("responses carry helmet's security headers", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.ok(res.headers.get("content-security-policy"));
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("static files are served from public/", async () => {
  const res = await fetch(`${baseUrl}/style.css`);
  assert.equal(res.status, 200);
});

// ENABLE_REAL_TRADING is unset in this test run (see .env.example's
// default) -- the real-trading router must not even be mounted, so these
// paths 404 like they genuinely don't exist, not just "hidden".
test("real-trading routes 404 when ENABLE_REAL_TRADING is not set", async () => {
  const res = await fetch(`${baseUrl}/api/real-trading/trades`);
  assert.equal(res.status, 404);
});
