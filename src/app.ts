import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, destroySession, getSession } from "./sessionStore.js";
import { getRecentSignals } from "./signalsStore.js";
import { getFollower, getShadowLog, upsertFollower } from "./copyTradingStore.js";
import { createBot, deleteBot, getBotsForOwner, getPaperTrades, updateBot } from "./botBuilderStore.js";
import type { BotDirection } from "./botBuilder.js";
import { TICKER_SYMBOLS } from "./symbols.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DERIV_APP_ID is really an OAuth2 client_id (Deriv's dashboard just calls
// it "App ID"). Registered per-app at https://developers.deriv.com.
export const APP_ID = process.env.DERIV_APP_ID ?? "";
export const REDIRECT_URI = process.env.OAUTH_REDIRECT_URL ?? "http://localhost:3000/redirect.html";
const SESSION_COOKIE = "traderpro_sid";

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

// The only symbols Signals (and so Bot Builder, which watches Signals)
// can ever fire for -- same list server.ts subscribes ticks for.
const KNOWN_SYMBOLS = new Set(TICKER_SYMBOLS);
const BOT_DIRECTIONS = new Set<BotDirection>(["up", "down", "any"]);
// Bot ids are kept as strings throughout (see Bot.id in botBuilder.ts) --
// this just rejects obviously-malformed input early with a clean 400,
// it's not doing any numeric conversion.
const BOT_ID_PATTERN = /^\d+$/;

// Login attempts hit Deriv's own API per try, so a stricter limit than most
// routes -- generous enough for someone with a few real accounts, tight
// enough to blunt code/token-guessing abuse.
const sessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

export const app = express();
// Render (and most PaaS/reverse-proxy setups) sits exactly one hop in
// front of this app and sets X-Forwarded-For. Without this, Express's
// default (don't trust any proxy) makes express-rate-limit's default
// keyGenerator throw on every request that has that header -- see
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. `1` (not `true`) trusts exactly one
// hop rather than the whole chain, which the library explicitly warns
// against as trivially spoofable.
app.set("trust proxy", 1);
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
    // that if expires_in is ever missing from the response. The cookie's
    // maxAge matches this exactly -- it used to be a fixed 24h regardless
    // of the DB session's real expiry, so the browser would keep sending
    // a cookie that looked valid for up to 23 hours after getSession()
    // (which filters on expires_at) had already started silently
    // rejecting it and reporting the user as logged out.
    const sessionLifetimeSeconds = expiresIn ?? 3600;
    const sessionId = await createSession({ loginid, currency, accessToken, expiresInSeconds: sessionLifetimeSeconds });
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionLifetimeSeconds * 1000,
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

// For routes that require login (as opposed to the GET routes above, which
// degrade to a logged-out-shaped response on any failure). Distinguishes
// "no session cookie" (genuinely not logged in -- 401 is correct) from "the
// database errored out while checking" (401 would misreport a real,
// logged-in user as logged out mid-outage -- this reports it honestly as
// a server error instead).
async function requireLogin(req: express.Request, res: express.Response): Promise<string | null> {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) {
    res.status(401).json({ error: "Not logged in" });
    return null;
  }
  let session;
  try {
    session = await getSession(cookie);
  } catch (err) {
    console.error("Could not verify session (database unavailable?):", err);
    res.status(502).json({ error: "Could not verify your session -- try again" });
    return null;
  }
  if (!session) {
    res.status(401).json({ error: "Not logged in" });
    return null;
  }
  return session.loginid;
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
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const { enabled, stakeRatio, maxStake } = req.body ?? {};
  if (typeof enabled !== "boolean" || typeof stakeRatio !== "number" || !(stakeRatio > 0)) {
    res.status(400).json({ error: "Invalid follower config" });
    return;
  }
  if (maxStake !== null && (typeof maxStake !== "number" || maxStake < 0)) {
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

// Bot Builder v1: paper-mode only -- see src/botBuilder.ts. Bots are
// full CRUD resources (unlike Copy Trading's one-row-per-user config), so
// every mutating/reading endpoint scopes by the owner's loginid, enforced
// in the store's queries themselves, not just checked here beforehand.
app.get("/api/bots", async (req, res) => {
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ bots: [] });
      return;
    }
    res.json({ bots: await getBotsForOwner(loginid) });
  } catch (err) {
    console.error("Could not fetch bots (database unavailable?):", err);
    res.json({ bots: [] });
  }
});

app.post("/api/bots", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const { name, symbol, direction, stake } = req.body ?? {};
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 60 ||
    typeof symbol !== "string" ||
    !KNOWN_SYMBOLS.has(symbol) ||
    typeof direction !== "string" ||
    !BOT_DIRECTIONS.has(direction as BotDirection) ||
    typeof stake !== "number" ||
    !(stake > 0)
  ) {
    res.status(400).json({ error: "Invalid bot config" });
    return;
  }
  try {
    const bot = await createBot(loginid, { name: name.trim(), symbol, direction: direction as BotDirection, stake });
    res.json({ bot });
  } catch (err) {
    console.error("Could not create bot (database unavailable?):", err);
    res.status(502).json({ error: "Could not create bot" });
  }
});

app.patch("/api/bots/:id", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const id = req.params.id;
  const { enabled, stake } = req.body ?? {};
  // Partial update -- a field that's omitted is left untouched. Sending
  // both back unconditionally (the old behavior) meant toggling just
  // "enabled" from a stale page could silently revert a stake edit made
  // in another tab since the page loaded.
  if (
    !BOT_ID_PATTERN.test(id) ||
    (enabled === undefined && stake === undefined) ||
    (enabled !== undefined && typeof enabled !== "boolean") ||
    (stake !== undefined && (typeof stake !== "number" || !(stake > 0)))
  ) {
    res.status(400).json({ error: "Invalid bot update" });
    return;
  }
  try {
    const updated = await updateBot(id, loginid, { enabled: enabled ?? null, stake: stake ?? null });
    if (!updated) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Could not update bot (database unavailable?):", err);
    res.status(502).json({ error: "Could not update bot" });
  }
});

app.delete("/api/bots/:id", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const id = req.params.id;
  if (!BOT_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "Invalid bot id" });
    return;
  }
  try {
    const deleted = await deleteBot(id, loginid);
    if (!deleted) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Could not delete bot (database unavailable?):", err);
    res.status(502).json({ error: "Could not delete bot" });
  }
});

app.get("/api/bots/:id/trades", async (req, res) => {
  const id = req.params.id;
  if (!BOT_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "Invalid bot id" });
    return;
  }
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ trades: [] });
      return;
    }
    res.json({ trades: await getPaperTrades(id, loginid, 20) });
  } catch (err) {
    console.error("Could not fetch paper trades (database unavailable?):", err);
    res.json({ trades: [] });
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
  // An unhandled 'error' event on a stream is a crash in Node (same class
  // of bug as the pg pool's 'error' listener above) -- a half-closed
  // connection can emit one here before 'close' fires and removes it from
  // sseClients, so this needs its own listener rather than relying on that.
  res.on("error", (err) => {
    console.error("SSE client connection error, dropping it:", err);
    sseClients.delete(res);
  });
});

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      console.error("Could not write to an SSE client, dropping it:", err);
      sseClients.delete(client);
    }
  }
}
