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
const MAX_STAKE = process.env.REAL_TRADING_MAX_STAKE ? Number(process.env.REAL_TRADING_MAX_STAKE) : null;

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

// UNCONFIRMED: whether one OTP'd socket supports a full proposal -> buy
// exchange or only a single request/response. This assumes the former --
// one fresh OTP fetch + connection per trade-placement *attempt* (not
// cached/reused across separate HTTP requests). Verify on first live test
// against a real account -- see README "Real Trading".
async function withAuthenticatedClient<T>(accessToken: string, accountId: string, fn: (client: AuthenticatedDerivClient) => Promise<T>): Promise<T> {
  const wsUrl = await fetchTradingSocketUrl(accessToken, accountId);
  const client = new AuthenticatedDerivClient(wsUrl);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    client.close();
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
    const result = await withAuthenticatedClient(session.accessToken, loginid, async (client) => {
      const msg = await client.send(
        buildProposalRequest({ symbol: input.symbol, direction: input.direction, stake: input.stake, duration: input.duration, durationUnit: "t", currency: session.currency }),
      );
      return parseProposalResponse(msg);
    });
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
  let session;
  try {
    session = await getSession(req.cookies?.[SESSION_COOKIE]);
  } catch (err) {
    console.error("Could not verify session (database unavailable?):", err);
    res.status(502).json({ error: "Could not verify your session -- try again" });
    return;
  }
  if (!session) {
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
    const result = await withAuthenticatedClient(session.accessToken, loginid, async (client) => {
      const msg = await client.send(buildBuyRequest({ proposalId, price }));
      return parseBuyResponse(msg);
    });
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
