import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, destroySession, getSession } from "./sessionStore.js";
import { getRecentSignals } from "./signalsStore.js";
import { getFollower, getShadowLog, upsertFollower } from "./copyTradingStore.js";

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

// Copy Trading v1 shadow-mode: whichever single account's trades get
// watched (once that detection is wired up -- see README Copy Trading).
// Unset means the feature has no leader yet; followers can still configure
// their settings, there's just nothing to copy from.
const LEADER_LOGINID = process.env.COPY_TRADING_LEADER_LOGINID ?? "";

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
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error(`Deriv token exchange failed: HTTP ${tokenRes.status}`, body);
      res.status(401).json({ error: "Could not complete Deriv login", stage: "token_exchange", status: tokenRes.status });
      return;
    }
    const { access_token: accessToken, expires_in: expiresIn } = await tokenRes.json();

    const accountsRes = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`, {
      headers: { "Deriv-App-ID": APP_ID, Authorization: `Bearer ${accessToken}` },
    });
    if (!accountsRes.ok) {
      const body = await accountsRes.text();
      console.error(`Deriv account fetch failed: HTTP ${accountsRes.status}`, body);
      res.status(401).json({ error: "Could not fetch your Deriv account", stage: "account_fetch", status: accountsRes.status });
      return;
    }
    const { data: accounts } = await accountsRes.json();
    const account = accounts?.[0] ?? {};
    // Exact field names aren't confirmed against a real login yet -- fall
    // back gracefully across the likely variants instead of assuming one.
    const loginid = account.loginid ?? account.login_id ?? account.id ?? "account";
    const currency = account.currency ?? "";

    // Deriv's docs show a 3600s (1h) access token lifetime; fall back to
    // that if expires_in is ever missing from the response.
    const sessionId = await createSession({ loginid, currency, accessToken, expiresInSeconds: expiresIn ?? 3600 });
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ loginid, currency });
  } catch (err) {
    console.error("Deriv OAuth login failed unexpectedly:", err);
    res.status(502).json({ error: "Unexpected error talking to Deriv", stage: "unexpected" });
  }
});

app.get("/api/session", async (req, res) => {
  try {
    const session = await getSession(req.cookies?.[SESSION_COOKIE]);
    if (!session) {
      res.json({ loggedIn: false });
      return;
    }
    res.json({ loggedIn: true, loginid: session.loginid, currency: session.currency });
  } catch (err) {
    console.error("Could not look up session (database unavailable?):", err);
    res.json({ loggedIn: false });
  }
});

app.delete("/api/session", async (req, res) => {
  try {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
  } catch (err) {
    console.error("Could not destroy session server-side (database unavailable?):", err);
  }
  res.clearCookie(SESSION_COOKIE);
  res.json({ loggedIn: false });
});

// History for the live signals feed's initial page load; new ones arrive
// over the same SSE stream as ticks (event: "signal").
app.get("/api/signals", async (_req, res) => {
  try {
    const signals = await getRecentSignals(20);
    res.json({ signals });
  } catch (err) {
    console.error("Could not fetch signals (database unavailable?):", err);
    res.json({ signals: [] });
  }
});

async function currentLoginId(req: express.Request): Promise<string | null> {
  const session = await getSession(req.cookies?.[SESSION_COOKIE]);
  return session?.loginid ?? null;
}

// Copy Trading v1: shadow-mode only -- see src/copyTrading.ts. These
// endpoints manage a follower's own settings and let them see what would
// have been copied; nothing here ever places a real trade.
app.get("/api/copy-trading/status", async (req, res) => {
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ loggedIn: false, leaderConfigured: Boolean(LEADER_LOGINID) });
      return;
    }
    const follower = await getFollower(loginid);
    res.json({
      loggedIn: true,
      leaderConfigured: Boolean(LEADER_LOGINID),
      enabled: follower?.enabled ?? false,
      stakeRatio: follower?.stakeRatio ?? 1,
      maxStake: follower?.maxStake ?? null,
    });
  } catch (err) {
    console.error("Could not fetch copy-trading status (database unavailable?):", err);
    res.json({ loggedIn: false, leaderConfigured: Boolean(LEADER_LOGINID) });
  }
});

app.post("/api/copy-trading/follow", async (req, res) => {
  const loginid = await currentLoginId(req).catch(() => null);
  if (!loginid) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  const { enabled, stakeRatio, maxStake } = req.body ?? {};
  if (typeof enabled !== "boolean" || typeof stakeRatio !== "number" || !(stakeRatio > 0)) {
    res.status(400).json({ error: "Invalid follower config" });
    return;
  }
  if (maxStake !== null && typeof maxStake !== "number") {
    res.status(400).json({ error: "Invalid follower config" });
    return;
  }
  try {
    await upsertFollower(loginid, { enabled, stakeRatio, maxStake: maxStake ?? null });
    res.json({ ok: true });
  } catch (err) {
    console.error("Could not save follower config (database unavailable?):", err);
    res.status(502).json({ error: "Could not save settings" });
  }
});

app.get("/api/copy-trading/shadow-log", async (req, res) => {
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ entries: [] });
      return;
    }
    const entries = await getShadowLog(loginid, 20);
    res.json({ entries });
  } catch (err) {
    console.error("Could not fetch shadow log (database unavailable?):", err);
    res.json({ entries: [] });
  }
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
