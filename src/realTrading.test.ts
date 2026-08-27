import { test } from "node:test";
import assert from "node:assert/strict";
import { contractTypeForDirection, buildProposalRequest, buildBuyRequest, parseProposalResponse, parseBuyResponse } from "./realTrading.js";

test("contractTypeForDirection maps rise -> CALL, fall -> PUT", () => {
  assert.equal(contractTypeForDirection("rise"), "CALL");
  assert.equal(contractTypeForDirection("fall"), "PUT");
});

test("buildProposalRequest produces the expected Deriv request shape", () => {
  const req = buildProposalRequest({ symbol: "R_100", direction: "rise", stake: 10, duration: 5, durationUnit: "t", currency: "USD" });
  assert.deepEqual(req, {
    proposal: 1,
    amount: 10,
    basis: "stake",
    contract_type: "CALL",
    currency: "USD",
    duration: 5,
    duration_unit: "t",
    symbol: "R_100",
  });
});

test("buildBuyRequest produces the expected Deriv request shape", () => {
  assert.deepEqual(buildBuyRequest({ proposalId: "abc123", price: 10.5 }), { buy: "abc123", price: 10.5 });
});

test("parseProposalResponse extracts fields from a well-formed message", () => {
  const result = parseProposalResponse({ proposal: { id: "p1", ask_price: 10.5, payout: 19.5, spot: 612.4 } });
  assert.deepEqual(result, { proposalId: "p1", askPrice: 10.5, payout: 19.5, spot: 612.4 });
});

test("parseProposalResponse throws clearly on a malformed message", () => {
  assert.throws(() => parseProposalResponse({}), /Malformed proposal response/);
  assert.throws(() => parseProposalResponse({ proposal: {} }), /Malformed proposal response/);
});

test("parseBuyResponse extracts fields from a well-formed message", () => {
  const result = parseBuyResponse({ buy: { contract_id: 123, transaction_id: 456, buy_price: 10.5, payout: 19.5, longcode: "Win if..." } });
  assert.deepEqual(result, { contractId: "123", transactionId: "456", buyPrice: 10.5, payout: 19.5, longcode: "Win if..." });
});

test("parseBuyResponse throws clearly on a malformed message", () => {
  assert.throws(() => parseBuyResponse({}), /Malformed buy response/);
  assert.throws(() => parseBuyResponse({ buy: {} }), /Malformed buy response/);
});

// Regression test, same reasoning as botBuilder.test.ts's CockroachDB-id
// test: document the known limitation rather than hide it. This can't
// prove no precision was lost inside JSON.parse itself (that already
// happened before this function runs) -- it only proves the post-parse
// String() coercion doesn't introduce a *second* loss on top of that.
test("parseBuyResponse coerces a numeric contract_id to a string without further loss", () => {
  const unsafeId = Number.MAX_SAFE_INTEGER + 2; // already imprecise as a JS number
  const result = parseBuyResponse({ buy: { contract_id: unsafeId, transaction_id: 1, buy_price: 1, payout: 1 } });
  assert.equal(result.contractId, String(unsafeId));
  assert.equal(typeof result.contractId, "string");
});
