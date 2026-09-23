import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

export type DerivAccountSummary = { accountId: string; accountType: "demo" | "real"; currency: string };

export type Session = {
  loginid: string;
  currency: string;
  accountType: "demo" | "real";
  // Every account (demo + real) this OAuth login covers -- lets the user
  // switch which one is active. See switchSessionAccount.
  accounts: DerivAccountSummary[];
  // The OAuth2 access token for this account. Never sent to the browser --
  // used server-side for REST calls (e.g. requesting an OTP'd WebSocket URL
  // for authenticated real-time data, once that's needed).
  accessToken: string;
};

// accountType/accounts are optional on the way in -- callers that don't
// know about multi-account switching (existing tests, any future simple
// caller) still get a sane single-account session instead of a required
// field they have to thread through.
export async function createSession(
  data: Omit<Session, "accountType" | "accounts"> & {
    accountType?: "demo" | "real";
    accounts?: DerivAccountSummary[];
    expiresInSeconds: number;
  },
): Promise<string> {
  const accountType = data.accountType ?? "real";
  const accounts = data.accounts ?? [{ accountId: data.loginid, accountType, currency: data.currency }];

  const id = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO users (loginid, currency, account_type) VALUES ($1, $2, $3)
     ON CONFLICT (loginid) DO UPDATE SET currency = EXCLUDED.currency, account_type = EXCLUDED.account_type`,
    [data.loginid, data.currency, accountType],
  );
  const expiresAt = new Date(Date.now() + data.expiresInSeconds * 1000);
  await pool.query(
    `INSERT INTO sessions (id, loginid, access_token, expires_at, accounts) VALUES ($1, $2, $3, $4, $5)`,
    [id, data.loginid, data.accessToken, expiresAt, JSON.stringify(accounts)],
  );
  return id;
}

export async function getSession(id: string | undefined): Promise<Session | undefined> {
  if (!id) return undefined;
  const result = await pool.query<{
    loginid: string;
    currency: string;
    account_type: "demo" | "real";
    access_token: string;
    accounts: DerivAccountSummary[];
  }>(
    `SELECT s.loginid, u.currency, u.account_type, s.access_token, s.accounts
     FROM sessions s JOIN users u ON u.loginid = s.loginid
     WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    loginid: row.loginid,
    currency: row.currency,
    accountType: row.account_type,
    accounts: row.accounts,
    accessToken: row.access_token,
  };
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (!id) return;
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
}

// Switches a session's active account among the ones its own OAuth login
// covers (e.g. demo <-> real) -- no new Deriv login needed, since one
// access token is valid for any account it returned. `accountId` is
// checked against the session's own stored accounts list, never trusted
// bare from the client, so a session can't be switched onto an account
// that isn't actually one of its own.
export async function switchSessionAccount(sessionId: string, accountId: string): Promise<Session | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const target = session.accounts.find((a) => a.accountId === accountId);
  if (!target) return undefined;

  await pool.query(
    `INSERT INTO users (loginid, currency, account_type) VALUES ($1, $2, $3)
     ON CONFLICT (loginid) DO UPDATE SET currency = EXCLUDED.currency, account_type = EXCLUDED.account_type`,
    [target.accountId, target.currency, target.accountType],
  );
  await pool.query(`UPDATE sessions SET loginid = $1 WHERE id = $2`, [target.accountId, sessionId]);

  return { ...session, loginid: target.accountId, currency: target.currency, accountType: target.accountType };
}
