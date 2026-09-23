// Bot Builder "active" mode routes: mounted only when BOT_TRADING_ENABLED
// (which itself requires ENABLE_REAL_TRADING too -- see botTrading.ts),
// so these 404 like they don't exist otherwise, same gating pattern as
// realTradingRoutes.ts. A bot rule match only ever creates a pending
// confirmation (see botBuilderStore.ts); the actual Deriv proposal+buy
// call happens here, only once a human explicitly confirms.

import { Router } from "express";
import { requireLogin, currentLoginId, SESSION_COOKIE } from "./authHelpers.js";
import { getSession } from "./sessionStore.js";
import { botDirectionToRiseFall } from "./botTrading.js";
import { getPendingConfirmations, getPendingConfirmationForOwner, resolveConfirmation } from "./botTradingStore.js";
import { buildProposalRequest, buildBuyRequest, parseProposalResponse, parseBuyResponse, contractTypeForDirection } from "./realTrading.js";
import { AuthenticatedDerivClient, fetchTradingSocketUrl } from "./derivAuthClient.js";
import { recordTrade } from "./realTradingStore.js";
import { MAX_STAKE } from "./realTradingRoutes.js";

export const botTradingRouter = Router();

const CONFIRMATION_ID_PATTERN = /^\d+$/;

botTradingRouter.get("/pending", async (req, res) => {
  try {
    const loginid = await currentLoginId(req);
    if (!loginid) {
      res.json({ confirmations: [] });
      return;
    }
    res.json({ confirmations: await getPendingConfirmations(loginid) });
  } catch (err) {
    console.error("Could not fetch pending bot confirmations (database unavailable?):", err);
    res.json({ confirmations: [] });
  }
});

botTradingRouter.post("/confirmations/:id/reject", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const id = req.params.id;
  if (!CONFIRMATION_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "Invalid confirmation id" });
    return;
  }
  try {
    const pending = await getPendingConfirmationForOwner(id, loginid);
    if (!pending) {
      res.status(404).json({ error: "Not found, already resolved, or expired" });
      return;
    }
    await resolveConfirmation(id, loginid, { status: "rejected", realTradeId: null, errorMessage: null });
    res.json({ ok: true });
  } catch (err) {
    console.error("Could not reject bot confirmation (database unavailable?):", err);
    res.status(502).json({ error: "Could not reject -- try again" });
  }
});

// Fetches one fresh proposal and buys it immediately, over the same
// connection -- unlike realTradingRoutes.ts's /proposal+/buy split (which
// exists so a human can review a price before confirming), there's no
// separate "get price" step here: confirming *is* the human review, so
// proposal and buy happen back-to-back in this one request. This also
// sidesteps the "a proposal is only valid on the connection it was
// requested on" bug realTradingRoutes.ts had to work around.
botTradingRouter.post("/confirmations/:id/confirm", async (req, res) => {
  const loginid = await requireLogin(req, res);
  if (!loginid) return;
  const id = req.params.id;
  if (!CONFIRMATION_ID_PATTERN.test(id)) {
    res.status(400).json({ error: "Invalid confirmation id" });
    return;
  }

  let pending;
  try {
    pending = await getPendingConfirmationForOwner(id, loginid);
  } catch (err) {
    console.error("Could not verify pending bot confirmation (database unavailable?):", err);
    res.status(502).json({ error: "Could not confirm -- try again" });
    return;
  }
  if (!pending) {
    res.status(404).json({ error: "Not found, already resolved, or expired" });
    return;
  }
  // The stake was validated against the cap when the bot was created, but
  // the cap can change (or be introduced) after that -- re-check here,
  // at the point money would actually move, not just at creation time.
  if (MAX_STAKE !== null && pending.stake > MAX_STAKE) {
    await resolveConfirmation(id, loginid, { status: "error", realTradeId: null, errorMessage: `Stake exceeds the current cap (${MAX_STAKE})` });
    res.status(400).json({ error: `Stake exceeds the current cap (${MAX_STAKE})` });
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

  const direction = botDirectionToRiseFall(pending.direction);
  const tradeBase = {
    ownerLoginid: loginid,
    symbol: pending.symbol,
    direction,
    contractType: contractTypeForDirection(direction),
    stake: pending.stake,
    duration: pending.duration,
    durationUnit: "t",
    currency: session.currency,
  };

  try {
    const wsUrl = await fetchTradingSocketUrl(session.accessToken, loginid);
    const client = new AuthenticatedDerivClient(wsUrl);
    let result;
    try {
      await client.connect();
      const proposalMsg = await client.send(
        buildProposalRequest({ symbol: pending.symbol, direction, stake: pending.stake, duration: pending.duration, durationUnit: "t", currency: session.currency }),
      );
      const proposal = parseProposalResponse(proposalMsg);
      const buyMsg = await client.send(buildBuyRequest({ proposalId: proposal.proposalId, price: proposal.askPrice }));
      result = parseBuyResponse(buyMsg);
    } finally {
      client.close();
    }

    const stored = await recordTrade({
      ...tradeBase,
      derivContractId: result.contractId,
      derivTransactionId: result.transactionId,
      buyPrice: result.buyPrice,
      payout: result.payout,
      status: "placed",
      errorMessage: null,
    });
    await resolveConfirmation(id, loginid, { status: "confirmed", realTradeId: stored.id, errorMessage: null });
    res.json({ trade: stored });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Could not execute confirmed bot trade:", err);
    let failedTradeId: string | null = null;
    try {
      const stored = await recordTrade({
        ...tradeBase,
        derivContractId: null,
        derivTransactionId: null,
        buyPrice: null,
        payout: null,
        status: "error",
        errorMessage: message,
      });
      failedTradeId = stored.id;
    } catch (recordErr) {
      console.error("Could not record failed bot trade attempt (database unavailable?):", recordErr);
    }
    await resolveConfirmation(id, loginid, { status: "error", realTradeId: failedTradeId, errorMessage: message });
    res.status(502).json({ error: "Could not place trade with Deriv -- try again" });
  }
});
