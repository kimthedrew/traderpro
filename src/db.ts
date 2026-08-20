import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL is not set -- sessions will not persist. " +
      "Point it at any Postgres instance (Neon, Render, Supabase, a local one, ...).",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A dropped idle-client connection emits 'error' on the pool; with no
// listener, Node treats that as an uncaught exception and crashes the
// process -- the same class of bug as the WebSocket reconnect crash.
pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client:", err);
});

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      loginid TEXT PRIMARY KEY,
      currency TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      loginid TEXT NOT NULL REFERENCES users(loginid) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signals (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      change_pct DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      window_seconds INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS signals_created_at_idx ON signals (created_at DESC)`);

  // Copy Trading v1 is shadow-mode only: we log what *would* be copied for
  // each follower, never place a real trade. See README Copy Trading.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followers (
      loginid TEXT PRIMARY KEY REFERENCES users(loginid) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT false,
      stake_ratio DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      max_stake DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copy_trade_shadow_log (
      id BIGSERIAL PRIMARY KEY,
      follower_loginid TEXT NOT NULL REFERENCES users(loginid) ON DELETE CASCADE,
      leader_trade_ref TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      leader_stake DOUBLE PRECISION NOT NULL,
      would_be_stake DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS shadow_log_follower_created_idx ON copy_trade_shadow_log (follower_loginid, created_at DESC)`,
  );
}

// Runs once per process on first import. Fine at this schema size (two
// small tables, idempotent CREATE TABLE IF NOT EXISTS) -- revisit with a
// real migration tool once the schema grows (e.g. when Signals/Copy Trading
// add tables).
//
// Deliberately non-fatal: a database is optional-for-now infrastructure
// (see .env.example) -- if it's unreachable, login/sessions degrade
// gracefully instead of taking the whole server down with them.
try {
  await runMigrations();
} catch (err) {
  console.error("Could not run database migrations -- login/sessions will not work until this is fixed:", err);
}
