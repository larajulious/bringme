# BringMe! Supabase Performance & Scalability Audit

_Audit date: 2026-11-13. Scope: the repository at `~/Development/bringme` (commit `9f60066`), plus the Supabase memory metrics the owner supplied. This was a read-only audit: no application code, migration, environment variable or infrastructure setting was changed, and nothing was run against the hosted project._

## How to read this report

Every claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[Code]** | Verified by reading the source in this repository. |
| **[Reproduced]** | Shown by running the repository's own migrations on a throwaway **local** PostgreSQL. Production was never touched. |
| **[Estimate]** | Derived from code paths with a stated model. Not measured. |
| **[Assumption]** | Believed likely, not verified. |
| **[Unverified]** | Cannot be established from the codebase. Needs dashboard data, logs or SQL (see section I). |

**Important caveat:** `PROJECT_STATUS.md` and `supabase/README.md` say several migrations (for example BingoSnap 17–21 and disposable-email 29–30) were "not yet applied to the hosted DB" when those notes were written. **[Unverified]** I cannot tell which migrations the production database actually runs. Findings describe what the repository would deploy. Section I includes a query to check this.

---

## A. Executive Summary

**Overall:** the architecture is sound and deliberately designed. PostgreSQL is the single source of truth. All game rules live in `SECURITY DEFINER` functions with row locks and optimistic versioning. Clients receive small Realtime **Broadcast** "something changed" hints on private channels and re-read an authoritative snapshot. The Next.js server never opens direct Postgres connections; everything goes over HTTP through PostgREST, so serverless connection exhaustion is not a risk. Indexes cover the hot lookups, and RLS policies already use `(select auth.uid())`.

**The biggest concerns, in order:**

1. **A reproducible deadlock when several players finish a photo at the same time** **[Code] [Reproduced]**. `complete_submission()` takes a `FOR SHARE` lock on the game row and then `UPDATE`s that same row (through `bump_game_version`). Two players in the same game doing this at once deadlock. On a local PostgreSQL running the repo's migrations, 2, 10 and 30 truly simultaneous completions in one game gave **1 success and 1, 9 and 29 `40P01 deadlock detected` errors**. Wall time was about 1 s, 9 s and 29 s, because each deadlock takes `deadlock_timeout` (1 s) to resolve. While it lasts, PostgREST connections are held for seconds, which can delay **every** game on the project, and players may run into the 45 s capture-expiry window.
2. **O(N²) re-read fan-out per game** **[Code] [Estimate]**. Every visible change bumps `games.state_version` and broadcasts to **everyone** in the game, and every client then re-reads its snapshot. That includes each join, each photo submission and each host review decision. One 50-player round produces roughly **105 broadcasts × ~58 re-reads ≈ 6,000+ database calls**, and the host and presenter screens also re-sign all photo URLs on every change.
3. **Realtime capacity and fallback** **[Unverified]**. Every player, host console and presenter tab holds one WebSocket. If guest Realtime tokens are rejected (the HS256 legacy-secret risk already noted in `PRODUCTION_READINESS.md`), or the plan's concurrent-connection quota is exceeded, clients silently fall back to **polling every 4 s**, which multiplies database reads. Connections also stay open after a game finishes.
4. **No data retention** **[Code]**. `platform_settings.photo_retention_days` exists but nothing enforces it. Photos, players, submissions and intents are kept forever.

**The memory warning:** the supplied numbers point to a ~0.5 GB compute instance **[Assumption: Nano/Free-size]**. On instances that small, Postgres plus Supabase's co-located services usually account for most of the RAM at idle. Nothing in the codebase points to a steady-state memory leak in the database: the data volume is tiny and there are no long-running queries or `LISTEN`/Postgres Changes subscriptions. The code patterns above can cause **peak** pressure (connection pile-ups during deadlocks, bursts of concurrent requests). Proving a cause needs the diagnostics in section I.

**Recommendation:** fix the deadlock and reduce fan-out **before** upgrading. Then measure. Be aware that Realtime connection quotas, not database CPU or RAM, may be what forces a plan change for larger events.

---

## B. Current Architecture

### B.1 Verified stack **[Code]**

| Layer | Finding | Evidence |
|---|---|---|
| Framework | Next.js **16.4.6** installed (`"next": "latest"` in `package.json`), App Router, `cacheComponents: true`, `proxy.ts` (Next 16 replacement for middleware) | `node_modules/next/package.json`, `next.config.ts`, `proxy.ts` |
| Hosting | **[Assumption] Vercel.** No `vercel.json`, but the code reads `VERCEL_ENV`, `VERCEL_URL` and `VERCEL_PROJECT_PRODUCTION_URL` | `lib/site/url.ts:22`, `lib/billing/config.ts:42-44` |
| Supabase SDK | `@supabase/supabase-js` 2.119.0, `@supabase/ssr` 0.12.7, `realtime-js` 2.119.0 (all `"latest"`, unpinned) | `node_modules/*/package.json` |
| Server client | `createServerClient` per request with cookies | `lib/supabase/server.ts` |
| Browser client | `createBrowserClient` (publishable key) | `lib/supabase/client.ts` |
| Privileged client | `createClient(url, SECRET_KEY)` per call, `server-only` | `lib/supabase/admin.ts` |
| DB access path | Only through **PostgREST/Storage/Auth HTTP APIs**. No `pg` driver or direct connection in app code (`pg`/`embedded-postgres` are used only by an opt-in test) | grep of `lib/`, `app/` |
| Realtime | **Broadcast only**, private channel `game:<uuid>`, sent from SQL via `realtime.send()`. No Postgres Changes, no Presence | `supabase/migrations/20261111000009_game_engine.sql:45-56, 473-491`, `components/game/use-game-sync.ts:127` |
| Payments | Polar (checkout API + Standard Webhooks) into a ledger of passes in Postgres | `app/api/billing/*`, `app/api/webhooks/polar/route.ts`, migrations `20261112000003–14` |
| Photos (Bring Me) | Private Storage bucket `submissions`, direct browser upload to a signed upload URL | `app/api/play/submissions/begin/route.ts`, `lib/game/upload.ts` |
| Photos (BingoSnap) | Kept **only in the phone's IndexedDB**. The server stores claimed cell IDs only | `lib/photos/store.ts` |

### B.2 Authentication and sessions **[Code]**

- **Hosts and admins:** passwordless email OTP through Supabase Auth, with a cookie session. `proxy.ts` → `updateSession()` calls `supabase.auth.getClaims()` on **every matched request** (`lib/supabase/proxy.ts:47`). Route handlers call it again in `requireUser()` (`lib/auth/guards.ts:15`). The role is read from `public.profiles`, never from JWT metadata.
  - **[Unverified, conditional]** `getClaims()` verifies locally only when the project uses **asymmetric** JWT signing keys. On a legacy **HS256** project it falls back to `getUser()`, which is a network call to Supabase Auth and a query against the `auth` schema. In that case, every host page or API request through Next costs **two Auth round trips**. The app also signs guest tokens with `SUPABASE_JWT_SECRET` (legacy HS256), which suggests the project still uses, or at least accepts, the legacy secret. Check Dashboard → Project Settings → JWT Keys.
- **Players (guests):** no Supabase account. `join_game()` stores only `sha256(token)`, and the raw 256-bit token lives in an HttpOnly cookie `bm_player` for 12 h (`lib/players/session.ts`). Every guest API resolves the player by `players.token_hash` (unique index) with the **service-role** client.
- **Guest Realtime:** `/api/play/realtime-token` mints a 1-hour HS256 JWT (`role: anon`, `kind: guest`, `game_id`) with the legacy JWT secret (`lib/game/guest-token.ts`, `lib/game/jwt.ts`). The `realtime.messages` select policy authorizes it through `can_listen_game_topic()`.

### B.3 How hosts create and run a game **[Code]**

1. `POST /api/host/games` → `create_game_with_rounds()` (runs as the caller; triggers enforce the Game Pass, active-game cap, per-period cap and room capacity = pass cap).
2. The host page `app/dashboard/games/[id]/page.tsx` server-renders with 4 parallel queries: `games`, `host_game_state`, `players`, `game_rounds`.
3. Every control goes through `POST /api/host/games/[id]/transition` → `game_transition()`. That function takes `SELECT … FOR UPDATE` on the game, checks `p_expected_version` (stale requests get 409), changes phase, bumps `state_version` and broadcasts.
4. The host console (`components/game/host-console.tsx`) and the presenter tab (`app/present/[id]` → `components/game/presenter-screen.tsx`) each run `useGameSync` (1 WebSocket each) and re-read on every version change (see D.3).

### B.4 How players join with a QR code **[Code]**

The QR encodes `/join/<CODE>`. Per joining player, in order:

| # | Request | DB work |
|---|---|---|
| 1 | `GET /join/CODE` (server component) | `bingo_room_info` RPC, plus `player_game_state` if a cookie exists, plus `public_room_info`: **2–3 RPCs** |
| 2 | `POST /api/play/join` | `join_game()`: game lookup → `INSERT players` → trigger `enforce_player_insert` (**`FOR UPDATE` on the game row**, `count(*)` players, `game_capacity()` → recursive `pass_entitlement()`) → trigger `players_bump_version` (`UPDATE games` + `realtime.send` = an `INSERT` into `realtime.messages`) |
| 3 | Redirect `GET /join/CODE/lobby` | `bingo_room_info` + `player_game_state`: **2 RPCs** |
| 4 | Client mount (`useGameSync`) | initial `GET /api/play/state` (1 snapshot), `GET /api/play/realtime-token` (**another full snapshot**, used only to read the player's identity), WebSocket join (Realtime evaluates the RLS policy), then on `SUBSCRIBED` another `resync()` (may coalesce) |

**≈ 8–9 database round trips per joining player [Code count]**, plus the **fan-out**: the join's broadcast makes every player already in the lobby, the host lobby (`host_game_state` + `fetchRoster`) and the presenter re-read.

### B.5 Game state synchronisation **[Code]**

`components/game/use-game-sync.ts` + `lib/game/sync.ts`:

- The DB snapshot is authoritative. The broadcast payload (`{version, phase}`) is only a hint.
- `GameSyncCore.handleSignal()` drops a hint whose version is not newer. Otherwise it calls `resync()`, which keeps at most **one fetch in flight and one queued** per client (coalescing).
- Extra re-reads: on reconnect (`SUBSCRIBED`), window `focus`, `visibilitychange`, `online`, at `countdownEndsAt` and `round.openedAt` (+60 ms, `use-game-sync.ts:183`), and at the BingoSnap hunt deadline (+60 ms and +2.2 s).
- **Safety net:** every **30 s** while subscribed and visible (`:172`).
- **Fallback:** if Realtime is down, every **4 s** after a 6 s grace (`:176`).
- **Clock-sync burst:** at each countdown, players fetch the snapshot **4 more times**, 150 ms apart (`syncBurst`, `:77`; called from `components/game/player-game.tsx`).

### B.6 Photo submissions (Bring Me) **[Code]**

1. Tap → `POST /api/play/submissions/begin` → `begin_submission()` (players row `FOR UPDATE`, games row `FOR SHARE`, insert `submission_intents`) → Storage `remove(path)` + `createSignedUploadUrl(path)`: **1 RPC + 2 Storage API calls**.
2. The browser `PUT`s the JPEG straight to Storage.
3. `POST /api/play/submissions/complete` → `getPlayerState()` (**full snapshot**), Storage `info(path)`, `SELECT platform_settings`, Storage **`download(path)` of the whole photo into the Vercel function** just to check 3 signature bytes (`lib/players/photo-check.ts:29`), then `complete_submission()` → `INSERT submissions` → `bump_game_version()` → broadcast. That is **≈ 3 DB calls + 2 Storage calls + a full photo download**.
4. Every broadcast makes all N players re-read. The host console and presenter re-fetch `/api/host/games/[id]/submissions`, which runs `host_game_state` + `round_ranking` + **`createSignedUrls` for every photo in the round** (`app/api/host/games/[id]/submissions/route.ts:28`).
5. Each host review (`review_submission`) bumps and broadcasts again.

### B.7 BingoSnap claims **[Code]**

- Photos never leave the device. `POST /api/play/bingosnap/claim` → `bingo_submit_claim()`: games row `FOR UPDATE` (serialised, **no deadlock pattern**), pattern check, insert `bingo_submissions`, `bump_game_version()` → broadcast.
- Snapshots: `bingo_player_state` → `bingo_state_json(..., 'player')`, which calls `public.game_capacity(g.id)` **on every read** (`20261112000018_bingosnap_functions.sql:150`), and that runs the recursive `pass_entitlement()` CTE. It also builds the player's shuffled layout (`bingo_layout`, ≤ 25 cells, cheap).
- Host snapshot `bingo_host_state` returns all players and all claims, with per-claim cell lookups. That is fine at ≤ 100 players.
- The hunt timer is evaluated lazily from DB timestamps (no cron).

### B.8 Polar payments and Game Passes **[Code]**

- Checkout: `POST /api/billing/checkout` → `start_checkout_order` (idempotent, profile row `FOR UPDATE`) → Polar API → `attach_verified_checkout`.
- The return page polls `/api/billing/checkout/status` every 3 s (every 10 s after 90 s) (`components/subscription/checkout-status.tsx`). Polar's answer is reused for 10 s through an **in-memory** throttle (per serverless instance, so not global). Each poll runs the `my_checkout_status` RPC.
- Webhook `POST /api/webhooks/polar` → signature check → `apply_payment_event()` (idempotent through `payment_events`; order + profile `FOR UPDATE`) → `grant_pass`/`revoke_pass` → `pass_segments` ledger → `sync_lobby_capacity`, which may bump open lobbies.
- Entitlement is computed by time (`pass_entitlement()`) and enforced by triggers on game insert/update and player insert.
- **This is low-volume traffic and not a scaling concern.**

### B.9 End-to-end flow: player joins → game finishes **[Code]**

```
QR scan ─► GET /join/CODE ─(2–3 RPC)─► POST /api/play/join ─► join_game()
   │                                         └─ trigger: lock game, count, capacity, UPDATE games.state_version, realtime.send
   │                                                   └─► Broadcast "state" ─► every client in game re-reads (N reads)
   ▼
GET /join/CODE/lobby (2 RPC) ─► client: /api/play/state + /api/play/realtime-token (+snapshot) + WS join + resync
   ▼
Host: start_game → start_countdown → start_round   (3 transitions → 3 broadcasts → 3×N re-reads)
   │   players: syncBurst = 4 extra snapshot reads each; boundary re-reads at countdown end and round open
   ▼
Each player: begin (1 RPC + 2 Storage) ─► PUT photo to Storage ─► complete (3 DB + 2 Storage + download)
   │   each complete: UPDATE games + broadcast ─► N player re-reads + host/presenter re-fetch ranked list + re-sign ALL photos
   ▼
Host: close_submissions ─► review × N (each: UPDATE submissions + bump + broadcast ─► N re-reads)
   ─► announce winner (broadcast; players fetch /api/play/winner-photo → signed URL)
   ─► next round … ─► finish (broadcast; snapshots now embed results)
   ▼
After finish: bump_game_version() is a no-op for closed games, BUT clients keep their WebSocket open and keep the
30 s safety re-read while the tab is visible (useGameSync stays mounted on the results screens).
```

---

## C. Database Findings

### C.1 Tables and relationships **[Code]**

Core: `profiles` (1:1 `auth.users`), `games` (owner → profiles), `game_rounds`, `players`, `submission_intents`, `submissions` (composite FKs `(round_id, game_id)` and `(player_id, game_id)`, so a row can never cross games). BingoSnap: `bingo_games` (1:1 games), `bingo_cells`, `bingo_submissions`. Billing: `subscription_plans`, `plan_prices`, `game_passes`, `pass_segments` (`btree_gist` exclusion, no overlap), `entitlement_events` (append-only), `pass_orders`, `payment_events`, `plan_polar_state`, `plan_sync_jobs`, `admin_audit_events`. Other: `platform_settings`, `snappy_counter` (single row), `disposable_email_domains` (~10,181 rows), `disposable_email_allowlist`, `disposable_email_list_versions`, and the legacy `subscriptions` (frozen).

### C.2 Indexes **[Code]**

Hot paths are covered:

| Lookup | Index |
|---|---|
| `players.token_hash` (every guest request) | `UNIQUE` |
| `games.join_code` | `UNIQUE` |
| players by game | `players_game_idx`, `players_nickname_per_game` |
| submissions by round | `UNIQUE (round_id, player_id)` (leading column) |
| submissions by game, by player | `submissions_game_idx`, `submissions_player_idx` |
| intents | `UNIQUE (round_id, player_id)` |
| rounds by game, one open round | `game_rounds_game_idx`, partial unique `game_rounds_one_open_per_game` |
| bingo submissions by player / game | `UNIQUE (player_id, attempt_no)`, `bingo_submissions_game_idx`, partial unique `bingo_submissions_one_open` |
| passes and segments by user | `game_passes_user_idx`, `pass_segments_user_idx (user_id, starts_at)` |

**FK columns with no supporting index [Code, Low impact]:** `games.current_round_id`, `games.winner_player_id`, `game_rounds.winner_player_id`, `game_rounds.winner_submission_id`, `bingo_submissions.validated_by`, `game_passes.granted_by`, `plan_sync_jobs.created_by`, `admin_audit_events.admin_id`. These only cost anything when the referenced row is deleted (an `ON DELETE SET NULL` scan). Hosts cannot delete games (migration 12), so this is negligible today. It becomes relevant once a retention job starts deleting rows.

### C.3 Row Level Security **[Code]**

- `anon` has no table privileges. Guests are served only by service-role handlers (RLS bypassed, scoped by the token hash inside SQL).
- Owner policies on `games` use `owner_id = (select auth.uid())` (initplan-cached, good). Child tables use `public.owns_game(game_id)`, a `SECURITY DEFINER` function called **per row** (one PK lookup each). Each table also has a second permissive policy `(select public.is_super_admin())`, so both are evaluated. At ≤ 100 rows per game this costs a fraction of a millisecond. **Not a bottleneck at current scale.**
- Storage read policy: `owns_game_path(name)` per object (regex + games lookup). This is evaluated for every object in every `createSignedUrls` call, which multiplies the cost of the O(N²) re-signing in D.3.
- Realtime policy: `can_listen_game_topic()` is evaluated when a channel is joined (and on token refresh), not per message.

### C.4 Query patterns, repeated and unnecessary queries **[Code]**

| # | Pattern | Where | Impact |
|---|---|---|---|
| Q1 | Every version bump → **all** players re-read the full snapshot, even when only host-relevant data changed (submissions, reviews) | `bump_game_version()` callers; `lib/game/sync.ts handleSignal` | **High** (O(N²) per round) |
| Q2 | Host console re-fetches **roster** (`fetchRoster`) and **rounds** (`fetchRounds`) on **every** version change, even though neither changes during submissions or reviews | `components/game/host-console.tsx:83, 90`; `lobby-view.tsx:54` | Medium |
| Q3 | Host console and presenter re-fetch the ranked list **and re-sign every photo URL** on every version change | `app/api/host/games/[id]/submissions/route.ts:28`; `host-console.tsx`; `presenter-screen.tsx:52` | **High** (O(N²) Storage signing + storage RLS per round) |
| Q4 | `/api/play/realtime-token` computes the **full** `player_game_state` only to read `me.id` and `gameId` | `app/api/play/realtime-token/route.ts` | Low |
| Q5 | `/api/play/submissions/complete` computes the full snapshot, reads `platform_settings` and **downloads the whole photo** to check 3 bytes | `app/api/play/submissions/complete/route.ts`; `lib/players/photo-check.ts:29` | Medium (function memory and egress; Storage load) |
| Q6 | `syncBurst`: 4 full snapshot reads per player at every countdown, used only as a clock sample | `use-game-sync.ts:77`; `player-game.tsx` | Medium (4N reads per round) |
| Q7 | All clients re-read at exactly `countdownEndsAt + 60 ms` and `openedAt + 60 ms`: a synchronised spike of N reads per game | `use-game-sync.ts:183` | Medium (spiky; needed for the prompt reveal) |
| Q8 | `player_game_state` on a finished game computes `game_results_json` **twice** (once inside `game_state_json`, then again with `p_player`) | `20261111000011_review_winners.sql:315, 318` (body re-created in `20261112000026`) | Low |
| Q9 | BingoSnap snapshot calls `game_capacity()` → recursive `pass_entitlement()` on **every** read | `20261112000018_bingosnap_functions.sql:150` | Low–Medium |
| Q10 | Join page runs `bingo_room_info` **and** `public_room_info`/`player_game_state` (2–3 RPCs), and the lobby page repeats 2 | `app/join/[code]/page.tsx`, `app/join/[code]/lobby/page.tsx` | Low |

**No classic N+1 loops** were found in TypeScript. Server pages use `Promise.all`, and lists are built inside SQL with `jsonb_agg`. The O(N²) patterns above are **fan-out** problems, not N+1 queries.

### C.5 Expensive joins and functions **[Code]**

None of the snapshot functions scan large tables. Each is a handful of indexed lookups and small aggregates bounded by one game's rows (≤ ~100 players × rounds). `round_ranking` uses window functions over ≤ 100 rows. `pass_entitlement()` is a recursive CTE over one user's segments (a few rows). **[Assumption]** Execution time per snapshot should be in the low milliseconds. Confirm with `pg_stat_statements` (section I).

### C.6 Locking and concurrency **[Code] [Reproduced]**

| Function | Locks | Result |
|---|---|---|
| `game_transition`, `review_submission`, `bingo_transition`, `bingo_submit_claim`, `replay_round`, `add_game_round` | games row `FOR UPDATE` | Correctly serialised per game |
| `enforce_player_insert` (join) | games row `FOR UPDATE` | Joins to one game are serialised; that is intended for capacity |
| `begin_submission` | players `FOR UPDATE`, games **`FOR SHARE`** (no later update of games) | OK |
| **`complete_submission`** | players `FOR UPDATE`, games **`FOR SHARE`**, then **`UPDATE games`** in `bump_game_version` | **Lock-upgrade deadlock between different players of the same game** |

**Deadlock details.** `supabase/migrations/20261111000010_submissions_timing.sql`: `FOR SHARE` at line 180, `perform public.bump_game_version(p.game_id)` at line 237. Transaction A and transaction B both hold `FOR SHARE` on the same `games` row. A's `UPDATE` waits for B's share lock, and B's `UPDATE` waits for A's. PostgreSQL detects the cycle after `deadlock_timeout` (1 s by default) and aborts one transaction. The existing `tests/concurrency/engine-concurrency.mjs` only races the **same** player (serialised by the players lock), so it never hits this.

**Local reproduction** (embedded PostgreSQL, the repo's shim plus all migrations, N players each with a valid intent, all calling `complete_submission` at the same instant):

| Simultaneous completes (one game) | Succeeded | `40P01 deadlock detected` | Wall time |
|---:|---:|---:|---:|
| 2 | 1 | 1 | ~1.0 s |
| 10 | 1 | 9 | ~9.0 s |
| 30 | 1 | 29 | ~29 s |

Real players don't finish at exactly the same microsecond, so production will see fewer collisions than this worst case. A collision still only needs two completions whose transactions overlap, and a blocked transaction lengthens its own window, so collisions grow quickly with players per game. The failures surface as HTTP 500 `request_failed` (`lib/host/errors.ts`, because `40P01` is not mapped). The client retries automatically (500 ms, 1.5 s). The operation is idempotent, so the photo is usually accepted in the end, but each collision **holds a PostgREST connection and a Postgres backend for about a second**, and repeated collisions can push a capture past the 45 s `attempt_expired` limit. **[Unverified]** whether production logs already show `deadlock detected` (query in I.2).

### C.7 Connection handling and pooling **[Code]**

- Next.js never connects to Postgres directly. Each request creates a lightweight supabase-js client (no connection) and talks HTTP to PostgREST, Storage and Auth. This follows the CLAUDE.md rule and avoids serverless connection storms.
- Pooling is therefore **PostgREST's own pool**, whose size Supabase sets per compute size **[Unverified for this project]**. Any long-held transaction (deadlock waits, lock queues on a hot `games` row) consumes that shared pool, so **one busy game can slow every other game**.
- Hot-row contention: every join, submission, review and claim in a game updates the **same `games` row** (`state_version`). Writes to one game are therefore serialised (correct by design). At ~50 players this is fine once the deadlock is fixed. Each update also creates a dead tuple, but these are mostly HOT updates and autovacuum handles them.

### C.8 Triggers and functions with side effects **[Code]**

- `players_bump_version` (after insert/kick) → `UPDATE games` + `realtime.send` (an `INSERT` into the `realtime.messages` partitioned table).
- `enforce_*` triggers on games, rounds, players and submissions validate state, entitlement and capacity. The `games` update trigger calls `entitlement_for()` on lobby/live transitions.
- `on_auth_user_created` → profile; `on_auth_user_trial` → trial pass; `hook_before_user_created` → disposable-email check (exact/suffix match on an indexed text PK).
- No `pg_cron` jobs, no `LISTEN/NOTIFY`, no Postgres Changes publication.

### C.9 Data retention and cleanup **[Code]**

- **None implemented.** `platform_settings.photo_retention_days` (default 30, `20261111000006_admin_dashboard.sql:19`) is editable in the admin UI but not enforced. `PRODUCTION_READINESS.md` already lists this as open.
- Never deleted: `games`, `players`, `game_rounds`, `submissions`, **`submission_intents`** (kept after acceptance), `bingo_*`, Storage photos. `realtime.messages` is managed by Supabase Realtime (partitioned; **[Unverified]** retention window, query in I.6).
- **[Estimate]** Rough growth per finished game is ~1–2 KB per player per round including indexes and JSONB metadata. A 50-player, 5-round game is roughly 0.3–0.6 MB of table and index data plus 250 photos in Storage. On a plan with a 500 MB database cap (**[Unverified]**: confirm your plan's limit), on the order of 1,000 large games could reach it. Measure the real average with I.5.

### C.10 Long-running or inefficient operations **[Code]**

- No long-running SQL found. The longest planned operation is the one-time `20261112000030_disposable_email_seed.sql` (10k inserts).
- Deadlocked `complete_submission` calls are the only measured multi-second operations (C.6).
- `apply_disposable_email_list` rewrites the 10k-row table on list updates, which is rare and admin-triggered.

---

## D. Multiplayer Architecture

### D.1 What is used **[Code]**

| Mechanism | Used? | Notes |
|---|---|---|
| Supabase Realtime **Broadcast** | **Yes** | Private `game:<uuid>`, event `state`, payload `{version, phase}`, sent by SQL `realtime.send(..., private=true)` |
| Postgres Changes | No | Deliberately not used (`docs/SECURITY.md`) |
| Presence | No | |
| Polling | **Yes, as a safety net** | 30 s while subscribed and visible; **4 s** while Realtime is down; checkout status page 3 s / 10 s |
| Server-Sent Events | No | An earlier SSE stream was removed (`PRODUCTION_READINESS.md`) |
| Raw WebSockets | Only through supabase-js Realtime | One socket per mounted `useGameSync` |

### D.2 Efficiency of the current design

**Good:**
- Hint-only broadcasts are tiny and leak nothing.
- Versioning makes clients drop stale or duplicate hints.
- Fetches are coalesced per client.
- Channels are removed on unmount (`use-game-sync.ts:146`), and supabase-js disconnects when no channels remain.
- Guests cannot publish (no INSERT policy).

**Inefficient:**
1. **Hint → full re-read for everyone.** Each hint costs N snapshot reads, each a Vercel function invocation plus an RPC. Most hints during a round are host-only changes: a new submission, a review decision.
2. **Host and presenter also re-fetch side data** (roster, rounds, ranked submissions with fresh signed URLs) on every hint.
3. **Connections outlive the game.** `PlayerGame` (`player-game.tsx:68`) and `FinishedResults` (`finished-results.tsx:28`) keep `useGameSync` mounted on the finished screens, so the WebSocket stays open and the 30 s safety re-read continues while the tab is visible. Phones left open on the results screen still count against the concurrent-connection quota.
4. **Fallback amplification.** If Realtime fails for guests (HS256 token rejected, quota exceeded, network blocks WebSockets), every client polls every 4 s. That alone is N/4 snapshot reads per second per game, all the time.

### D.3 Per-round call model **[Estimate]**

Model: Bring Me, N players, 1 host console and 1 presenter tab, every player submits, the host reviews every submission. Per round there are about **2N + 5 broadcasts** (countdown, round open, N submissions, close, N reviews, winner, next).

Calls that reach the database per broadcast ≈ **N** (player snapshots) + **~5** (host: `host_game_state`, roster, rounds, submissions route = `host_game_state` + `round_ranking`) + **~3** (presenter: `host_game_state` + submissions route) = **N + 8**. On top of that come **Storage signing operations** for every photo in the round on each host and presenter re-fetch, plus per round: 4N (`syncBurst`), 2N (boundary re-reads), 3N (begin/complete RPCs) and 2N Storage calls on `begin`.

| N | Broadcasts/round | DB calls/round (upper bound, no coalescing) | Photo URL signings/round (host + presenter) | Realtime messages delivered/round (broadcasts × (N+2)) |
|---:|---:|---:|---:|---:|
| 10 | 25 | ~550 | ~400 | ~300 |
| 30 | 65 | ~2,700 | ~3,000 | ~2,100 |
| 50 | 105 | ~6,500 | ~8,000 | ~5,500 |

Coalescing (one in flight + one queued per client) lowers this when hints arrive faster than a client's round trip, mainly during the submission burst. Treat the table as an upper bound.

---

## E. Memory Assessment

### E.1 Interpreting the supplied metrics

| Metric | Value | Interpretation |
|---|---|---|
| Total RAM | 406.45 MB | Usable RAM of what looks like a **~0.5 GB instance** **[Assumption: Nano-class compute, usually the Free plan]** |
| Used RAM | 190.73 MB | Process memory (Postgres backends + shared memory, plus whatever Supabase services run on the same VM) |
| Cache + Buffers | 137.98 MB | Linux page cache. **Reclaimable**; Postgres relies on it for reads. Not "lost" memory |
| Total usage | 328.71 MB (80.9%) | Used + cache. High-looking, but on Linux a full page cache is normal |
| Swap | 309.54 MB used | At some point the working set did not fit in RAM and cold pages were swapped out. **Swap in use is not itself an emergency**; *swap activity* (pages in/out per second) is what hurts latency |
| Memory commitment | 1.21 GB of 1.4 GB | Linux `Committed_AS` vs `CommitLimit`: virtual memory processes have **reserved**, not used. As it nears the limit, new allocations (new backends, big sorts, service restarts) can fail with out-of-memory errors |
| Warning active | yes | You are ~86% of the commit limit. That is a real but narrow margin, not a measured incident |

### E.2 What likely drives it

1. **Baseline platform footprint [Assumption, most likely].** On a 0.5 GB instance, Postgres (`shared_buffers`, background workers, autovacuum) plus the Supabase services co-located on the database VM reserve most of the commit budget even with no traffic. Which services share the VM is a Supabase implementation detail **[Unverified]**. This explains a high but **steady** commitment that application changes cannot reduce much.
2. **Postgres backends per active connection [Code-informed]**. Each PostgREST, Auth, Storage and Realtime connection is a backend process with its own memory. The deadlock in C.6 and lock queues on a hot `games` row **hold connections open for seconds** during bursts, which raises peak backend memory and commitment exactly when a game is busiest.
3. **Burst concurrency from fan-out [Code-informed]**. Hundreds of near-simultaneous snapshot RPCs (D.3, Q7) raise PostgREST and Postgres working memory at peaks. Each query is small.
4. **Data size: not a factor today [Assumption].** The schema is small and bounded per game. The largest static table is ~10k disposable-email domains (well under a few MB).

### E.3 Codebase patterns checked for memory pressure

| Check | Result |
|---|---|
| Unreleased Realtime subscriptions | None found. Channels are removed on unmount, timers and listeners cleared (`use-game-sync.ts`). **But** sockets persist on finished-game screens (D.2 #3) |
| Duplicate subscriptions per page | One per mounted sync hook. A host with console + presenter = 2 sockets (by design). No page mounts two hooks for one game |
| Postgres Changes / logical replication slots | Not used by the app. **[Unverified]** whether any slot exists (I.3) |
| Long-running or idle-in-transaction queries | None in app code. Deadlocks are the exception (C.6) |
| Large result sets | None. Snapshots are bounded JSON; lists ≤ 50–100 rows |
| Repeated queries | Yes: fan-out (Q1–Q3, Q6, Q7). This drives CPU and connection churn more than RAM |
| Server-side memory (Vercel, not Supabase) | `complete` downloads each full photo into the function (Q5); snappy and checkout throttles are per-instance in-memory maps (small) |

### E.4 What cannot be established from code

Per-process memory on the database VM, current `shared_buffers`/`work_mem`/`max_connections`, connection counts over time, whether swap is actively paging, whether out-of-memory events or service restarts happened, `pg_stat_statements` totals, and whether production even runs the latest migrations. Section I lists how to collect each.

---

## F. Scalability Estimates

**Nothing below is measured. No load test was run, and the brief forbade one against production.** "Risk" is a judgement from the code paths.

### F.1 Model assumptions **[Assumption]**

- Bring Me games, 5 rounds, 60 s limit, ~150 s per round including review; every player submits and the host reviews every photo.
- Each game has 1 host console and 1 presenter tab (2 sockets). Players keep the tab visible.
- Worst case: **all games in the same phase at once.** Real events are staggered, so averages are more realistic than peaks.
- The submission burst: N completions within ~15 s.
- Realtime works. If it doesn't (fallback to 4 s polling), add **N/4 reads/s per game** continuously.
- Plan quotas quoted below are what Supabase **documented when last checked** **[Unverified: confirm on the current pricing and limits pages]**: Realtime concurrent connections ≈ **200 (Free) / 500 (Pro, adjustable)**; Realtime messages/s ≈ **100 (Free) / 500 (Pro)**; Free database size 500 MB.

### F.2 Scenario table **[Estimate]**

| Scenario | Games × players | Concurrent players | Realtime sockets (players + 2/game) | DB calls/s, round average | DB calls/s, submission-burst peak | DB writes/s, burst peak | Realtime msgs/s, burst | Photo signings/round (all games) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Small | 5 × 10 | 50 | 60 | ~18 | ~60 | ~15 | ~40 | ~2,000 |
| Medium | 10 × 30 | 300 | 320 | ~180 | ~760 | ~80 | ~640 | ~30,000 |
| Large | 20 × 50 | 1,000 | 1,040 | ~870 | ~3,900 | ~270 | ~3,500 | ~160,000 |
| High traffic | 50 × 50 | 2,500 | 2,600 | ~2,200 | ~9,700 | ~670 | ~8,700 | ~400,000 |
| Stress | 100 × 50 | 5,000 | 5,200 | ~4,300 | ~19,000 | ~1,300 | ~17,000 | ~800,000 |

How the numbers are derived: per-game calls/round from D.3 ÷ 150 s; peak = N × (N + 8) ÷ 15 s; writes ≈ 4 per completion (intent, submission, games update, `realtime.messages` insert) plus Storage object writes; messages = N broadcasts × (N + 2) recipients ÷ 15 s. Every player read is also a **Vercel function invocation** (cost and cold-start exposure), except host snapshots, which go from the browser straight to PostgREST.

### F.3 Bottlenecks and risk per scenario

| Scenario | Likely first bottleneck | Expected limitation | Risk of degraded performance |
|---|---|---|---|
| Small (50) | Deadlock on near-simultaneous photo completions (≈ 10 per game) | Occasional 1–2 s stalls and auto-retries when several players finish together | **Low–Medium.** Fits Free-tier Realtime quotas **[Unverified]**; DB load small |
| Medium (300) | Realtime **connection quota** (320 > ~200 on Free) and **message rate** (~640/s burst > ~100–500/s) **[Unverified quotas]**; deadlocks with 30 players per game | Rejected or throttled sockets → those clients fall back to **4 s polling** → +75 reads/s; deadlock chains of several seconds | **Medium–High** on Free/Nano; **Medium** on Pro |
| Large (1,000) | Connection and message quotas (exceed Pro defaults **[Unverified]**); PostgREST pool saturated by deadlock waits; Storage re-signing (~160k ops per round) | Seconds-long stalls spread across games; host submission list lags | **High** without the C1/H1/H2 fixes |
| High traffic (2,500) | Same, plus raw request volume through PostgREST and Vercel | Not plausible on the current small compute without changes; needs Realtime quota increases | **Very high** |
| Stress (5,000) | Same | Requires both architectural changes (section H) and a larger plan; must be load-tested on staging | **Very high** |

### F.4 What the code does well for scale **[Code]**

Per-game state is independent: no global hot row except `snappy_counter` on the homepage. Snapshots are indexed and bounded. There are no direct DB connections from serverless. Game actions are idempotent with version checks, so retries are safe. BingoSnap claims are rare (≤ 5 per player per game) and lock correctly with `FOR UPDATE`.

---

## G. Identified Issues (evidence-backed)

| ID | Severity | Issue | Evidence |
|---|---|---|---|
| G1 | **Critical** | Lock-upgrade **deadlock** between different players' `complete_submission` in the same game | `supabase/migrations/20261111000010_submissions_timing.sql:180` (`FOR SHARE`) + `:237` (`bump_game_version` → `UPDATE games`). Reproduced locally: 1/2, 1/10, 1/30 succeed on the first try; ~1 s per deadlock |
| G2 | **High** | **O(N²) fan-out:** every submission, review and join broadcasts to all players, who all re-read the full snapshot | `bump_game_version()` callers (`…000010:237`, `…000011` `review_submission`, `…000009:81-86` join triggers); `lib/game/sync.ts handleSignal` |
| G3 | **High** | Host console and presenter re-fetch the ranked list and **re-sign every photo URL** on each version | `app/api/host/games/[id]/submissions/route.ts:28`; `components/game/host-console.tsx` (`loadRows` on `s.version`); `components/game/presenter-screen.tsx:52` |
| G4 | **High (verify)** | Realtime viability unverified in production: the guest token is HS256 with the legacy secret; failure = silent 4 s polling for everyone | `lib/game/guest-token.ts`, `use-game-sync.ts:13, 176`; `PRODUCTION_READINESS.md` (B2, item on HS256) |
| G5 | **High** | **No retention:** photos and game rows kept forever; the `photo_retention_days` setting is not enforced | `20261111000006_admin_dashboard.sql:19`; no delete or cron anywhere; `PRODUCTION_READINESS.md` known gap |
| G6 | Medium | Realtime sockets and the 30 s safety re-reads continue **after a game has finished** | `components/game/player-game.tsx:68, 76`; `components/game/finished-results.tsx:28`; `use-game-sync.ts:172` |
| G7 | Medium | Host console re-fetches **roster and rounds on every version** | `components/game/host-console.tsx:83, 90`; `components/game/lobby-view.tsx:54` |
| G8 | Medium | `complete` route downloads the **entire photo** to check 3 bytes, and also builds a full snapshot and reads `platform_settings` per call | `lib/players/photo-check.ts:29`; `app/api/play/submissions/complete/route.ts` |
| G9 | Medium | `syncBurst` = 4 full snapshot reads per player per countdown, used only as clock samples | `components/game/use-game-sync.ts:77`; `components/game/player-game.tsx` |
| G10 | Medium (conditional) | On an HS256 project, `getClaims()` becomes an Auth network call, twice per host request through Next | `lib/supabase/proxy.ts:47`; `lib/auth/guards.ts:15` |
| G11 | Medium | Deadlock (`40P01`) and other unknown DB errors map to generic 500 `request_failed`, so they are invisible in client errors | `lib/host/errors.ts` |
| G12 | Low–Medium | BingoSnap snapshot runs `game_capacity()` → recursive `pass_entitlement()` on every read | `20261112000018_bingosnap_functions.sql:150` |
| G13 | Low | `realtime-token` routes compute a full snapshot just to learn identity | `app/api/play/realtime-token/route.ts`, `app/api/play/bingosnap/realtime-token/route.ts` |
| G14 | Low | `player_game_state` computes results twice on finished games | `20261111000011_review_winners.sql:315, 318` (same in `20261112000026`) |
| G15 | Low | `submission_intents` rows are never removed after acceptance | `…000010` (deletes only on replace or discard) |
| G16 | Low | Unindexed FK columns (see C.2); matters only once deletions start | migrations `000009`, `000011`, `000017`, `000003`, `000014`, `000013` |
| G17 | Low | No rate limiting on guest endpoints (state, token, join, begin/complete); in-memory throttles are per instance | `PRODUCTION_READINESS.md` F4/B4; `app/api/snappy/route.ts` |
| G18 | Low | `next` and `@supabase/*` are `"latest"` (unpinned): a fresh deploy can change Realtime or Auth behaviour | `package.json` |

---

## H. Recommended Improvements (prioritised)

None of these were implemented; this audit is read-only.

### Critical

**C1. Remove the `complete_submission` deadlock (G1).**
- *Change:* lock the game row with a lock that already allows the later update, e.g. `select … from games where id = … for no key update` (or `for update`) instead of `for share`. Alternatively take the lock first, before the players lock, to keep a single lock order. Add a concurrency test with **different** players completing at once (the scenario in C.6).
- *Benefit:* eliminates the 1 s-per-collision stalls and retries and frees PostgREST connections during submission bursts. Completions in a game then serialise in milliseconds each.
- *Complexity:* Low (one function plus a test).
- *Risk:* Low–Medium. Re-check lock ordering against `game_transition` and the kick path (game → players vs. players → game) in the same concurrency test. Map `40P01`/`40001` to a retryable 503 (G11) as a safety net.

**C2. Verify Realtime end to end on the real project before any large event (G4).**
- *Change:* none in code. Confirm that guests reach `SUBSCRIBED` with the HS256 token, that the "Live" chip (not "basic mode") shows, and what the plan's connection and message quotas are.
- *Benefit:* confirms the architecture's core assumption. If it fails, every estimate above gets worse by N/4 reads/s per game.
- *Complexity:* Low. *Risk:* none.

### High

**H1. Stop waking every player for host-only changes (G2).**
- *Option A:* give the broadcast payload a scope, e.g. `{version, phase, scope: 'host'}` for submissions and reviews. Players skip the re-read for host-scoped hints. This is safe: the safety re-read and phase hints still catch up, and versions stay monotonic. *Tradeoff:* the player view's live `submissionCount` would only update on the next player-scoped hint.
- *Option B:* a second private topic `game:<id>:host` for host-only events.
- *Lobby:* debounce player re-reads on join hints (e.g. 1–2 s), since the only change is the headcount.
- *Benefit [Estimate]:* at N = 50 the player re-reads per round fall from ~(2N + 5) × N ≈ 5,000 to ~5 × N ≈ 250, so total per-round DB calls drop roughly **70–85%**, and Realtime messages delivered drop by a similar share.
- *Complexity:* Medium (SQL `broadcast_game` signature + `handleSignal`). *Risk:* Medium. Must keep the "never roll back" and "catch up after a missed hint" guarantees; extend `tests/game-sync.test.ts`.

**H2. Make host and presenter refreshes incremental (G3, G7).**
- Fetch the roster only when `playerCount` changes, and rounds only when `totalRounds` or the current round changes.
- Sign photo URLs only for paths not already signed in the last ~100 s (cache by path on the client), or sign lazily when a photo is shown, and raise the TTL slightly.
- *Benefit:* signing work goes from O(N²) to O(N) per round (~8,000 → ~100 at N = 50), and Storage RLS evaluations fall to match.
- *Complexity:* Low–Medium. *Risk:* Low (expired URLs need a refresh-on-error path).

**H3. Implement retention (G5, G15).**
- A scheduled job (`pg_cron` in Supabase, or a Vercel cron calling a service-role function) that deletes Storage objects older than `photo_retention_days`, deletes `submission_intents` for closed rounds, and optionally prunes old finished/cancelled games' players and submissions after N days (add the FK indexes in G16 first).
- *Benefit:* bounded DB and Storage size, lower cost, meets privacy expectations.
- *Complexity:* Medium. *Risk:* Medium (irreversible deletes). Ship with a dry-run report first.

**H4. Close Realtime after the game ends (G6).**
- Unmount or stop `useGameSync` (or skip the subscription) once the snapshot is `finished`/`canceled` and results are shown. One final read is enough.
- *Benefit:* frees connection-quota slots for the next game in the same evening.
- *Complexity:* Low. *Risk:* Low.

### Medium

**M1. Make `complete` cheaper (G8).** Fetch only the first bytes of the object (an HTTP `Range` request on the authenticated object URL) instead of `download()`. Use a light identity lookup instead of the full snapshot. Read `max_photo_size_mb` with the RPC or cache it per instance for a short time. *Benefit:* less function memory and Storage egress per photo. *Complexity:* Low–Medium. *Risk:* Low.

**M2. Cheaper clock samples (G9).** Use a tiny RPC that returns only `clock_timestamp()` (the database clock stays the reference) for `syncBurst`, instead of four full snapshots. *Benefit:* removes 4N snapshot builds per round. *Complexity:* Low. *Risk:* Low (keep the same RTT bracketing).

**M3. Confirm JWT signing mode (G10).** If the project is HS256, plan a move to asymmetric signing keys so `getClaims()` verifies locally. **Plan the guest token first:** it is signed with the legacy secret and must keep working (or switch to a server-signed token Realtime accepts). *Benefit:* fewer Auth calls per host request. *Complexity:* Medium. *Risk:* Medium (auth outage if done carelessly).

**M4. Map transient DB errors (G11).** Return `40P01`/`40001`/`57014` as 503 `retry` and log them distinctly. *Benefit:* visibility and correct client retries. *Complexity:* Low. *Risk:* Low.

**M5. Rate limits at the edge (G17).** WAF or platform rules per IP and path, sized for a venue behind one NAT (see `PRODUCTION_READINESS.md`). *Benefit:* protects the small instance from abusive traffic. *Complexity:* Low (config). *Risk:* Low if limits are generous.

**M6. BingoSnap capacity per read (G12).** Use the stored `games.max_players` (already kept in step by `sync_lobby_capacity`) in snapshots, and keep `game_capacity()` for joins only. *Complexity:* Low. *Risk:* Low; check that the displayed cap after a pass expiry is acceptable.

### Low

- **L1.** Pin `next` and `@supabase/*` to exact versions (G18).
- **L2.** Compute results once in `player_game_state` (G14) and use a light identity query in the token routes (G13).
- **L3.** Add indexes for the FK columns in G16 **before** enabling retention deletes.
- **L4.** Spreading the boundary re-reads (Q7) with jitter would smooth spikes, **but it would delay the prompt reveal for some players and hurt fairness.** Leave it unless measurements show a problem.

### Expected effect on infrastructure decisions

C1 + H1 + H2 + H4 remove most of the peak-time database work and connection holding that the code itself creates. They do **not** shrink the platform's idle memory footprint, and they do not raise the **Realtime connection quota**, which grows linearly with concurrent players (one socket each) and is likely the first hard limit above ~200 concurrent clients **[Unverified quota]**.

---

## I. Additional Diagnostics Required

All SQL below is **read-only** (`SELECT`/`SHOW` only). Run it in the Supabase SQL Editor. Don't paste results that contain secrets.

### I.1 Instance configuration
```sql
select name, setting, unit from pg_settings
where name in ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_connections',
               'max_worker_processes','autovacuum_max_workers','deadlock_timeout','statement_timeout','idle_in_transaction_session_timeout')
order by name;
select version();
```

### I.2 Deadlocks, rollbacks, temp files (key evidence for G1)
```sql
select datname, numbackends, xact_commit, xact_rollback, deadlocks, conflicts, temp_files,
       pg_size_pretty(temp_bytes) as temp_bytes, stats_reset
from pg_stat_database where datname = current_database();
```
Also search **Logs → Postgres** for `deadlock detected`, `out of memory`, `terminating connection`, `could not fork`.

### I.3 Connections and who holds them
```sql
select usename, application_name, state, wait_event_type, count(*)
from pg_stat_activity group by 1,2,3,4 order by 5 desc;

select pid, usename, application_name, state, now() - xact_start as xact_age, wait_event_type, wait_event, left(query, 100)
from pg_stat_activity where state <> 'idle' order by xact_age desc nulls last limit 20;

select slot_name, plugin, slot_type, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained_wal
from pg_replication_slots;
```

### I.4 Query cost (pg_stat_statements is enabled by default on Supabase; the schema is usually `extensions`)
```sql
select calls, round(total_exec_time::numeric) as total_ms, round(mean_exec_time::numeric, 2) as mean_ms,
       rows, left(query, 140) as query
from extensions.pg_stat_statements
order by total_exec_time desc limit 25;
-- Also order by calls desc to see the fan-out RPCs (player_game_state, host_game_state, round_ranking).
```

### I.5 Data size and growth
```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size;

select n.nspname as schema, c.relname as table, pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       c.reltuples::bigint as est_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and n.nspname in ('public','realtime','storage','auth')
order by pg_total_relation_size(c.oid) desc limit 25;

select count(*) as games,
       round(avg(p.n), 1) as avg_players, round(avg(s.n), 1) as avg_submissions
from public.games g
left join lateral (select count(*) n from public.players where game_id = g.id) p on true
left join lateral (select count(*) n from public.submissions where game_id = g.id) s on true;
```

### I.6 Realtime and Storage footprint
```sql
select count(*), min(inserted_at), max(inserted_at) from realtime.messages;
select bucket_id, count(*) as objects, pg_size_pretty(sum((metadata->>'size')::bigint)) as bytes
from storage.objects group by bucket_id;
```

### I.7 Table health and index usage
```sql
select relname, n_live_tup, n_dead_tup, n_tup_hot_upd, last_autovacuum, last_autoanalyze
from pg_stat_user_tables order by n_dead_tup desc limit 15;

select relname as table, indexrelname as index, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes order by idx_scan asc, pg_relation_size(indexrelid) desc limit 20;

-- FK columns without a leading index
select c.conrelid::regclass as table, c.conname, pg_get_constraintdef(c.oid)
from pg_constraint c
where c.contype = 'f' and c.connamespace = 'public'::regnamespace
  and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and (i.indkey::int2[])[0] = c.conkey[1]);
```

### I.8 Locks right now (run during a live game)
```sql
select l.locktype, l.relation::regclass, l.mode, l.granted, a.pid, now() - a.xact_start as age, left(a.query, 80)
from pg_locks l join pg_stat_activity a on a.pid = l.pid
where not l.granted or l.relation = 'public.games'::regclass
order by age desc nulls last;
```

### I.9 Which migrations production actually runs
```sql
select version, name from supabase_migrations.schema_migrations order by version;  -- exists if the CLI was used
select proname from pg_proc where pronamespace = 'public'::regnamespace
  and proname in ('bingo_submit_claim','replay_round','add_game_round','hook_before_user_created','bingo_start')
order by 1;
```

### I.10 Not available through SQL: collect manually
- **Dashboard → Settings → Compute & Disk:** compute size (confirms the 0.5 GB assumption) and plan.
- **Dashboard → Settings → JWT Keys:** legacy HS256 vs asymmetric (G4, G10).
- **Dashboard → Realtime → Reports/Usage:** peak concurrent connections, messages per second, rejected joins; **Logs → Realtime** for quota or authorization errors.
- **Database report / metrics:** memory, swap **in/out rate** (not just swap used), CPU, disk IO, connections over the last 7 days. Supabase also offers a Prometheus-compatible metrics endpoint per project (see Supabase's docs) for `Committed_AS`, swap activity and per-connection counts.
- **API (PostgREST) logs:** 5xx rates and latencies on `rpc/player_game_state`, `rpc/complete_submission`, `rpc/host_game_state`.
- **Vercel:** function invocations, duration and memory for `/api/play/state`, `/api/play/submissions/complete`, `/api/host/games/[id]/submissions`.

### I.11 Tests to run (never against production)
1. **Deadlock regression test:** extend `tests/concurrency/engine-concurrency.mjs` with N **different** players completing at once (the local reproduction used exactly this setup).
2. **Staging load test:** a separate Supabase project and deployment, a script that opens N guest sessions (join → WebSocket → state reads) per game and drives the host through rounds. Measure p95 latency, deadlocks, PostgREST 5xx, Realtime rejects and memory, at 5 × 10, 10 × 30 and 20 × 50.
3. **Realtime fallback drill:** block WebSockets on one device and confirm the 4 s polling load matches expectations.

---

## J. Final Verdict

1. **Is BringMe! currently optimised for its expected usage?**
   For small events (a few games of ≤ 10–15 players), it is adequate: correct, secure and light on data. It is **not optimised for larger rooms.** The per-round work grows with N², and one confirmed locking bug hits exactly when a room is busiest.

2. **What is the biggest potential bottleneck?**
   On the database side, the **`complete_submission` deadlock** (G1), followed by the **broadcast → everyone re-reads** fan-out (G2) and the host and presenter's re-signing of all photos (G3). On the platform side, the **Realtime concurrent-connection quota** (one socket per player and per host tab) is the first hard ceiling above ~200 concurrent clients **[Unverified quota]**.

3. **Is Supabase Realtime being used efficiently?**
   The *mechanism* choice is efficient and safe: Broadcast from the database, tiny private hint messages, no Postgres Changes, no Presence. The *usage pattern* is not: host-only changes wake every player, sockets stay open after games end, and a Realtime failure silently turns into 4 s polling for everyone.

4. **Is the memory-commitment warning an immediate concern?**
   **Not an emergency on the evidence given.** No out-of-memory event, restart or latency incident was reported. It is a **narrow margin** (~86% of the commit limit on a ~0.5 GB instance), and peak events (deadlock pile-ups, request bursts) are what could tip it over. Check I.1–I.3 and the swap in/out rate. If swap is actively paging during games, or the logs show out-of-memory errors, treat it as urgent.

5. **Does the architecture appear capable of supporting 500 concurrent players?**
   **Not as it stands, and this cannot be claimed without a load test.** At 500 players (e.g. 10 × 50), the estimates show roughly 450 average and ~1,900 peak DB calls/s plus ~1,700 Realtime messages/s in a submission burst. That exceeds the documented Free-tier Realtime limits **[Unverified]** and is unproven on Nano-class compute. **After C1, H1, H2 and H4, on a plan whose Realtime quota covers ~520 sockets**, 500 players looks **plausible**, pending a staging load test.

6. **What would need to change to support 1,000+ concurrent players?**
   - All Critical and High items (deadlock fix, scoped hints, incremental host refresh, closing sockets after games, retention).
   - A plan and compute size whose **Realtime connection and message quotas** exceed peak sockets (≥ players + 2 per game) with headroom. Request quota increases from Supabase if needed.
   - Cheaper per-hint work: optionally put the non-secret parts of the state in the broadcast payload so most hints need **no** re-read (keep the authoritative re-read for the prompt reveal and for gaps). This is an architectural change that trades some of today's "hint-only" simplicity for an order-of-magnitude cut in reads.
   - Edge rate limiting, pinned dependencies, and a repeatable staging load test as a release gate.

7. **Should I optimise the current infrastructure before upgrading the Supabase plan?**
   **Yes, for the database load.** C1 is a small change with a large effect, and H1, H2 and H4 remove most of the self-inflicted O(N²) work, so a larger instance would mostly be paying for avoidable work. Two caveats:
   - **(a)** if section I shows the memory warning comes from baseline footprint (high commitment at idle), code changes won't fix it; a modest compute step-up is then the honest fix.
   - **(b)** if you expect more than ~200 simultaneous phones in the near term, the **Realtime connection quota** may require a paid plan regardless of database optimisation **[Unverified quota]**.

   The order: confirm the facts (C2, section I) → fix C1 → H1/H2/H4 → load test on staging → then decide on the plan or compute size with numbers.

---

### Appendix: local reproduction (for the engineer fixing G1)

The reproduction was a standalone Node script, run outside the repository. It started an `embedded-postgres` instance (already present in `node_modules`), loaded `tests/db/supabase-shim.sql` and every file in `supabase/migrations/` in order, then created a game with N players and had each player run `begin_submission`. Finally it ran `complete_submission` for all N players at the same moment, each on its own connection. Results are in C.6. The same setup as `tests/concurrency/engine-concurrency.mjs` (its `activeRound` and `parallelSvc` helpers) can be reused for a permanent regression test.
