import { pool } from "./db.js";
import { PENDING_CONFIRMATION_TTL_MS, type BotTradeConfirmation, type BotConfirmationStatus } from "./botTrading.js";
import type { SignalEvent } from "./signals.js";
import type { Bot } from "./botBuilder.js";

type ConfirmationRow = {
  id: string;
  bot_id: string;
  bot_name: string;
  owner_loginid: string;
  symbol: string;
  direction: "up" | "down";
  stake: number;
  duration: number;
  signal_change_pct: number;
  signal_price: number;
  status: BotConfirmationStatus;
  real_trade_id: string | null;
  error_message: string | null;
  created_at: Date;
  resolved_at: Date | null;
};

function rowToConfirmation(r: ConfirmationRow): BotTradeConfirmation {
  return {
    id: r.id,
    botId: r.bot_id,
    botName: r.bot_name,
    ownerLoginid: r.owner_loginid,
    symbol: r.symbol,
    direction: r.direction,
    stake: r.stake,
    duration: r.duration,
    signalChangePct: r.signal_change_pct,
    signalPrice: r.signal_price,
    status: r.status,
    realTradeId: r.real_trade_id,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

export async function createPendingConfirmation(bot: Bot, signal: SignalEvent, duration: number): Promise<BotTradeConfirmation> {
  const result = await pool.query<ConfirmationRow>(
    `INSERT INTO bot_trade_confirmations (bot_id, bot_name, owner_loginid, symbol, direction, stake, duration, signal_change_pct, signal_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [bot.id, bot.name, bot.ownerLoginid, signal.symbol, signal.direction, bot.stake, duration, signal.changePct, signal.price],
  );
  return rowToConfirmation(result.rows[0]);
}

// Lazily expires anything past its TTL before listing -- same
// check-on-read approach sessions already use for expires_at, rather than
// a separate sweep job for one small table.
export async function getPendingConfirmations(ownerLoginid: string): Promise<BotTradeConfirmation[]> {
  const cutoff = new Date(Date.now() - PENDING_CONFIRMATION_TTL_MS);
  await pool.query(
    `UPDATE bot_trade_confirmations SET status = 'expired', resolved_at = now()
     WHERE owner_loginid = $1 AND status = 'pending' AND created_at < $2`,
    [ownerLoginid, cutoff],
  );
  const result = await pool.query<ConfirmationRow>(
    `SELECT * FROM bot_trade_confirmations WHERE owner_loginid = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [ownerLoginid],
  );
  return result.rows.map(rowToConfirmation);
}

// Scoped by (id AND ownerLoginid AND status = 'pending') -- same
// ownership-in-the-query pattern as every other mutation in this
// codebase, plus a state check so an already-resolved or expired
// confirmation can't be re-confirmed by replaying an old request.
export async function getPendingConfirmationForOwner(id: string, ownerLoginid: string): Promise<BotTradeConfirmation | undefined> {
  const cutoff = new Date(Date.now() - PENDING_CONFIRMATION_TTL_MS);
  const result = await pool.query<ConfirmationRow>(
    `SELECT * FROM bot_trade_confirmations WHERE id = $1 AND owner_loginid = $2 AND status = 'pending' AND created_at >= $3`,
    [id, ownerLoginid, cutoff],
  );
  return result.rows[0] ? rowToConfirmation(result.rows[0]) : undefined;
}

export async function resolveConfirmation(
  id: string,
  ownerLoginid: string,
  update: { status: "confirmed" | "rejected" | "error"; realTradeId: string | null; errorMessage: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE bot_trade_confirmations SET status = $1, real_trade_id = $2, error_message = $3, resolved_at = now() WHERE id = $4 AND owner_loginid = $5`,
    [update.status, update.realTradeId, update.errorMessage, id, ownerLoginid],
  );
}
