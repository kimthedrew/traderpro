// Session/login helpers shared by app.ts and any route module mounted into
// it (e.g. realTradingRoutes.ts). Pulled out of app.ts so those modules
// don't have to import back into the module that mounts them.

import type express from "express";
import { getSession } from "./sessionStore.js";

export const SESSION_COOKIE = "traderpro_sid";

// For GET routes that should degrade to a logged-out-shaped response on any
// failure (missing cookie or a DB error), rather than a hard error.
export async function currentLoginId(req: express.Request): Promise<string | null> {
  const session = await getSession(req.cookies?.[SESSION_COOKIE]);
  return session?.loginid ?? null;
}

// For routes that require login. Distinguishes "no session cookie"
// (genuinely not logged in -- 401 is correct) from "the database errored
// out while checking" (401 would misreport a real, logged-in user as
// logged out mid-outage -- this reports it honestly as a server error
// instead).
export async function requireLogin(req: express.Request, res: express.Response): Promise<string | null> {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) {
    res.status(401).json({ error: "Not logged in" });
    return null;
  }
  let session;
  try {
    session = await getSession(cookie);
  } catch (err) {
    console.error("Could not verify session (database unavailable?):", err);
    res.status(502).json({ error: "Could not verify your session -- try again" });
    return null;
  }
  if (!session) {
    res.status(401).json({ error: "Not logged in" });
    return null;
  }
  return session.loginid;
}
