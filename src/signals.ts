// Fires a signal when a symbol's price moves at least THRESHOLD_PCT within
// a rolling WINDOW_MS, with a per-symbol COOLDOWN_MS to avoid re-firing on
// every tick while a move is still in progress. Starting defaults -- tune
// once there's a feel for how often these synthetic indices actually move.
const THRESHOLD_PCT = 1;
const WINDOW_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

export type SignalEvent = {
  symbol: string;
  direction: "up" | "down";
  changePct: number;
  price: number;
  windowSeconds: number;
};

type PricePoint = { epochMs: number; quote: number };

export class SignalDetector {
  private history = new Map<string, PricePoint[]>();
  private lastFired = new Map<string, number>();

  constructor(
    private thresholdPct = THRESHOLD_PCT,
    private windowMs = WINDOW_MS,
    private cooldownMs = COOLDOWN_MS,
  ) {}

  // epochSeconds matches Deriv's tick.epoch (unix seconds).
  check(symbol: string, quote: number, epochSeconds: number): SignalEvent | null {
    const nowMs = epochSeconds * 1000;
    const points = this.history.get(symbol) ?? [];
    points.push({ epochMs: nowMs, quote });

    const cutoff = nowMs - this.windowMs;
    while (points.length > 0 && points[0].epochMs < cutoff) points.shift();
    this.history.set(symbol, points);

    const oldest = points[0];
    if (!oldest || points.length < 2) return null;

    const changePct = ((quote - oldest.quote) / oldest.quote) * 100;
    if (Math.abs(changePct) < this.thresholdPct) return null;

    // -Infinity (not 0) for "never fired" -- 0 would make a never-fired
    // symbol look like it just fired at the Unix epoch, wrongly blocking
    // the very first signal whenever "now" is small (as in tests; real
    // epochs are large enough that this particular gap never showed up).
    const lastFire = this.lastFired.get(symbol) ?? -Infinity;
    if (nowMs - lastFire < this.cooldownMs) return null;

    this.lastFired.set(symbol, nowMs);
    return {
      symbol,
      direction: changePct >= 0 ? "up" : "down",
      changePct,
      price: quote,
      windowSeconds: Math.round(this.windowMs / 1000),
    };
  }
}
