// Copy Trading v1 is shadow-mode only: we compute and log what a follower's
// copied trade *would* look like, but never call Deriv's trade-execution
// API. Nothing here places a real trade. See README Copy Trading for why.

export type LeaderTrade = {
  ref: string; // identifies the leader's original trade (e.g. contract_id)
  symbol: string;
  direction: string;
  stake: number;
};

export type FollowerConfig = {
  loginid: string;
  enabled: boolean;
  stakeRatio: number;
  maxStake: number | null;
};

export type ShadowCopy = {
  followerLoginid: string;
  leaderTradeRef: string;
  symbol: string;
  direction: string;
  leaderStake: number;
  wouldBeStake: number;
};

export function computeShadowCopy(trade: LeaderTrade, follower: FollowerConfig): ShadowCopy {
  const scaled = trade.stake * follower.stakeRatio;
  const wouldBeStake = follower.maxStake !== null ? Math.min(scaled, follower.maxStake) : scaled;
  return {
    followerLoginid: follower.loginid,
    leaderTradeRef: trade.ref,
    symbol: trade.symbol,
    direction: trade.direction,
    leaderStake: trade.stake,
    wouldBeStake,
  };
}
