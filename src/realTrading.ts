// Real Trading v1: Rise/Fall contracts only, placed with real money against
// Deriv's authenticated trading channel. This is the first feature in this
// codebase that ever calls Deriv's trade-execution API -- see README "Real
// Trading" for the feature-flag gating and what's confirmed vs. not.
//
// Pure request-building/response-parsing logic lives here, no I/O -- same
// split as botBuilder.ts (matchesBot/buildPaperTrade vs botBuilderStore.ts).
// Every Deriv message shape below is documented but UNCONFIRMED against a
// real account -- see README "Real Trading" before trusting it in prod.

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

// Deriv's stable CALL/PUT naming for Rise/Fall contracts (per Deriv's public
// API docs) -- not yet confirmed against this app's own authenticated
// trading channel.
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
    symbol: input.symbol,
  };
}

export type ProposalResult = { proposalId: string; askPrice: number; payout: number; spot: number };

// UNCONFIRMED response shape -- based on Deriv's documented proposal message
// (proposal.{id,ask_price,payout,spot}), never verified against a real
// response from this app's own OTP'd channel.
export function parseProposalResponse(msg: any): ProposalResult {
  const p = msg?.proposal;
  if (!p || (typeof p.id !== "string" && typeof p.id !== "number")) {
    throw new Error("Malformed proposal response from Deriv");
  }
  return { proposalId: String(p.id), askPrice: Number(p.ask_price), payout: Number(p.payout), spot: Number(p.spot) };
}

export function buildBuyRequest(input: { proposalId: string; price: number }): Record<string, unknown> {
  return { buy: input.proposalId, price: input.price };
}

export type BuyResult = { contractId: string; transactionId: string; buyPrice: number; payout: number; longcode: string };

// Same UNCONFIRMED-shape caveat as parseProposalResponse. contract_id /
// transaction_id are coerced to String() immediately -- but that coercion
// happens *after* JSON.parse, so it can't recover precision already lost
// there if Deriv's own ids ever exceed Number.MAX_SAFE_INTEGER (unconfirmed
// either way -- see README "Real Trading").
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
