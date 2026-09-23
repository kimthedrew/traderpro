// Real Trading v1: Rise/Fall contracts only, placed with real money against
// Deriv's authenticated trading channel. This is the first feature in this
// codebase that ever calls Deriv's trade-execution API -- see README "Real
// Trading" for the feature-flag gating and what's confirmed vs. not.
//
// Pure request-building/response-parsing logic lives here, no I/O -- same
// split as botBuilder.ts (matchesBot/buildPaperTrade vs botBuilderStore.ts).
// Request/response shapes below are cross-checked against Deriv's own
// official App Builder template source (packages/core/src/types/trading.ts
// and react/useProposal.ts/useBuy.ts) -- confirmed by reading Deriv's own
// code, not yet by a live trade against a real account. See README "Real
// Trading" for what that last step still needs.

export type RiseFallDirection = "rise" | "fall";

export type RealTrade = {
  // Kept as a string, never Number() -- same reasoning as Bot.id in
  // botBuilder.ts (pg/CockroachDB BIGSERIAL ids can exceed JS's safe
  // integer range).
  id: string;
  ownerLoginid: string;
  symbol: string;
  direction: RiseFallDirection;
  contractType: "CALL" | "PUT";
  stake: number;
  duration: number;
  durationUnit: string;
  currency: string;
  derivContractId: string | null;
  derivTransactionId: string | null;
  buyPrice: number | null;
  payout: number | null;
  status: "placed" | "error";
  errorMessage: string | null;
};

// CALL/PUT for plain Rise/Fall -- confirmed directly in Deriv's own
// rise-fall template (hooks/use-rise-fall-trading.ts). The "Allow equals"
// variant that template also offers appends "E" (CALLE/PUTE), not built
// here -- see TRADING_ROADMAP.md.
export function contractTypeForDirection(direction: RiseFallDirection): "CALL" | "PUT" {
  return direction === "rise" ? "CALL" : "PUT";
}

export function buildProposalRequest(input: {
  symbol: string;
  direction: RiseFallDirection;
  stake: number;
  duration: number;
  durationUnit: string;
  currency: string;
}): Record<string, unknown> {
  return {
    proposal: 1,
    amount: input.stake,
    basis: "stake",
    contract_type: contractTypeForDirection(input.direction),
    currency: input.currency,
    duration: input.duration,
    duration_unit: input.durationUnit,
    // CONFIRMED field name via Deriv's own template (react/useProposal.ts):
    // Deriv's proposal request takes `underlying_symbol`, not `symbol` --
    // this was wrong before and would have made every proposal call fail.
    underlying_symbol: input.symbol,
  };
}

export type ProposalResult = { proposalId: string; askPrice: number; payout: number; spot: number };

// Response shape confirmed against Deriv's own ProposalResponse type
// (proposal.{id,ask_price,payout,spot,...}) -- matches what was already
// here. Deriv's own template additionally uses `subscribe: 1` to keep this
// streaming live rather than a one-shot call; this app still does a single
// request per "Get price" click -- see TRADING_ROADMAP.md.
export function parseProposalResponse(msg: any): ProposalResult {
  const p = msg?.proposal;
  if (!p || (typeof p.id !== "string" && typeof p.id !== "number")) {
    throw new Error("Malformed proposal response from Deriv");
  }
  return { proposalId: String(p.id), askPrice: Number(p.ask_price), payout: Number(p.payout), spot: Number(p.spot) };
}

export function buildBuyRequest(input: { proposalId: string; price: number }): Record<string, unknown> {
  // CONFIRMED via Deriv's own template (react/useBuy.ts): `price` is sent
  // as a string, not a number -- this was wrong before.
  return { buy: input.proposalId, price: String(input.price) };
}

export type BuyResult = { contractId: string; transactionId: string; buyPrice: number; payout: number; longcode: string };

// Field names confirmed against Deriv's own BuyResponse type (buy.{contract_id,
// transaction_id,buy_price,payout,longcode,balance_after,...}) -- matches
// what was already here. Deriv's own TypeScript types contract_id/
// transaction_id as `number`, which meaningfully lowers (but doesn't fully
// rule out) the JSON.parse precision-loss risk flagged in README/db.ts --
// still coerced to String() here regardless, since that's free and correct
// either way.
export function parseBuyResponse(msg: any): BuyResult {
  const b = msg?.buy;
  if (!b || (typeof b.contract_id !== "string" && typeof b.contract_id !== "number")) {
    throw new Error("Malformed buy response from Deriv");
  }
  return {
    contractId: String(b.contract_id),
    transactionId: String(b.transaction_id ?? ""),
    buyPrice: Number(b.buy_price),
    payout: Number(b.payout),
    longcode: String(b.longcode ?? ""),
  };
}
