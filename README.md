# traderpro

Deriv third-party trading app. Scaffold stage: live market-data feed +
Deriv OAuth2 login. Planned build order: **signals &rarr; copy trading &rarr;
no-code bot builder**.

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
- `src/sessionStore.ts` &mdash; in-memory session store keyed by an httpOnly
  cookie; holds each logged-in user's OAuth2 access token server-side.
- `public/` &mdash; static frontend: live tick display, and a "Log in with
  Deriv" button that runs the OAuth2 + PKCE flow.

## Setup

1. Register your own app — there's no working shared/demo app_id for the
   current API, even for local dev:
   - Go to the [Deriv API dashboard](https://developers.deriv.com) → log in
     with a Deriv account → **Register application**.
   - Set the app's **Redirect URL** to match `OAUTH_REDIRECT_URL` below
     exactly.
   - Copy the resulting **App ID** (this is an OAuth2 `client_id`, despite
     the name Deriv's dashboard gives it).

2. Copy the env file and fill in your App ID:
   ```
   cp .env.example .env
   ```

3. Install and run:
   ```
   npm install
   npm run dev
   ```

4. Open http://localhost:3000 — you should see live ticks immediately
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
   logout. Sessions are in-memory only (see Persistence below) — they don't
   survive a server restart yet.

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

## Next steps (not built yet)

- Signals: pick a strategy trigger, push it to subscribers (email/push/
  webhook) — no live account access required for this piece.
- Copy trading: listen for a "leader" account's transaction stream and
  replicate trades onto follower accounts' authorized connections, with
  per-follower risk limits.
- Persistence (users, subscriptions, leader/follower config) — nothing
  here is stored anywhere yet, it's all in-memory.
- Legal: risk disclaimers, ToS, and a jurisdiction-specific compliance
  check before charging anyone money for signals/copy trading.
