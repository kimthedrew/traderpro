import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { APP_ID, DERIV_API_BASE } from "./derivConfig.js";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
};

// Requests a short-lived, single-use WebSocket URL for authenticated
// trading operations (proposal/buy), using the session's own access token.
// Never sent to the browser -- called server-side only, same as the
// /accounts fetch in app.ts's /api/session handler.
//
// CONFIRMED against Deriv's own official App Builder template source:
// `accountId` here is the same value app.ts now stores as `loginid`
// (Deriv's /accounts response only has one identifier field, `account_id`
// -- there's no separate "loginid" concept to reconcile, see app.ts).
export async function fetchTradingSocketUrl(accessToken: string, accountId: string): Promise<string> {
  const res = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
    method: "POST",
    headers: { "Deriv-App-ID": APP_ID, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deriv OTP request failed: HTTP ${res.status} ${body}`);
  }
  const body = await res.json();
  // CONFIRMED shape (Deriv's OTPResponse type): { data: { url } }, wrapped
  // in `data` like every other Deriv REST response here -- not a bare
  // { url } at the top level as previously guessed.
  const url = body.data?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("Deriv OTP response did not include a usable WebSocket URL");
  }
  return url;
}

/**
 * Authenticated counterpart to DerivClient, for the short-lived OTP'd
 * socket used for proposal/buy. Same req_id/send pattern, but with a
 * persistent error handler: DerivClient's `ws.once("error", reject)` only
 * matters until connect() resolves, which is fine for a socket that's
 * mostly just a long-lived tick feed, but this client's connections are
 * meant to survive a full proposal -> buy round trip (a real request/
 * response exchange, not just the initial handshake) -- an unhandled
 * 'error' event anywhere in that window would still crash the process.
 */
export class AuthenticatedDerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(private wsUrl: string) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let settled = false;

      // Persistent, not `.once` -- see class comment above. Deliberately
      // does NOT `this.emit("error", ...)`: EventEmitter special-cases the
      // "error" event and throws if nothing's listening, which would just
      // move the crash risk from the socket to this wrapper. A distinct
      // event name means a caller that forgets to listen degrades to
      // "nothing happens" instead of a second crash path.
      ws.on("error", (err) => {
        console.error("AuthenticatedDerivClient: WebSocket error:", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emit("socket_error", err);
      });

      ws.once("open", () => {
        settled = true;
        resolve();
      });

      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch (err) {
          console.error("AuthenticatedDerivClient: received a non-JSON message, ignoring:", err);
          return;
        }
        if (typeof msg.req_id === "number" && this.pending.has(msg.req_id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.req_id)!;
          this.pending.delete(msg.req_id);
          if (msg.error) rej(msg.error);
          else res(msg);
        }
      });

      ws.on("close", () => this.emit("disconnected"));
    });
  }

  send(payload: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("AuthenticatedDerivClient: socket not open"));
    }
    const req_id = this.nextReqId++;
    const body = { ...payload, req_id };
    return new Promise((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject });
      this.ws!.send(JSON.stringify(body));
    });
  }

  close() {
    this.ws?.close();
  }
}
