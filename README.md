# Statto Sweepstake

Pick a real football match, invite your mates, and the app deals everyone a random, evenly-balanced set of players
(starters spread across defence / midfield / attack, plus a sub, split across both teams). Goals, cards, assists etc.
score points live, and side prizes (first scorer, first booking, most scorers, most bookings...) are tracked too.

Live at **https://stattosweepstake.cobaltpinksoftware.com** (same look, login and Neon stack as MyTeamCompanion).

## Stack
| Part | What |
| --- | --- |
| Frontend | Static site in `public/` (no build step) - Manrope/Inter, light/dark theme, app colours |
| Login | Neon Auth (Managed Better Auth): email + password, Google, or **play as guest** (name only) |
| Database | Neon Postgres project `stattosweepstake`, accessed through the Neon Data API with row-level security (`db/schema.sql`) |
| Football data | `functions/api/football.js` (Cloudflare Pages Function) - the only place the API-Football key lives |
| Hosting | Cloudflare Pages, auto-deploys from this repo |

## How the free API-Football plan is protected
100 calls/day on the free plan, so the function caches everything in Neon and shares it between all friends:
fixtures by date (30 min - 3 h), squads (24 h), line-ups (10 min), match state (2 min live, 30 min pre-match, kept
once finished). A whole match costs about 55 calls, with a hard stop at 95/day. The free plan can't query by season,
so fixtures are listed by date. Squads are used for the draw until line-ups are announced (about 1h before kick-off);
the host can reopen and redraw then.

## Deploy (Cloudflare Pages)
1. Pages > Create > Connect to Git > `73bobster/StattoSweepstake`. Build command: none. Build output directory: `public`.
2. Settings > Variables and Secrets (Production): add **secrets** `DATABASE_URL` (Neon connection string) and
   `API_FOOTBALL_KEY`. `NEON_JWKS_URL` comes from `wrangler.toml`.
3. Custom domains: `stattosweepstake.cobaltpinksoftware.com`.
4. Neon: Auth > trusted origins must include that URL; Data API CORS must allow it (already set).

## Run locally
`cd public && python3 -m http.server 8000` - with `neonUrl` blanked in `public/config.js` it runs in demo mode
(one browser, simulated match). Tests: `node test/engine.test.mjs && node test/function.test.mjs`.

## Layout
`public/js/draw.js` balanced random draw - `public/js/scoring.js` points and prizes - `public/js/api.js` Neon and demo
backends - `public/js/app.js` screens - `db/schema.sql` tables, RLS and RPC functions - `functions/` server code.
