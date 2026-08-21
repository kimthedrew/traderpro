# traderpro

Deriv third-party trading app. Live market-data feed, Deriv OAuth2 login,
Signals (live), and Copy Trading + Bot Builder (both real, both
deliberately shadow/paper-mode-only — see their sections below for why).

Deriv migrated their API in 2026 to a REST + OAuth2/PKCE model (from the
older single-WebSocket, `?app_id=` query-param API many older examples
still reference). This project is built against the current API.

## What's here

- `src/derivClient.ts` &mdash; thin wrapper around Deriv's **public**
  WebSocket API (`wss://api.derivws.com/trading/v1/options/ws/public`):
  request/response matching via `req_id`, ping keepalive, and an event
  emitter for streamed messages (ticks, etc). No auth or app_id needed —
  confirmed directly against the live endpoint.
- `src/app.ts` &mdash; Express app. Subscribes to ticks and relays them to
  the browser over SSE at `/api/stream`. Also serves `/api/config` (OAuth2
  client pieces) and the `/api/session` endpoints that drive login.
- `src/db.ts` &mdash; Postgres connection pool + schema migration (runs
  automatically on boot, non-fatally — see Persistence below). Works with
  any Postgres provider via `DATABASE_URL`, no code changes needed to
  switch one out for another.
- `src/sessionStore.ts` &mdash; session store backed by Postgres (`users` +
  `sessions` tables), keyed by an httpOnly cookie; holds each logged-in
  user's OAuth2 access token server-side.
- `src/signals.ts` / `src/copyTrading.ts` / `src/botBuilder.ts` &mdash; pure,
  unit-tested logic for each feature (detection, shadow-copy math, bot
  matching), separate from their `*Store.ts` counterparts which do the
  actual Postgres reads/writes.
- `src/symbols.ts` / `public/symbols.js` &mdash; the one place the tradeable
  symbol list (`R_100`, `R_75`, ...) is defined, for backend and frontend
  respectively. `server.ts`, `app.ts`, `app.js`, and `bots.js` all import
  from these instead of each keeping their own hand-synced copy.
- `public/` &mdash; static frontend. `index.html` (ticker, Signals, Copy
  Trading) and `bots.html` (Bot Builder) share `style.css`, `symbols.js`,
  and `auth.js` (OAuth2 + PKCE login/logout, kept in one place since it's
  security-sensitive code two drifting copies would be bad news for).

## Setup

1. Register your own app — there's no working shared/demo app_id for the
   current API, even for local dev:
   - Go to the [Deriv API dashboard](https://developers.deriv.com) → log in
     with a Deriv account → **Register application**.
   - Set the app's **Redirect URL** to match `OAUTH_REDIRECT_URL` below
     exactly.
   - Copy the resulting **App ID** (this is an OAuth2 `client_id`, despite
     the name Deriv's dashboard gives it).

2. Start a local Postgres (or point `DATABASE_URL` at any hosted one —
   see Persistence below):
   ```
   docker run -d --name traderpro-pg -e POSTGRES_PASSWORD=devpassword \
     -e POSTGRES_DB=traderpro -p 5434:5432 postgres:16-alpine
   ```

3. Copy the env file and fill in your App ID (and `DATABASE_URL` if not
   using the exact command above):
   ```
   cp .env.example .env
   ```

4. Install and run:
   ```
   npm install
   npm run dev
   ```

5. Open http://localhost:3000 — you should see live ticks immediately
   (public data, no login needed). Testing the login button locally
   requires a Redirect URL registered for `http://localhost:3000/redirect.html`
   specifically (register a second app for this, or test login against a
   deployed URL that matches your registered Redirect URL).

## How the OAuth2 + PKCE flow works here

1. `public/app.js` generates a PKCE `code_verifier` + `code_challenge` and a
   random `state`, stashes the first two in `sessionStorage`, and sends the
   user to `https://auth.deriv.com/oauth2/auth` with them.
2. User logs in / approves on Deriv's site.
3. Deriv redirects back to the registered Redirect URL with `?code=...&state=...`.
4. `public/redirect.js` checks `state` matches what was stored (CSRF check),
   then posts `{ code, codeVerifier }` to the backend — never the browser's
   job to talk to Deriv's token endpoint directly.
5. `POST /api/session` exchanges those for an access token at
   `https://auth.deriv.com/oauth2/token`, fetches the account via
   `GET https://api.derivws.com/trading/v1/options/accounts`, and hands the
   browser back only an httpOnly session cookie. The access token itself
   never reaches browser JS.
6. `GET /api/session` / `DELETE /api/session` cover login-state checks and
   logout. Sessions live in Postgres now (see Persistence below), so they
   survive a restart or crash. The session cookie's lifetime matches the
   real session's expiry exactly (Deriv's `expires_in`, ~1h) rather than a
   separate fixed value — it used to be a flat 24h cookie regardless of
   how long the underlying session actually stayed valid for, so people
   could hold a cookie that looked fine for up to 23 hours after the
   server had already started rejecting it and silently reporting them as
   logged out.

Note: the exact field names in the `/accounts` response (`loginid` vs
`login_id` vs `id`) haven't been confirmed against a real login yet —
`src/app.ts` falls back across the likely variants. Worth double-checking
once someone logs in for real, and tightening up if the guess was wrong.

For real-time *authenticated* data (balance, portfolio — not built yet),
Deriv's model is different from the ticker: request a short-lived,
single-use OTP'd WebSocket URL via
`POST /trading/v1/options/accounts/{accountId}/otp` (needs the access
token), then connect to that URL directly. Not a long-lived authorized
socket like the old API.

## Persistence

`DATABASE_URL` is a plain Postgres connection string — works with Neon,
Render Postgres, Supabase, a local instance, or anything else, with no
code changes. Deliberately kept undecided for now: `src/db.ts` runs its
migration on boot but **won't take the server down** if the database is
unreachable or `DATABASE_URL` is unset — the ticker and static pages keep
working either way, and login/session endpoints degrade to reporting
"logged out" instead of crashing. Schema is currently `users`, `sessions`,
`signals`, `followers`, and `copy_trade_shadow_log`; there's no migration
*tool* yet (just idempotent `CREATE TABLE IF NOT EXISTS` on boot) since
this doesn't warrant one yet.

## Reliability

A recurring bug class this project has hit more than once: an unhandled
error on something long-lived (a WebSocket, a stream, a connection pool)
crashes the *entire* Node process, not just the one thing that broke —
taking every connected user down over one bad message or one dropped
connection. Fixed instances of this, all verified directly rather than
assumed fixed after the code looked right:

- **`src/db.ts`**: the Postgres pool had no `connectionTimeoutMillis`
  (pg's default is 0 — wait forever), and migrations run behind a
  blocking top-level `await`. A `DATABASE_URL` pointing at a host that
  hangs instead of actively refusing (firewalled, paused, wrong
  hostname) would block server startup forever — not just the database,
  the *entire app*, including the public ticker. Fixed with a 5s
  timeout; verified by pointing `DATABASE_URL` at a non-routable IP and
  confirming the server now starts within ~9s instead of hanging.
- **`src/app.ts`**: `broadcast()` wrote to every SSE client with no error
  handling — a half-closed connection whose `close` event hadn't fired
  yet could crash the process for every connected user. Now wraps
  `write()` in try/catch and listens for `error` on each connection.
- **`src/derivClient.ts`**: `JSON.parse` on incoming WebSocket messages
  had no try/catch — one malformed frame from Deriv would take down the
  ticker/Signals/Bot Builder for everyone. Now logs and ignores a
  malformed frame instead; verified against a mock server that sends one
  deliberately, confirming the client stays functional afterward.
- **`src/app.ts`**: the four mutating routes (`POST /api/copy-trading/follow`,
  `POST /api/bots`, `PATCH /api/bots/:id`, `DELETE /api/bots/:id`) used
  to swallow database errors and report a plain `401 Not logged in` —
  identical to what a genuinely missing session cookie produces. A
  database outage would misreport a real, logged-in user as logged out.
  `requireLogin()` now distinguishes "no cookie" (401 is correct) from
  "the database errored out while checking" (502, with a clear message);
  verified by stopping the local Postgres mid-request and confirming a
  502 instead of a 401, then confirming normal 401s resume once it's
  back.
- **`src/app.ts`**: added `app.set("trust proxy", 1)` for Render's
  reverse proxy. Worth a correction here: this was originally flagged as
  breaking every login behind a proxy (express-rate-limit's default
  config validates the `trust proxy` setting and throws if it looks
  misconfigured). Direct testing showed the library actually catches
  that validation error internally and only logs it — it never fails
  the request. So this was never actually broken; the fix is still
  correct practice (accurate `req.ip`, no console noise), just not the
  severity first claimed.

## Signals

`src/signals.ts` watches the same tick stream the ticker uses and fires
an event when a symbol moves ≥1% within a 5-minute rolling window (10min
per-symbol cooldown so one big move doesn't spam repeatedly while still
in progress — see the comment there for the exact numbers, chosen as a
starting point rather than anything tuned against real volatility yet).
Signals are persisted (`src/signalsStore.ts`) and broadcast live over the
same SSE connection as ticks (`event: signal`) — `GET /api/signals`
serves the last 20 for a page's initial load. No login or account access
needed to watch; delivery is in-app only for now (no email/webhook yet).

The initial history fetch and the live SSE listener both start around
page load and can race — a signal firing in that window could arrive via
both paths. `public/app.js` dedups by a content key (symbol + direction +
changePct + price; a symbol's 10-minute cooldown makes two *real* signals
colliding on all four values essentially impossible) rather than plumbing
a database id through the broadcast-before-insert live path.

## Copy Trading

**Shadow mode only — no real trade is ever placed.** `src/copyTrading.ts`
computes what a follower's copied trade *would* look like (leader's stake
× the follower's `stakeRatio`, capped at their optional `maxStake`); it
never calls Deriv's trade-execution API. Any logged-in user can configure
following + risk limits (`POST /api/copy-trading/follow`) and see their
shadow copy history (`GET /api/copy-trading/shadow-log`).

What's *not* built yet: actually detecting a leader account's trades.
Deriv's authenticated real-time model (OTP'd WebSocket per connection,
`POST /trading/v1/options/accounts/{accountId}/otp`) isn't confirmed
against real trade/transaction event shapes — same kind of gap the
`ws_public` tick format was before it got verified. `COPY_TRADING_LEADER_LOGINID`
identifies which account to watch once that's wired up; until then the
feature has no leader, but everything else (follower config, shadow-copy
math, the log) is real and tested.

Going from shadow mode to actually placing trades is a deliberate,
separate step — not something to flip on casually. Do the legal/compliance
work (see Next steps) before that switch gets thrown.

## Bot Builder

**Paper mode only — no real trade is ever placed.** The third and last
roadmap item, and the riskiest one if it were live: a bot is a no-code
rule ("when a Signal fires for [symbol] in [direction], paper-trade
[$stake]") that reuses Signal detection rather than a second condition
engine (`src/botBuilder.ts`). Unlike Copy Trading's one-row-per-user
config, bots are full CRUD resources — any logged-in user can create,
enable/disable, edit the stake on, or delete multiple bots
(`/api/bots`, own page at `/bots.html`), and every mutating/reading
endpoint scopes by owner in the query itself (`WHERE ... AND
owner_loginid = $2`), not just a check beforehand, so one user can't
touch another's bot by guessing its id. `PATCH /api/bots/:id` is a real
partial update (send only the field you're changing) — it used to
require and overwrite both `enabled` and `stake` together, so toggling a
bot on/off from a page with a stale cached stake value could silently
revert a stake edit made in another tab.

There's deliberately no path from paper mode to live trading yet, unlike
Copy Trading which at least has `COPY_TRADING_LEADER_LOGINID` wired up
for when detection is ready. A bot placing real, unsupervised trades from
an arbitrary user-defined rule is a materially bigger risk than mirroring
a single known leader's activity — that switch needs its own explicit
design discussion, not just a config flag, whenever it's actually on the
table.

## Legal

`public/terms.html` and `public/privacy.html` are a technically-informed
first draft — accurately describing what the app actually does today —
**not reviewed by a lawyer yet**. Both are marked as drafts on the page
itself. Before relying on them:

- Real counsel review, specifically for: jurisdictions where users will
  actually be (this determines a lot — GDPR/CCPA-style rights language,
  financial-promotion rules for Signals, and whether Copy Trading counts
  as regulated investment advice/portfolio management in a given
  jurisdiction even in shadow mode, and especially once live).
- A real contact address/email (both docs have a placeholder).
- Governing law and limitation-of-liability language (both explicitly
  stubbed out, `[in brackets]`, in `terms.html`).
- Confirming Deriv's own terms don't conflict with or already cover
  something traderpro's terms currently duplicate or contradict.

## Next steps (not built yet)

- Pick a Postgres provider for real deployments (currently undecided —
  works locally via Docker in the meantime).
- Signals: delivery channels beyond the in-app feed (email, webhook).
- Copy trading: wire up real leader trade detection (needs Deriv's
  authenticated WS event shapes confirmed), and — only after legal
  groundwork — an explicit, separate step to actually place trades
  instead of shadow-logging them.
- Legal: get the draft ToS/privacy policy in front of real counsel (see
  Legal above) before charging anyone money, and specifically before
  Copy Trading or Bot Builder go from shadow/paper mode to live.
- Bot Builder: real trade execution is intentionally undesigned — needs
  its own explicit design pass (not just a flag) once legal groundwork
  and Copy Trading's live-detection piece are both further along.
- Confirm the `/accounts` response field names (see OAuth2 + PKCE flow
  above) against a real login.
