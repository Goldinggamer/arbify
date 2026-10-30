# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Arbify is a local pre-match arbitrage scanner for 16 German-licensed bookmakers: a Node backend (`server/`) that scrapes odds via the bookmakers' internal JSON/WebSocket endpoints, plus a React/Vite/Tailwind frontend (`src/`). All prose — code comments, README, commit messages — is in **German**; keep it that way. `README.md` is a short overview (keep it readable in ~3 minutes). The design rationale lives in `docs/`: `datenbeschaffung.md` covers transports, rate limits and cycles; `matching-und-maerkte.md` covers matching and the market model; `schutzschranken.md` covers guards, warnings, time window and tax; `meldungen.md` covers phone alerts. Check those before changing behaviour they describe, and update them when you change it.

## Commands

TypeScript runs directly through Node's type stripping (`node file.ts`). There is no build step for the server and no `tsx`/`ts-node`. That is why imports carry explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`): use `import type` for type-only imports.

```bash
npm run dev          # backend on :8787, waits for /api/health, then Vite on :5173 (scripts/dev.ts)
API_PORT=9000 npm run dev   # different backend port; Vite proxy follows
npm run scan         # backend only (server/index.ts)
npm run dev:web      # frontend only — shows demo data (src/data/mock.ts) when no backend is running
npm run scan:once    # one scan, printed to the console, no server
npm run build        # tsc -b (typecheck) + vite build
npm test             # node:test over server/**/*.test.ts and src/**/*.test.ts, no network
node --test server/match.test.ts                    # single test file
node --test --test-name-pattern="…" server/match.test.ts   # single test
node scripts/variance.ts      # three full sweeps back to back, to measure spread
node scripts/check-links.ts   # check every adapter's deep links against the live sites
```

There is no linter. `npm run build` is the typecheck.

Server env vars: `PORT`, `DISCOVERY_INTERVAL_MS`, `REFRESH_INTERVAL_MS`, `WINDOW_HOURS`, `MAX_EVENTS`, `MIN_PERCENT`, `MAX_DEPTH_EVENTS`, `MAX_HOT_EVENTS`, `HOT_THRESHOLD`. Phone alert config is stored in `.arbify-alerts.json` (gitignored).

## Architecture

**Pipeline:** adapters → `match.ts` → `scan.ts` → snapshot in `store.ts` → HTTP API in `server/index.ts` → frontend via `src/lib/api.ts`.

- **Adapters (`server/adapters/`)** implement `BookmakerAdapter` (`types.ts`). There is one adapter per *platform*, not per brand: `bwin.ts` covers bwin, Sportingbet and ODDSET, and `kambi.ts` covers LeoVegas. `index.ts` is the registry of active adapters. `sport888` (Italian 888) is built but deliberately left out because its bets can't be placed from Germany. An adapter's `id` must match `src/data/bookmakers.ts`.
- **Two stages per adapter:** `fetchEvents` is the cheap sweep (all events, main markets only). The optional `fetchDepth` fetches the full markets, but only for events that at least two books offer. The depth budget is split per sport in `store.ts` (`allocateDepth`), and `depthSports` limits which sports get depth. If a depth fetch fails, the adapter returns the sweep state.
- **Two scheduler cycles (`store.ts`):** discovery (default 60 s: full sweep, matching, depth) and refresh (default 10 s: re-fetches only "hot" events). `/api/scan` waits for any running scan and then starts a fresh one; it never returns a stale snapshot.
- **Transports:**
  - `server/http.ts`: HTTP, optionally with Chrome TLS impersonation via `impit` (Betano's Cloudflare checks JA3/JA4). Rate limits are set per host in `HOST_POLICIES`, not per caller. On a 429 or 403 the host is throttled adaptively, and blocks expire after a while.
  - `server/ws.ts`: JSON-RPC over WebSocket (VBET).
  - `server/livedoc.ts`: SockJS + STOMP + JSON-Patch (DAZN Bet/OpenBet).
  - `server/aswgateway.ts`: deflate-packed JSON entity store (AdmiralBet).
  - These use the `ws` library rather than Node's built-in WebSocket on purpose: it can set the `Origin` header, and it lets one-off scripts exit.
- **Canonical market model (`server/types.ts`):** every adapter translates its markets into a type, period, home-perspective line, side and optional `subject`. `marketKey()` is the only basis for comparing two quotes. **Unknown markets are dropped, never guessed:** a mis-mapped market creates phantom arbs, while a missing one only costs an opportunity. The exclusion lists in the adapters are deliberate and usually longer than the positive lists. Every label in `server/adapters/markets.test.ts` was measured against the real endpoint, and each test pairs a mapping with a neighbouring market that must *not* map the same way. Follow that pattern when you add mappings.
- **Matching (`server/match.ts`)** runs in two passes:
  1. An exact join on the Sportradar ID.
  2. Sources without an ID (the majority) attach to existing groups by normalized team tokens plus kickoff time (±20 min). The similarity threshold of 0.75 applies to each team separately, not to the sum.
  - Books disagree about which team is home. Every source is aligned to an anchor source: HOME and AWAY are swapped, handicap lines negated, and team totals reassigned. If the orientation is unclear, the source is dropped.
- **Arbitrage search (`server/scan.ts`):**
  - Live matches are not evaluated at all; this is pre-match only.
  - A market counts only if all of its sides are present, and the best odds must come from at least two different books.
  - An implied sum below 75 % is rejected as a data error (`rejectedAsImplausible`). Between 75 % and 90 % the find is kept but carries the warning `implausible-high`.
  - Other issues are attached as warnings (`src/data/warnings.ts`) rather than filtered out: stale odds, betting tax (`src/data/tax.ts`), short lead time.
- **`/api/diagnostics`** is the main debugging tool. It shows host load, unmapped and rejected markets, alignment fixes and `marketKeyCollisions`. A collision means one book produced two odds for the same side of the same key, so two different markets landed on one key.
- **Shared code:** the server imports from `src/` (`src/lib/filter.ts`, `arbitrage.ts`, `window.ts`, `src/data/*`, `src/types.ts`). Server-side phone alerts (`server/alerts.ts` → `notify.ts`, ntfy etc.) run the same `applyFilters` that the UI uses, so keep these `src/` modules free of browser-only code.
- **Calculation core (`src/lib/arbitrage.ts`):** the stake for each leg is proportional to 1/odds. Betting tax and stake limits are intentionally *not* part of the calculation. Rounding to whole amounts is applied afterwards, and the UI shows both the achieved and the theoretical return.
- The default time window is 24 h (`src/lib/window.ts`). It was shortened from a week because far-out high returns were mostly odds errors that the bookmaker later voids.
