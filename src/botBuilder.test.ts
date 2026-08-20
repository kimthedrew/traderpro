import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesBot, buildPaperTrade, type Bot } from "./botBuilder.js";

const signal = { symbol: "R_100", direction: "up" as const, changePct: 1.5, price: 612.4, windowSeconds: 300 };

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return { id: 1, ownerLoginid: "CR1", name: "Test bot", symbol: "R_100", direction: "any", stake: 10, enabled: true, ...overrides };
}

test("matches when symbol matches and direction is 'any'", () => {
  assert.equal(matchesBot(makeBot(), signal), true);
});

test("matches when direction filter matches the signal's direction", () => {
  assert.equal(matchesBot(makeBot({ direction: "up" }), signal), true);
});

test("does not match when direction filter is the opposite direction", () => {
  assert.equal(matchesBot(makeBot({ direction: "down" }), signal), false);
});

test("does not match a different symbol", () => {
  assert.equal(matchesBot(makeBot({ symbol: "R_75" }), signal), false);
});

test("does not match a disabled bot", () => {
  assert.equal(matchesBot(makeBot({ enabled: false }), signal), false);
});

test("buildPaperTrade carries the bot's stake and the signal's market data", () => {
  const trade = buildPaperTrade(makeBot({ id: 42, stake: 25 }), signal);
  assert.deepEqual(trade, {
    botId: 42,
    symbol: "R_100",
    direction: "up",
    stake: 25,
    price: 612.4,
    signalChangePct: 1.5,
  });
});
