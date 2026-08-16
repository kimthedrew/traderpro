import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DerivClient } from "./derivClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const APP_ID = process.env.DERIV_APP_ID ?? "1089";

// Public tick data -- no auth needed. Symbols shown in the homepage ticker tape.
const TICKER_SYMBOLS = ["R_100", "R_75", "R_50", "BOOM1000", "CRASH500", "JD100"];

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

// Frontend needs the app_id to build the OAuth login URL and to open its
// own WebSocket connection later (e.g. once it has a user's token).
app.get("/api/config", (_req, res) => {
  res.json({
    appId: APP_ID,
    oauthUrl: `https://oauth.deriv.com/oauth2/authorize?app_id=${APP_ID}`,
  });
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

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

async function startDerivFeed() {
  const deriv = new DerivClient(APP_ID);

  deriv.on("tick", (msg) => {
    broadcast("tick", { symbol: msg.tick.symbol, quote: msg.tick.quote, epoch: msg.tick.epoch });
  });

  deriv.on("api_error", (err) => {
    console.error("Deriv API error:", err);
  });

  deriv.on("disconnected", () => {
    console.warn("Deriv WebSocket disconnected, retrying in 3s...");
    setTimeout(startDerivFeed, 3000);
  });

  await deriv.connect();
  // allSettled: one bad/unavailable symbol shouldn't take down the rest of the ticker tape.
  const results = await Promise.allSettled(TICKER_SYMBOLS.map((symbol) => deriv.subscribeTicks(symbol)));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`Failed to subscribe to ${TICKER_SYMBOLS[i]}:`, result.reason);
    }
  });
  console.log(`Connected to Deriv API (app_id=${APP_ID}), streaming ${TICKER_SYMBOLS.join(", ")}`);
}

startDerivFeed().catch((err) => {
  console.error("Failed to connect to Deriv API:", err);
});

app.listen(PORT, () => {
  console.log(`traderpro server listening on http://localhost:${PORT}`);
});
