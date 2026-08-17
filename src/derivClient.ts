import { EventEmitter } from "node:events";
import WebSocket from "ws";

const DERIV_WS_URL = "wss://ws.derivws.com/websockets/v3";
const PING_INTERVAL_MS = 30_000;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
};

/**
 * Thin wrapper around Deriv's WebSocket API.
 * Matches requests to responses via req_id, and re-emits streamed
 * messages (ticks, ohlc, balance, ...) as events for subscribers.
 */
export class DerivClient extends EventEmitter {
  private appId: string;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;

  // wsUrl is overridable so tests can point this at a local mock server
  // instead of Deriv's real API.
  constructor(appId: string, wsUrl: string = DERIV_WS_URL) {
    super();
    this.appId = appId;
    this.wsUrl = wsUrl;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?app_id=${this.appId}`);
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
        // Streamed messages (tick, ohlc, balance, ...) carry a `msg_type`
        // and keep arriving after the initial subscribe response. Error
        // responses also carry the requested msg_type but no payload, so
        // route those separately instead of emitting a malformed event.
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

  authorize(token: string) {
    return this.send({ authorize: token });
  }

  subscribeTicks(symbol: string) {
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }
}
