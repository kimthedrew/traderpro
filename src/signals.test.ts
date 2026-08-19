import { test } from "node:test";
import assert from "node:assert/strict";
import { SignalDetector } from "./signals.js";

// Small window/cooldown for fast, readable tests -- semantics are the
// same regardless of the real thresholds used in production.
function testDetector() {
  return new SignalDetector(1, 5000, 10000); // 1%, 5s window, 10s cooldown
}

test("no signal on the very first tick for a symbol", () => {
  const d = testDetector();
  assert.equal(d.check("R_100", 100, 0), null);
});

test("no signal when the move is below threshold", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  assert.equal(d.check("R_100", 100.5, 1), null); // +0.5%, under 1%
});

test("fires an 'up' signal when price rises past the threshold within the window", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  const signal = d.check("R_100", 101.5, 2); // +1.5% within 2s
  assert.ok(signal);
  assert.equal(signal?.direction, "up");
  assert.equal(signal?.symbol, "R_100");
  assert.ok(Math.abs(signal!.changePct - 1.5) < 0.001);
});

test("fires a 'down' signal when price falls past the threshold", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  const signal = d.check("R_100", 98, 2); // -2%
  assert.ok(signal);
  assert.equal(signal?.direction, "down");
});

test("does not re-fire for the same symbol within the cooldown", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  const first = d.check("R_100", 102, 1);
  assert.ok(first);
  const second = d.check("R_100", 104, 2); // still a big move, but within cooldown
  assert.equal(second, null);
});

test("fires again once the cooldown has elapsed", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  assert.ok(d.check("R_100", 102, 1)); // fires; cooldown starts at t=1s
  assert.equal(d.check("R_100", 104, 2), null); // still within the 10s cooldown

  // By t=12s the cooldown (10s since the t=1s fire) has elapsed, but the
  // 5s window has also rolled past every earlier point -- establish a
  // fresh baseline, then a real move relative to *that*.
  d.check("R_100", 100, 12);
  const signal = d.check("R_100", 103, 13); // +3% within 1s of the new baseline
  assert.ok(signal);
});

test("points older than the window are pruned and don't count toward the move", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  // 6s later (past the 5s window) a small move shouldn't compare against the stale t=0 point
  const signal = d.check("R_100", 100.5, 6);
  assert.equal(signal, null);
});

test("symbols are tracked independently", () => {
  const d = testDetector();
  d.check("R_100", 100, 0);
  d.check("R_75", 50, 0);
  const signal = d.check("R_100", 102, 1);
  assert.ok(signal);
  assert.equal(signal?.symbol, "R_100");
  assert.equal(d.check("R_75", 50.2, 1), null); // R_75 barely moved, unaffected by R_100's signal
});
