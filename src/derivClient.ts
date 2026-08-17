import { EventEmitter } from "node:events";
import WebSocket from "ws";

// Deriv's public market-data WebSocket (quotes/ticks/contract metadata).
// No app_id or auth needed -- confirmed directly against the live endpoint.
// Account-scoped actions (trades, balances) aren't available on this
// channel; those go through the REST API + OAuth2 flow instead (see
// src/app.ts), which issues a short-lived, single-use OTP'd WebSocket URL
// per connection rather than a long-lived authorized socket.
const DERIV_WS_PUBLIC_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const PING_INTERVAL_MS = 30_000;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
};

/**
 * Thin wrapper around Deriv's public WebSocket API.
 * Matches requests to responses via req_id, and re-emits streamed
 * messages (ticks, ohlc, ...) as events for subscribers.
 */
export class DerivClient extends EventEmitter {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;

  // wsUrl is overridable so tests can point this at a local mock server
  // instead of Deriv's real API.
  constructor(wsUrl: string = DERIV_WS_PUBLIC_URL) {
    super();
    this.wsUrl = wsUrl;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.once("open", () => {
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), PING_INTERVAL_MS);
        resolve();
      });

      ws.once("error", (err) => reject(err));

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (typeof msg.req_id === "number" && this.pending.has(msg.req_id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.req_id)!;
          this.pending.delete(msg.req_id);
          if (msg.error) rej(msg.error);
          else res(msg);
        }
        // Streamed messages (tick, ohlc, ...) carry a `msg_type` and keep
        // arriving after the initial subscribe response. Error responses
        // also carry the requested msg_type but no payload, so route those
        // separately instead of emitting a malformed event.
        if (msg.error) this.emit("api_error", msg.error);
        else if (msg.msg_type) this.emit(msg.msg_type, msg);
      });

      ws.on("close", () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.emit("disconnected");
      });
    });
  }

  send(payload: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("DerivClient: socket not open"));
    }
    const req_id = this.nextReqId++;
    const body = { ...payload, req_id };
    return new Promise((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject });
      this.ws!.send(JSON.stringify(body));
    });
  }

  subscribeTicks(symbol: string) {
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
