import { pool } from "./db.js";
import type { SignalEvent } from "./signals.js";

export async function recordSignal(signal: SignalEvent): Promise<void> {
  await pool.query(
    `INSERT INTO signals (symbol, direction, change_pct, price, window_seconds) VALUES ($1, $2, $3, $4, $5)`,
    [signal.symbol, signal.direction, signal.changePct, signal.price, signal.windowSeconds],
  );
}

export type StoredSignal = SignalEvent & { createdAt: string };

export async function getRecentSignals(limit = 20): Promise<StoredSignal[]> {
  const result = await pool.query<{
    symbol: string;
    direction: "up" | "down";
    change_pct: number;
    price: number;
    window_seconds: number;
    created_at: Date;
  }>(`SELECT symbol, direction, change_pct, price, window_seconds, created_at FROM signals ORDER BY created_at DESC LIMIT $1`, [limit]);

  return result.rows.map((r) => ({
    symbol: r.symbol,
    direction: r.direction,
    changePct: r.change_pct,
    price: r.price,
    windowSeconds: r.window_seconds,
    createdAt: r.created_at.toISOString(),
  }));
}
