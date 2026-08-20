import "dotenv/config";
import { app, broadcast } from "./app.js";
import { DerivClient } from "./derivClient.js";
import { SignalDetector } from "./signals.js";
import { recordSignal } from "./signalsStore.js";
import { runBotsForSignal } from "./botBuilderStore.js";

const PORT = Number(process.env.PORT ?? 3000);

// Public tick data -- no auth or app_id needed. Symbols shown in the homepage ticker tape.
const TICKER_SYMBOLS = ["R_100", "R_75", "R_50", "BOOM1000", "CRASH500", "JD100"];

// Module-scoped (not per-connection) so signal history/cooldowns survive
// the feed reconnecting -- a network blip shouldn't reset them.
const signalDetector = new SignalDetector();

async function startDerivFeed() {
  const deriv = new DerivClient();

  deriv.on("tick", (msg) => {
    broadcast("tick", { symbol: msg.tick.symbol, quote: msg.tick.quote, epoch: msg.tick.epoch });

    const signal = signalDetector.check(msg.tick.symbol, msg.tick.quote, msg.tick.epoch);
    if (signal) {
      broadcast("signal", signal);
      recordSignal(signal).catch((err) => console.error("Could not persist signal (database unavailable?):", err));
      runBotsForSignal(signal).catch((err) => console.error("Could not evaluate bots for signal (database unavailable?):", err));
    }
  });

  deriv.on("api_error", (err) => {
    console.error("Deriv API error:", err);
  });

  deriv.on("disconnected", () => {
    console.warn("Deriv WebSocket disconnected, retrying in 3s...");
    setTimeout(() => {
      startDerivFeed().catch((err) => console.error("Failed to reconnect to Deriv API:", err));
    }, 3000);
  });

  await deriv.connect();
  // allSettled: one bad/unavailable symbol shouldn't take down the rest of the ticker tape.
  const results = await Promise.allSettled(TICKER_SYMBOLS.map((symbol) => deriv.subscribeTicks(symbol)));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`Failed to subscribe to ${TICKER_SYMBOLS[i]}:`, result.reason);
    }
  });
  console.log(`Connected to Deriv public API, streaming ${TICKER_SYMBOLS.join(", ")}`);
}

startDerivFeed().catch((err) => {
  console.error("Failed to connect to Deriv API:", err);
});

app.listen(PORT, () => {
  console.log(`traderpro server listening on http://localhost:${PORT}`);
});
