# Trading Roadmap

Real Trading v1 (`src/realTrading.ts`, `src/realTradingRoutes.ts`, `public/trade.html`) supports **Rise/Fall only** — a deliberate scope cut, not a technical ceiling. This doc sketches what each other Deriv contract type would need, for whoever picks this up next.

None of the field names below have been confirmed against Deriv's current REST+WS trading API in this codebase — same "documented, not yet verified live" status Rise/Fall itself carries until it's been tested against a real account (see README "Real Trading").

## Multipliers

Leveraged CFD-style contracts with no fixed expiry — you close them yourself, and losses can compound with the leverage rather than being capped at the stake the way Rise/Fall's fixed payout is.

- **Proposal/buy changes**: add `multiplier` to the request; optional `stop_loss`/`take_profit` params. No `duration`/`duration_unit` — these contracts don't expire on a timer.
- **UI changes**: no duration selector; needs a live running P&L display and an explicit "Close" action (there's no natural end state the way a Rise/Fall contract settles itself).
- **Risk/compliance**: materially higher than Rise/Fall — the account can lose more than the initial stake without a stop-loss set. This alone likely needs its own, stronger risk disclosure and probably its own confirmation flow, not a copy of Rise/Fall's.

## Touch / No Touch

Pays out if the price does (or doesn't) touch a barrier level before expiry.

- **Proposal/buy changes**: add a `barrier` param (a price level, often expressed relative to current spot, e.g. `+0.5`) alongside the existing direction/duration fields.
- **UI changes**: needs a barrier-price input. Natural reuse point: overlay a horizontal line on the live line chart Real Trading v1 already draws, so the barrier is visually obvious relative to the live price.
- **Risk/compliance**: same general bar as Rise/Fall (fixed payout, capped loss at stake) — smaller lift than Multipliers.

## Higher / Lower

Similar to Rise/Fall, but against an explicit barrier rather than "above/below the spot price at purchase time."

- **Proposal/buy changes**: smallest of this list — same shape as Rise/Fall's proposal/buy plus a `barrier` field.
- **UI changes**: one added barrier input; could reuse most of Real Trading v1's existing form and route logic directly.
- **Risk/compliance**: same bar as Rise/Fall.

## Accumulators

No fixed duration and no barrier — payout grows each tick the price stays within a implicit range, and the contract knocks out (payout resets) if it moves outside that range.

- **Proposal/buy changes**: different request shape entirely — no `duration`, no `barrier`; likely a `growth_rate` param instead. Needs its own response-parsing logic, not a variant of Rise/Fall's.
- **UI changes**: needs live "how much would this be worth if I sold right now" tracking and a manual "cash out" action — closer to Multipliers' UI needs than Rise/Fall's.
- **Risk/compliance**: the most different from Rise/Fall of anything here — effectively deserves its own feature design pass rather than being bolted onto the existing Real Trading page.

## Rise/Fall improvements, found by comparing against Deriv's own App Builder templates

Deriv's own no-code app builder (`developers.deriv.com/dashboard/builder/`) ships a Rise/Fall template built against their real API, which surfaced two gaps in v1 worth closing before considering Rise/Fall "done" (both are deferred, not scope-cut for a good reason the way the contract types above are — just bigger than pure visual polish, so held until the base flow is confirmed working live):

- **Streaming proposal, not one-shot**: Deriv's template shows the current payout live on the Buy button itself, continuously updating ("Buy / Payout 19.53 USD"), which means their `proposal` request is used with `subscribe: 1` and kept open, not a single request/response the way `POST /api/real-trading/proposal` does it now (confirmed directly in their `packages/core/src/react/useProposal.ts`). Matching this means keeping a subscription alive for as long as the trade form is open (re-rendering the button on every update) rather than a per-click fetch — a real architecture change to `derivAuthClient.ts`'s usage in `realTradingRoutes.ts`, not just a frontend tweak.
- **"Allow equals" variant**: Deriv's Rise/Fall template has a toggle for "Rise/Fall" vs. "Rise/Fall or equal" — confirmed directly in their `hooks/use-rise-fall-trading.ts`: `contractType: allowEquals ? \`${direction}E\` : direction`, i.e. `CALLE`/`PUTE` instead of plain `CALL`/`PUT`. `src/realTrading.ts`'s `contractTypeForDirection` would need a second parameter for this; not built.

## Suggested order

Higher/Lower first (smallest addition to what already exists) → Touch/No Touch (reuses the chart for barrier visualization) → Multipliers and Accumulators last, since both need a genuinely different UI shape (no-expiry, live P&L) rather than an extension of the existing proposal-then-buy flow.
