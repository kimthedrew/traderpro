// Real Trading v1: Rise/Fall only, real money, mounted into app.ts only
// when ENABLE_REAL_TRADING=true (see app.ts) -- when the flag is off this
// router is never mounted, so these paths 404 like they don't exist at all.
//
// Split into its own module (a first for this codebase) specifically so
// this real-money surface is easy to audit, read, and remove as one unit.
// See README "Real Trading" for what's confirmed vs. unconfirmed about the
// Deriv-side shapes this relies on.

import { Router } from "express";
import { requireLogin, currentLoginId, SESSION_COOKIE } from "./authHelpers.js";
import { getSession } from "./sessionStore.js";
import { TICKER_SYMBOLS } from "./symbols.js";
import {
  buildProposalRequest,
  buildBuyRequest,
  parseProposalResponse,
  parseBuyResponse,
  contractTypeForDirection,
  type RiseFallDirection,
} from "./realTrading.js";
import { AuthenticatedDerivClient, fetchTradingSocketUrl } from "./derivAuthClient.js";
import { recordTrade, getTradesForOwner } from "./realTradingStore.js";

export const realTradingRouter = Router();

const KNOWN_SYMBOLS = new Set(TICKER_SYMBOLS);
const DIRECTIONS = new Set<RiseFallDirection>(["rise", "fall"]);
// Fixed tick-count durations rather than an open numeric field -- sidesteps
// needing per-symbol min/max duration metadata (Deriv's contracts_for,
// unconfirmed/not built) and keeps the validated input space small for the
// pre-legal-review window. A deliberate scope reduction, not a discovered
// Deriv constraint -- see TRADING_ROADMAP.md.
const ALLOWED_DURATIONS = new Set([5, 10]);
// Exported so /api/config can tell the frontend the real cap, instead of
// the UI guessing/hardcoding a value that could drift from this one.
export const MAX_STAKE = process.env.REAL_TRADING_MAX_STAKE ? Number(process.env.REAL_TRADING_MAX_STAKE) : null;

type TradeInput = { symbol: string; direction: RiseFallDirection; stake: number; duration: number };

function validateTradeInput(body: any): TradeInput | null {
  const { symbol, direction, stake, duration } = body ?? {};
  if (typeof symbol !== "string" || !KNOWN_SYMBOLS.has(symbol)) return null;
  if (typeof direction !== "string" || !DIRECTIONS.has(direction as RiseFallDirection)) return null;
  if (typeof stake !== "number" || !(stake > 0)) return null;
  if (MAX_STAKE !== null && stake > MAX_STAKE) return null;
  if (typeof duration !== "number" || !ALLOWED_DURATIONS.has(duration)) return null;
  return { symbol, direction: direction as RiseFallDirection, stake, duration };
}

// CONFIRMED live against a real account: a proposal is only valid on the
// WebSocket connection it was requested on -- buying it from a fresh
// connection (even with a valid proposalId/price) fails with Deriv's
// InvalidContractProposal / "Unknown contract proposal". So the connection
// opened for /proposal has to stay open and get reused by /buy, not be
// closed and reopened per HTTP request the way this used to work.
//
// Kept in memory, keyed by loginid -- fine for this app's single Node
// process (Render's free tier runs one instance, no clustering); would
// need moving to a shared store if this ever runs across multiple
// processes/instances.
type PendingProposal = {
  client: AuthenticatedDerivClient;
  proposalId: string;
  askPrice: number;
  createdAt: number;
};
const pendingProposals = new Map<string, PendingProposal>();
// Deriv's own proposal streams are typically quoted for a few seconds at a
// time; this isn't a confirmed Deriv-side expiry, just a conservative
// upper bound so a connection can't sit open indefinitely if a user gets a
// price and never acts on it.
const PROPOSAL_TTL_MS = 60_000;

function clearPendingProposal(loginid: string) {
  const existing = pendingProposals.get(loginid);
  if (existing) {
    existing.client.close();
    pendingProposals.delete(loginid);
  }
}

realTradingRouter.post("/proposal", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const input = validateTradeInput(req.body);
  if (!input) {
    res.status(400).json({ error: "Invalid trade input" });
    return;
  }
  try {
    const session = await getSession(req.cookies?.[SESSION_COOKIE]);
    if (!session) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    // A repeated "Get price" click (new symbol/direction/stake) supersedes
    // whatever proposal this user had pending -- don't leak the old socket.
    clearPendingProposal(loginid);

    const wsUrl = await fetchTradingSocketUrl(session.accessToken, loginid);
    const client = new AuthenticatedDerivClient(wsUrl);
    await client.connect();
    let result;
    try {
      const msg = await client.send(
        buildProposalRequest({ symbol: input.symbol, direction: input.direction, stake: input.stake, duration: input.duration, durationUnit: "t", currency: session.currency }),
      );
      result = parseProposalResponse(msg);
    } catch (err) {
      client.close();
      throw err;
    }

    pendingProposals.set(loginid, { client, proposalId: result.proposalId, askPrice: result.askPrice, createdAt: Date.now() });
    res.json(result);
  } catch (err) {
    console.error("Could not get a Deriv price proposal:", err);
    res.status(502).json({ error: "Could not get a price from Deriv -- try again" });
  }
});

realTradingRouter.post("/buy", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const input = validateTradeInput(req.body);
  const { proposalId, price } = req.body ?? {};
  if (!input || typeof proposalId !== "string" || !proposalId || typeof price !== "number" || !(price > 0)) {
    res.status(400).json({ error: "Invalid trade input" });
    return;
  }

  const pending = pendingProposals.get(loginid);
  if (!pending || Date.now() - pending.createdAt > PROPOSAL_TTL_MS) {
    clearPendingProposal(loginid);
    res.status(409).json({ error: "Price quote expired -- get a new price and try again" });
    return;
  }
  // The client should only ever be echoing back exactly what /proposal
  // just returned (see trade.js) -- cross-checking against what's actually
  // pending server-side means a mismatched or fabricated proposalId/price
  // is rejected here rather than forwarded to Deriv.
  if (proposalId !== pending.proposalId || price !== pending.askPrice) {
    res.status(400).json({ error: "Proposal does not match the pending price quote" });
    return;
  }
  // Consumed either way below -- a proposal is single-use once bought (or
  // attempted), and the socket it lives on isn't reused for anything else.
  pendingProposals.delete(loginid);

  let session;
  try {
    session = await getSession(req.cookies?.[SESSION_COOKIE]);
  } catch (err) {
    console.error("Could not verify session (database unavailable?):", err);
    pending.client.close();
    res.status(502).json({ error: "Could not verify your session -- try again" });
    return;
  }
  if (!session) {
    pending.client.close();
    res.status(401).json({ error: "Not logged in" });
    return;
  }

  const tradeBase = {
    ownerLoginid: loginid,
    symbol: input.symbol,
    direction: input.direction,
    contractType: contractTypeForDirection(input.direction),
    stake: input.stake,
    duration: input.duration,
    durationUnit: "t",
    currency: session.currency,
  };

  try {
    const msg = await pending.client.send(buildBuyRequest({ proposalId, price }));
    const result = parseBuyResponse(msg);
    const stored = await recordTrade({
      ...tradeBase,
      derivContractId: result.contractId,
      derivTransactionId: result.transactionId,
      buyPrice: result.buyPrice,
      payout: result.payout,
      status: "placed",
      errorMessage: null,
    });
    res.json({ trade: stored });
  } catch (err) {
    // Still record the attempt so there's an audit trail of a trade that
    // failed to place, not just a client-side error the user can't trace
    // later. UNCONFIRMED whether a failed buy call can ever partially
    // charge the account -- see README "Real Trading".
    const message = err instanceof Error ? err.message : String(err);
    console.error("Could not place Deriv trade:", err);
    try {
      await recordTrade({
        ...tradeBase,
        derivContractId: null,
        derivTransactionId: null,
        buyPrice: null,
        payout: null,
        status: "error",
        errorMessage: message,
      });
    } catch (recordErr) {
      console.error("Could not record failed trade attempt (database unavailable?):", recordErr);
    }
    res.status(502).json({ error: "Could not place trade with Deriv -- try again" });
  } finally {
    pending.client.close();
  }
});

realTradingRouter.get("/trades", async (req, res) => {
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ trades: [] });
      return;
    }
    res.json({ trades: await getTradesForOwner(loginid, 20) });
  } catch (err) {
    console.error("Could not fetch real trades (database unavailable?):", err);
    res.json({ trades: [] });
  }
});
