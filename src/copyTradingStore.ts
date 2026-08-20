import { pool } from "./db.js";
import { computeShadowCopy, type FollowerConfig, type LeaderTrade, type ShadowCopy } from "./copyTrading.js";

export async function getFollower(loginid: string): Promise<FollowerConfig | undefined> {
  const result = await pool.query<{ loginid: string; enabled: boolean; stake_ratio: number; max_stake: number | null }>(
    `SELECT loginid, enabled, stake_ratio, max_stake FROM followers WHERE loginid = $1`,
    [loginid],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return { loginid: row.loginid, enabled: row.enabled, stakeRatio: row.stake_ratio, maxStake: row.max_stake };
}

export async function upsertFollower(
  loginid: string,
  config: { enabled: boolean; stakeRatio: number; maxStake: number | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO followers (loginid, enabled, stake_ratio, max_stake, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (loginid) DO UPDATE SET enabled = EXCLUDED.enabled, stake_ratio = EXCLUDED.stake_ratio,
       max_stake = EXCLUDED.max_stake, updated_at = now()`,
    [loginid, config.enabled, config.stakeRatio, config.maxStake],
  );
}

export async function getEnabledFollowers(): Promise<FollowerConfig[]> {
  const result = await pool.query<{ loginid: string; enabled: boolean; stake_ratio: number; max_stake: number | null }>(
    `SELECT loginid, enabled, stake_ratio, max_stake FROM followers WHERE enabled = true`,
  );
  return result.rows.map((r) => ({ loginid: r.loginid, enabled: r.enabled, stakeRatio: r.stake_ratio, maxStake: r.max_stake }));
}

export async function recordShadowCopy(copy: ShadowCopy): Promise<void> {
  await pool.query(
    `INSERT INTO copy_trade_shadow_log (follower_loginid, leader_trade_ref, symbol, direction, leader_stake, would_be_stake)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [copy.followerLoginid, copy.leaderTradeRef, copy.symbol, copy.direction, copy.leaderStake, copy.wouldBeStake],
  );
}

export type StoredShadowCopy = ShadowCopy & { createdAt: string };

export async function getShadowLog(loginid: string, limit = 20): Promise<StoredShadowCopy[]> {
  const result = await pool.query<{
    follower_loginid: string;
    leader_trade_ref: string;
    symbol: string;
    direction: string;
    leader_stake: number;
    would_be_stake: number;
    created_at: Date;
  }>(
    `SELECT follower_loginid, leader_trade_ref, symbol, direction, leader_stake, would_be_stake, created_at
     FROM copy_trade_shadow_log WHERE follower_loginid = $1 ORDER BY created_at DESC LIMIT $2`,
    [loginid, limit],
  );
  return result.rows.map((r) => ({
    followerLoginid: r.follower_loginid,
    leaderTradeRef: r.leader_trade_ref,
    symbol: r.symbol,
    direction: r.direction,
    leaderStake: r.leader_stake,
    wouldBeStake: r.would_be_stake,
    createdAt: r.created_at.toISOString(),
  }));
}

// Wires a leader's trade to every enabled follower's shadow log. Nothing
// here calls Deriv's trade API -- see copyTrading.ts.
export async function shadowCopyToAllFollowers(trade: LeaderTrade): Promise<void> {
  const followers = await getEnabledFollowers();
  for (const follower of followers) {
    await recordShadowCopy(computeShadowCopy(trade, follower));
  }
}
