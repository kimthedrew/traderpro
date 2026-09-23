import { test } from "node:test";
import assert from "node:assert/strict";
import { botDirectionToRiseFall } from "./botTrading.js";

test("botDirectionToRiseFall maps up -> rise, down -> fall", () => {
  assert.equal(botDirectionToRiseFall("up"), "rise");
  assert.equal(botDirectionToRiseFall("down"), "fall");
});
