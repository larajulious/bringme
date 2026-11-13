# BringMe! Phase 2: Realtime Synchronization Optimization

_2026-11-13. Implemented and verified locally; **not deployed, not committed**. Nothing was run against the hosted Supabase project._

**Deployment prerequisite:** Phase 1 (`20261113000001_submission_lock_order.sql`, commit `80e6093`) must be applied to the hosted database first. It is committed, but this report cannot confirm it is applied. The Phase 2 migration checks for it and refuses to run without it.

---

## A. Executive Summary

Before Phase 2, every visible change in a game sent one Realtime hint to **everyone** in the game, and every phone, the host console and the presenter re-read their full snapshot. The host console also re-read the roster and the round list on every change. A photo submission or a review decision, which only the host's screens show, therefore cost N player reads. In a 50-player round that meant roughly 100 such events × 50 phones.

Phase 2 keeps the existing architecture (PostgreSQL as source of truth, `state_version`, Broadcast hints, authoritative re-reads) and adds **audience awareness**:

- Every hint now carries a **scope**. Host-only news (photo submissions, Bring Me review decisions, BingoSnap claims) goes to a new **owner-only private topic** `game:<id>:host`. Players never receive it.
- Players **delay join hints** by 1–2.5 s (headcount only) and **skip** BingoSnap review hints unless they hold a claim. Every phase change still reaches every phone immediately.
- The host console and presenter re-read side lists only when that list's data changed, using new **fingerprints** in the host snapshot.

**Measured locally** (real PostgreSQL, the repo's migrations, the real client sync core, simulated clients; section G). In a 50-player, 2-round game:

| | Before | After | Change |
|---|---:|---:|---:|
| Player snapshot reads | 12,061 | 1,356 | **−89%** |
| Realtime messages delivered | 12,178 | 2,475 | **−80%** |
| All sync database reads | 13,753 | 2,389 | **−83%** |
| Serverless invocations (estimated by route) | 12,925 | 2,224 | **−83%** |
| Missed phase transitions / clients stale at the end | 0 / 0 | 0 / 0 | – |

Phase 1 locking is untouched: `complete_submission` keeps its locks, with exactly one line changed (where its hint is sent). The 30 s safety re-read and the 4 s fallback polling are unchanged.

---

## B. Original Problems

| ID | Finding (from `BRINGME_SUPABASE_AUDIT.md`) | Addressed here |
|---|---|---|
| **G2** | O(N²) fan-out: every submission, review and join broadcast to all players, who all re-read | Yes: scopes plus the host-only topic, and debounced joins |
| **G7** | Host console re-fetched roster and rounds on every version | Yes: fingerprint and dependency keys |
| **G3** | Host and presenter re-sign every photo URL on each change | **Partly.** Signing now happens only when the submissions list changed, but during photo and review bursts it changes on almost every event, so the count is unchanged. Phase 3 (URL caching) remains |
| **G4** | Realtime failures silently become 4 s polling | Observability improved: a host whose host topic fails shows "basic mode" and logs a console warning. Production Realtime remains unverified |
| G6 | Sockets stay open after a game ends | Not changed (out of scope for Phase 2) |
| G9, G13 | `syncBurst` and `realtime-token` full snapshots | Not changed |

---

## C. Architecture Changes

### C.1 Event routing (chosen design: scope metadata plus a host-only topic)

| Scope | Topic | Who subscribes | Player behaviour | Host / presenter behaviour |
|---|---|---|---|---|
| `all` | `game:<id>` | everyone | re-read now | re-read now |
| `roster` | `game:<id>` | everyone | re-read after 1–2.5 s (debounced, jittered) | re-read now |
| `claims` | `game:<id>` | everyone | re-read now **only if** this player holds a claim (BingoSnap), otherwise skip | re-read now |
| `host` | **`game:<id>:host`** | owner only | never delivered | re-read now |

Why both mechanisms:

- **Scope metadata alone** would still deliver host-only hints to every phone, so it wouldn't reduce Realtime message deliveries, which count against the plan quota.
- **A host-only topic alone** can't express "players: delay this" or "only claim holders".
- The combination uses the existing private-channel authorization. Hosts listen to two channels on **one** WebSocket, so the connection count is unchanged.

Payloads stay `{version, phase, scope}`, with no IDs, names, prompts or claim data. Unknown or missing scopes are treated as `all`, so an older database and newer clients work together safely.

### C.2 Version handling (`lib/game/sync.ts`)

- `state_version` still bumps for **every** change, including host-only ones. There is one version sequence across both topics (tested).
- A player that skips a hint does **not** record that version as seen. Its next relevant hint is newer still and triggers a re-read. Any snapshot it reads is the latest one, which includes every skipped change, because snapshots are built in one SQL statement.
- Unchanged guarantees:
  - Older snapshots never overwrite newer ones.
  - Fetches are serialised and coalesced (one in flight, one queued).
  - Optimistic `expectedVersion` checks on host actions still apply.
- **Debounce:** trailing and bounded. The first join hint starts a timer of 1,000 ms plus up to 1,500 ms of random jitter, and later join hints don't postpone it. The timer is cancelled as soon as the client holds a snapshot at least as new as the hint it was waiting for, for example after an immediate `all` hint or a reconnect re-read.
- **Health:** `combineRealtime(main, host)` means a host relies on hints only when **both** of its topics are subscribed. Otherwise it falls back to the existing 4 s polling and shows "basic mode". `fallbackPlan()` contains the existing timers (30 s / 4 s / 6 s grace), now unit-tested.

### C.3 Host side lists (`lib/game/refresh-keys.ts`)

| List | Re-read when | Key |
|---|---|---|
| Roster (console, lobby, presenter) | a player joins, is removed or is restored | `rosterKey` = md5 of active player IDs (from the database) |
| Round list (console) | a round is added, opened, closed or replayed, or the game status changes | status, totalRounds, roundsRemaining, round id and status |
| Ranked submissions (console, presenter) | a photo, a review decision, a removal, or a round, phase or official-winner change | `submissionsKey` = md5 of (id, status, removed) for the current round, plus round, phase and winner |

Without the database fingerprints (older database), every key falls back to the version, which is the pre-Phase-2 behaviour.

---

## D. Event Classification Matrix

Each row lists the database event, its scope and topic, which clients must re-read, and why. "Players" means guest phones, "Host" the host console, "Presenter" the projector tab (also the owner).

### Bring Me

| Event | Source (function) | Scope / topic | Players | Host | Presenter | Reason |
|---|---|---|---|---|---|---|
| Player joins | `join_game` → `players_bump_version` (INSERT) | `roster` / game | debounced 1–2.5 s | now | now | Players only show the headcount, in the lobby |
| Same browser rejoins | `join_game` (restore) | no bump | – | – | – | Nothing visible changes (unchanged) |
| Player removed, or restored | host `UPDATE players.kicked_at` → trigger | `all` / game | now | now | now | The removed player must see it at once; headcount |
| Start game, countdown, restart countdown, round open | `game_transition` | `all` / game | now | now | now | Phase change; the round prompt is revealed at the server start time |
| Photo tap | `begin_submission` | no bump | – | – | – | Nothing visible (unchanged) |
| **Photo accepted** | `complete_submission` | **`host` / host** | **none** | now | now | Only host screens show photos. The submitter's own screen uses its own response |
| **Review decision** (approve, disqualify, undo) | `review_submission` | **`host` / host** | **none** | now | now | Outcomes reach players only with the official announcement |
| Close submissions, move to review | `game_transition` | `all` / game | now | now | now | Phase / round status change |
| Winner announced | `game_transition` | `all` / game | now | now | now | Every phone shows the winner and its own review result |
| Next round, end game, cancel, archive | `game_transition` | `all` / game | now | now | now | Phase / lifecycle change; final results |
| Round added live | `add_game_round` | `all` / game | now | now | now | "Round n of N" changes |
| Round replayed | `replay_round` | `all` / game | now | now | now | New countdown for everyone |
| Game Pass change raises or lowers an open lobby's cap | `sync_lobby_capacity` | `all` / game | now | now | now | Rare; capacity shown in the lobby |
| Discarded invalid photo | `discard_submission_intent` | no bump | – | – | – | Unchanged |

### BingoSnap

| Event | Source | Scope / topic | Players | Host / Presenter | Reason |
|---|---|---|---|---|---|
| Joins / removals | same triggers as Bring Me | `roster` / `all` | debounced / now | now | as above |
| Board saved or published, winner rule changed | `bingo_save_board`, `bingo_update_settings` | `all` / game | now | now | Lobby shows the board shape and rules |
| Start, countdown, hunt, close hunt, announce results, end, cancel, archive | `bingo_start`, `bingo_transition` | `all` / game | now | now | Phase and timer changes |
| **Claim submitted** | `bingo_submit_claim` | **`host` / host** | **none** (the claimant gets its snapshot in the response) | now | Only the host queue shows claims |
| Claim submitted **and** it settled an expired hunt (active → reviewing) in the same transaction | `bingo_submit_claim` | **`all` / game** | now | now | A phase change must reach everyone (tested under real concurrency) |
| **Claim reviewed** (verify, reject, undo) | `bingo_review_submission` | **`claims` / game** | now **only if the player holds a claim**, otherwise skip | now | A review can only concern a player who has a claim |
| Claim reviewed **and** it settled an expired hunt | `bingo_review_submission` | **`all` / game** | now | now | Phase change (tested) |
| Hunt deadline passes | none (settled lazily; clients re-read at the deadline +60 ms and +2.2 s) | – | timer re-read | timer re-read | Unchanged: the timer stays server-authoritative |

---

## E. Files Modified

| File | Change |
|---|---|
| `supabase/migrations/20261113000002_realtime_audience.sql` (**new**) | Phase 1 precondition check. `broadcast_game(…, scope)` and `bump_game_version(…, scope)` overloads, with the old signatures delegating to `all`. Join trigger sends `roster`, kick/restore sends `all`. `can_listen_game_topic` adds the owner-only `game:<id>:host`. `host_sync_keys` adds fingerprints to host views of `game_state_json`. `complete_submission` (Phase 1 body with one line changed), `review_submission`, `bingo_submit_claim` and `bingo_review_submission` send their scopes. Bodies were generated from the latest definitions with asserted single-line substitutions. New internals are revoked from clients |
| `supabase/rollback/20261113000002_realtime_audience_revert.sql` (**new**) | Restores the previous bodies verbatim (keeps the Phase 1 locks) and drops the overloads |
| `lib/game/sync.ts` | `SyncScope`, `scopeOf`, `guestRoute` / `routeEverything` policies, bounded debounce with cancel-on-newer, `stats` counters, `combineRealtime`, `fallbackPlan` and the timer constants (moved here unchanged) |
| `lib/game/refresh-keys.ts` (**new**) | `rosterKey`, `roundsKey`, `submissionsKey` dependency keys with version fallback |
| `lib/game/types.ts` | `HostSnapshot.rosterKey?`, `submissionsKey?` |
| `components/game/use-game-sync.ts` | Routing policy per role; hosts also join `game:<id>:host` (same socket); either topic down means basic-mode polling, with a console warning; optional `claimsRelevant` |
| `components/game/host-console.tsx` | Roster, rounds and submissions effects keyed on dependency keys instead of `s.version` |
| `components/game/lobby-view.tsx` | Roster keyed on `rosterKey` (also fixed a stale comment about polling) |
| `components/game/presenter-screen.tsx` | Roster and submissions keyed on dependency keys |
| `components/bingosnap/player-screen.tsx` | `claimsRelevant`: the player holds at least one claim |
| `tests/db/realtime-audience.test.ts` (**new**) | 12 DB tests: topic and scope of every event class, host-topic authorization, fingerprints, game isolation, BingoSnap claims, reviews and settle |
| `tests/game-sync.test.ts` | 24 new unit tests: routing, skipped and out-of-order versions, reconnect, debounce, claims, fallback, refresh keys |
| `tests/concurrency/engine-concurrency.mjs` | 6 new real-Postgres checks: 2/10/30/50 concurrent photos route to the host topic; 30 simultaneous joins; a queued claim that settles the hunt reaches everyone |
| `tests/db/submissions.test.ts`, `tests/db/bingosnap.test.ts`, `tests/db/bingosnap-lobby.test.ts` | Updated to the new contract (the payload has `scope`; a submission's hint is on the host topic) |
| `tests/bench/realtime-sync.bench.mjs` (**new**), `package.json` (`bench:realtime`) | Repeatable before/after benchmark (section G) |
| `supabase/README.md`, `PROJECT_STATUS.md` | Migration 36 entry; status section |

UI, pricing, Polar, authentication, game rules and timers are unchanged.

---

## F. Test Results

| Suite | Result |
|---|---|
| `npm test` (unit + PGlite DB) | **689 / 689 passed**, 0 skipped. That includes 36 new tests (12 DB, 24 unit) and 3 updated ones |
| `npm run test:concurrency` (real PostgreSQL, parallel connections) | **52 / 52 passed**: all 46 earlier checks, including every Phase 1 deadlock regression, plus 6 new ones |
| `npx tsc --noEmit` | passed |
| `npx eslint .` | passed |
| `npm run build` | passed |
| Migration safety (local throwaway Postgres) | Applies cleanly; re-run is idempotent; rollback restores the previous bodies **with the Phase 1 locks intact**; re-apply works; **without Phase 1 it refuses** with `phase2_precondition` and changes nothing; new internals are executable by no client role |

### Coverage of the requested scenarios

| # | Scenario | Where | Result |
|---|---|---|---|
| 1 | Multiple players joining at once | concurrency: 30 simultaneous joins give 30 `roster` hints with distinct versions and 30 players; unit: a 30-hint burst causes one delayed read | pass |
| 2 | Host-only events with 10/30/50 players | unit: 10/30/50 host-only hints cost a player 0 reads; concurrency: 2/10/30/50 concurrent photos give N host-topic hints and 0 player-topic hints | pass |
| 3 | Skipped broadcast versions | unit "skipped versions never block a later relevant hint" | pass |
| 4 | Out-of-order broadcasts | unit "late older hint costs nothing" plus the existing ordering tests | pass |
| 5 | Reconnect after many missed events | unit: the SUBSCRIBED re-read brings the latest state and cancels the pending delayed read | pass |
| 6 | Player removal during gameplay | DB: a kick mid-round is `all` on the players' topic; unit: applied immediately; benchmark: one kick per run | pass |
| 7 | Concurrent submissions | concurrency (Phase 1 cases unchanged, plus routing checks) | pass |
| 8 | Winner announcements | DB: announce and end are never host-only; benchmark: 0 missed `winner_announced` | pass |
| 9 | Game completion | DB: the final hint carries the final version, and a finished game sends nothing more | pass |
| 10 | BingoSnap claims and validation | DB: claim → host topic, review → `claims`, settle → `all`; concurrency: a queued claim that settles the hunt → `all`; unit: `claims` routing | pass |
| 11 | Realtime failure and fallback polling | unit: `combineRealtime` and `fallbackPlan`; polling alone keeps a player correct | pass (logic only; see "Unverified") |
| 12 | Multiple games independently | DB: two games' hints stay on their own topics | pass |

**Pre-existing flake:** `tests/db/authorization.test.ts` "submissions are rejected once the round is closed" fails about 1 run in 3 **on the untouched commit as well**, due to a same-millisecond timing issue (found in Phase 1). It passed in this run. It was not changed.

**Unverified (requires a staging or hosted Supabase project and real devices):**

- Joining the private `game:<id>:host` channel through Supabase Realtime and its RLS check.
- supabase-js automatically rejoining after a denied join (relevant when the app is deployed before the migration).
- Real network latency, mobile browser suspension, background tabs.
- A browser check of the host console "Live" indicator.

The local shim emulates `realtime.send` and the `realtime.messages` policy, not the Realtime server.

---

## G. Performance Comparison

### Methodology (`npm run bench:realtime`; raw JSON with `BENCH_OUT=file`)

- **Setup:** two throwaway PostgreSQL servers.
  - *Before:* all migrations up to Phase 1, with legacy client behaviour (re-read on every hint; side lists on every version).
  - *After:* all migrations, with Phase 2 clients.
- **Clients:** per game, N players, 1 host console and 1 presenter. Each runs the real `GameSyncCore`, and every read is a real query (`player_game_state`, `host_game_state`, roster, rounds, `host_game_state` + `round_ranking` for the submissions route).
- **Realtime emulation:** a poller delivers each `realtime.messages` row to the subscribers of its topic.
- **Script:**
  - Lobby: N players join within ~3 s.
  - 2 rounds, each with a countdown (including the existing 4-read clock burst), the round open (including a boundary re-read), and photos tapped over ~6 s with 0.3–2 s uploads.
  - One player removed during round 1.
  - Close, review, the host approves every photo (40 ms apart), winner, next round / end.
- **Not emulated:**
  - Network latency (local socket only).
  - Storage: photo URL signing is **counted, not executed**.
  - Vercel: invocations are **estimated** by mapping each call to its API route.
  - The 30 s safety re-read (no step lasts 30 s), focus and visibility events.
- **Connection pool:** 12 connections per role, a stand-in for PostgREST's pool; the real size is unverified.

### Results (measured locally)

| Metric | N=10 before | N=10 after | N=30 before | N=30 after | N=50 before | N=50 after |
|---|---:|---:|---:|---:|---:|---:|
| Broadcasts (players' topic + host topic) | 61 + 0 | 24 + 37 | 161 + 0 | 44 + 117 | 261 + 0 | 64 + 197 |
| **Realtime messages delivered** | 648 | 305 (−53%) | 4,614 | 1,187 (−74%) | 12,178 | 2,475 (−80%) |
| **Player snapshot reads** | 633 | 259 (−59%) | 4,580 | 806 (−82%) | 12,061 | 1,356 (−89%) |
| Host console snapshot reads | 30 | 30 | 90 | 90 | 150 | 150 |
| Roster reads (console + presenter) | 124 | 24 (−81%) | 324 | 64 (−80%) | 518 | 104 (−80%) |
| Round-list reads | 62 | 10 (−84%) | 162 | 10 (−94%) | 259 | 10 (−96%) |
| Presenter snapshot reads | 61 | 61 | 161 | 161 | 261 | 261 |
| Submissions-route calls (2 queries each) | 110 | 110 | 310 | 308 | 504 | 508 |
| **All sync DB reads** | 1,020 | 494 (−52%) | 5,627 | 1,439 (−74%) | 13,753 | 2,389 (−83%) |
| Action DB calls (joins, photos, host actions) | 81 | 81 | 221 | 221 | 361 | 361 |
| Serverless invocations (estimated) | 823 | 449 (−45%) | 5,110 | 1,334 (−74%) | 12,925 | 2,224 (−83%) |
| Photo URL signings (counted; Phase 3) | 812 | 812 | 7,256 | 7,228 | 19,908 | 20,022 |
| Phase transitions reaching phones, p50 / p95 / max (ms) | 1 / 2 / 2 | 1 / 2 / 2 | 1 / 3 / 4 | 1 / 3 / 3 | 1 / 3 / 4 | 2 / 15 / 16 |
| Join headcount reaching phones, p50 / p95 (ms) | immediate | 1,945 / 2,477 | immediate | 1,113 / 2,236 | immediate | 1,181 / 2,174 |
| Host-only change reaching the host, p95 (ms) | 327 | 322 | 127 | 126 | 121 | 125 |
| Missed transitions / stale at end / version regressions | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

How to read it:

- **Bursts:** during photo and review bursts, players now make **zero** reads; their remaining reads are phase changes, the clock burst and boundary re-reads.
- **Host-only hints:** about 3/4 of all hints at N=50 are host-only and now reach 2 clients instead of 52.
- **Not reduced:** host and presenter snapshot reads (the host needs every change), the submissions route and photo signing (the list really changes on each photo or review; that is Phase 3), and action calls (unchanged by design).
- **Latency:** the phase-transition p95 at N=50 (15 ms vs 3 ms) is local pool contention when 50 phones re-read at the same instant; it is not a protocol delay. Both are far below real network latency. The join headcount delay of up to ~2.5 s is the intended debounce.
- **"Missed transitions"** counts, for every phone present through the game, whether it observed `countdown`, `active`, `reviewing` and `winner_announced` of every round, and `finished`.

### Estimated production effect (**not measured**)

Fewer reads should mean less PostgREST and Postgres work and fewer serverless invocations per game, in roughly the proportions above. Network latency adds to every re-read equally in both modes. **No claim is made about database CPU or memory**, because neither was measured; confirm with `pg_stat_statements` and the Realtime usage report after deployment (audit section I).

---

## H. Security Review

- **Host topic authorization.** `can_listen_game_topic` accepts `game:<uuid>:host` only when the caller owns that game (`auth.uid()`). It is regex-anchored and tested against the owner, another host, a guest of the same game, a forged `game_id` claim, an anonymous visitor and malformed topics. Through the actual `realtime.messages` select policy, a guest of the game reads **0** host-topic messages.
- **Guest isolation is unchanged.** Guest tokens still match only `game:<id>` exactly; `substr(topic, 6)` for a `:host` topic never equals a bare UUID. Players' snapshots are unchanged and contain no fingerprints (tested).
- **No publishing.** There is still no INSERT policy on `realtime.messages`, and no client can publish to either topic (tested).
- **Payload exposure.** Payloads are `{version, phase, scope}`. On the shared topic, the scope tells a player only the *class* of an event ("someone joined", "a claim was reviewed"). Host-only events are not visible to players at all; previously players received an undifferentiated hint for every one of them. No IDs, names, prompts or claim contents travel.
- **New internals.** `broadcast_game(…, text)`, `bump_game_version(…, text)` and `host_sync_keys` are revoked from `public`, `anon` and `authenticated` (tested, and the existing QA privilege audit passes).
- **Fingerprints.** `rosterKey` and `submissionsKey` are md5 digests of IDs and statuses, returned only in host views. Those views are owner-checked by `host_game_state`, `game_transition`, `review_submission`, `replay_round` and `add_game_round`.
- **RLS and authorization.** No RLS policy was weakened, no grant widened, and authentication is unchanged.

---

## I. Remaining Risks

1. **Hosted Realtime is unverified** (section F). This is the most important item to check on staging.
2. **Deployment window, old pages.** After the migration, host consoles opened **before** the app deploy don't listen to the host topic. Until they reload, they see new photos and claims only via the 30 s safety re-read or the next phase change. Mitigation: deploy the app first, migrate between events (or ask hosts to reload), see section J.
3. **App deployed but database not yet migrated.** Hosts' host-topic join is refused, so hosts run in basic mode (4 s polling, about 2 clients per game) until the migration. This is correct but slightly more traffic. Players are unaffected.
4. **Join headcount delay.** Players' "N players joined" lags by up to 2.5 s, by design. Host and presenter are immediate. Capacity enforcement is untouched, because it is in SQL at join time.
5. **BingoSnap edge case.** If a claimant's claim response was lost on every retry, its phone has no claim locally and skips `claims` hints. It then sees the review at the next `all` hint, the 30 s safety re-read, on focus or reconnect, or when it retries (the server answers `claim_pending` or `already_verified`). The delay is bounded, not indefinite.
6. **Hints can arrive out of order across the host's two channels.** This is harmless: versions decide, and it is tested.
7. **Not addressed (later phases):** photo URL re-signing (G3, Phase 3), sockets after game end (G6), the `syncBurst` and `realtime-token` full snapshots (G9, G13), retention (G5). The 30 s safety re-read and 4 s fallback were deliberately kept.
8. **Benchmark limits.** Local only: one game at a time (isolation is DB-tested), no network, Storage not executed, invocations estimated by route, a stand-in pool size.
9. **Pre-existing:** the `reconnecting` connection state is never produced (the chip shows "Connecting…" or "basic mode"); there is one known flaky DB test.

---

## J. Production Deployment

### Order

1. **Phase 1 first.** Check whether it's applied:
   ```sql
   select pg_get_functiondef('public.complete_submission(text,uuid,uuid,jsonb)'::regprocedure) like '%p.game_id for no key update%' as phase1_applied;
   ```
   If this returns `false`, apply `20261113000001_submission_lock_order.sql` and verify, as in the Phase 1 instructions.
2. **Deploy the app (Phase 2 client code).** It works with the unmigrated database: hints without a scope are treated as `all`, and hosts poll every 4 s because the host topic is refused. Smoke-test a short game.
3. **Apply `20261113000002_realtime_audience.sql`**, preferably when no games are live: `npx supabase db push --dry-run`, then `npx supabase db push`, or run it in the SQL Editor inside `begin; … commit;`. It refuses to run without Phase 1. It is quick, with no table changes.
4. **Ask any host with an open console to reload**, or wait for current games to end.

### Smoke tests (staging first, then production)

1. **Host console:** the connection chip shows **Live**, not "basic mode", which means both topics are subscribed. In the browser devtools WebSocket frames, joins to `realtime:game:<id>` and `realtime:game:<id>:host` both succeed.
2. **Two phones in a game:**
   - Joining: the host lobby updates immediately; each phone's headcount updates within ~2.5 s.
   - Start, countdown and round reach both phones instantly.
   - While photos come in, the phones' WebSocket frames show **no** `state` messages; the host's list updates.
   - Close, announce and end reach both phones; removing a player mid-round reaches that phone at once.
3. **BingoSnap:** a claim appears in the host queue immediately; verifying it updates the claimant; a phone without a claim gets no review messages.
4. **Isolation:** with a guest token, joining `game:<id>:host` must fail with `CHANNEL_ERROR`.
5. **SQL check of hint routing (last hour):**
   ```sql
   select (topic like '%:host') as host_topic, payload->>'scope' as scope, count(*)
   from realtime.messages where inserted_at > now() - interval '1 hour' group by 1, 2 order by 1, 2;
   ```
6. **Load:** compare `pg_stat_statements` call counts for `player_game_state` per game before and after (audit I.4).

### Rollback

- **Database:** run `supabase/rollback/20261113000002_realtime_audience_revert.sql` in a transaction. All hints return to the shared topic without a scope. **Phase 1's locks are kept** (verified locally).
- **App:** the Phase 2 app keeps working after a database rollback: it treats a missing scope as `all`, and hosts fall back to 4 s polling when the host topic is refused. For a full revert, also redeploy the previous app version.
- **Verify a rollback:**
  ```sql
  select to_regprocedure('public.broadcast_game(uuid,bigint,public.game_phase,text)') is null as reverted;
  ```

### Backward compatibility summary

| Database \ App | Old app | Phase 2 app |
|---|---|---|
| Pre-Phase-2 DB | today's behaviour | correct; hosts poll 4 s |
| Phase 2 DB | players correct (they re-read more); **old host pages miss host-only hints until reload (30 s safety)** | intended behaviour |

Nothing was committed, pushed, deployed or run against production.
