import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

export type Session = {
  loginid: string;
  currency: string;
  // The OAuth2 access token for this account. Never sent to the browser --
  // used server-side for REST calls (e.g. requesting an OTP'd WebSocket URL
  // for authenticated real-time data, once that's needed).
  accessToken: string;
};

export async function createSession(data: Session & { expiresInSeconds: number }): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO users (loginid, currency) VALUES ($1, $2)
     ON CONFLICT (loginid) DO UPDATE SET currency = EXCLUDED.currency`,
    [data.loginid, data.currency],
  );
  const expiresAt = new Date(Date.now() + data.expiresInSeconds * 1000);
  await pool.query(`INSERT INTO sessions (id, loginid, access_token, expires_at) VALUES ($1, $2, $3, $4)`, [
    id,
    data.loginid,
    data.accessToken,
    expiresAt,
  ]);
  return id;
}

export async function getSession(id: string | undefined): Promise<Session | undefined> {
  if (!id) return undefined;
  const result = await pool.query<{ loginid: string; currency: string; access_token: string }>(
    `SELECT s.loginid, u.currency, s.access_token
     FROM sessions s JOIN users u ON u.loginid = s.loginid
     WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return { loginid: row.loginid, currency: row.currency, accessToken: row.access_token };
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (!id) return;
  await pool.query(`DELETE FROM sessions WHERE id = $1`, [id]);
}
