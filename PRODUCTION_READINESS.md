# BringMe! — Production Readiness Audit (Phase 11)

_Audit date: 2026-11-11 · Scope: the complete app (Super Admin, Game Master, Player), its 12 SQL migrations and the Next.js handlers._

**Verdict: not ready to launch yet.** The code is in good shape: automated checks pass, and the three issues this audit found are fixed and covered by tests. But **nothing has run against a real Supabase project or on real phones**. Most of the role checklists below can only be signed off there (see [Launch blockers](#6-launch-blockers)).

**How to read this report.** "Passed" means the check was actually run during this audit, with the method named. Anything that could not be run here is listed as **Not executed** and moved to the manual testing list. Results from earlier phases are labelled as earlier evidence and were not re-run, except where stated.

---

## 1. Environment and limits of this audit

| Item | State |
|---|---|
| Supabase project | Migrations **not applied**. `SUPABASE_SECRET_KEY` is **not set** locally, so every guest page and handler that needs the service role fails on purpose with a generic server error. |
| Database tests | PGlite (in-memory Postgres) plus **real PostgreSQL** (`embedded-postgres`), both with a shim that mimics Supabase's roles, auth, storage and Realtime, including Supabase's default `GRANT … TO anon, authenticated`. |
| HTTP tests | `next start` (production build) on localhost, probed with curl. |
| Browser tests | Playwright on Chromium (fake camera) against the production build. Only the public screens work without a backend. |
| Not available | A real Supabase Auth, Storage or Realtime service, real iOS/Android devices, a shared-Wi-Fi venue network. |

---

## 2. Passed checks (executed in this audit)

### 2.1 Build and automated suites

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ no errors (run before and after the fixes) |
| `npm run lint` | ✅ clean (before and after) |
| `npm run build` | ✅ production build OK (before and after): 40 app routes incl. 14 API handlers, Proxy detected |
| `npm test` | ✅ **203/203** after the fixes (202/202 before; +1 Phase 11 regression test) |
| `npm run test:concurrency` (real PostgreSQL, simultaneous connections) | ✅ **16/16**, run before and after adding migration 12 |
| Mutation check for the new fix | ✅ with migration 12 hidden, both delete-related tests **fail**; with it restored, they pass |

### 2.2 Concurrency (real PostgreSQL, `tests/concurrency/engine-concurrency.mjs`)
All run in this audit:
- 10 simultaneous `start_game` → exactly 1 succeeds, 9 get `stale_state`; the version moves by exactly 1.
- 10 simultaneous `start_round` → opened once, one open round.
- `start_countdown` racing `end_game` on the same version → one wins, one is stale.
- **12 simultaneous joins into 3 slots → exactly 3 admitted.** Joins racing Start Game → nobody admitted after the start.
- **10 simultaneous `begin`s of one capture → 1 intent. 10 simultaneous `complete`s → 1 accepted + 9 idempotent duplicates, 1 submission.**
- After acceptance every new attempt gets `already_submitted`. Two devices racing different captures → exactly one survives.
- A capture racing the host's *Close submissions* → accepted, never lost or doubled.
- Review racing announce (8 rounds; both orderings happened) → never a disqualified winner. 10 simultaneous announcements → one winner.
- Concurrent review decisions leave every photo in a valid state.

### 2.3 Security: database (PGlite suite + audit scripts)
- **Privilege inventory** (new audit script, with Supabase's default grants emulated): every `public` table has RLS. `anon` has no table privileges in `public` except `SELECT` on `subscription_plans`. `anon` can execute only `can_listen_game_topic` and trigger functions, which Postgres refuses to run outside a trigger. `authenticated` can execute only RPCs that check the caller themselves (`admin_*` re-check `super_admin`; host RPCs check ownership). The storage bucket is private, with one `SELECT` policy (owner path prefix or super admin) and no client insert, update or delete.
- Covered by the suite (executed): cross-subscriber reads, writes and deletes; token hashes unreadable; guests (anon) can't read or control games; forged tokens match nothing; cross-game submission forgery refused; storage path constraint; one submission per player per round; no submissions after close; no self-promotion to Super Admin (metadata, profile update, insert); clients can't grant subscriptions or edit plans or settings; expired, suspended, pending and deactivated accounts can't create or start games; per-period, active-game, round and player caps; who may listen to or publish on Realtime channels; winner write-once; players see review results only once the winner is official; the winner photo is reachable only during the announcement.
- Direct host writes over REST (audit script): raising `max_players` above the plan is **clamped by the trigger** (stored 50, not 100000). Kicking and un-kicking only affect the host's own game.

### 2.4 Security: HTTP (production server, 37 probes, all as expected)
- **Unauthenticated Super Admin APIs** (settings, plans, role, subscription, account) → `401`. A **forged Supabase cookie** claiming `super_admin` → `401`.
- **Unauthenticated Game Master APIs** (create, transition, submissions, results, review, remove player) → `401`.
- **Guest APIs** with no cookie or a malformed one (`state`, `realtime-token`, `winner-photo`, `begin`, `complete`) → `401`.
- **Join input validation:** form-encoded and `text/plain` bodies → `415` (CSRF shape refused), body over 8 KB → `413`, invalid JSON or an array body → `400`, bad or SQL-like room code → `400`, an empty name, a name of only zero-width characters, a 25-character name or a non-string name → `400`.
- **Open redirects:** `/auth/continue?next=//evil.com` and `/auth/confirm?next=https://evil.com` stay on the site.
- Protected pages redirect to the right login page with `next=`. API responses carry `Cache-Control: no-store`.
- **Secrets:** the value of `SUPABASE_JWT_SECRET` appears in **0** built files. No secret env names appear in `.next/static`. `SUPABASE_SECRET_KEY` / `SUPABASE_JWT_SECRET` are read only in `server-only` modules. `.env.local` is git-ignored and not tracked.
- New security headers present (see §4); `X-Powered-By` removed.

### 2.5 Browser (Playwright + Chromium, production build): 27/27
- No horizontal overflow on 8 public pages at **360×640, 390×844, 768×1024, 1280×800 and 1920×1080**, and no unexpected console or page errors.
- **axe-core WCAG 2.0/2.1 A + AA: 0 violations** on `/`, `/play`, `/join/<code>`, `/auth/login`, `/auth/sign-up`, `/auth/forgot-password`, `/admin/login` and the 404 page.
- **Reduced motion:** no long or infinite animations on the landing page.
- **Keyboard:** Tab reaches the room-code input, focus is visible, every input has a label, and Enter submits and navigates to `/join/<CODE>`.
- **Camera under the new Permissions-Policy:** `getUserMedia(video, rear camera preferred)` still works on this origin; the microphone is blocked.
- **Clickjacking:** `/admin/login` does not render inside a cross-origin iframe.

### 2.6 Code review (read, not executed)
- **Realtime cleanup** (`use-game-sync.ts`): the channel is removed on unmount (supabase-js disconnects when no channels remain). A cancelled start never creates a channel. The token-refresh timer, intervals and window/document listeners are all cleared. Broadcasts are only hints; stale or duplicate ones are dropped (unit-tested).
- **Indexes:** unique `players.token_hash` and `games.join_code`; `game_id` indexes on players, rounds and submissions; unique `(round_id, player_id)` on submissions and intents; `games.owner_id`. These cover the hot paths (session lookup, snapshot, ranking, period count).
- **Rendering:** the live SS.mmm timer writes straight to the DOM, not through React state. Re-render timers are 100 ms (player countdown, only while timed), 250 ms (projector) and 500 ms (time left on the camera screen). That's acceptable.
- **Image size:** client JPEG ≤ 1600 px on the long edge, quality steps 0.82 → 0.45 to reach ≤ 1.5 MB. Server checks `image/jpeg`, 1 KB ≤ size ≤ the platform limit (default 5 MB), and the `FF D8 FF` signature. Storage bucket limit 5 MB.
- **Timing** (unit-tested in `camera-timing.test.ts`, documented in [TIMING.md](TIMING.md)): elapsed time is fixed at the tap from a monotonic `performance.now()` clock offset. `begin` is sent before compression, so a slow upload can't change the time (tested). The server records its own `intent_at` and receipt time and flags inconsistent claims. Flagged photos rank by server-observed time. Results within **150 ms** count as a near tie and the host must look (SQL tests). TIMING.md §4 says plainly that millisecond fairness is not guaranteed.

---

## 3. Failed checks (found during the audit)

| # | Check | Finding | Status |
|---|---|---|---|
| F1 | Server-side subscription enforcement | A Game Master could call `DELETE /rest/v1/games?id=…` (and `game_rounds`) directly with their own session. The per-period game cap counts existing rows, so **delete and re-create bypassed the cap without limit**. Reproduced: 5 games created under a cap of 2. Side effects: orphaned photos in Storage, history erased from the admin metrics, and lobbies could be left with zero rounds. | **Fixed** (I1) |
| F2 | Session expiry handling for host/admin APIs | The proxy answered unauthenticated `/api/host/*` and `/api/admin/*` calls with a **307 to the login page**. `fetch` followed it and ended on an HTML `405`, so the UI showed a generic "request failed" instead of its own "Your session has ended. Please sign in again." | **Fixed** (I2) |
| F3 | Security headers | No clickjacking protection on host/admin controls, no `nosniff`, no Permissions-Policy, and `X-Powered-By: Next.js` was exposed. | **Fixed** (I3) |
| F4 | Rate limiting | No application-level rate limiting on any endpoint. | **Open**, launch blocker B4 |
| — | First browser run | 6 checks failed on the first run. Both causes were in the harness, not the app: (a) `/join/<code>` returns the server error boundary because `SUPABASE_SECRET_KEY` isn't set locally (correct fail-safe behaviour); (b) the Enter test didn't wait for client-side navigation. After fixing the harness, the re-run passed 27/27. | Not an app defect |

---

## 4. Issues fixed

| # | Change | Files | Verified by |
|---|---|---|---|
| I1 | New migration: drops `games_delete_own` / `rounds_delete_own` and revokes `DELETE` on `games` and `game_rounds` from `authenticated`. The app never deleted these rows; games end through `game_transition` (cancel / end / archive). | `supabase/migrations/20261111000012_production_hardening.sql` | New test *"hosts cannot delete their own games or rounds, so the per-period cap cannot be reset"*; the cross-tenant delete assertion is now stricter (`permission denied` instead of 0 rows); mutation check; concurrency suite re-run 16/16 |
| I2 | The proxy returns `401 {"error":"unauthenticated"}` (`no-store`) for unauthenticated `/api/*` requests instead of redirecting. Pages still redirect to login. | `lib/supabase/proxy.ts` | HTTP probe: all 12 host/admin API probes return 401 JSON |
| I3 | Global headers: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (room codes in URLs don't leak cross-origin), `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()`; `poweredByHeader: false`. | `next.config.ts` | curl header check; browser: camera works, microphone blocked, framing blocked |
| Docs | Migration list put back in order with #12 added. Out-of-date "known gaps" corrected in SECURITY.md (JPEG signature is checked; Realtime policies exist; the SSE stream is gone; rate-limit note rewritten). | `supabase/README.md`, `docs/SECURITY.md` | — |

No gameplay, UI or API behaviour changed beyond these fixes.

---

## 5. Remaining risks

| Risk | Impact | Recommendation |
|---|---|---|
| **No rate limiting** (join, state polling, begin/complete, host/admin APIs) | Bots can fill an open lobby up to `max_players` (the room code is public at the venue), and junk requests cost DB queries. Guessing room codes across about 1e9 codes is impractical but not throttled. | Edge or WAF rules (e.g. Vercel Firewall) per IP and path. **Allow a whole venue behind one NAT**: at least 60 joins/min per IP. Supabase Auth applies its own limits. |
| No full Content-Security-Policy (only `frame-ancestors`) | XSS has less defence in depth. React escaping is the main protection; `app/`, `components/` and `lib/` contain no `dangerouslySetInnerHTML`, `innerHTML` or `eval` (grep). | Add a nonce-based CSP via `proxy.ts` once it's tested with Cache Components. |
| Photo retention is not enforced | Storage grows without limit; privacy expectations aren't met. | Build the scheduled cleanup job (setting `photo_retention_days` already exists). |
| `verifyStoredPhoto` downloads the whole object to read 3 bytes | Up to about 1.5 MB of extra egress per submission; with 50 players that's about 75 MB per round. | Ranged read (`Range: bytes=0-2`) via a signed URL, once verified against real Storage. |
| Guest Realtime token is HS256, signed with the legacy JWT secret | Projects on asymmetric signing keys may reject it; the game then falls back to 4 s polling ("basic mode"). | Confirm on the real project (B2). |
| Timing fairness | Clock offset error up to RTT/2; device tampering is possible (no attestation). | Documented in TIMING.md §4; the host reviews near ties (≤ 150 ms). |
| Dependencies `next`, `@supabase/*` are `"latest"`; `eslint-config-next` 15.3.1 vs Next 16 | A fresh install could pull in breaking changes. | Pin exact versions before deploying. |
| Git layout | `bringme/` sits inside a parent repo (`~/Development`) with many unrelated staged projects and no commits. | Give BringMe! its own repo before CI/deploy. Confirm `.env.local` stays untracked (it is ignored today). |
| Kicked players can be un-kicked through REST (host's own game) | The host chose it; no cross-tenant impact. | Accept, or block in the trigger if "removal is final" must be strict. |
| Admin actions have no audit log | No forensic trail for subscription or role changes. | Add an append-only `admin_events` table. |

---

## 6. Launch blockers

1. **B1: Migrations 1–12 not applied** to the hosted Supabase project. Apply them in order (`supabase/README.md`), then set `SUPABASE_SECRET_KEY`, `SUPABASE_JWT_SECRET` and `NEXT_PUBLIC_SITE_URL` (a public HTTPS URL; QR codes encode it).
2. **B2: No end-to-end run on real Supabase.** Auth emails, signed uploads (`PUT` + CORS from browsers), Storage signed reads, Realtime private channels and the guest HS256 token have only been checked against fakes or shims.
3. **B3: No real-device run.** iOS Safari and Android Chrome camera permission, rear camera, interruptions (call, lock screen, app switch), upload on venue Wi-Fi or cellular, and clock-sync error on real networks.
4. **B4: Rate limiting / abuse rules** (F4) at the edge, at least for `/api/play/join` and `/api/play/*`.
5. **B5: Pin dependency versions** (`next`, `@supabase/ssr`, `@supabase/supabase-js`) and align `eslint-config-next`.

---

## 7. Manual testing requirements (Not executed: run on staging with a projector laptop and at least 3 real phones)

**Super Admin**
- [ ] `/admin/login` with a super admin → console. A subscriber signing in there is signed out with "forbidden".
- [ ] Subscriber list: search, filter, pagination. Activate, renew, assign plan, change expiry, suspend, deactivate and reactivate, each confirming the subscriber's dashboard updates.
- [ ] Expiry: set expiry in the past → the subscriber can't create or start games but can still end a running one.
- [ ] Plans create/edit/deactivate; settings save; the photo size limit reaches the Storage bucket.
- [ ] As a subscriber, call `/api/admin/*` with your own session → `403`.

**Game Master**
- [ ] Sign-up → verification email → login → pending restriction screen → admin activates → create game.
- [ ] Plan caps: active games, games per period, rounds, players (join until full).
- [ ] **Regression for F1:** `DELETE /rest/v1/games?id=eq.<own finished game>` with the publishable key + host JWT → `403`/permission denied.
- [ ] QR on the projector scans on iOS and Android and opens `NEXT_PUBLIC_SITE_URL/join/<CODE>`.
- [ ] Lobby: players appear live, remove a player, start game. Countdown, round, close, review (approve / disqualify / undo, photo viewer, close-finish comparison), declare winner, next round, end, archive.
- [ ] Double-click every control and use two host tabs → one action wins, the other says the state changed.
- [ ] **Regression for F2:** let the host session expire (or delete the auth cookies), then press a control → "Your session has ended…" message.

**Player**
- [ ] Scan QR → name (try a duplicate, emoji, too long or empty) → lobby. Refresh → same player, no duplicate.
- [ ] Camera permission prompt before round 1; deny → guidance → allow in settings → Try again.
- [ ] Countdown in sync across phones (within about 100 ms by eye); the item appears only at GO.
- [ ] Tap → "Locked in!" with time; refresh shows the same time; no retake.
- [ ] Winner screen (winner photo, own time, "You won!"), disqualification notice, final results.
- [ ] Reconnection: airplane mode for 10 s during a round and during the lobby; lock the phone for 30 s; switch apps during the countdown.

**Concurrency, network and timing on real infrastructure**
- [ ] 10+ phones join within 5 s; 10+ phones tap within 1 s; check one submission each and a sensible ranking.
- [ ] Two near-simultaneous taps (< 150 ms) → a "close finish" badge; the host resolves it.
- [ ] Throttle one phone to slow 3G → its upload is slow but its time is unchanged.
- [ ] Block the Realtime websocket on one phone → "basic mode" chip and the game still advances within about 4 s.
- [ ] Compare the claimed time with the server receipt time for 20 captures (host review shows both).

**Security on real infrastructure**
- [ ] Storage: an unsigned `GET` of `/storage/v1/object/submissions/<path>` → denied; another host's signed-URL request → denied.
- [ ] Upload a non-JPEG or a > limit file to a signed upload URL → `complete` rejects it and the object is deleted.
- [ ] A guest token used to subscribe to another game's channel → refused.
- [ ] Check response headers on the deployed domain (and HSTS from the host platform).

---

## 8. How to reproduce

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test
npm i --no-save embedded-postgres pg && npm run test:concurrency
```
The HTTP probe, privilege inventory and Playwright audit scripts used here are one-off harnesses kept outside the repo (session scratchpad). The checks they made are listed in §2.3–2.5.
