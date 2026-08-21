import { pool } from "./db.js";
import { matchesBot, buildPaperTrade, type Bot, type BotDirection, type PaperTrade } from "./botBuilder.js";
import type { SignalEvent } from "./signals.js";

// id comes back from Postgres as a string (BIGSERIAL/BIGINT columns are
// returned as strings by pg, to avoid precision loss on values outside
// JS's safe integer range) -- convert explicitly rather than let a wrong
// type quietly ride along as "it happens to work in a URL param".
type BotRow = { id: string; owner_loginid: string; name: string; symbol: string; direction: BotDirection; stake: number; enabled: boolean };

function rowToBot(r: BotRow): Bot {
  return { id: Number(r.id), ownerLoginid: r.owner_loginid, name: r.name, symbol: r.symbol, direction: r.direction, stake: r.stake, enabled: r.enabled };
}

export async function createBot(ownerLoginid: string, config: { name: string; symbol: string; direction: BotDirection; stake: number }): Promise<Bot> {
  const result = await pool.query<BotRow>(
    `INSERT INTO bots (owner_loginid, name, symbol, direction, stake) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, owner_loginid, name, symbol, direction, stake, enabled`,
    [ownerLoginid, config.name, config.symbol, config.direction, config.stake],
  );
  return rowToBot(result.rows[0]);
}

export async function getBotsForOwner(ownerLoginid: string): Promise<Bot[]> {
  const result = await pool.query<BotRow>(
    `SELECT id, owner_loginid, name, symbol, direction, stake, enabled FROM bots WHERE owner_loginid = $1 ORDER BY created_at DESC`,
    [ownerLoginid],
  );
  return result.rows.map(rowToBot);
}

// Every mutation is scoped to (id AND ownerLoginid) so one user can never
// touch another's bot by guessing an id -- ownership is enforced in the
// query itself, not just checked beforehand.
//
// Partial update: pass null for a field to leave it untouched (COALESCE
// falls back to the existing value). Unconditionally overwriting both
// fields together let toggling "enabled" from a stale page silently
// revert a stake edit made elsewhere since the page loaded.
export async function updateBot(
  id: number,
  ownerLoginid: string,
  config: { enabled: boolean | null; stake: number | null },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE bots SET enabled = COALESCE($1, enabled), stake = COALESCE($2, stake) WHERE id = $3 AND owner_loginid = $4`,
    [config.enabled, config.stake, id, ownerLoginid],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteBot(id: number, ownerLoginid: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM bots WHERE id = $1 AND owner_loginid = $2`, [id, ownerLoginid]);
  return (result.rowCount ?? 0) > 0;
}

async function getEnabledBotsForSymbol(symbol: string): Promise<Bot[]> {
  const result = await pool.query<BotRow>(
    `SELECT id, owner_loginid, name, symbol, direction, stake, enabled FROM bots WHERE symbol = $1 AND enabled = true`,
    [symbol],
  );
  return result.rows.map(rowToBot);
}

async function recordPaperTrade(trade: PaperTrade): Promise<void> {
  await pool.query(
    `INSERT INTO bot_paper_trades (bot_id, symbol, direction, stake, price, signal_change_pct) VALUES ($1, $2, $3, $4, $5, $6)`,
    [trade.botId, trade.symbol, trade.direction, trade.stake, trade.price, trade.signalChangePct],
  );
}

// Wires a fired signal to every matching bot's paper-trade log. Nothing
// here calls Deriv's trade API -- see botBuilder.ts.
export async function runBotsForSignal(signal: SignalEvent): Promise<void> {
  const candidates = await getEnabledBotsForSymbol(signal.symbol);
  for (const bot of candidates) {
    if (matchesBot(bot, signal)) {
      await recordPaperTrade(buildPaperTrade(bot, signal));
    }
  }
}

export type StoredPaperTrade = PaperTrade & { createdAt: string };

// Ownership check via a join, not just trusting the caller's botId --
// same reasoning as updateBot/deleteBot above.
export async function getPaperTrades(botId: number, ownerLoginid: string, limit = 20): Promise<StoredPaperTrade[]> {
  const result = await pool.query<{
    bot_id: string; // see BotRow comment above -- pg returns bigint as string
    symbol: string;
    direction: "up" | "down";
    stake: number;
    price: number;
    signal_change_pct: number;
    created_at: Date;
  }>(
    `SELECT t.bot_id, t.symbol, t.direction, t.stake, t.price, t.signal_change_pct, t.created_at
     FROM bot_paper_trades t JOIN bots b ON b.id = t.bot_id
     WHERE t.bot_id = $1 AND b.owner_loginid = $2 ORDER BY t.created_at DESC LIMIT $3`,
    [botId, ownerLoginid, limit],
  );
  return result.rows.map((r) => ({
    botId: Number(r.bot_id),
    symbol: r.symbol,
    direction: r.direction,
    stake: r.stake,
    price: r.price,
    signalChangePct: r.signal_change_pct,
    createdAt: r.created_at.toISOString(),
  }));
}
