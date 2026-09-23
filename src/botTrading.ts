// Bot Builder "active" mode: when enabled, a fired bot rule creates a
// pending confirmation instead of executing anything automatically -- a
// human still has to explicitly confirm before any real money moves. This
// is a deliberate middle ground between Bot Builder's original paper-only
// mode and full automation (a bug in a rule, or a burst of Signals, could
// otherwise place many real trades with nobody watching). See README "Bot
// Builder" and TRADING_ROADMAP.md for what full automation would need.

export type BotConfirmationStatus = "pending" | "confirmed" | "rejected" | "expired" | "error";

export type BotTradeConfirmation = {
  // Kept as a string, never Number() -- same reasoning as every other id
  // in this codebase (see Bot.id in botBuilder.ts).
  id: string;
  botId: string;
  botName: string;
  ownerLoginid: string;
  symbol: string;
  direction: "up" | "down";
  stake: number;
  duration: number;
  signalChangePct: number;
  signalPrice: number;
  status: BotConfirmationStatus;
  realTradeId: string | null;
  errorMessage: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

// Deriv's Rise/Fall contract_type naming is CALL/PUT, addressed as
// "rise"/"fall" elsewhere in this codebase (see realTrading.ts) -- bots
// use Signals' own "up"/"down" vocabulary, so this bridges the two.
export function botDirectionToRiseFall(direction: "up" | "down"): "rise" | "fall" {
  return direction === "up" ? "rise" : "fall";
}

// Bots don't have a duration field of their own yet (the create-bot form
// only has symbol/direction/stake) -- every bot-triggered trade uses the
// shortest duration Real Trading supports, the same deliberate
// scope-reduction reasoning as Real Trading's own fixed [5, 10] tick set
// (see TRADING_ROADMAP.md). A per-bot duration is a reasonable follow-up,
// not required for this to be safe.
export const BOT_TRADE_DURATION_TICKS = 5;

// How long a pending confirmation stays actionable. A matched Signal is a
// snapshot of a moment that's already passed by the time a human notices
// and reacts -- an old one isn't a meaningful trade opportunity anymore,
// so it lapses into "expired" rather than staying confirmable indefinitely.
export const PENDING_CONFIRMATION_TTL_MS = 5 * 60_000;

// Requires ENABLE_REAL_TRADING too, not just its own flag -- bot-confirmed
// trades execute through the exact same Deriv trade-execution path Real
// Trading uses (see botTradingRoutes.ts), so it shouldn't be reachable
// when that's off. Defense in depth, not just documentation: even if
// ENABLE_BOT_TRADING were set by mistake, real trading being off keeps
// this off too.
export const BOT_TRADING_ENABLED = process.env.ENABLE_BOT_TRADING === "true" && process.env.ENABLE_REAL_TRADING === "true";

if (process.env.ENABLE_BOT_TRADING === "true" && process.env.ENABLE_REAL_TRADING !== "true") {
  console.warn(
    "ENABLE_BOT_TRADING is set but ENABLE_REAL_TRADING is not -- bot trade confirmations will not be created " +
      "(bots stay in paper mode) until real trading is also enabled.",
  );
}
