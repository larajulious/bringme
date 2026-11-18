# BringMe! Supabase Memory & Performance Investigation

_2026-11-18. Scope: the repository at `9b932a9` plus the monitoring snapshot you supplied (Nov 17, 8:17–9:17 PM: memory usage 385.54 MB, memory commitment 1.21 GB "SEVERE", CPU 0.99%). Builds on `BRINGME_SUPABASE_AUDIT.md` (11-13), Phase 1–3 reports and `BRINGME_PRODUCTION_MIGRATION_RECONCILIATION.md`; nothing they established is re-derived here._

**Production access:** none this time. The Supabase CLI link still exists, but its login token has expired and `supabase login` is interactive. I did not use the service-role key against production. **Every production statement below is therefore a query for you to run (section E). No hosted database, Storage object, migration or deployment was touched.**

Labels: **Confirmed** (code or measured), **Likely** (strong evidence, not verified in production), **Potential** (plausible, needs measurement), **Baseline** (infrastructure, not application code).

---

## A. Executive Summary

1. **The memory commitment looks like infrastructure baseline, not something the app is driving (Baseline, medium–high confidence).**
   - Commitment was **1.21 GB on Nov 13 and is 1.21 GB again on Nov 17**, four days and many code changes apart.
   - CPU in the observation window was **0.99%**, so the database was essentially idle.
   - The Free plan runs on Nano compute ("up to 0.5 GB" memory, per Supabase's compute docs).
   - Linux commitment (`Committed_AS`) counts virtual memory that processes have **reserved**, not RAM they use. On a 0.5 GB box hosting Postgres plus Supabase's co-located services, a commitment of 2–3× RAM at idle is the expected shape.
   - A load-driven problem would move with traffic. This number hasn't moved.
2. **No evidence that application code inflates Postgres memory (Confirmed for code).**
   - The app never opens a direct Postgres connection. Everything goes over PostgREST, Storage, Auth or Realtime HTTP/WebSocket, so Postgres backend count is set by Supabase's service pools, not by the number of players.
   - No Postgres Changes, Presence, `LISTEN`, replication slots, cron jobs or long transactions.
   - Result sets are bounded.
   - The one real peak-pressure bug (the photo-completion deadlock) is fixed, and the fix was verified in production on 11-13.
3. **The biggest live risk is deployment drift, not code (Likely, P0 to verify).**
   - On 11-13 production had **Phase 1 but not Phase 2** (`20261113000002_realtime_audience`), and `PROJECT_STATUS.md` still says it isn't applied.
   - If the Phase 2+ app is deployed against that database:
     - every host console, presenter and TV tab is refused the `:host` channel and **polls every 4 s for as long as it's open**;
     - every phone re-reads on every photo and review (the O(N²) pattern Phase 2 removes).
   - That multiplies database **calls**, not resident memory. It is still the cheapest large win available.
4. **Three small, verified waste patterns were fixed locally** (section C): Realtime sockets and 30 s re-reads kept alive on finished games, full snapshots built just to mint Realtime tokens, and a token-refresh timer that could outlive its screen.

**Bottom line:** keep Free for now if events stay small. Verify the deployment state, then let the measurements in section E decide. A Pro upgrade won't be driven by memory commitment; it will be driven by Realtime quotas or sustained swap paging (section G).

---

## B. Confirmed Problems

| # | Finding | Evidence | Impact | Confidence | Priority | Fix |
|---|---|---|---|---|---|---|
| F1 | **Commitment is a static baseline** | 1.21 GB on 11-13 and 11-17; CPU 0.99%; Nano = 0.5 GB | Warning is persistent but not traffic-driven | Medium–High (**Baseline**) | P1 (measure) | Section E queries. No code fix exists for it |
| F2 | **Phase 2 migration likely missing in production** | Reconciliation §B #44 (11-13); `PROJECT_STATUS.md` header; `lib/game/sync.ts` `combineRealtime` (refused host topic → `"down"`), `fallbackPlan("down")` = 4 s | Hosts, presenters and TVs poll every 4 s indefinitely. Players re-read on every host-only event (bench, N=30: 4,580 vs 806 player reads per 2 rounds) | **Likely** | **P0** | Apply `20261112000012` + `20261113000002` exactly as in the reconciliation plan §F–G (backup first) |
| F3 | Realtime channel + 30 s re-read + focus re-reads stay active on **finished/canceled** games | `bump_game_version` skips `status in ('finished','canceled')` (`20261113000002…sql:61`), so such a game is **never** broadcast again. `FinishedResults` (`components/game/finished-results.tsx:28`), the player results screen (`player-game.tsx:69`) and the presenter/TV final screens kept `useGameSync` fully active | 1 socket + 1–2 channel joins + 2 reads/min per open tab, for zero benefit; a host revisiting an old game reopened all of it. With F2, the host pages poll every **4 s** | **Confirmed** | P1 | **Fixed** (C.1) |
| F4 | Realtime-token routes built the **full game snapshot** to read two IDs | `app/api/play/realtime-token/route.ts`, `app/api/play/bingosnap/realtime-token/route.ts` (audit G13). The BingoSnap snapshot also evaluates the owner's Game Pass (recursive `pass_entitlement`) | 1 full snapshot per phone per page load + 1/hour; ~30 per join wave at N=30 | **Confirmed** | P2 | **Fixed** (C.2) |
| F5 | Token-refresh callback could re-arm after unmount | `use-game-sync.ts`: the refresh `setTimeout` callback awaited `fetchToken()` without re-checking `cancelled` | A leaked hourly token fetch (1 DB read each) when unmount races a refresh | **Confirmed** (rare) | P3 | **Fixed** (C.1) |
| F6 | Clock-sync burst = **4 full snapshot reads** per phone per countdown | `use-game-sync.ts` `syncBurst`, called from `player-game.tsx:87` (audit G9) | 120 snapshot reads per round at N=30, in a ~1 s burst | **Confirmed** | P2 | **Proposal only** (D.2): it touches capture timing |
| F7 | Synchronised boundary re-reads at countdown end / round open | `use-game-sync.ts` boundary effect (`+60 ms`) | 2 × N reads in the same instant | Confirmed | P3 | **Leave.** Needed for a fair, simultaneous reveal |
| F8 | `getClaims()` in `proxy.ts` may be an Auth network call per signed-in request | `lib/supabase/proxy.ts`; guest tokens signed with the legacy HS256 secret suggest the project may still use HS256 | Extra Auth + `auth` schema query per host/admin request | **Potential** | P2 | Check Dashboard → JWT Keys. Migrate to asymmetric keys only after planning guest tokens (audit M3) |
| F9 | No automatic retention | `platform_settings.photo_retention_days` is not enforced; manual admin cleanup migration `20261116000003` not yet applied | DB and Storage **size** (not memory) | Confirmed | P2 | Apply the admin cleanup first; schedule later (D.3) |
| F10 | `image_cleanup_classify` scans every object in the bucket on each admin page view | `20261116000003_admin_image_cleanup.sql:25-38` | Admin-only, rare; grows with photo count | **Potential** | P3 | Fine at current scale. Revisit above ~50k objects |
| F11 | `next`, `@supabase/*` pinned to `"latest"` | `package.json` | A redeploy can silently change Realtime/Auth behaviour | Confirmed | P3 | Pin exact versions (16.4.6 / 2.119.0 / ssr 0.12.7 are installed) |

**Checked and found correct (no action):**

- **Browser client:** `@supabase/ssr` singleton.
- **Server clients:** per request (`lib/supabase/server.ts`, `proxy.ts`).
- **Service-role client:** per call, `server-only`, no session, no auto-refresh.
- **Guest Realtime client:** one per mounted hook, torn down via `removeChannel`. realtime-js disconnects the socket once no channels remain (`RealtimeClient._remove` → `disconnect`), so there are no duplicate subscriptions, and React Strict Mode's double effect is safe because the async start checks `cancelled`.
- **Auth listener:** one `onAuthStateChange`, only on the OTP form, and unsubscribed.
- **No direct `pg` usage** anywhere in `app/`, `lib/` or `scripts/`.
- **No server-side intervals or background jobs**, and no PM2 config in the repo, so PM2 just runs `next start`.
- **In-process caches are size-bounded:** `shared-url-cache` 256 entries, `poll-throttle` 5,000.
- **Admin lists are paginated or capped** (`range`, `limit 5000`, SQL `least(…, 200/1000)`).
- **Image cleanup is bounded and idempotent:** 500 per run, batches of 100, revalidated before every Storage batch, deletes only through the Storage API.
- **Phase 1 locks and Phase 3 photo validation are present** and untouched.

---

## C. Changes Implemented (local only, not committed, not deployed)

### C.1 `components/game/use-game-sync.ts` + `lib/game/sync.ts`: release resources on closed games (F3, F5)

- New pure rule `isClosedGame(state)` in `lib/game/sync.ts`. It is true for `finished`/`canceled`, plus BingoSnap's `completed`/`cancelled` (the same two lifecycle states; `20261112000018…sql:145`). These are exactly the statuses `bump_game_version` refuses to broadcast for.
- In the hook, `closed = unauthorized || isClosedGame(state)`. When closed:
  - the Realtime effect doesn't start, or tears down when the game closes mid-session (the existing cleanup removes both channels, and the socket closes);
  - the 30 s safety interval and the 4 s fallback polling stop;
  - the focus / visibility / online re-reads become no-ops;
  - the "Realtime unavailable" console warning is suppressed;
  - `conn` reports `live` (online) so a results screen never shows "Connecting…" forever. Before, the chip showed `live` there too.
- **Unchanged:**
  - the one initial re-read on mount;
  - the host's own "archive" (applied from its action response, exactly as before);
  - kicked players (they keep syncing, because the database still has a "restore" path);
  - every live, lobby or draft game.
- The token-refresh callback now returns if `cancelled` after its `await` (F5).

### C.2 `app/api/play/realtime-token/route.ts`, `app/api/play/bingosnap/realtime-token/route.ts`, `lib/players/session.ts` (F4)

- New `findGuestIdentity(token)`: one indexed `players.token_hash` row. It uses the same "null = no player row" rule as `player_game_state` / `bingo_player_state`, and the same pattern the Phase 3 `complete` route already uses.
- Responses are identical:
  - 401 `invalid_session`;
  - BingoSnap 409 `wrong_game_type` (checked first, like the SQL function);
  - 403 `player_removed`;
  - 503 `realtime_unavailable`;
  - the same token and topic.
- The BingoSnap route adds one primary-key read of `games.game_type` instead of the full snapshot.

### C.3 `tests/game-sync.test.ts`

2 new tests: the closed statuses, and the statuses that must keep syncing, including a missing or non-string status.

### Validation (Phase 9)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint .` | pass |
| `npm test` (unit + PGlite DB) | **757 / 757 pass** |
| `npm run build` | pass |
| Browser / real Supabase / real phones | **Not done.** No hosted access, and no local Supabase stack running. Smoke test before deploying: finish a game → DevTools → WS shows the `phx_leave` and the socket closes; the results screen keeps showing results with a "Live" chip; reopen an old finished game → no WebSocket, one `host_game_state` read |
| `npm run test:concurrency` | Not re-run: no SQL changed (Phase 1/2 suites last passed 52/52) |
| 30-player load test | **Not performed.** No numbers here are load-test results |

---

## D. Database Recommendations

### D.1 No new migration is justified by this investigation

- **Indexes:** the hot paths are covered (audit C.2). The unindexed FK columns matter only once retention starts **deleting** rows; add them in the same migration as any row-deleting retention job, not before.
- **Deploy what is already written,** in the order and with the safeguards in `BRINGME_PRODUCTION_MIGRATION_RECONCILIATION.md` §F–G:
  1. take backups (production has no PITR);
  2. repair the history for the 42 applied versions;
  3. push `20261112000012`, `20261113000002`, then `20261113000003` (TV links), `20261116000001/2` (admin rooms) and `20261116000003` (image cleanup).
  - Each later migration should get the same dry-run treatment.

### D.2 Proposal (not applied): a cheap clock sample for `syncBurst` (F6)

```sql
-- PROPOSAL ONLY. Returns the database clock (the same clock submissions are ranked by).
create or replace function public.server_clock() returns timestamptz
language sql volatile security invoker set search_path = '' as $$ select clock_timestamp() $$;
revoke all on function public.server_clock() from public;
grant execute on function public.server_clock() to service_role;
```

- A `GET /api/play/clock` route would call it, and `syncBurst` would use it instead of four snapshots.
- **Before doing this:**
  - confirm that the snapshot's `serverNow` comes from the same database clock;
  - re-run `tests/camera-timing.test.ts` and `TIMING.md`'s checks.
- Rank and order stay server-side either way.
- Saves ~4N snapshot builds per round (120 at N=30).

### D.3 Retention, after the admin cleanup is live

- Run the same `admin_image_cleanup_candidates` → Storage `remove` → `admin_record_image_cleanup` path on a schedule, from a server cron on the Ubuntu host calling a new service-role route. Keep the 500 cap and the per-batch revalidation.
- Never delete `storage.objects` rows in SQL.
- Prune `submission_intents` of closed rounds in batches (`… where id in (select … limit 1000)`).

---

## E. Production Diagnostics (read-only; run in the SQL Editor)

```sql
-- E1. Is this baseline? Instance memory settings + what holds backends (expect PostgREST/Realtime/Auth/Storage pools, NOT one per player)
select name, setting, unit from pg_settings
 where name in ('shared_buffers','work_mem','maintenance_work_mem','max_connections','max_worker_processes',
                'autovacuum_max_workers','max_wal_senders','max_replication_slots') order by 1;
select coalesce(nullif(application_name,''), usename) as who, state, count(*)
  from pg_stat_activity group by 1, 2 order by 3 desc;

-- E2. Memory-relevant pressure since stats reset (temp spills, deadlocks, rollbacks)
select numbackends, xact_commit, xact_rollback, deadlocks, temp_files, pg_size_pretty(temp_bytes) temp, stats_reset
  from pg_stat_database where datname = current_database();

-- E3. Long or idle-in-transaction sessions (should be empty)
select pid, application_name, state, now() - xact_start as xact_age, wait_event_type, left(query, 100)
  from pg_stat_activity where xact_start is not null and now() - xact_start > interval '5 seconds' order by xact_age desc;

-- E4. Replication slots retaining WAL (should be none from this app)
select slot_name, plugin, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) retained from pg_replication_slots;

-- E5. Which RPCs dominate (fan-out signature: player_game_state >> host_game_state means F2 is live)
select calls, round(total_exec_time::numeric) total_ms, round(mean_exec_time::numeric, 2) mean_ms, left(query, 120)
  from extensions.pg_stat_statements order by calls desc limit 20;

-- E6. F2: are Phase 1 / Phase 2 installed?
select pg_get_functiondef('public.complete_submission(text,uuid,uuid,jsonb)'::regprocedure) like '%p.game_id for no key update%' as phase1,
       to_regprocedure('public.broadcast_game(uuid,bigint,public.game_phase,text)') is not null as phase2;

-- E7. Hint routing in the last day (with Phase 2: most photo/review hints on ':host' topics)
select (topic like '%:host') host_topic, payload->>'scope' scope, count(*)
  from realtime.messages where inserted_at > now() - interval '1 day' group by 1, 2;

-- E8. Data/footprint (size, not memory)
select pg_size_pretty(pg_database_size(current_database())) db;
select n.nspname, c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) total
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p') and n.nspname in ('public','realtime','storage','auth')
 order by pg_total_relation_size(c.oid) desc limit 15;
select bucket_id, count(*), pg_size_pretty(sum((metadata->>'size')::bigint)) from storage.objects group by 1;

-- E9. Abandoned rooms (open lobby/live games whose host tabs may still be polling)
select status, phase, count(*), min(updated_at), max(updated_at) from public.games where status in ('lobby','live') group by 1, 2;
```

**Dashboard (not reachable by SQL):**

- **Reports → Database:**
  - compare memory commitment **at idle** (e.g. 4 AM) with **during a game**. Flat means baseline;
  - look at the swap **in/out rate**: swap used is fine, sustained paging is not.
- **Logs → Postgres:** search `out of memory`, `could not fork`, `terminating connection`, `deadlock detected`.
- **Realtime → Reports:** peak concurrent connections and messages/s versus your plan's quota.
- **Settings → JWT Keys:** HS256 legacy or asymmetric (F8).
- **On the Ubuntu host:** `pm2 ls` (instance count) and the deployed commit (`git -C <app dir> log -1`). This is F2's other half.

---

## F. Expected Improvement (no percentages claimed for production)

- **Memory commitment:** **expect no visible change** from any code change, including these. If E1/E2 and the idle-vs-game comparison show it flat, it is Supabase's baseline on Nano.
- **F3 fix:**
  - removes every socket, channel authorization check and periodic read held by finished-game tabs (players lingering on "That's a wrap!", presenters and TVs left on the final screen, hosts revisiting old games);
  - under F2 that is a 4 s poll per host tab, i.e. **15 reads/min per tab removed**; otherwise 2/min plus focus reads;
  - frees Realtime connection-quota slots for the next room.
- **F4 fix:** one full snapshot fewer per phone per page load and per hourly token refresh. At N=30 that is ~30 snapshots per join wave, replaced by 30 single-row reads.
- **Applying Phase 2 (F2), measured on local Postgres in `BRINGME_PHASE2_REALTIME_OPTIMIZATION.md` §G:** at N=30 over 2 rounds,
  - all sync reads 5,627 → 1,439;
  - Realtime messages 4,614 → 1,187.
  - Production impact is unmeasured. Compare E5 call counts before and after.

---

## G. Free Plan Assessment

### 30-player room, after F2 is resolved (counts from code and the local bench; not load-tested)

| Moment | Database work | Realtime |
|---|---|---|
| 30 join at once | ~8 small calls per phone (join page RPCs, `join_game` with a short `FOR UPDATE` on the game row, lobby, state, token: now 1 row, channel auth, resync) ≈ 240, serialized per game in milliseconds each | 30 `roster` hints; phones debounce 1–2.5 s; host and presenter re-read the roster on fingerprint change |
| 30 photos at once | begin: 1 RPC + 2 Storage. complete: 2 row reads + settings + Storage info + 3-byte range + `complete_submission` (Phase 1 lock order, no deadlock). ≈ 150 calls | 30 hints on `:host` only; **0 player reads**; host/presenter coalesce |
| Host checks standings | owner lookup + `round_ranking`; signs only photos it doesn't already hold | – |
| Winner announced | 1 transition → 30 player reads + 30 `player_winner_photo` (one shared signed URL) | 1 `all` hint × 32 clients |
| Next round | 30 reads + 120 (`syncBurst`, F6) + 60 boundary re-reads | 2–3 `all` hints |
| Everyone leaves | none; channels removed, sockets close; with C.1 also on result screens | – |

**Postgres connections don't scale with players:** phones talk to PostgREST and Realtime, whose own small pools hold the backends. A room is about 32–33 WebSockets (30 phones + console + presenter, plus TV) against a Free-plan Realtime quota last documented at ~200 connections (**verify**: audit F.1).

1. **Can BringMe stay on Free?** Yes, for a few concurrent rooms of up to 30, once F2 is resolved. Nothing in the code points to memory growth with load. The commitment warning has been flat at idle.
2. **Primary bottleneck:** on the database side, request volume and connection holding during bursts, which Phases 1–3 address. On the platform side, the **Realtime concurrent-connection quota** (~6 rooms of 30 at ~200 connections, unverified) is the first hard ceiling, plus Nano's 0.5 GB RAM if swap starts actively paging.
3. **Is application code causing excessive memory use?** **No evidence of it.** The code checks are in B. The pre-fix deadlock could raise *peak* backend count, and it is fixed in production. The remaining waste (F2–F6) costs calls and CPU, not resident memory.
4. **Upgrade triggers (measure, then decide):**
   - sustained swap **in/out** or OOM / `could not fork` in Postgres logs during games;
   - Realtime peak connections > ~70% of quota, or rejected joins in Realtime logs;
   - p95 latency of `player_game_state` / `complete_submission` RPCs rising during events;
   - database size approaching 500 MB;
   - Supabase pausing the project for inactivity (a Free-plan behaviour) becoming unacceptable.
5. **Before upgrading:** resolve F2 (backup → migrations → confirm app commit), deploy C.1/C.2, pin dependencies (F11), check JWT mode (F8), apply the admin image cleanup and use it (F9). Then run E1–E5 during a real event.

---

## H. Remaining Risks

- **Production state is unverified this round:** deployed app commit, whether Phase 2 / TV / admin migrations are applied, and Realtime quotas. CLI login expired; no SSH to the Ubuntu host.
- **The memory attribution is inference:** two identical snapshots, idle CPU, Nano size. Per-process memory on Supabase's VM isn't visible to SQL. The idle-vs-game comparison in E is the decisive check.
- **C.1:** a kicked player who is later **restored** isn't affected (kicked players aren't "closed"). A game that left `finished` would not be followed live, but no SQL path does that today; only `archive`, which is the host's own action.
- **No real-device or browser verification** of C.1/C.2, and **no concurrent load test** (30 real phones, real network, real Realtime). Do one on staging before a large event.
- **Realtime private-channel behaviour on the hosted project** (guest HS256 tokens, the `:host` topic) is still unverified (Phase 2 report §I).
- **Pre-existing:** one flaky DB test (Phase 1 note). It passed in this run.

---

Sources: [Supabase: Compute and Disk](https://supabase.com/docs/guides/platform/compute-and-disk) (Nano / Free: up to 0.5 GB memory); [Supabase: Manage Compute usage](https://supabase.com/docs/guides/platform/manage-your-usage/compute).
