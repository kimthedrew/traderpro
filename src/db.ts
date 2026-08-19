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
