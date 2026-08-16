# traderpro

Deriv third-party trading app. Scaffold stage: live market-data feed +
Deriv OAuth login. Planned build order: **signals &rarr; copy trading &rarr;
no-code bot builder**.

## What's here

- `src/derivClient.ts` &mdash; thin wrapper around Deriv's WebSocket API
  (`wss://ws.derivws.com/websockets/v3`): request/response matching via
  `req_id`, ping keepalive, and an event emitter for streamed messages
  (ticks, etc).
- `src/server.ts` &mdash; Express server. Connects to Deriv on boot, subscribes
  to ticks for `R_100`, and relays them to the browser over SSE at
  `/api/stream`. Also serves `/api/config` (app_id + OAuth URL) to the
  frontend.
- `public/` &mdash; static frontend: live tick display, and a "Log in with
  Deriv" button that walks through Deriv's OAuth redirect flow.

## Setup

1. Register your own app (don't ship on the shared demo `app_id`):
   - Go to the [Deriv API dashboard](https://developers.deriv.com) → log in
     with a Deriv account → **Register application**.
   - Set the app's **Redirect URL** to match `OAUTH_REDIRECT_URL` below
     exactly (e.g. `http://localhost:3000/redirect.html` for local dev).
   - Copy the resulting `app_id`.

2. Copy the env file and fill in your app_id:
   ```
   cp .env.example .env
   ```

3. Install and run:
   ```
   npm install
   npm run dev
   ```

4. Open http://localhost:3000 — you should see live R_100 ticks
   immediately (public data, no login needed), and can test the OAuth
   button once your app_id/redirect URL are set.

## How the OAuth flow works here

Deriv uses a simplified redirect flow, not full OAuth2 code exchange:

1. Frontend sends the user to `https://oauth.deriv.com/oauth2/authorize?app_id=...`.
2. User logs in / approves on Deriv's site.
3. Deriv redirects back to your registered Redirect URL with query params
   `acct1`, `token1`, `cur1` (and `acct2`/`token2`/... if the user has
   multiple accounts, e.g. demo + real).
4. `public/redirect.html` picks up those params and stores them, then
   bounces back to `/`.

This demo stores the token in `localStorage` for simplicity. **Before
handling real user funds**, move token storage/handling server-side —
never let a long-lived account token sit in the browser for a production
app.

## Next steps (not built yet)

- Send the token to the backend and call `authorize` on a per-user
  `DerivClient` connection (rather than trusting the browser).
- Signals: pick a strategy trigger, push it to subscribers (email/push/
  webhook) — no live account access required for this piece.
- Copy trading: listen for a "leader" account's transaction stream and
  replicate trades onto follower accounts' authorized connections, with
  per-follower risk limits.
- Persistence (users, subscriptions, leader/follower config) — nothing
  here is stored anywhere yet, it's all in-memory/localStorage.
- Legal: risk disclaimers, ToS, and a jurisdiction-specific compliance
  check before charging anyone money for signals/copy trading.
