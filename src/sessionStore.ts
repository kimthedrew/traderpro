import { randomBytes } from "node:crypto";

export type Session = {
  loginid: string;
  currency: string;
  // The OAuth2 access token for this account. Never sent to the browser --
  // used server-side for REST calls (e.g. requesting an OTP'd WebSocket URL
  // for authenticated real-time data, once that's needed).
  accessToken: string;
};

const sessions = new Map<string, Session>();

export function createSession(data: Session): string {
  const id = randomBytes(32).toString("hex");
  sessions.set(id, data);
  return id;
}

export function getSession(id: string | undefined): Session | undefined {
  if (!id) return undefined;
  return sessions.get(id);
}

export function destroySession(id: string | undefined): void {
  if (!id) return;
  sessions.delete(id);
}
