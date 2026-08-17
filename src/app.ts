import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, destroySession, getSession } from "./sessionStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DERIV_APP_ID is really an OAuth2 client_id (Deriv's dashboard just calls
// it "App ID"). Registered per-app at https://developers.deriv.com.
export const APP_ID = process.env.DERIV_APP_ID ?? "";
export const REDIRECT_URI = process.env.OAUTH_REDIRECT_URL ?? "http://localhost:3000/redirect.html";
const SESSION_COOKIE = "traderpro_sid";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DERIV_AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_API_BASE = "https://api.derivws.com";
// Least-privilege: only what login + displaying the account actually needs.
const OAUTH_SCOPE = "trade account_manage";

if (!APP_ID) {
  console.warn(
    "WARNING: DERIV_APP_ID is not set -- Deriv login will fail. " +
      "Register an app at https://developers.deriv.com and set DERIV_APP_ID to its App ID.",
  );
}

// Login attempts hit Deriv's own API per try, so a stricter limit than most
// routes -- generous enough for someone with a few real accounts, tight
// enough to blunt code/token-guessing abuse.
const sessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

export const app = express();
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// Frontend generates PKCE params itself (needs browser crypto/sessionStorage)
// and builds the full authorize URL from these static pieces.
app.get("/api/config", (_req, res) => {
  res.json({
    clientId: APP_ID,
    redirectUri: REDIRECT_URI,
    authUrl: DERIV_AUTH_URL,
    scope: OAUTH_SCOPE,
  });
});

// redirect.js posts the authorization code + PKCE verifier here (never the
// browser's job to talk to Deriv's token endpoint directly). We exchange
// them server-side for an access token, fetch the account, and hand the
// browser back only an httpOnly session cookie -- it never sees the token.
app.post("/api/session", sessionLimiter, async (req, res) => {
  const { code, codeVerifier } = req.body ?? {};
  if (typeof code !== "string" || !code || typeof codeVerifier !== "string" || !codeVerifier) {
    res.status(400).json({ error: "Missing code or codeVerifier" });
    return;
  }

  try {
    const tokenRes = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: APP_ID,
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: HTTP ${tokenRes.status}`);
    const { access_token: accessToken } = await tokenRes.json();

    const accountsRes = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`, {
      headers: { "Deriv-App-ID": APP_ID, Authorization: `Bearer ${accessToken}` },
    });
    if (!accountsRes.ok) throw new Error(`Fetching accounts failed: HTTP ${accountsRes.status}`);
    const { data: accounts } = await accountsRes.json();
    const account = accounts?.[0] ?? {};
    // Exact field names aren't confirmed against a real login yet -- fall
    // back gracefully across the likely variants instead of assuming one.
    const loginid = account.loginid ?? account.login_id ?? account.id ?? "account";
    const currency = account.currency ?? "";

    const sessionId = createSession({ loginid, currency, accessToken });
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ loginid, currency });
  } catch (err) {
    console.error("Deriv OAuth login failed:", err);
    res.status(401).json({ error: "Could not complete Deriv login" });
  }
});

app.get("/api/session", (req, res) => {
  const session = getSession(req.cookies?.[SESSION_COOKIE]);
  if (!session) {
    res.json({ loggedIn: false });
    return;
  }
  res.json({ loggedIn: true, loginid: session.loginid, currency: session.currency });
});

app.delete("/api/session", (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ loggedIn: false });
});

// Relays live ticks from our backend Deriv WebSocket connection to the
// browser over Server-Sent Events, proving the server <-> Deriv link works.
const sseClients = new Set<express.Response>();

app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}
