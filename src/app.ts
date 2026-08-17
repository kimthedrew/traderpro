import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DerivClient } from "./derivClient.js";
import { createSession, destroySession, getSession } from "./sessionStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ID = process.env.DERIV_APP_ID ?? "1089";
const SESSION_COOKIE = "traderpro_sid";
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEMO_APP_ID = "1089";

if (process.env.NODE_ENV === "production" && APP_ID === DEMO_APP_ID) {
  console.warn(
    "WARNING: running in production on Deriv's shared demo app_id. " +
      "Register your own at https://developers.deriv.com before real users rely on this.",
  );
}

// Login attempts hit Deriv's own API per try, so a stricter limit than most
// routes -- generous enough for someone with a few real accounts, tight
// enough to blunt token-guessing/abuse.
const sessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

export const app = express();
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public")));

// Frontend needs the app_id to build the OAuth login URL and to open its
// own WebSocket connection later (e.g. once it has a user's token).
app.get("/api/config", (_req, res) => {
  res.json({
    appId: APP_ID,
    oauthUrl: `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`,
  });
});

// The Deriv account token never reaches browser JS: redirect.html posts it
// here, we exchange it for an authorized server-side DerivClient connection,
// and hand the browser back only an httpOnly session cookie.
app.post("/api/session", sessionLimiter, async (req, res) => {
  const { token } = req.body ?? {};
  if (typeof token !== "string" || !token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const client = new DerivClient(APP_ID);
  try {
    await client.connect();
    const authResult = await client.authorize(token);
    const { loginid, currency, email } = authResult.authorize;

    const sessionId = createSession({ loginid, currency, email, client });
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ loginid, currency });
  } catch (err) {
    client.close();
    console.error("Authorize failed:", err);
    res.status(401).json({ error: "Invalid or expired Deriv token" });
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
