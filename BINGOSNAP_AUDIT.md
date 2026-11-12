# BingoSnap — Phase 0: architecture audit & integration plan

_2026-11-12. Audit only: no code, schema or behaviour changed._

BingoSnap is a photo scavenger hunt played as Bingo, under a new **Extra Fun** section. The host builds a board of photo challenges and players join by QR or code. Players snap photos that **never leave their phone**, then claim a line or a full card before the timer runs out. The host sees names and claims only, calls players forward, inspects the photos on their phones, and verifies or rejects each claim.

## 1. Current architecture (inspected)

| Area | What exists | Where |
|---|---|---|
| Framework | Next.js 16.4.6 App Router, React 19, strict TS, Tailwind 3.4, Radix/shadcn-style kit, `cacheComponents: true`, root `proxy.ts` | `app/`, `proxy.ts`, `next.config.ts` |
| Supabase | `@supabase/ssr` with a new client per request; a server-only service client | `lib/supabase/{client,server,proxy,admin}.ts` |
| Roles | `profiles.role` (`subscriber` / `super_admin`) read server-side; guests have no auth account | `lib/auth/guards.ts`, `lib/auth/session.ts` |
| Game model | `games` (status `draft→lobby→live→finished/canceled`; `phase` `lobby/countdown/active/reviewing/winner_announced/finished`; `state_version`; `max_players`; `join_code`; `archived_at`), `game_rounds`, `players`, `submissions`, `submission_intents` | migrations `…01`, `…09`, `…10`, `…11` |
| Creation | `POST /api/host/games` → `requireActiveSubscription()` → `parseGameInput` → `create_game_with_rounds` | `app/api/host/games/route.ts` |
| State machine | `game_transition(game, action, expectedVersion)`: owner check, `FOR UPDATE`, `stale_state`; the only writer of status/phase (column grants revoked) | `…07_entitlement_cutover.sql` (latest body) |
| Entitlement | `pass_entitlement(user)` reads the ledger (`game_passes` + `pass_segments`, half-open UTC, no cron). The app calls `my_entitlement`; nothing reads the frozen `subscriptions` table | `…05`, `…07` |
| Player cap | `enforce_game_insert` sets `games.max_players` = pass cap; `enforce_player_insert` locks the game and checks `game_capacity()`; `start_game` re-checks (`player_limit_exceeded`); `sync_lobby_capacity` raises open lobbies on upgrade | `…07`, `…12` |
| Expiry | Pure time. No new games, joins or starts without a pass; **a live game may finish** (D-10); results stay readable | `GAME_PASS_DESIGN.md` §14 |
| Game limits | Per plan `max_active_games` (trial 1, starter 1, party 3, pro 10), `max_rounds_per_game` (5/5/15/40), optional `max_games_per_period`. These count **every `games` row** | `…02_plan_catalogue.sql` |
| Join / QR | `/join/[code]` → `public_room_info` → `POST /api/play/join` → `join_game` (service role, token **hash** only) → `bm_player` HttpOnly cookie (12 h) → `/join/[code]/lobby`. Joins allowed only while in the lobby. Server-rendered SVG QR | `app/join/**`, `lib/players/*`, `lib/site/{qr,url}.ts`, `components/game/qr-code.tsx` |
| Realtime | DB broadcasts `{version, phase}` hints on the private channel `game:<id>` (`broadcast_game`, `bump_game_version`). Guests get a 1 h anon token from `/api/play/realtime-token`. `useGameSync` re-reads snapshots, uses 4 s polling in "basic mode" and offsets the server clock | `…09`, `components/game/use-game-sync.ts`, `lib/game/{sync,clock}.ts` |
| Timer | 3 s countdown via `countdown_ends_at` (server clock). `game_rounds.time_limit_seconds` is **display only**: rounds close when the host acts. There is **no server-enforced deadline** today | `…09`, `components/game/countdown.tsx`, `lib/game/sync.ts` (`secondsUntil`, `msUntil`) |
| Photos (classic) | Live camera only (no file input), `grabFrame`/`fitWithin`/JPEG ladder, then **auto-upload** to the private `submissions` bucket via a signed URL | `lib/game/{camera,photo,upload,submit-flow}.ts`, `components/game/camera-*.tsx` |
| Payments | Polar one-time checkout + verified webhook → `apply_payment_event` → pass. Plans and prices are authoritative in `subscription_plans` / `plan_prices` / `game_passes.max_players` | `lib/billing/*`, `…09–…14` |
| UI | `components/ui/*`, `DashboardShell` (nav in `app/dashboard/layout.tsx`), `PlayerShell`, `Mascot`, `Backdrop`, `Confetti`, `Countdown`, `PlayerCount`, `WaitingDots`, `LobbyView`, `ProjectorStage`, `PresenterScreen`, `ConfirmDialog`, `Modal`, `Toast` | `components/**` |
| Migrations | `supabase/migrations/YYYYMMDDNNNNNN_name.sql` (latest `20261112000016`). Idempotent guards, never edit applied files, RLS + explicit `revoke … from anon, authenticated` on every table, rollback scripts in `supabase/rollback/` | `supabase/README.md` |
| Tests | `npm test` (PGlite SQL + unit), `test:concurrency` (real PG). `tests/db/qa-audit.test.ts` holds **exact EXECUTE allowlists** and a types↔schema parity check. New functions must be added there and to `database.types.ts` | `tests/**` |
| Safety | `readJson` caps request bodies at **8 KB**; headers include `camera=(self)`; no rate limiting yet (known launch blocker) | `lib/api/http.ts`, `next.config.ts` |

## 2. Reusable as-is

- **Entitlement & caps:** `pass_entitlement`, `enforce_game_insert`, `enforce_player_insert`, `game_capacity`, `sync_lobby_capacity`, `requireActiveSubscription`, restriction screens (`components/subscription/*`). If a BingoSnap game is a `games` row, it inherits the pass check, the player cap, expiry and upgrades **with no billing changes**.
- **Join:** `/join/[code]`, `join_game`, `public_room_info`, the player cookie, `JoinForm`, `RoomCodeForm`, `/play`, QR and the join URL.
- **Realtime:** `broadcast_game`, `bump_game_version`, the `game:<id>` channel policy, the guest token route, `useGameSync`, `GameSyncCore`, `ClockSync`.
- **Lifecycle:** `status`, `state_version`, `archived_at`, and the existing phase values (`lobby → countdown → active → reviewing → finished`) all fit BingoSnap within `games_status_phase_check`.
- **Camera:** `CameraProvider`/`useCamera`, `CameraGate`, `classifyCameraError`/`cameraHelp`, `grabFrame`, `fitWithin`, `QUALITY_LADDER`. **Not** `submit-flow.ts` or `upload.ts`.
- **UI:** all of `components/ui/*`, `DashboardShell`, `PlayerShell`, `Mascot`, `Backdrop`, `Confetti`, `Countdown`, `PlayerCount`, `WaitingDots`, `CopyButton`, `QrCode`, `GameList`, `ConfirmDialog`, plus the motion utilities in `tailwind.config.ts`.
- **Payments:** nothing new. No Polar product, price or webhook change.

## 3. What must be new

### Database (additive migrations, `20261112000017+`)
- `games.game_type` enum (`bring_me` default | `bingosnap`), not null, **immutable** after insert. Existing rows become `bring_me`, so current behaviour is unchanged.
- `bingo_boards`: `game_id` PK/FK, `size` (3|4|5), `win_mode` (`line` | `full_card`), `free_center` bool, `duration_seconds`, `hunt_opened_at`, `hunt_ends_at` (server clock).
- `bingo_cells`: `id`, `game_id`, `position` (0…n²−1), `prompt` (1–120 chars), unique `(game_id, position)`.
- `bingo_claims`: `id`, `game_id`, `player_id` (composite FK like `submissions`), `claim_type`, `positions smallint[]`, `received_at` (DB clock), `status` (`pending`/`verified`/`rejected`), `reviewed_at`, `reject_reason`, `attempt_no`. At most one pending claim per player (partial unique index). **No image, path, hash or URL columns.**
- Functions:
  - `create_bingosnap_game(title, size, win_mode, free_center, duration, prompts[])` runs as the owner and inserts through `games`, so the existing triggers enforce the pass.
  - `bingo_transition(game, action, expectedVersion)`: `start_game` (≥1 player + cap re-check, copied from D-9), `start_countdown`, `start_hunt` (sets `hunt_ends_at`), `close_hunt`, `end_game`, `cancel`, `archive`.
  - `bingo_submit_claim(token_hash, positions[])`: service role only. Validates the pattern against the board, enforces the deadline on the DB clock and bumps the version.
  - `bingo_review_claim(claim, decision, reason, expectedVersion)`: owner only.
  - `bingo_state_json(game, viewer)` for host and player views, plus `bingo_results_json`.
- **Guards on existing code (the only edits):** `game_transition` and `begin_submission` reject `game_type = 'bingosnap'`, and `player_game_state` / `host_game_state` branch on `game_type`. Classic games take exactly the same paths as before. Both guards get mutation tests.
- RLS enabled on every new table. `revoke all` from anon/authenticated; hosts get SELECT on their own boards and claims only; **no client writes**. Update the `qa-audit` allowlists and `database.types.ts`.

### Routes
| Route | Purpose |
|---|---|
| `/dashboard/extra-fun` | Extra Fun section (BingoSnap card; room for future games). New nav item |
| `/dashboard/extra-fun/bingosnap/new` | Board builder: size, mode, timer, prompts, free centre |
| `/dashboard/extra-fun/bingosnap/[id]` | Host lobby (reused `LobbyView`/QR) → hunt timer → claims queue → results |
| `/join/[code]/lobby` (existing) | Branches on `gameType` to `BingoPlayerGame` |
| `POST /api/host/bingosnap` | Create |
| `POST /api/host/bingosnap/[id]/transition` | Lifecycle |
| `POST /api/host/bingosnap/[id]/claims/[claimId]/review` | Verify / reject |
| `POST /api/play/bingosnap/claim` | Cookie-authorized claim (positions only) |
| `GET /api/play/state` (existing) | Returns the bingo snapshot for bingo games |

`GameList` and the dashboard read `game_type` so each game links to the right console and shows a "BingoSnap" badge. `/dashboard/games/[id]` redirects bingo games to their console.

### Client modules
- `lib/bingosnap/rules.ts`: pure line/full-card detection, shared by the UI and tests. The SQL copy is authoritative.
- `lib/bingosnap/photo-store.ts`: an IndexedDB wrapper (no library).
- `components/bingosnap/*`: `BoardBuilder`, `BingoBoard`, `CellCamera`, `ShowHostGallery`, `ClaimsQueue`, `BingoHostConsole`, `BingoResults`.
- `useGameSync`: an additive optional `deadlineAt` boundary so every device resyncs exactly when the timer ends.

## 4. Recommended integration architecture

1. **One game table, a type discriminator.** BingoSnap games are `games` rows with `game_type = 'bingosnap'`. Pass, cap, expiry, join, QR, Realtime and archive all come for free, so the "shared entitlement and player allowance" requirement holds by construction. There is no parallel entitlement logic that could drift.
2. **A separate state machine and snapshot.** `bingo_transition` and `bingo_state_json` sit beside the classic ones and reuse the same enum values, version and broadcast. Classic functions get one rejection guard each.
3. **The server knows positions, never pictures.** Board progress stays on the device. The only thing sent is the claim, as a list of cell positions. The server checks it's a legal line or full card and records the DB-clock time. The host's queue shows name, claim type, the cells claimed (prompt text), the time and status.
4. **Timer:** `hunt_ends_at` is set by `start_hunt`. Claims are accepted only while `clock_timestamp() <= hunt_ends_at + grace` (a short grace, e.g. 2 s, for a tap just before zero). There's no cron: "time's up" is derived from the clock, and the host's `close_hunt` (or the first review after the deadline) moves the phase to `reviewing`.
5. **Expiry follows D-10.** Starting needs an active pass that covers everyone. Once live, an expiring pass doesn't stop the hunt, reviews or results.

## 5. Security & local-photo storage

**Guaranteeing photos never reach the server**
- No code path exists: there's no signed URL, bucket path or `submission_intents` row for bingo games. `begin_submission` rejects them, and they have no rounds anyway.
- Claim and review endpoints accept only `{positions:number[]}` / `{decision, reason}` with strict parsing (unknown keys rejected). The existing 8 KB body cap makes an embedded photo impossible.
- Tests: a bingo claim with extra fields is rejected; the bucket and `submission_intents` stay empty after a full bingo game; a static scan finds no `fetch`/XHR in `components/bingosnap` or `photo-store.ts` that sends a Blob.
- Nothing about photos (count, size, hash) is logged.

**On-device storage**
- Use **IndexedDB** (Blobs) keyed `gameId/playerId/cellId`, not localStorage (string-only, ~5 MB). Reuse `fitWithin` at ~1280 px with the JPEG quality ladder: 25 photos ≈ 10–20 MB.
- Re-encoding through a canvas strips EXIF/GPS.
- Call `navigator.storage.persist()`. Handle `QuotaExceededError` and private browsing, where quotas are small and storage may be cleared, with clear messages.
- iOS Safari may evict site data after 7 days without use. That's fine for a party game; just say so.
- Photos survive a refresh (IndexedDB plus cookie identity). They **do not** follow the player to another phone or browser; warn on the board screen.
- Live camera only, consistent with the existing anti-cheat stance (no file input). Retakes are allowed until the claim is verified.
- Cleanup: "Delete my photos" at any time. Auto-delete when the player opens the app after the game finished more than 24 h ago. An optional "Save to my phone" (local download) keeps the photos theirs.
- `ShowHostGallery`: a full-screen, swipeable view of each claimed cell with its prompt, using the wake lock (already used by the presenter screen). Object URLs are revoked on unmount.

**Server-side controls**
- Claims are bound to the cookie → token hash → player → game. Positions must exist on this board and form a legal pattern. One pending claim per player, enforced by `FOR UPDATE` and a unique index. A kicked player can't claim.
- Review is owner-only with an expected version (no double decisions). A rejected player may claim again before the deadline (`attempt_no`).
- Honest limit: the server can't prove a photo exists. **The host's in-person check is the control**, and the UI says so.
- Rate limiting is still missing platform-wide (existing blocker). The claim route needs it at the edge like `/api/play/*`.
- The privacy page (`app/privacy/page.tsx`) currently says submitted photos are stored. It needs a BingoSnap paragraph: photos stay on the device and only names and claimed cells are stored.

## 6. Decisions needed before Phase 1

> **Answered 2026-11-12:** 1 yes · 2 yes · 3 per-player order · 4 both, host toggle (ranked list / first wins) · 5 yes · 6 yes (host option, default on) · 7 yes. Binding spec: [BINGOSNAP_DESIGN.md](BINGOSNAP_DESIGN.md).

1. **Shared game limits:** a BingoSnap game counts toward `max_active_games` (trial/starter: 1 open game) and `max_games_per_period`. **Recommended: yes** (one pass, one budget).
2. **Board size per plan:** is `max_rounds_per_game` ignored for BingoSnap, with 3×3/4×4/5×5 for all plans? **Recommended: all sizes for all plans.**
3. **Layout:** same board for everyone, or each player's own shuffle of the same prompts (seeded server-side)? **Recommended: per-player shuffle**, which makes lines differ like real bingo.
4. **Winners:** first verified claim wins, or rank every verified claim by `received_at` (podium)? **Recommended: ranked list; first verified = winner.**
5. **After a rejection:** can the player resubmit before the deadline? **Recommended: yes.**
6. **Free centre square** on odd boards: host option, default on?
7. **Presenter screen** for BingoSnap (timer + claim names on the TV): MVP or later?

## 7. Phase plan (one phase at a time, each with tsc/lint/build/tests + status update)

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Domain design** | `BINGOSNAP_DESIGN.md`: rules, the decisions above, state diagram, invariants, acceptance matrix | Approved spec |
| **2. Schema & functions** | Migrations 17–18 (type, tables, RLS, functions, classic guards) + rollback script; `database.types.ts`; `qa-audit` allowlists | PGlite tests: caps 3/10/50/100 shared, expiry, line/full-card validation, deadline, one pending claim, owner-only review, classic games unchanged (existing suite green); concurrency: racing claims and joins |
| **3. Extra Fun + builder** | Nav item, `/dashboard/extra-fun`, board builder, create API, dashboard and `GameList` type badges and links | Create a game under each plan; restriction screens reused |
| **4. Host lobby & timer** | Console with reused lobby/QR/`PlayerCount`, countdown, hunt timer (`deadlineAt` in `useGameSync`), close/end/cancel | Multi-device timer aligned; refresh restores |
| **5. Player board & local photos** | `BingoBoard`, `CellCamera`, `photo-store`, claim flow, progress, persistence, delete | Chromium fake camera at 360/390 px; network log shows no image bytes; refresh keeps photos |
| **6. Review & results** | `ClaimsQueue`, verify/reject, `ShowHostGallery`, player result states, final results, archive | End-to-end with 3+ sessions |
| **7. Polish & copy** | Mascot moods, confetti on a verified bingo, reduced-motion resting states, axe pass, privacy/terms copy, landing mention | axe clean; reduced motion checked |
| **8. QA & security audit** | Real iOS Safari + Android Chrome (camera, IndexedDB quota and eviction, private mode), HTTP probes, bundle scan | Report + `PROJECT_STATUS.md` |

Out of scope for every phase: Polar/pricing changes, uploading photos, and changes to classic Bring Me gameplay.
