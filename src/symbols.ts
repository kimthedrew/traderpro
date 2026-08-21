// The only symbols the public tick feed streams. Signals only ever fire
// for these, and so Bot Builder (which watches Signals) can only ever
// match one of these too -- kept as a single source both server.ts and
// app.ts import, instead of two hand-synced copies.
export const TICKER_SYMBOLS = ["R_100", "R_75", "R_50", "BOOM1000", "CRASH500", "JD100"];
