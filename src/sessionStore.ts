import { randomBytes } from "node:crypto";
import type { DerivClient } from "./derivClient.js";

export type Session = {
  loginid: string;
  currency: string;
  email?: string;
  // Kept alive for the life of the session so future authorized calls
  // (balance, portfolio, copy trading...) don't need to re-authorize.
  // The raw token itself is never stored -- only this authorized connection.
  client: DerivClient;
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
  const session = sessions.get(id);
  session?.client.close();
  sessions.delete(id);
}
