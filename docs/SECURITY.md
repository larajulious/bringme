# BringMe! — Security boundaries (Phase 2)

Three identities, three trust levels. The database is the source of truth; the Next.js layer adds early, friendly checks but is **never** the only control.

| Identity | How it authenticates | Postgres role | What it can touch |
|---|---|---|---|
| **Guest player** | Random token in an httpOnly cookie, validated by a server handler | `anon` has **no table privileges**; handlers use the service role | Only what `/api/play/*` does for the player resolved from the token |
| **Subscriber / Game Master** | Supabase Auth session | `authenticated` | Own games and everything under them (RLS) |
| **Super Admin** | Supabase Auth session + `profiles.role = 'super_admin'` | `authenticated` (read-only via RLS) | Reads all; writes only through server handlers that call `requireSuperAdmin()` |

## Boundaries

1. **Role storage.** The role lives in `public.profiles.role`. It is never read from JWT/user metadata (client-editable). `handle_new_user()` always creates `subscriber`, ignoring signup metadata.
2. **Super Admin cannot be self-assigned.** Three layers: (a) `authenticated` only has `UPDATE (display_name)` on profiles and no INSERT; (b) trigger `guard_profile_update` rejects role changes unless `current_user` is `postgres`/`service_role`/`supabase_admin`; (c) the only app path is `PATCH /api/admin/users/[id]/role`, which runs `requireSuperAdmin()` first and refuses self-changes. First admin: run `update public.profiles set role='super_admin' where email='…'` in the SQL editor.
3. **Anon has nothing.** All default Supabase grants are revoked; guests never talk to PostgREST tables.
4. **Tenant isolation (RLS).** `games.owner_id = auth.uid()`; rounds/players/submissions authorize through `owns_game(game_id)`. Admin policies are SELECT-only.
5. **Column-level grants.** Hosts cannot read `players.token_hash`, cannot change `owner_id`/`join_code`/`status` on insert, cannot write submissions' ownership columns or any subscription/plan data.
6. **Entitlements are enforced in the database** (triggers, so they also bind the service role): an unexpired `trialing`/`active` subscription is required to create games, add rounds, open the lobby or go live. Expiry is **time-based** (`current_period_end > now()`), so a stale status can't keep access. Finishing/cancelling never requires a subscription. Plan limits (active games, players, rounds) are checked too. Super admins bypass limits (they are not subscribers). `requireActiveSubscription()` calls the same `my_entitlement()` for early UX errors.
7. **Guest sessions.** Token = 32 random bytes (CSPRNG, base64url). Only `SHA-256(token)` is stored (`players.token_hash`, unique). Cookie is `httpOnly`, `SameSite=Lax`, `Secure` in production, 12h. Handlers derive `player_id` and `game_id` **only** from the token lookup; request bodies never carry identity. Kicked players are rejected.
8. **No forged submissions.** Composite FKs force `(round, game)` and `(player, game)` to match, so a submission can't cross games. `UNIQUE(round_id, player_id)` prevents duplicates. A trigger requires game `live`, round `open`, within the time limit (+5s grace), and player not kicked. `storage_path` is CHECK-constrained to `<game>/<round>/<player>.<ext>`.
9. **Private photos.** Bucket `submissions` is private (5 MB, jpeg/png/webp). No client can insert/update/delete objects. Upload (Phase 8): `/api/play/submissions/begin` validates the guest/round/duplicate rule and returns a signed upload URL for **one server-chosen path** (no upsert); `/api/play/submissions/complete` verifies the stored object (type, size, JPEG signature), then creates the submission. Read: only the game's owner (path prefix) or super admin, via short-lived signed URLs created under the host's own session.
10. **Service-role key.** `lib/supabase/admin.ts` is `server-only` and reads `SUPABASE_SECRET_KEY` (no `NEXT_PUBLIC_`). Callers must authorize first and scope every query.
11. **Request hygiene.** JSON-only bodies (CSRF mitigation), 8 KB cap, UUID/shape validation, generic error codes, `Cache-Control: no-store`.

## Phase 3 additions
12. **Server-verified areas.** `/admin/**` and `/dashboard/**` call `requireAdminPage()` / `requireSubscriberPage()` in the layout *and* each page (layouts don't re-run on client navigation). The proxy redirect is only a UX gate.
13. **Role-based landing is server-side.** `/auth/continue` reads `profiles.role`; `?area=admin` signs out non-admins. Signup has no role input and `handle_new_user()` ignores metadata.
14. **Access states are derived in SQL** (`access_state_for`), the same entitlement logic the game triggers use. New users are `pending`; only an admin (service-role RPC `admin_set_subscription`, reached via `requireSuperAdmin()`) can activate/suspend. `my_access_status()` returns only the caller's own state; `admin_list_subscribers()` self-checks `is_super_admin()`.
15. **Redirect safety.** `next` parameters pass through `safeNext` (same-site absolute paths only). Auth error copy is mapped, never raw provider text; reset/signup responses don't reveal whether an email exists.
16. **Suspension scope.** Suspending blocks creating games/rounds and opening the lobby / going live. A game already `live` can still be finished (by design).

## Phase 4 additions
17. **Every admin action:** `requireSuperAdmin()` (role from `profiles`) → input validation (`lib/admin/validation.ts`, unknown fields ignored) → service-role/SQL call that validates again. Admin *reads* use the admin's own session: SQL functions (`admin_overview`, `admin_list_subscribers`, `admin_subscriber_state`) re-check `is_super_admin()`, so a non-admin gets `forbidden` even if they call them directly.
18. **Writes to plans, settings and subscriptions are service-role only** (no client grants). `platform_settings` is readable by signed-in users (non-sensitive values only).
19. **Deactivation** removes entitlement in the database *and* bans the Auth user; existing sessions are rejected by `requireSubscriberPage()`. Admins cannot deactivate or change their own account.
20. **Search safety.** Search text is escaped for `ILIKE` (`%`, `_`, `\` literal), state and paging inputs are whitelisted/clamped.
21. **Photo limit** is enforced by Storage (bucket `file_size_limit` synced by trigger), not by trusting the browser.

## Phase 5 additions
22. **Game creation is protected end to end:** `POST /api/host/games` requires an *active* subscription (`my_entitlement`), validates against the caller's plan, then calls `create_game_with_rounds()` as `SECURITY INVOKER` — RLS and all triggers apply, owner = `auth.uid()`, and the whole call is one transaction (no half-created games).
23. **Host endpoints run as the host, not the service role** (start, cancel, remove player). Ownership is enforced by RLS and by scoping each query; someone else's game or player id returns 404, same as a missing one.
24. **Identifiers:** game ids are random UUIDs; room codes come from a CSPRNG, are unique by index, and only grant access to the (future) join flow, never to host data.
25. **Join links** use `NEXT_PUBLIC_SITE_URL` only; request headers are never used, so a spoofed `Host` cannot poison the QR code. `joinUrl()` rejects anything that isn't a 6-char `[A-Z0-9]` code.
26. Removing a player sets `kicked_at`; their token then fails `requireGuestPlayer` and the DB blocks new submissions from them.

## Phase 6 additions
27. **Guest endpoints (service role) are narrow, audited SQL functions** — `public_room_info`, `join_game`, `player_lobby_state` — executable only by `service_role`, returning just what the join page / lobby needs. No raw table access for guests.
28. **Joining is atomic and idempotent:** the same browser (cookie hash belongs to this game) gets its existing player back instead of a duplicate; capacity, lobby/live status and per-game name uniqueness are enforced by the database, so concurrent joins cannot overshoot `max_players`. Removed players stay blocked (`player_removed`, kicked rows keep their name).
29. **Names are labels, not credentials.** Access is only ever the random token (hash lookup). Names are normalised (NFC), stripped of control/zero-width/bidi characters, length-limited and rendered as text by React.
30. **Live updates are authorized per connection:** `/api/play/state` requires the HttpOnly cookie (401 otherwise), reads only that player's game, and sends only `{nickname, title, status, playerCount, maxPlayers, kicked}` — never other players' ids or tokens. Supabase Realtime was deliberately not used for guests (no JWT to authorize them).
31. The join page reveals only title, status and head-count of a room to anyone holding its code (the code is the capability). The lobby page for `/join/X/lobby` redirects away unless the cookie belongs to room X.

## Phase 7 additions
32. **One writer for game state.** `status`, `phase`, `state_version`, round status and `winner_player_id` can only be changed by `game_transition()` (column UPDATE grants revoked, even for the owner). It runs as definer but authorizes explicitly: caller must be `auth.uid()` = owner (non-owners get `game_not_found`, same as a missing game), then locks the row, checks the expected version, then checks the transition table.
33. **No double actions.** Row lock + `expectedVersion` + one-open-round unique index; proven with simultaneous connections on real PostgreSQL. Rejected requests change nothing and broadcast nothing.
34. **Spoiler protection.** The round item is withheld from player snapshots until `opened_at` (server clock); broadcasts never contain game content, only `{version, phase}`.
35. **Realtime authorization.** Private channel `game:<uuid>`; listen policy = owning host or a guest token with `kind=guest` and that exact `game_id`. No INSERT policy → no client can publish; even a forged hint only causes a re-read of the authoritative, access-controlled snapshot. Guest tokens are 1 h, `role: anon` (zero table privileges), minted only for a valid, non-removed session, and require `SUPABASE_JWT_SECRET` (server only).
36. **Players join only before the game starts** (DB trigger + `join_game`); existing players restore from their token; removed players stay locked out and their snapshot says `kicked`.
37. **Time.** All countdown/round timestamps are generated by the database; clients correct for clock offset but never produce timestamps. Submissions are rejected before `opened_at` and after the time limit.

## Phase 8 additions
38. **A submission can only exist through `begin_submission` → `complete_submission`** (service role; guests never touch tables). `begin` validates session, game, current round, official-start and time-limit, then records an *intent* (server clock). A trigger refuses any direct insert without an intent.
39. **One submission per player per round, race-safe:** per-player row lock + `UNIQUE(round_id, player_id)`; retries are idempotent (`duplicate`), a new capture after acceptance gets `already_submitted`; nobody can overwrite another's file because the storage path is derived from DB-verified ids and constrained by a CHECK.
40. **Upload authorization:** single-use signed upload URL for ONE server-chosen path, issued only after `begin` succeeds; `complete` re-verifies the stored object (content type, size within the platform limit, real JPEG signature) and deletes junk plus its intent. Bucket stays private; hosts read via 2-minute signed URLs scoped by the storage RLS policy.
41. **Timing is a claim.** The server records its own `intent_at` and receipt time, cross-checks the claim, and falls back to server-observed time when inconsistent. Maximum undetected lead is 1 s; a tap→upload window of 45 s prevents "tap early, photograph later"; a new capture restarts its timing. See TIMING.md.
42. **Client metadata is untrusted:** whitelisted keys, numeric clamps, enum values, 1 KB cap (TypeScript) and type-checked in SQL (junk can't break completion).
43. **Camera:** no microphone, no file input, live `getUserMedia` stream only, secure context required; the stream is released when the game ends.

## Phase 9 additions
44. **Reviews go through one function.** `review_submission()` checks the caller owns the game, the photo belongs to the *current* round of a *live* game in `active`/`reviewing`, and the winner isn't official yet. Direct client UPDATEs of submission status are revoked; a trigger also blocks status changes once the round's winner is confirmed.
45. **The server decides the winner.** `announce_winner` recomputes the fastest *approved* submission (removed players excluded) and compares it with the host's confirmation; any difference is `winner_mismatch`. Review and announcement take the same game-row lock, so they are strictly ordered (proved on real PostgreSQL: never a disqualified winner).
46. **Write-once results.** `winner_player_id/_submission_id/_rank_ms/_confirmed_at` can't change after confirmation (trigger, also for trusted roles); clients have no UPDATE rights on them. One announcement per round.
47. **Photos stay private.** Hosts read through 2-minute signed URLs under their own session (storage RLS). Players get exactly one path — the winner's — from `player_winner_photo()`, only while their game's phase is `winner_announced`; nothing else is addressable. A disqualified player's outcome is not revealed before the winner is official.
48. **Archive** is a host-only, once-only transition for *finished* games; archived games remain frozen (the only allowed edit on a closed game is `archived_at` plus its version bump).

## Known gaps (not done in Phase 2)
- Camera upload/CORS and mobile-browser behaviour are unverified on real devices and a live Supabase project. A modified client can still upload an arbitrary image or claim up to 1 s of lead (TIMING.md §4).
- Realtime has not been exercised against a live Supabase project (see PROJECT_STATUS known issues). Token/auth endpoints and `/api/play/state` have no rate limiting.
- **No application rate limiting** on `/api/play/*` (join, state, begin/complete) or the host/admin APIs; Supabase applies its own limits to the auth endpoints. DB limits bound the damage (max players per game, joins only while the lobby is open, one capture per player per round), but add edge/WAF rules before launch (see PRODUCTION_READINESS.md). A per-IP limit must allow a whole venue behind one Wi-Fi NAT.
- Image content is checked by MIME, bucket size limits and the JPEG signature (Phase 8), not by full decoding or moderation.
- Realtime is Broadcast-only on private `game:<id>` channels with a `realtime.messages` policy (Phase 7). Don't add these tables to the `supabase_realtime` publication (Postgres Changes) without new policies.
- No admin audit log yet; photo-retention deletion is not implemented (setting only).
- Billing integration is out of scope: subscriptions are written only by the service role.

## Tests
`npm test` runs `tests/db/authorization.test.ts` against the real migrations in an in-memory Postgres (PGlite) with a Supabase role/auth/storage shim. A mutation check (disabling RLS, triggers, or granting anon access) makes these tests fail. They do not exercise the Next.js handlers or Supabase's own GoTrue/Storage services; verify those against a staging project.
