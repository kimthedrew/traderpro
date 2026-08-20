// Bot Builder v1 is paper-mode only: a bot is a rule that watches Signals
// (reusing that detection rather than building a second condition engine)
// and logs what it would have traded. Nothing here calls Deriv's
// trade-execution API. See README Bot Builder for why.

import type { SignalEvent } from "./signals.js";

export type BotDirection = "up" | "down" | "any";

export type Bot = {
  id: number;
  ownerLoginid: string;
  name: string;
  symbol: string;
  direction: BotDirection;
  stake: number;
  enabled: boolean;
};

export type PaperTrade = {
  botId: number;
  symbol: string;
  direction: "up" | "down";
  stake: number;
  price: number;
  signalChangePct: number;
};

export function matchesBot(bot: Bot, signal: SignalEvent): boolean {
  if (!bot.enabled) return false;
  if (bot.symbol !== signal.symbol) return false;
  if (bot.direction !== "any" && bot.direction !== signal.direction) return false;
  return true;
}

export function buildPaperTrade(bot: Bot, signal: SignalEvent): PaperTrade {
  return {
    botId: bot.id,
    symbol: signal.symbol,
    direction: signal.direction,
    stake: bot.stake,
    price: signal.price,
    signalChangePct: signal.changePct,
  };
}
