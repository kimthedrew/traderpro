import "dotenv/config";
import { app, broadcast, APP_ID } from "./app.js";
import { DerivClient } from "./derivClient.js";

const PORT = Number(process.env.PORT ?? 3000);

// Public tick data -- no auth needed. Symbols shown in the homepage ticker tape.
const TICKER_SYMBOLS = ["R_100", "R_75", "R_50", "BOOM1000", "CRASH500", "JD100"];

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
