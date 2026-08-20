import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShadowCopy } from "./copyTrading.js";

const trade = { ref: "C1", symbol: "R_100", direction: "buy", stake: 100 };

test("scales the follower's stake by their ratio", () => {
  const copy = computeShadowCopy(trade, { loginid: "CR1", enabled: true, stakeRatio: 0.2, maxStake: null });
  assert.equal(copy.wouldBeStake, 20);
  assert.equal(copy.leaderStake, 100);
  assert.equal(copy.followerLoginid, "CR1");
  assert.equal(copy.leaderTradeRef, "C1");
});

test("a 1.0 ratio mirrors the leader's stake exactly", () => {
  const copy = computeShadowCopy(trade, { loginid: "CR1", enabled: true, stakeRatio: 1, maxStake: null });
  assert.equal(copy.wouldBeStake, 100);
});

test("caps the scaled stake at maxStake when it would exceed it", () => {
  const copy = computeShadowCopy(trade, { loginid: "CR1", enabled: true, stakeRatio: 1, maxStake: 30 });
  assert.equal(copy.wouldBeStake, 30);
});

test("does not cap when the scaled stake is already under maxStake", () => {
  const copy = computeShadowCopy(trade, { loginid: "CR1", enabled: true, stakeRatio: 0.1, maxStake: 30 });
  assert.equal(copy.wouldBeStake, 10);
});

test("a zero ratio produces a zero-stake shadow copy (never negative or NaN)", () => {
  const copy = computeShadowCopy(trade, { loginid: "CR1", enabled: true, stakeRatio: 0, maxStake: null });
  assert.equal(copy.wouldBeStake, 0);
});

test("preserves symbol and direction from the leader's trade", () => {
  const copy = computeShadowCopy(
    { ref: "C2", symbol: "BOOM1000", direction: "sell", stake: 50 },
    { loginid: "CR1", enabled: true, stakeRatio: 1, maxStake: null },
  );
  assert.equal(copy.symbol, "BOOM1000");
  assert.equal(copy.direction, "sell");
});
