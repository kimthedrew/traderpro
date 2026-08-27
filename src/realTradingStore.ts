import { pool } from "./db.js";
import type { RealTrade, RiseFallDirection } from "./realTrading.js";

// id comes back from Postgres/CockroachDB as a string -- same passthrough
// reasoning as botBuilderStore.ts's BotRow/rowToBot.
type RealTradeRow = {
  id: string;
  owner_loginid: string;
  symbol: string;
  direction: RiseFallDirection;
  contract_type: "CALL" | "PUT";
  stake: number;
  duration: number;
  duration_unit: string;
  currency: string;
  deriv_contract_id: string | null;
  deriv_transaction_id: string | null;
  buy_price: number | null;
  payout: number | null;
  status: "placed" | "error";
  error_message: string | null;
  created_at: Date;
};

export type StoredRealTrade = RealTrade & { createdAt: string };

function rowToRealTrade(r: RealTradeRow): StoredRealTrade {
  return {
    id: r.id,
    ownerLoginid: r.owner_loginid,
    symbol: r.symbol,
    direction: r.direction,
    contractType: r.contract_type,
    stake: r.stake,
    duration: r.duration,
    durationUnit: r.duration_unit,
    currency: r.currency,
    derivContractId: r.deriv_contract_id,
    derivTransactionId: r.deriv_transaction_id,
    buyPrice: r.buy_price,
    payout: r.payout,
    status: r.status,
    errorMessage: r.error_message,
    createdAt: r.created_at.toISOString(),
  };
}

export async function recordTrade(trade: Omit<RealTrade, "id">): Promise<StoredRealTrade> {
  const result = await pool.query<RealTradeRow>(
    `INSERT INTO real_trades (
       owner_loginid, symbol, direction, contract_type, stake, duration, duration_unit,
       currency, deriv_contract_id, deriv_transaction_id, buy_price, payout, status, error_message
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, owner_loginid, symbol, direction, contract_type, stake, duration, duration_unit,
               currency, deriv_contract_id, deriv_transaction_id, buy_price, payout, status, error_message, created_at`,
    [
      trade.ownerLoginid,
      trade.symbol,
      trade.direction,
      trade.contractType,
      trade.stake,
      trade.duration,
      trade.durationUnit,
      trade.currency,
      trade.derivContractId,
      trade.derivTransactionId,
      trade.buyPrice,
      trade.payout,
      trade.status,
      trade.errorMessage,
    ],
  );
  return rowToRealTrade(result.rows[0]);
}

// Scoped by owner_loginid in the query itself -- same reasoning as
// botBuilderStore.ts's getPaperTrades: never trust a client-passed id alone
// for ownership.
export async function getTradesForOwner(ownerLoginid: string, limit = 20): Promise<StoredRealTrade[]> {
  const result = await pool.query<RealTradeRow>(
    `SELECT id, owner_loginid, symbol, direction, contract_type, stake, duration, duration_unit,
            currency, deriv_contract_id, deriv_transaction_id, buy_price, payout, status, error_message, created_at
     FROM real_trades WHERE owner_loginid = $1 ORDER BY created_at DESC LIMIT $2`,
    [ownerLoginid, limit],
  );
  return result.rows.map(rowToRealTrade);
}
