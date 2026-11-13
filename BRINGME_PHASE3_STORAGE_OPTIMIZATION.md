# BringMe! Phase 3: Photo Storage & Signed URL Optimization

_2026-11-13. Implemented and verified locally. **Not committed, not deployed.** Nothing was run against the hosted Supabase project or its Storage._

| Phase | Git | Production database | Production app |
|---|---|---|---|
| 1, deadlock fix (`20261113000001`) | committed `80e6093` | **unverified** | **unverified** |
| 2, Realtime audience (`20261113000002`) | committed `2b085e1` | **unverified** | **unverified** |
| 3, this report | working tree (uncommitted) | no migration | not deployed |

I have no access to the production database or deployment, so I could not verify whether Phases 1 and 2 are live. **Phase 3 needs no migration, but it should only be rolled out after Phases 1 and 2 are confirmed in production** (section I gives the checks).

---

## A. Executive Summary

Photo handling repeated a lot of expensive work:

- The host console **and** the presenter re-signed **every photo of the round** every time the list changed.
- Completing a photo **downloaded the whole image** into the serverless function to check 3 bytes.
- Every player signed the winner's photo separately.

Phase 3 removes that repetition. It is an **application-only change**: no migration, no change to the bucket, its policies or the URL lifetime.

- **Metadata-first listing with reuse.** The host screen tells the server which photos it already holds valid URLs for (`?have=`), and the server signs only new or expiring ones. The URLs live only in that tab's memory.
- **Presenter least privilege.** The projector gets names, plus the official winner's photo only during the announcement. It no longer receives URLs for every review photo.
- **Bounded validation.** Completion reads only the first bytes of the stored object: it sends `Range: bytes=0-2`, reads at most what's needed, then cancels the stream. It no longer downloads the photo.
- **Shared winner URL.** One signed URL per winner photo per server instance, handed out only after the database authorizes each requester.
- **Lighter lookups.** The full game snapshot in the completion and listing routes is replaced by single-row lookups.
- **Expiry recovery.** A refresh before expiry, plus a re-sign when an image fails to load. This also fixes a pre-existing bug: photos used to go blank if the host looked at them for more than 2 minutes without anything changing.

**Measured locally (mocked Storage; section F), 50 players, 2 rounds:**

| | Before | After | Change |
|---|---:|---:|---:|
| Photo paths signed | 20,136 | 107 | **−99.5%** |
| Storage API requests | 1,103 | 597 | **−46%** |
| Bytes buffered per photo completion | 409,600 | 3 (64 KiB worst case if Range is ignored) | **−99.999%** |
| Expired photos shown in a 25 s review pause (10 s URLs) | 4,408 / 8,844 samples | 0 / 8,843 | fixed |
| Missed gameplay transitions | 0 | 0 | – |

Phase 1 locking, Phase 2 event routing, BingoSnap's on-device photos, game rules, pricing and authentication are unchanged.

---

## B. Photo Lifecycle Audit (before Phase 3)

| Step | Code | Storage API calls | DB calls | Necessary? |
|---|---|---|---|---|
| 1. Tap: intent + upload URL | `app/api/play/submissions/begin/route.ts` | `remove(path)` + `createSignedUploadUrl(path)` | `begin_submission` | **Yes.** The remove clears a half-uploaded earlier try (uploads use `upsert=false`, so an accepted photo can never be overwritten). **Kept** |
| 2. Upload | browser `PUT` to the signed upload URL (`lib/game/upload.ts`) | 1 | – | Yes |
| 3. Complete | `app/api/play/submissions/complete/route.ts`, `lib/players/photo-check.ts` | `info(path)` + **`download(path)` (whole photo buffered)** | `player_game_state` (full snapshot, ~10 subqueries) + `platform_settings` + `complete_submission` | Info: yes. **Full download: no** (3 bytes needed). **Full snapshot: no** (only identity and a duplicate check needed) |
| 4. Host list (each change) | `app/api/host/games/[id]/submissions/route.ts` | `createSignedUrls(ALL photos)`, even for an empty list | `host_game_state` (full snapshot, just for the round id) + `round_ranking` | **Re-signing unchanged photos: no.** Snapshot: no (owner-scoped row lookup suffices) |
| 5. Presenter list (each change) | same route | `createSignedUrls(ALL photos)` | same | **No.** It only shows names and the winner's photo |
| 6. Host review | `review_submission` (Phase 2: host-only hint) | – | 1 | Yes. The extra explicit list reload after each decision is redundant |
| 7. Winner announcement (every phone) | `app/api/play/winner-photo/route.ts` | `createSignedUrl` **per player** | `player_winner_photo` | Authorization per player: yes. **N signings of one object: no** |
| 8. Final results | `app/api/host/games/[id]/results/route.ts` | `createSignedUrls(winner photos)` per page load | `game_results` | Yes (once per screen). Unchanged |
| Removal / expiry | none (`photo_retention_days` not enforced, audit G5) | – | – | Out of scope (retention) |
| Storage authorization | `submissions` bucket private, 5 MB limit synced from settings, JPEG/PNG/WebP only; read policy `owns_game_path(name)` or super admin; no client write policy | – | – | Unchanged |

**Other observations:**

- **URL expiry:** host URLs expired after 120 s, but the list was only re-fetched when the game changed. A host studying photos for more than 2 minutes saw broken pictures (reproduced in the benchmark: 4,408 expired samples).
- **Dead code:** `components/game/submissions-panel.tsx` and `review-panel.tsx`'s list are no longer mounted anywhere. They were left untouched.
- **BingoSnap** photos never touch Supabase (IndexedDB only, `lib/photos/store.ts`). Verified and untouched.

**Baseline counts** (this repo before Phase 3, run against real Postgres with mocked Storage; section F):

| | 10 players | 30 players | 50 players |
|---|---:|---:|---:|
| Paths signed | 834 | 7,302 | 20,136 |
| Storage requests | 225 | 663 | 1,103 |
| Photo bytes buffered by completions | 7.4 MiB | 23.0 MiB | 38.7 MiB |
| DB calls by photo routes | 316 | 912 | 1,512 |

---

## C. Optimization Architecture

### C.1 Where URLs are cached, and why there

| Option | Decision |
|---|---|
| **Client-side, in memory, per screen** | **Chosen** for host and presenter lists. The URL was issued to this host's own session, never leaves the tab, is never persisted (no localStorage, it is a bearer credential), and is dropped when the round, game or screen changes |
| Server-side shared cache for host lists | Rejected: it would hold one host's bearer URLs where a bug could hand them to another request, and serverless instances make hit rates unpredictable |
| Per-request deduplication | Built in: paths are unique per request, the client keeps one request in flight with at most one queued, and concurrent misses for the winner photo share one signing |
| Lazy signing | Used for the presenter: nothing is signed until there is an official winner |
| Shared server cache | **Only** for the winner photo, which every player of that game is entitled to during the announcement. It is consulted only *after* `player_winner_photo` authorized that requester for that exact path |

### C.2 Listing protocol (`GET /api/host/games/[id]/submissions`)

1. `requireUser()`, then an **owner-scoped** lookup: `games` where `id` and `owner_id = me` (RLS applies too). Another host's game returns 404 with nothing ranked or signed. This replaces the full `host_game_state` snapshot.
2. `round_ranking(round)` (SECURITY INVOKER, RLS) gives the order, statuses and paths. Removed players are excluded by the database.
3. **Paths come only from the database** and must match `<thisGame>/<uuid>/<uuid>.(jpg|png|webp)`. `?have=<submission ids>` (at most 200 UUIDs) only marks photos the caller already holds, which are then not re-signed. Lying in `have` can only cost the caller its own picture; it can never yield a URL for anything else.
4. **Host view:** sign the remaining photos in **one** `createSignedUrls` call under the host's own session, so Storage's policy re-checks ownership per object. No call is made if nothing needs signing. **Presenter view (`?view=presenter`):** sign only the official winner's photo, and only during `winner_announced` with `winner_confirmed_at` set.
5. **Response:** rows with `photoKey` (`bucket/path`, the cache identity) and `photoUrl` only for newly signed photos, plus `ttlSeconds`. `Cache-Control: no-store`. Signing failures still return the list; the client retries. URLs and paths are never logged.

### C.3 Client cache and refresh (`lib/game/photo-url-cache.ts`, `components/game/use-submission-rows.ts`)

- **Key:** `bucket/path`. An accepted photo's object is immutable (one per player and round, `upsert=false`), so a URL stays correct for its lifetime.
- **Lifetime:** 120 s, unchanged. Expiry is computed on the device's own clock **from when the request was sent**, so clock skew can't keep a dead URL.
- **Reuse and refresh:** a URL is reused until 30 s before expiry; the margin is capped at half the lifetime. Inside the margin the next listing re-signs it, and the old URL stays on screen until the new one arrives. An **expired URL is never shown**.
- **Timer refresh:** a re-read is scheduled before the earliest shown URL reaches its margin, even with no game activity.
- **Image errors:** an `<img onError>` drops that photo and re-signs it, at most once per 10 s per photo.
- **Invalidation:** photos that leave the list (a removed player, another round) are forgotten at once and never resurrected. Rows a view may not show (`photoKey: null`) never get a URL, even if one is cached.
- **Concurrency:** one request in flight, later triggers coalesce into one follow-up. Failed lists or photos retry with back-off (3, 6, 12, then 30 s). 401/403/404 stops the loader.
- **Revocation:** a signed URL **cannot be revoked** in application code; it stays valid until it expires (≤ 120 s, as before). Dropping it from the cache only stops *this app* from using it. The effective Storage-side revocation is deleting or moving the object, which the future retention job (audit G5) will do. Immediate revocation isn't needed for gameplay: the only holders are the owning host's own tabs, and players only ever get the winner photo during the announcement. See section H.

### C.4 Completion validation (`lib/players/photo-probe.ts`, `lib/players/photo-check.ts`)

The same checks run in the same order:

1. `info()`: the object exists; its stored type is `image/jpeg`; its size is between 1 KiB and the platform limit. Wrong type or size is rejected **without reading any content**.
2. The first bytes via `storage.from(bucket).setHeader("Range", "bytes=0-2").download(path, {}, { signal }).asStream()`. This is the public storage-js API, under the same service-role client, with no hand-built credentials.
3. `readPrefix` reads only until 3 bytes have arrived, capped at 256 KiB, then **cancels the stream and aborts the request**.

**The Range header is not assumed to be honoured.** If Storage ignores it and sends the whole file, at most one network chunk is buffered: 64 KiB in the benchmark, versus the 400 KB photo. The signature check (`FF D8 FF`) is unchanged, and so are the bucket's type and size limits.

New distinction: Storage 5xx or network failures return **503 `upload_unavailable`** (retryable) instead of being reported as a missing upload. The client retries both the same way.

### C.5 Lookups (`app/api/play/submissions/complete/route.ts`)

- **Identity:** `players` by `token_hash`, a unique-index single row, instead of `player_game_state`.
- **Responses:** unknown session gives 401; removed player gives 403 `player_removed` (as before, now without touching Storage).
- **Duplicate retry:** `submissions` by `(round_id, player_id)`, which returns the same `duplicate` answer as before.
- **Then:** the probe, then `complete_submission`. Phase 1's locks, idempotency, the 45 s attempt expiry and the Phase 1 retry mapping (`db_busy`) are unchanged.
- **Trade-off:** this is **4 light calls instead of 3** (one of which was a heavy snapshot). The platform size limit is still read per completion, because I added no global cache for a mutable admin setting.

### C.6 Realtime integration

- No change to Phase 2 routing. Photos remain host-only hints, and players are not notified.
- The host and presenter lists still refresh on Phase 2's `submissionsKey` fingerprint.
- URL refreshes are plain HTTP reads that create **no** game-state change and **no** broadcast.
- After a reconnect, the catch-up re-read reuses every held URL (tested).

---

## D. Files Modified

| File | Change |
|---|---|
| `lib/game/submission-photos.ts` (**new**) | Pure listing logic with injected database and Storage: owner check, ranking, path validation, `have`, presenter rules, one batch signing, failure accounting. 120 s TTL constant |
| `lib/game/photo-url-cache.ts` (**new**) | `PhotoUrlCache` (key, lifetime, margin, prune, throttled invalidation) and `SubmissionPhotoLoader` (single flight, `have`, refresh timer, back-off, stop on fatal) |
| `lib/players/photo-probe.ts` (**new**) | `probePhoto` (metadata, then bounded signature read), `readPrefix` (cancel after N bytes, 256 KiB cap), outcome types |
| `lib/players/shared-url-cache.ts` (**new**) | `SharedSignedUrlCache` (TTL, minimum remaining validity, in-flight sharing, bounded size, no caching of failures) and `resolveWinnerPhoto` (database first, then cache) |
| `components/game/use-submission-rows.ts` (**new**) | React hook around the loader (host / presenter view) |
| `app/api/host/games/[id]/submissions/route.ts` | Metadata-first listing via `listSubmissionPhotos`; owner-scoped `games` lookup instead of `host_game_state`; `?view=presenter`, `?have=`; returns `photoKey`, `ttlSeconds` |
| `app/api/play/submissions/complete/route.ts` | Row lookups instead of the full snapshot; 503 `upload_unavailable` for Storage trouble |
| `lib/players/photo-check.ts` | `verifyStoredPhoto` built on `probePhoto` with a Range + streamed, cancelled download |
| `app/api/play/winner-photo/route.ts` | Shared winner URL (120 s, reused while ≥ 60 s remain) via `resolveWinnerPhoto` |
| `components/game/host-console.tsx` | Uses `useSubmissionRows`; removed the redundant reloads after a successful review and announcement (the applied state's fingerprint triggers them); image error → re-sign |
| `components/game/presenter-screen.tsx` | Uses `useSubmissionRows` with the presenter view |
| `components/game/photo-review-grid.tsx`, `photo-viewer.tsx` | Optional `onPhotoError` prop (`<img onError>`); no visual change |
| `components/game/review-panel.tsx` | `LiveSubmission.photoKey?` |
| `tests/photo-storage.test.ts` (**new**) | 30 unit tests (mocked Storage) |
| `tests/db/photo-access.test.ts` (**new**) | 6 DB tests (real migrations, RLS, Storage policy in the shim) |
| `tests/bench/photo-storage.bench.mjs` (**new**), `package.json` (`bench:photos`) | Before/after benchmark |
| `PROJECT_STATUS.md` | Phase 3 section |

There is **no migration and no change to any SQL function, policy or bucket.** BingoSnap code is untouched.

---

## E. Test Results

| Suite | Result |
|---|---|
| `npm test` (unit + PGlite DB) | **725 / 725 passed**, 0 failed, 0 skipped (36 new) |
| `npm run test:concurrency` (real PostgreSQL, parallel) | **52 / 52 passed**, including Phase 1's 2/10/30/50 simultaneous completions and Phase 2's routing checks |
| `npx tsc --noEmit` | passed |
| `npx eslint .` | passed |
| `npm run build` | passed |

### Requested coverage

| Scenario | Where | Kind | Result |
|---|---|---|---|
| 2/10/30/50 concurrent completions | concurrency suite (SQL unchanged); benchmark at 10/30/50 runs the new route logic | real DB | pass |
| Simultaneous new submissions | loader: 10 concurrent triggers give 2 requests and 5 signings | unit (mock) | pass |
| Cache hits and misses | `PhotoUrlCache` tests; 2/10/30/50 photos signed once over 21 re-reads | unit (mock) | pass |
| URL expiry and refresh | margin, half-life cap, expired never shown, timer refresh; benchmark expiry scenario | unit + simulated | pass |
| Concurrent requests for the same photo | 50 winner-photo requests give 1 signing | unit (mock) | pass |
| Removal or replacement | pruned rows never resurrected; DB: a removed player's photo leaves `round_ranking` | unit + DB | pass |
| Host and presenter updates | presenter: no URL before the official winner, then only the winner's; host latency in the benchmark | unit + simulated | pass |
| Winner announcements | DB: winner photo only during the announcement, not for removed players or other games, gone after | DB | pass |
| Invalid signatures | PNG bytes give `invalid` | unit | pass |
| Oversized images | 6 MB, and 2 MB with a 1 MB limit, give `invalid` with no content read | unit | pass |
| Storage API failures | info or stream failing, a reset mid-read give `unavailable` (request still released); signing failure keeps the list and retries photos | unit (mock) | pass |
| Unauthorized cross-game requests | another host's game is "not found", no ranking or signing (unit); DB: no game row, ranking, winner row or object for another host | unit + DB | pass |
| Guests | cannot read `storage.objects`, `round_ranking` or `submissions`; cannot write objects | DB | pass |
| Invalid object paths | other game's folder, traversal and malformed paths are never signed | unit | pass |
| Cache poisoning | `have` accepts only UUIDs and can only suppress signing; winner cache never touched without a database path | unit | pass |
| Realtime reconnect | catch-up re-read reuses every URL; Phase 2 reconnect tests unchanged | unit | pass |
| Phase 1/2 compatibility | full suites with all migrations; route queries verified under RLS (DB) | DB | pass |

### Unverified (requires real Supabase Storage on staging)

- Whether Supabase Storage **honours `Range`** on authenticated object downloads. The code is safe either way: the benchmark shows ≤ 64 KiB buffered when it is ignored.
- That `setHeader("Range")` plus `download().asStream()` behaves on hosted Storage as the storage-js source shows. Cancelling the stream relies on the platform's fetch.
- That signed URLs actually expire at 120 s on hosted Storage. The client never *uses* an expired URL; enforcement is Storage's job.
- Real Storage latency, real devices, Vercel memory figures.

---

## F. Performance Comparison

### Methodology (`npm run bench:photos`; raw JSON with `BENCH_OUT=file`)

- **Real:** an embedded PostgreSQL with **all** migrations (Phase 1 and 2), the Phase 2 sync clients (N players, host console, presenter), every database query the photo routes make (counted), and **in after mode the actual Phase 3 modules**.
- **Mocked:** Supabase Storage, as an in-process fake that counts requests and signed paths, tracks every issued URL's expiry, and measures bytes buffered. Photos are **400 KB (an assumption)**, streamed in 64 KiB chunks.
- **Modelled:** the "before" routes and loaders, call for call, from the code at `2b085e1`.
- **Script:** 2 rounds; every player submits; one player is removed in round 1; the host approves every photo; winner announcement (every phone fetches the winner photo); results page plus presenter final screen.
- **Not emulated:** network and Storage latency, multiple serverless instances (the winner cache is modelled as **one** warm instance; with k instances it signs up to k times per announcement), Vercel memory accounting.

### Results (measured locally; Storage mocked)

| Metric | 10 before | 10 after | 30 before | 30 after | 50 before | 50 after |
|---|---:|---:|---:|---:|---:|---:|
| Photos accepted | 19 | 19 | 59 | 59 | 99 | 99 |
| **Paths signed** | 834 | 27 (−96.8%) | 7,302 | 67 (−99.1%) | 20,136 | 107 (−99.5%) |
| Signing requests (batch + single) | 130 | 25 | 368 | 65 | 608 | 102 |
| **Storage requests, total** | 225 | 120 (−47%) | 663 | 360 (−46%) | 1,103 | 597 (−46%) |
| of which full downloads | 19 | 0 | 59 | 0 | 99 | 0 |
| **Bytes buffered by completions** | 7.4 MiB | 57 B | 23.0 MiB | 177 B | 38.7 MiB | 297 B |
| Max buffered per completion | 409,600 B | 3 B | 409,600 B | 3 B | 409,600 B | 3 B |
| Same, if Storage **ignores Range** | – | – | – | – | – | 65,536 B (6.2 MiB total) |
| DB calls: listing route | 220 | 186 | 616 | 506 | 1,016 | 814 (−20%) |
| DB calls: completion route | 57 | 76 | 177 | 236 | 297 | 396 (+33%, lighter) |
| DB calls: all photo routes | 316 | 301 (−5%) | 912 | 861 (−6%) | 1,512 | 1,409 (−7%) |
| Listing route invocations | 110 | 92 | 308 | 252 | 508 | 406 |
| Host photo latency (complete → URL on the host screen), p50 / p95 | 3 / 5 ms | 2 / 4 ms | 3 / 4 ms | 3 / 5 ms | 3 / 4 ms | 3 / 5 ms |
| Expired or missing photos on the host screen | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Missed gameplay transitions / stale clients | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

**Expiry recovery** (30 players, URLs shortened to 10 s, the host studies the photos for 25 s before deciding):

| | Before | After |
|---|---:|---:|
| Host-screen samples showing an **expired** URL | **4,408 / 8,844 (50%)** | **0 / 8,843** |
| Paths signed (including refreshes) | 7,278 | 381 |

How to read this:

- **Storage requests:** the remaining 597 at N=50 are about 5 per photo that are genuinely needed: remove, upload URL, upload, info, ranged read. Plus ~1 signing request per list change that has a new photo, and 2 winner signings.
- **Database calls** changed little in count: the listing route avoids a snapshot, and the completion route makes 4 single-row calls instead of 3 that included a heavy snapshot. I did not measure database CPU or time.
- **Latency:** local host photo latency is unchanged, a few milliseconds without network.

### Estimated production effect (**not measured**)

- Fewer Storage signing requests and fewer signed objects per game, in roughly the proportions above.
- Each photo completion should allocate kilobytes rather than the full photo in the function. That should show up as lower peak memory on busy rounds, but **no real Vercel or Supabase memory was measured**.

---

## G. Security Assessment

| Area | Assessment |
|---|---|
| Bucket | Still private, 5 MB limit (synced from settings), JPEG/PNG/WebP only. No public URLs. Unchanged |
| Signed upload URLs | Unchanged: one server-derived path per verified intent, `upsert=false` (an accepted photo can't be overwritten). Their default 2 h validity is pre-existing (section H) |
| Signed read URLs | **Lifetime unchanged (120 s); signing still under the host's own session**, so Storage's `owns_game_path` policy decides per object. URLs are never logged, never persisted, and responses are `no-store` |
| Host ownership | Owner-scoped `games` lookup (plus RLS) before anything is ranked or signed. Another host's id returns 404 (unit + DB tests) |
| Paths | Only from the database, and only inside this game's folder (`<game>/<uuid>/<uuid>.<ext>`). Request input cannot name a path. `have` accepts UUIDs only and can only *suppress* signing |
| Presenter | **Tighter than before**: no review photo URLs at all, only the official winner's during the announcement |
| Guests | No table, `round_ranking` or Storage access (DB tests). The winner photo is reachable only through `player_winner_photo`: that game, during the announcement, not removed |
| Shared winner URL | The cache is touched only after the database returned this exact path for this requester; keys are `bucket/path`; failures aren't cached; bounded size. A URL may be reused for up to 60 s by other authorized players of the same game, who were all entitled to it anyway |
| Removed players | Their photo leaves the host's list (not re-signed); they get no winner URL. Already-issued URLs live out their ≤ 120 s, as before |
| Rejected photos | Still listed for the **host** (needed to review and undo, by design); never for the presenter; a rejected photo can't become the winner |
| Revocation | Not possible for issued signed URLs (documented in C.3). The window is the unchanged 120 s |
| Credentials | Service role only in server modules (`server-only`). Range downloads use the storage-js client's own headers; no key is assembled by hand |
| Cross-game isolation | Topics, paths, cache keys and owner checks are all game-scoped (unit + DB) |

---

## H. Remaining Risks

1. **Real Storage behaviour is unverified** (Range, stream cancellation, expiry). Mitigated: the code is correct and bounded whether or not Range is honoured. Verify on staging (section I).
2. **Signed upload URLs** use storage-js's default validity (2 h). A captured upload URL could upload to its own path until a photo exists there; `upsert=false` and the 45 s attempt window keep it from replacing an accepted photo. This is pre-existing and unchanged. Phase 4 could set an explicit short expiry.
3. **Issued read URLs can't be revoked** before they expire (≤ 120 s; unchanged).
4. **The winner-photo cache is per server instance.** With many cold instances, signing approaches the old one-per-player count. Correctness is unaffected.
5. **Completion makes 4 light DB calls instead of 3** (one heavy). The platform photo-size limit is still read each time (no cache without an invalidation strategy).
6. **Open host tabs from before the deploy** keep the old loader until reloaded: they request without `have`, so the server signs everything, which is still correct. **Old presenter tabs** keep receiving every review photo URL until reloaded (pre-Phase-3 behaviour).
7. **Results route unchanged:** 2 signing requests per finished game. The results page's winner photos can still go blank after 2 minutes on that page (no refresh there); this is pre-existing and low impact.
8. **Dead code** (`submissions-panel.tsx`, the list part of `review-panel.tsx`) still contains the old fetch pattern. It is not mounted anywhere; delete it or migrate it later.
9. **Retention** (audit G5) is not done: photos are kept forever, and that is also the only Storage-side revocation path.

---

## I. Production Deployment Plan

**Prerequisites** (verify; this report could not):

1. Phase 1 applied:
   ```sql
   select pg_get_functiondef('public.complete_submission(text,uuid,uuid,jsonb)'::regprocedure) like '%p.game_id for no key update%';
   ```
2. Phase 2 applied:
   ```sql
   select to_regprocedure('public.broadcast_game(uuid,bigint,public.game_phase,text)') is not null;
   ```
   Also confirm the Phase 2 app (`2b085e1`) is deployed and its smoke tests passed.

Phase 3 itself has **no migration**. It works on a Phase 1-only database too, because the host-side keys fall back to the version and the listing uses only tables and functions from migrations ≤ 11. It is simply intended to ship after Phase 2.

### Rollout

1. Deploy to a **staging** project first and run the smoke tests below.
2. Deploy the app to production between events if possible, and ask hosts with open consoles or presenters to reload.

### Smoke tests (staging, then production)

1. **Range support:** complete a photo, then check the function logs (no errors). Locally, a one-off script can call `verifyStoredPhoto` on a known object and log `bytesBuffered`: 3 means Range is honoured, ≤ 64 KiB means it is ignored but bounded.
2. **Validation:** an invalid file (PNG renamed to `.jpg`) is rejected with 422 `invalid_image`; a file over the limit is refused by the bucket.
3. **Host console:** photos appear as they arrive. In DevTools → Network, after the first photo each listing request carries `have=` and its response contains `photoUrl` only for new photos.
4. **Long review:** leave the review grid open for 3 minutes with no action. Photos must stay visible, with a background re-read about every 90 s.
5. **Presenter:** the response for `?view=presenter` contains no `photoUrl` until the winner is announced, then exactly one.
6. **Winner:** every phone shows the winner's photo; removed players don't get it.
7. **Another host:** requesting `/api/host/games/<someone else's id>/submissions` returns 404.

### Rollback

- **App-only:** redeploy the previous build (`2b085e1`). There is no database change to undo.
- **Signed URLs** issued by either version are ordinary Storage URLs that stay valid until they expire (≤ 120 s), so a rollback in either direction doesn't break pictures already on screen.

### Compatibility

| Database \ App | Phase 2 app (`2b085e1`) | Phase 3 app |
|---|---|---|
| Phase 1 only | works (hosts poll for host-only hints) | works (same; keys fall back to the version) |
| Phase 1 + 2 | works | **intended** |
| Open old tabs during deploy | – | correct; they sign everything until reloaded |

---

## J. Final Verdict

1. **How many signed URL operations were eliminated?** In the local benchmark (mocked Storage), **20,029 of 20,136 path signings (99.5%) at 50 players**, 7,235 of 7,302 at 30 and 807 of 834 at 10. Signing *requests* went from 608 to 102 at 50 players.
2. **How many Storage API requests were eliminated?** **506 of 1,103 (46%) at 50 players** (303 at 30, 105 at 10). These are mainly whole-photo downloads, per-change re-signing and per-player winner signing. The rest are needed per photo.
3. **Did serverless memory usage improve?** **Photo-buffer allocations did, by construction and as measured:** 3 bytes per completion instead of the whole photo (400 KB assumed), or at most 64 KiB if Storage ignores Range. Total function memory was **not measured** on Vercel.
4. **Are host and presenter photo updates still responsive?** Yes in local measurements: 3–5 ms p95 from completion to URL on the host screen, unchanged, with zero expired or missing pictures. The expiry scenario went from 50% broken samples to none.
5. **Is private photo access still secure?** Yes, and tighter for the presenter. Same bucket, policies, owner checks and 120 s lifetime; paths only from the database; no shared host cache; the winner cache is used only after database authorization. Unit and DB tests cover cross-host, guest, removed-player and invalid-path access. Signed URLs still can't be revoked before expiry (as before).
6. **Were any gameplay rules changed?** No. Photo acceptance, timing, the 45 s attempt window, review, winner rules, Phase 1 locking and Phase 2 routing are unchanged. BingoSnap is untouched.
7. **Is the implementation ready for production deployment?** **Ready for staging, not yet for production.** It needs (a) Phase 1 and Phase 2 verified in production, (b) the staging smoke tests against real Supabase Storage (Range, streamed download, expiry), and (c) a review and commit of this working tree.
8. **What should Phase 4 focus on?**
   - **Data retention and cleanup** (audit G5 / H3): enforce `photo_retention_days`, delete old objects (which also gives Storage-side revocation), prune intents and old rows, and add the FK indexes first.
   - **A shorter, explicit signed-upload expiry.**
   - **Closing Realtime after a game ends** (G6).
   - Removing the dead submission panels.
   - Cheaper clock samples and token routes (G9 / G13).
