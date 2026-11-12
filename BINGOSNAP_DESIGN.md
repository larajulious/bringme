# BingoSnap — Phase 1: domain design

_2026-11-12. Design only: no code, schema or behaviour changed. Builds on [BINGOSNAP_AUDIT.md](BINGOSNAP_AUDIT.md)._

## 1. Decisions (B-1 … B-14)

| # | Decision |
|---|---|
| B-1 | A BingoSnap game is a `games` row with `game_type = 'bingosnap'`. It uses the same Game Pass, player cap (3/10/50/100), expiry, join code, QR and Realtime channel as Bring Me. |
| B-2 | It **counts toward** `max_active_games` and `max_games_per_period`. |
| B-3 | Board sizes **3×3, 4×4 and 5×5 on every plan**. `max_rounds_per_game` does not apply. |
| B-4 | **Each player gets their own order** of the same prompts, derived on the server and stable for that player (§4). |
| B-5 | Win mode is set per game: **Line** (any full row, column or diagonal) or **Full Card**. |
| B-6 | Winner rule, a host toggle per game: **Ranked** (default; every verified claim, ordered by when the server received it) or **First wins** (only the earliest-received verified claim). The toggle can be changed until the hunt starts. |
| B-7 | **Free centre** square: host option, default **on**. It applies only to odd sizes (3×3, 5×5); 4×4 has no centre. The centre needs no photo and is the same square for every player. |
| B-8 | A rejected player **may claim again** before the deadline (at most 5 attempts per player). |
| B-9 | Hunt length 3–120 minutes (default 20), with a 3 s countdown as in Bring Me. The deadline is checked on the **database clock**, with a 2 s grace period. No cron job. |
| B-10 | Photos **never leave the device**. The server stores cell ids, times and review results only. |
| B-11 | Live camera only (no gallery import), the same as Bring Me. Retakes are allowed until that cell is part of a verified claim. |
| B-12 | Once live, an expiring pass doesn't stop the hunt, the reviews or the results (Game Pass D-10). |
| B-13 | A **presenter screen** is included: lobby QR, timer, live claim names and status, then results. No photos. |
| B-14 | Players can't see other players' claims during the hunt. Everyone sees the results after they are announced. |

## 2. Lifecycle

```
status: draft ─► lobby ─────────► live ───────────────────────────────────────► finished
phase:         lobby   start_game  lobby ─► countdown ─► active ─► reviewing ─► winner_announced ─► finished
                                       start_countdown  start_hunt  close_hunt  announce_results    end_game
                                                         (3 s)      (or deadline)
cancel: from draft / lobby / live → canceled.   archive: finished → archived_at.
```

These are the existing enum values, and they satisfy `games_status_phase_check` without changing it.

| Action | From | Guards | Effect |
|---|---|---|---|
| `start_game` | lobby/lobby | owner, version, ≥1 player, pass covers everyone in the room (D-9 copy) | status `live` |
| `start_countdown` | live/lobby | — | `countdown_ends_at = now + 3 s` |
| `start_hunt` | countdown | — | `hunt_opened_at = greatest(now, countdown_ends_at)`, `hunt_ends_at = opened + duration`, phase `active` |
| `close_hunt` | active | — (allowed early) | phase `reviewing`; `hunt_ends_at = least(hunt_ends_at, now)` |
| `announce_results` | active (after the deadline) / reviewing | host confirms the result it saw (§6) | phase `winner_announced`, results frozen; any pending claim becomes `unreviewed` |
| `end_game` | live | — | status `finished` (from any live phase; pending claims become `unreviewed`) |

The first review or transition after the deadline moves `active` to `reviewing` automatically. Snapshots also report `huntOver: now > hunt_ends_at`, so clients switch screens at zero without waiting for the host.

## 3. Data model (migration in Phase 2)

- `games.game_type public.game_type not null default 'bring_me'`. It can't be changed after insert (its own trigger; the existing trigger is untouched).
- `bingo_boards`:
  - `game_id` (PK, FK cascade)
  - `size smallint check (size in (3,4,5))`
  - `win_mode` (`line` | `full_card`)
  - `winner_rule` (`ranked` | `first`)
  - `free_center bool`
  - `duration_seconds int check (180..7200)`
  - `seed uuid default gen_random_uuid()`
  - `hunt_opened_at`, `hunt_ends_at`, `results_at timestamptz`
- `bingo_cells`: `id uuid`, `game_id`, `prompt text check 1..120 chars, trimmed`, `sort_no smallint`; unique `(game_id, sort_no)`. The free centre is **not** a cell row.
- `bingo_claims`:
  - `id`, `game_id`, `player_id` (composite FK to `players(id, game_id)`)
  - `attempt_no smallint check 1..5`
  - `cell_ids uuid[] not null`
  - `received_at timestamptz default clock_timestamp()`
  - `status` (`pending` | `verified` | `rejected` | `unreviewed`)
  - `reviewed_at`, `reject_reason text check ≤ 120`
  - unique `(player_id, attempt_no)`; partial unique `(player_id) where status in ('pending','verified')`, so a player has at most one live claim
  - **no photo, path, hash, size or URL column of any kind**
- RLS on all three tables. `revoke all` from anon/authenticated; hosts may SELECT rows of their own games (via `owns_game`). Every write goes through SECURITY DEFINER functions.

## 4. Per-player layout

- Order for player P: the non-centre cells sorted by `md5(seed || P.id || cell.id)`, then `cell.id`, filling positions row by row and skipping the centre when `free_center` is on.
- The ordering function is pure and **identical in SQL and TS** (`lib/bingosnap/layout.ts`; a test vector keeps the two in sync). SQL is authoritative: the snapshot returns the player's own layout, and the client never computes it for real play.
- Prompt count: n², or n² − 1 with a free centre (8, 16, 24 or 25). The builder requires exactly that many prompts, all distinct (ignoring case).

## 5. Claims

`bingo_submit_claim(token_hash, cell_ids uuid[])` runs as the service role only and is called by `POST /api/play/bingosnap/claim`. In order:

1. The player exists, isn't kicked, and the game is a BingoSnap game, live, phase `active`. Lock the player row `FOR UPDATE`.
2. `clock_timestamp() <= hunt_ends_at + 2 s`, otherwise `hunt_over`.
3. No pending or verified claim exists (`claim_open` / `already_verified`), and attempts < 5 (`attempts_exhausted`).
4. The ids are distinct cells of **this** game (`invalid_cells`). Mapped through P's layout, with the free centre added, they must form:
   - Line: **exactly one** complete row, column or diagonal; the ids must be exactly that line's cells.
   - Full Card: every cell.

   Otherwise `invalid_pattern`.
5. Insert with `received_at = clock_timestamp()`, then `bump_game_version` (the host and presenter refresh).

The player marks cells locally and only sends the claim. The server doesn't track progress.

## 6. Review & results

- `bingo_review_claim(claim, decision 'verify'|'reject', reason, expected_version)` is owner-only and refuses after `results_at`. Allowed while `active` or `reviewing`. A decision is final (no undo once results are announced; before that, `undo` returns the claim to `pending`, like Bring Me's review).
- Rejecting frees the player to claim again if the deadline hasn't passed.
- **Ranking:** verified claims ordered by `received_at`, then `id`. Ranked mode shows positions 1…k; First mode shows only #1.
- `announce_results(expected_winner_claim)`. The server computes the result. The host's id is only a confirmation (`winner_mismatch` if it changed meanwhile, as in Bring Me). It is refused while a pending claim was received **before** the current leader: that claim could still take first place (`earlier_claim_pending`). Other pending claims require host confirmation, and the UI warns how many are left; they become `unreviewed`.
- If nothing is verified, the result is "no winner" (allowed when no claims are pending).

## 7. Snapshots

`bingo_state_json(game, viewer)` is built in the same style as `game_state_json`: `version`, `serverNow`, `status`, `phase`, `countdownEndsAt`, `playerCount`, `maxPlayers`, plus:

- `gameType: 'bingosnap'`; `board: { size, winMode, winnerRule, freeCenter, durationSeconds, huntOpenedAt, huntEndsAt, huntOver }`.
- **Player:** `me: { id, nickname, kicked, layout: [{pos, cellId|null(centre), prompt}] (only once the hunt opens; withheld before, like the round item), claim: {attempt, status, cellIds, receivedAt, rejectReason}|null, attemptsLeft }`; `results` once announced.
- **Host / presenter:** the prompt list. `claims: [{id, playerId, nickname, attempt, status, receivedAt, cells: [{id, prompt}] }]` in received order, with `rank` on verified claims and `counts`. The presenter view drops prompts until the hunt opens and drops reject reasons.
- `useGameSync` gains an optional `deadlineAt` (← `huntEndsAt`) boundary, an additive change.

`player_game_state` / `host_game_state` branch on `game_type`. For `bring_me` games their output is byte-for-byte unchanged (regression test).

## 8. Local photo storage (client contract)

- Module `lib/bingosnap/photo-store.ts` uses IndexedDB (no library): database `bingosnap`, store `photos`, key `[gameId, playerId, cellId]`, value `{blob, takenAt, width, height}`.
- Capture uses `grabFrame` → `fitWithin(…, 1280)` → JPEG quality ladder up to 800 KB. Canvas re-encoding strips EXIF/GPS.
- The first capture calls `navigator.storage.persist()`. Error states: quota exceeded, IndexedDB unavailable (some private modes), and photos missing after a reload (evicted). Each shows a clear message; the cell simply shows as not snapped.
- The board warns: "Photos stay on this phone only. Don't switch phones or browsers."
- **Show Host:** a full-screen gallery of the claimed cells (prompt + photo, swipe or arrow keys, cell n of m), with wake lock on. Object URLs are revoked on close.
- **Delete:** "Delete my photos" is always available. Auto-delete runs on any visit more than 24 h after the game finished or was canceled, or when the player was removed. "Save to my phone" downloads locally.
- **Never:** a Blob in `fetch`/XHR/WebSocket/`sendBeacon`, a service worker cache, or localStorage. Enforced by a test that scans `components/bingosnap` and `lib/bingosnap` for network calls given Blob/File/canvas data, plus strict server-side body parsing (positions only, unknown keys → 400, 8 KB cap).

## 9. Screens

- **Host:** Extra Fun (`/dashboard/extra-fun`) → BingoSnap builder (title, size, Line/Full Card, Ranked/First, free centre, timer, prompts with paste-many and reorder, preview) → console `/dashboard/extra-fun/bingosnap/[id]`:
  - lobby: reused `LobbyView`, QR, player chips, "Open presenter screen"
  - countdown
  - hunt: large timer, claims queue with Verify/Reject (reason chips: "photo missing", "doesn't match", "other"), and a "Call forward" hint
  - reviewing
  - results
- **Player:** join (unchanged) → waiting room (camera permission, same as Bring Me) → countdown → board (tap a cell → camera → photo thumbnail in the cell; marked count; a "BINGO!" button when a legal pattern exists) → claim sent ("Head to the host!", Show Host) → verified / rejected (reason, "Keep hunting", attempts left) → time's up → results (rank, list, confetti for the player's own win).
- **Presenter** (`/present/[id]` branches on type): lobby wall, countdown, big timer + claim feed (names, "checking…" / ✓ / ✗), results podium or single winner.
- Visuals reuse `Mascot`, `Backdrop`, `Confetti`, `Countdown`, `PlayerCount` and the existing motion utilities. Every animation has a resting state for reduced motion.

## 10. Invariants

- I-1 No BingoSnap code path writes to Storage, `submissions` or `submission_intents`. Bring Me paths reject BingoSnap games.
- I-2 Player count ≤ the room's pass cap at all times; same triggers as Bring Me.
- I-3 At most one pending or verified claim per player; ≤ 5 attempts.
- I-4 No claim has `received_at > hunt_ends_at + 2 s`.
- I-5 Every claim matches the player's layout pattern for the game's mode.
- I-6 Results are frozen once `results_at` is set; no review after it.
- I-7 Only the owner reviews or transitions; every change bumps `state_version`.
- I-8 Bring Me behaviour and snapshots are unchanged (the full existing suite stays green).

## 11. Acceptance matrix (tests to write in Phase 2+)

| Area | Cases |
|---|---|
| Entitlement | create without a pass → `subscription_required`; trial with an open Bring Me game → `game_limit_reached`; caps 3/10/50/100 exact; upgrade raises the lobby cap; expiry mid-hunt → hunt, review and results still work; expired → can't start |
| Board | sizes 3/4/5; prompt count with and without the centre; duplicate prompts refused; 4×4 ignores free centre; settings locked after `start_hunt` |
| Layout | stable across refreshes; differs between players; SQL = TS vector; centre fixed |
| Claims | valid row/column/diagonal; full card; free centre counted; two lines in one claim refused; foreign or other-game cells; before hunt / after grace refused; 2 s grace accepted; kicked player refused; 10 racing claims → 1; 6th attempt refused |
| Review | non-owner → not found; verify/reject/undo; reject then re-claim; review after results refused |
| Results | ranked order by `received_at`; First mode → one winner; `earlier_claim_pending`; `winner_mismatch`; no winner; pending → `unreviewed` |
| Privacy | extra body keys → 400; >8 KB → 413; Storage, `submissions` and `submission_intents` empty after a full game; network-call scan clean; Network panel shows no image bytes (browser run) |
| Regression | Bring Me snapshots identical; `game_transition` / `begin_submission` refuse BingoSnap; `qa-audit` allowlists updated deliberately |
| UI | 360/390/1280 px, axe clean, keyboard-only host review, reduced motion, refresh restores every screen, photos survive a reload, delete works |

## 12. Next
Phase 2: migrations `20261112000017_bingosnap_schema.sql` and `…18_bingosnap_functions.sql`, a rollback script, `database.types.ts`, `qa-audit` allowlists, and the DB tests above.

## 13. Phase 2 as built (supersedes §3 and §5–§7 where they differ)

Migrations `20261112000017_bingosnap_schema.sql` and `20261112000018_bingosnap_functions.sql`. Changes from the spec above, mostly to match the Phase 2 brief:

- **Win modes are `traditional` | `full_card`** (the spec said "Line"). The **free space is allowed only on odd boards in Traditional mode**, not in Full Card.
- **Free space is a cell row** (`bingo_cells.is_free`, no challenge) with `row_no`, `col_no` and `display_order`, as the brief asks. It stays in the centre for every participant.
- **Statuses:** snapshots report `draft | lobby | active | completed | cancelled`, mapped from `games.status` (`live` → active, `finished` → completed). No second status column, so the existing lifecycle trigger stays authoritative.
- **Claim statuses are only `pending | verified | rejected`.** There is no `unreviewed`: claims still pending when results are frozen stay `pending` and are left out of the results.
- **Participants are `public.players`** (no new table): same join, cookie, capacity trigger and removal. "Participation state" is derived: `active` / `removed`.
- **Review is state-checked rather than version-checked:** a second click gets `already_reviewed`, so a new claim arriving doesn't make the host's click fail with `stale_state`. Lifecycle transitions and settings still need `expectedVersion`.
- **`end_game` freezes the results** (`results_at`) even if they were never announced.
- **Existing readers are untouched.** `player_game_state` / `host_game_state` are not branched; BingoSnap has its own `bingo_player_state` / `bingo_host_state` and routes. The UI phase will route `/join/[code]/lobby` by game type.
- **No TypeScript copy of the layout shuffle:** SQL is authoritative and the snapshot carries each participant's layout.
- **Isolation is done with new triggers, not edits to existing functions.** A BingoSnap game's status/phase can change only while the BingoSnap engine's transaction-local flag `bingosnap.engine` is on (the same pattern as `bringme.ledger_maintenance`). Rounds, photo intents and photo submissions refuse BingoSnap games.
- **Error codes:** see `lib/bingosnap/error-codes.ts`.

## 14. Phase 4 as built: card editor and drafts

Migration `20261112000019_bingosnap_board_drafts.sql`.

- **Drafts:** a board can be saved incomplete as `status = 'draft'` (not joinable). A draft counts toward the plan's open-game limit like any game, because the existing insert trigger applies. "Discard draft" uses the `cancel` transition.
- **One save function:** `bingo_save_board(game | null, expected_revision, settings…, cells[size²], publish)`.
  - Cells are one entry per position, row-major, so no two instructions can share a square, and the length must equal size² (`invalid_board_dimensions`).
  - The free centre's entry must be empty (`free_cell_not_editable`).
  - Instructions are trimmed and limited to 120 characters.
  - The squares are rewritten on each save; no claims can exist before the game starts.
- **Editable until the game starts:** draft and lobby can both be edited. Once `start_game` runs, saves fail with `board_locked`, so every player gets the same challenges.
- **Complete board:** publishing (draft → lobby), saving a lobby board, and starting all need every non-free square filled with distinct instructions. A trigger on `games.status` enforces this whatever the caller. A refused save changes nothing.
- **Concurrency:** `bingo_games.board_revision` is checked on every save, so a second tab's stale save gets `stale_board`. It is separate from `state_version`, which also moves when players join.
- **Pass expiry:** a draft can still be saved after the pass ends; publishing then fails with `subscription_required` (existing trigger).
- **Editor** (`components/bingosnap/board-editor.tsx`, logic in `lib/bingosnap/board.ts`):
  - a clickable grid with arrow-key navigation (an ARIA grid with roving focus) and a focused instruction editor with a 120-character counter
  - typing on a square replaces it; Enter / Shift+Enter move to the next / previous square, Esc goes back to the card, Delete clears, and pasting a list fills the following squares
  - Clear, Previous and Next buttons, three idea chips, "Fill empty squares", and Ctrl/Cmd+S to save
  - resizing keeps instructions in reading order and warns, listing what would be removed, before anything is dropped; turning the free centre on moves its instruction to an empty square or warns
  - a phone-frame "Player preview", and an unsaved-changes guard
  - drafts are saved explicitly (no autosave), so the host decides what is kept
- **Phase 2 API change:** `POST /api/host/bingosnap` now takes positional `cells` (plus `publish`) instead of the list of challenges; `PUT /api/host/bingosnap/[id]/board` saves. `create_bingosnap_game` is kept for compatibility but no longer used by the app.

## 15. Phase 5 as built: joining and the lobby

Migration `20261112000020_bingosnap_lobby.sql`.

- **Joining is Bring Me's, unchanged:** the same QR / `/play` code entry, `/join/[code]`, `POST /api/play/join`, `join_game()`, HttpOnly `bm_player` cookie (only its SHA-256 is stored) and the `enforce_player_insert` trigger. That trigger locks the game row and checks `game_capacity()` (the host's current pass cap), so concurrent joins can't pass the limit, and only `lobby` games accept new players.
- **Identity:** the cookie token is the only identity. A refresh or a second visit restores the same participant (`restored`), and a removed participant's token is refused (`player_removed`). Names are display only: a taken name is refused rather than merged, and request bodies never name a player.
- **Routing by type:** `/join/[code]` and `/join/[code]/lobby` ask `bingo_room_info(code)` first. BingoSnap rooms get their own screens; Bring Me rooms take the existing path untouched (one extra lookup).
- **Player screens** (`components/bingosnap/player-screen.tsx`):
  - an invitation (title, mode and size, timer, headcount)
  - a waiting lobby (name, headcount, mode and goal, a blank card preview with the free centre; challenges stay hidden)
  - 3-2-1, then the participant's own board and timer; time's up; removed / cancelled / ended
  - photo capture is not part of this phase
- **Realtime:** joins, removals and the start already broadcast `{version, phase}` on `game:<id>`. Guests get a channel token from `/api/play/bingosnap/realtime-token`; `useGameSync` gained an optional `tokenUrl`. Without Realtime both sides fall back to the existing 4 s polling.
- **Host lobby** (`components/bingosnap/host-lobby.tsx`, on the game page once published):
  - a presentable stage (QR code, room-code tiles, join link, live arrivals, fullscreen)
  - participants n / pass cap with removal, the limit-reached notice with an upgrade link
  - Start, Cancel, the card summary with **Edit card** (`/dashboard/extra-fun/bingosnap/[id]/edit`, lobby only), and copy fields for the link and code
- **One-step start:** `bingo_start` runs `start_game` → `start_countdown` → `start_hunt` in one transaction, so the hunt opens exactly when the 3 s countdown ends without the host's browser having to act again. All rules are still `bingo_transition`'s (owner, version, ≥ 1 player, the current pass covers everyone). A stale version (someone joined) is retried once by the client. The lobby closes atomically: a join racing the start either lands first and is counted, or gets `game_not_joinable`.
- **After the start** the host page shows a live panel (countdown, hunt timer, players, End game) above the locked card. Claim review comes with gameplay.

## 16. Phase 6 as built: photos on the device (supersedes §8 where they differ)

No server, API or database change. Photos never leave the browser.

- **Modules:**
  - `lib/photos/process.ts`: capture from the live preview (`grabFrame`) or a picked file (decoded through `<img>`, so EXIF orientation is applied), scaled to ≤ 1280 px and JPEG-encoded to ≤ 800 KB, plus a ≤ 360 px thumbnail. Canvas re-encoding drops EXIF/GPS; the original is not kept.
  - `lib/photos/store.ts`: IndexedDB `bingosnap` v1 with two stores keyed `[gameId, playerId, cellId]`: `photos` (schema, thumbnail, size, `takenAt`, `savedAt`, `source`) and `images` (full photo). Both are written in **one transaction** (an interrupted or failed write leaves the previous photo). Falls back to bytes where a browser can't store Blobs, and to a memory store (with a warning) when IndexedDB is unavailable. Errors: `quota`, `interrupted`, `unavailable`, `invalid`.
  - `lib/photos/export.ts`: "Save a copy" on an explicit tap only, via the share sheet (where files can be shared) or a download. Nothing is written to the gallery automatically.
- **Components:** `PhotoCapture` (reusable full-screen camera: live preview, shutter, review, Retake / Save, saved-photo viewer, file fallback, error states), `PhotoBoard` (the card as buttons with thumbnails), `HuntBoard` / `LocalPhotosPanel`, and `useCellPhotos` (thumbnail object URLs created once per saved photo and revoked on replace / delete / unmount; full photos are read only when opened).
- **Rules:**
  - Retakes are allowed until a square is in a **pending or verified** claim (`lockedCellIds`). After time's up the card is view-only.
  - The camera stream runs only while the preview shows; it stops for review, on close and on unmount.
  - The current game's photos are never deleted automatically. Other games' are pruned after 7 days. "Delete from this phone" is offered once the game is over or the player was removed.
- **Change to B-11:** live camera stays the default. The device camera app / file picker (`capture="environment"`) is offered **only** when the live camera fails or its preview stalls, as the Phase 6 brief requires. Picked photos are stored with `source: "file"` so Show Host can label them later.
- **Privacy guards:** a static test forbids network, service-worker, localStorage and base64 code in the photo modules. The browser QA audits every request (no other host, nothing > 8 KB, no JPEG bytes).

## 17. Phase 7 as built: completion engine and Submit

No server or database change: the Phase 2 claim endpoint (`POST /api/play/bingosnap/claim`, `{ cellIds }` only) and `bingo_pattern` are reused.

- **Engine** (`lib/bingosnap/completion.ts`, pure): `evaluateCard({ size, mode, cells, done })` returns:
  - `completed` / `required` / `percent` (rounded down; 100 only when full)
  - `lines` (complete rows, columns, `diag:main`, `diag:anti`, in that order), `full`, `eligible`
  - `claim` (the first complete line's photographed cells, or every non-free cell for Full Card)
  - `winningPositions` and `toGo`

  The free centre counts as done and is never part of a claim. It decides only whether photos exist for a pattern; the Game Master judges the photos.
- **Kept in step with the server:** a PGlite test compares the engine with SQL `bingo_pattern` on 3×3/4×4/5×5, both modes and the free centre. The engine never offers a claim the server would refuse.
- **UI:**
  - `HuntBoard` recalculates from the local photos on every change (capture, retake, missing photo, restore after refresh).
  - `PhotoBoard` rings the winning positions.
  - A banner celebrates the moment a pattern completes (a confetti burst only on the transition, never on a refresh or with reduced motion).
  - `ClaimPanel` shows Submit (enabled only when eligible, the server says `canClaim`, and the hunt is running), a confirmation, and the pending / rejected / verified states.
- **Several complete lines:** all are highlighted; the claim uses the first in the stable order (the server accepts exactly one line).

## 18. Phase 8 as built: server-enforced timer and reliable claims

Migration `20261112000021_bingosnap_claims.sql`.

- **Timer:**
  - `bingo_start` stamps `hunt_started_at` / `hunt_ends_at` from the database clock and broadcasts.
  - Phones and the host show `huntEndsAt` through the server clock offset, so a wrong device clock doesn't matter.
  - `useGameSync({ deadlineOf })` re-reads at the deadline and again after the grace.
  - Accepting or refusing a claim is decided **only** in SQL.
- **Claim rules** (`bingo_submit_claim(token_hash, cell_ids, request_id)`, game row locked `FOR UPDATE`):
  - the session token's player
  - not removed
  - the game live and the hunt open
  - arrival ≤ deadline + 2 s (or ≤ the moment of an early close)
  - not verified, no pending claim
  - fewer than 5 attempts
  - the exact pattern
- **Arrival time:** `statement_timestamp()` decides the deadline and is stored as `submitted_at` (the queue and ranking order). A claim waiting on the lock isn't penalised.
- **Idempotency:** `request_id` is unique per player. A replay, even after the deadline, returns the current state and creates nothing. The client generates one id per attempt, reuses it for every retry and renews it after a rejection.
- **History:** one row per attempt, never updated except by the host's review. "Verified" is final for that player.
- **Early end:**
  - **End hunt now** (`close_hunt`): the deadline becomes now, there's no grace, claims already received stay reviewable, and players see Time's up.
  - **End game** finishes everything, and reviews close.
- **Host queue:** the live panel lists every claim in received order (name, pattern, attempt, challenges, time since the start, status). Verify / reject comes next.

## 19. Phase 9 as built: host validation dashboard

No server or database change (Phase 2's `bingo_review_submission` + route).

- **How validation works:** a player submits, their name appears under **Call forward** with the squares to check, they show the photos on their own phone, and the host taps **Verify** or **Reject** (optional reason). Photos never reach the host's device.
- **Queue model** (`lib/bingosnap/queue.ts`, pure): built from the host snapshot only, deduplicated by submission id.
  - **pending:** by `submittedAt`, then id; the first one is "up next"
  - **verified:** by rank
  - **history:** decided claims, the most recent first
  - also a "verified players" set and the First-wins leader
- **Decisions:**
  - Each submission has its own in-flight guard (double taps).
  - Server refusals are explained: already decided (another tab), superseded (the player already sent a newer claim), removed player, reviews closed.
  - **Undo** is `reset`, while live.
- **Realtime:** reviews bump the version and broadcast. The dashboard re-reads, and so do players' phones, which show Verified, or Rejected with the reason (and, after the deadline, that no more claims are possible).
- **Lifecycle:** End hunt now / End game stay the same. After End game the dashboard is read-only history.

## 20. Phase 10 as built: polish

UI only; the rules, APIs and data are unchanged.

- **Two views of the card:**
  - **Card**: square cells, clamped text; the full text is in the label and the camera title.
  - **List**: every instruction at full size, the best way to read long ones on small phones or with a screen reader.
  - The choice is a per-device convenience (`localStorage`, failure-tolerant).
- **Order of the player screen during the hunt:**
  1. header: title + timer, coral in the last minute
  2. goal
  3. progress, mode and view toggle
  4. then, when relevant (eligible, or any claim): the BINGO! banner (until a claim is sent) and the claim panel
  5. the card
  6. otherwise the Submit hint
  7. the privacy note, and Save copies
- **Feedback:**
  - **flags:** squares of the last rejected claim, cleared per square by a newer photo
  - **motion** (transform/opacity only, all off under reduced motion): staggered pop of the winning squares, a bounce on a fresh check badge, confetti bursts only on transitions (a pattern completing, verification), never on a refresh
  - **focus:** moves to the claim status after Submit
- **Announcements:** one polite region for saves, and one assertive region for the last minute, the last 10 s and Time's up, each said once.
- **Performance:** `PhotoCapture` is loaded with `next/dynamic` on the first tap (prefetched on idle during the hunt). `PhotoBoard` / `PhotoList` are memoised with stable props.

