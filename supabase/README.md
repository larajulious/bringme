# Database migrations & deployment

Migrations (apply in order, all idempotent-guarded):

0. `20261110000000_legacy_schema_compat.sql` — **only matters if the project already had older BringMe! tables** (no-op on a fresh project). Adds/backfills the columns migration 1 expects, converts text statuses/roles to the enums, adds the keys later files need, removes legacy RLS policies. Never drops tables, columns or rows. See "Upgrading a database with an older schema" below.
1. `20261111000001_core_schema.sql` — enums, tables, constraints, indexes, profile trigger, plan seed
2. `20261111000002_security_rls.sql` — helper functions, entitlement/state triggers, grants, RLS
3. `20261111000003_storage.sql` — private `submissions` bucket + read policy
4. `20261111000004_subscription_suspended_enum.sql` — adds the `suspended` status (must be its own transaction)
5. `20261111000005_access_status.sql` — access states, admin subscriber list, manual activation function
6. `20261111000006_admin_dashboard.sql` — plan period cap, account deactivation, platform settings, admin overview/search/plan/expiry RPCs (replaces two Phase 3 functions)
7. `20261111000007_game_creation.sql` — atomic `create_game_with_rounds()` (runs as the caller)
8. `20261111000008_guest_join.sql` — service-role-only `public_room_info`, `join_game`, `player_lobby_state`
9. `20261111000009_game_engine.sql` — phase/version state machine (`game_transition`), snapshots, Realtime broadcast + channel policy; **revokes direct status writes**
10. `20261111000010_submissions_timing.sql` — camera submissions: intents, begin/complete functions, timing flags, ranking
11. `20261111000011_review_winners.sql` — review decisions, server-computed winners (write-once), results, archive, winner-photo gating (**revokes direct submission edits**)
12. `20261111000012_production_hardening.sql` — Phase 11: hosts can no longer DELETE games/rounds directly (closed a per-period game-cap bypass and orphaned photos)

**7-Day Game Pass** (Game Pass Phase 2; design in [GAME_PASS_DESIGN.md](../GAME_PASS_DESIGN.md), results in [MIGRATION_VERIFICATION.md](../MIGRATION_VERIFICATION.md)). Files 1–6 change no behaviour; 7 is the single cutover.

13. `20261112000001_game_pass_types.sql` — enums `pass_source`, `pass_disposition`, `order_status`
14. `20261112000002_plan_catalogue.sql` — plan `tier/duration_seconds/is_trial`, Free Trial plan, `plan_prices` (PHP + USD, minor units)
15. `20261112000003_pass_ledger.sql` — `btree_gist`, `game_passes`, `pass_segments` (no-overlap exclusion), `entitlement_events` (append-only), `profiles.hosting_suspended_at`
16. `20261112000004_orders_webhooks.sql` — `pass_orders` (payment state machine), `payment_events` (webhook idempotency)
17. `20261112000005_pass_functions.sql` — replan, grants, trial, admin tools, orders, `apply_payment_event`
18. `20261112000006_legacy_backfill.sql` — every `subscriptions` row → a `legacy_subscription` pass with the same interval; then Pro 200 → 100 players
19. `20261112000007_entitlement_cutover.sql` — **behaviour change**: entitlement from the ledger, room capacity = pass cap, `subscriptions` frozen. Revert: [`rollback/20261112000007_entitlement_cutover_revert.sql`](rollback/20261112000007_entitlement_cutover_revert.sql) (not a migration)

20. `20261112000008_auto_trial.sql` — **automatic free trial**: granted once when a Game Master's email is confirmed (trigger on `auth.users`, never blocks sign-up) or at the next sign-in (`ensure_my_trial`); eligibility tightened to "never had any pass"; `my_game_pass_summary()` for the dashboard

21. `20261112000009_polar_price_mapping.sql` — Polar mapping (Phase 4): orders snapshot `polar_environment` + `polar_product_id` (ids come from per-deployment env), `create_checkout_order`, `attach_verified_checkout` (cancels on any price/currency/product mismatch), webhook checks against the snapshot. Setup: [POLAR_PRODUCT_SETUP.md](../POLAR_PRODUCT_SETUP.md)

22. `20261112000010_checkout_flow.sql` — checkout flow (Phase 5): idempotent `start_checkout_order` (double clicks reuse the same open checkout), checkout URL/expiry on the order, `my_checkout_status` for the return page. Still no entitlement from checkout

23. `20261112000011_webhook_fulfilment.sql` — verified webhook fulfilment (Phase 6): `apply_payment_event` also checks buyer (`customer.external_id`), checkout, server-side rejections, exact amount (total or net), Polar "refunded" = full refund, repeated refunds are no-ops

24. `20261112000012_capacity_enforcement.sql` — Phase 7: restoring a removed player (`kicked_at → null`) is capacity-checked like a join (closed an over-capacity bypass)

25. `20261112000013_game_pass_admin.sql` — Phase 8: purchase history (`my_purchase_history` / `admin_purchase_history`), audited plan edits and per-currency price changes (`admin_update_plan`, `admin_set_plan_price`, `admin_audit_events`), revenue per environment × currency (`admin_revenue`, `admin_pass_counts`)

26. `20261112000014_plan_polar_sync.sql` — admin plan edits synchronised to Polar: `plan_polar_state` (per-environment price ids, status, last synced, error), `plan_sync_jobs` (previous + requested config, one open job per plan), begin/retry/fail/finish functions, `record_polar_product_state` (product.updated never overwrites local data)

27. `20261112000015_snappy_taps.sql`, `20261112000016_snappy_counter_simplify.sql` — homepage boop counter (no game data)

**BingoSnap (Extra Fun)** — design in [BINGOSNAP_DESIGN.md](../BINGOSNAP_DESIGN.md). Additive: no existing function is redefined, existing games become `game_type = 'bring_me'`, and no photo data is ever stored.

28. `20261112000017_bingosnap_schema.sql` — `games.game_type` (immutable, not client-writable), `bingo_games` (board settings + database-clock timer), `bingo_cells`, `bingo_submissions` (one row per claim attempt), RLS (owner/admin read, no client writes), and guards so Bring Me code paths (rounds, photo intents/submissions, `game_transition`, direct status writes) refuse BingoSnap games
29. `20261112000018_bingosnap_functions.sql` — `create_bingosnap_game`, `bingo_transition`, `bingo_update_settings`, `bingo_review_submission`, `bingo_host_state` (host); `bingo_player_state`, `bingo_submit_claim` (service role). Revert: [`rollback/20261112000017_18_bingosnap_revert.sql`](rollback/20261112000017_18_bingosnap_revert.sql) (not a migration; refuses to run while any BingoSnap game exists)

30. `20261112000019_bingosnap_board_drafts.sql` — card editor: drafts may leave squares empty, `bingo_games.board_revision` (a second tab's save is refused with `stale_board`), `bingo_save_board` (create / save / publish; editable until the game starts, then `board_locked`), and a trigger that refuses to publish or start an incomplete board or one with duplicate instructions
31. `20261112000020_bingosnap_lobby.sql` — joining and the lobby: `bingo_room_info` (service role: room type, title, status, headcount, board shape, never challenges), `bingo_player_state` now includes the room code, and `bingo_start` (host: start game + 3 s countdown + hunt in one transaction; every rule stays in `bingo_transition`). Joining itself is unchanged (`join_game` + the capacity trigger)

32. `20261112000021_bingosnap_claims.sql` — reliable claims: `bingo_submissions.request_id` + a unique index per player, a 3-argument `bingo_submit_claim` (a replay of the same request returns the existing claim; the deadline is judged on arrival with `statement_timestamp()`; no grace after the host ends the hunt early). The 2-argument function now delegates to it with the same rules. Additive: one nullable column, one index, one new function

Apply 28, 29, 30, 31, then 32 (each in its own `begin; … commit;` in the SQL Editor, or `db push`). Afterwards run [`inspect/bingosnap_postflight.sql`](inspect/bingosnap_postflight.sql) (read-only) and compare with the expected values in its comments.

Before 13–26 run [`inspect/game_pass_preflight.sql`](inspect/game_pass_preflight.sql); after, [`inspect/game_pass_postflight.sql`](inspect/game_pass_postflight.sql). **After 19, never re-run 6, 9 or 11 on their own** (they redefine functions with the legacy bodies); re-running the whole sequence in order is safe.

**Status:** generated and tested locally (`npm test`); **not yet applied** to the hosted project. The project's REST schema was empty when inspected, so nothing needs migrating or backing up.

**Disposable email protection** — new accounts can't use temporary inboxes. Details and operations: "Disposable email protection" below.

33. `20261112000029_disposable_email_guard.sql` — `disposable_email_domains` (active blocklist), `disposable_email_allowlist`, `disposable_email_list_versions` (snapshots), `is_disposable_email`, the Auth hook `hook_before_user_created`, and service-role `apply_disposable_email_list` / `rollback_disposable_email_list` / `disposable_email_list_status`. No existing object changes
34. `20261112000030_disposable_email_seed.sql` — allowlist (major providers + privacy relays) and the upstream list (10,181 domains, commit `ba992a0`) as version 1; does nothing once any version exists. Revert both: [`rollback/20261112000029_30_disposable_email_revert.sql`](rollback/20261112000029_30_disposable_email_revert.sql) (turn the hook off first)

**Concurrency fix** (audit G1, [BRINGME_SUPABASE_AUDIT.md](../BRINGME_SUPABASE_AUDIT.md)).

35. `20261113000001_submission_lock_order.sql` — `begin_submission` / `complete_submission`: lock clauses only (game row `FOR NO KEY UPDATE` in complete; player row `FOR NO KEY UPDATE` in both). Removes the deadlock between players submitting at the same time. Same signatures and grants; re-runnable. Revert: [`rollback/20261113000001_submission_lock_order_revert.sql`](rollback/20261113000001_submission_lock_order_revert.sql) (brings the deadlock back). Requires 10; safe after 30

**Realtime audience** (Phase 2, [BRINGME_PHASE2_REALTIME_OPTIMIZATION.md](../BRINGME_PHASE2_REALTIME_OPTIMIZATION.md)). **Requires 35** (the migration refuses to run without it).

36. `20261113000002_realtime_audience.sql` — every hint carries a `scope` (`all` / `roster` / `claims` / `host`); host-only hints (photo submissions, Bring Me review decisions, BingoSnap claims) go to the owner-only topic `game:<id>:host`; `can_listen_game_topic` allows that topic to the owner only; host snapshots gain `rosterKey` / `submissionsKey`. `complete_submission` keeps 35's locks (one line changed: its hint's topic). Re-runnable. Revert: [`rollback/20261113000002_realtime_audience_revert.sql`](rollback/20261113000002_realtime_audience_revert.sql) (keeps 35). Deploy the app first (see the report, section J)
37. `20261113000003_tv_screen_links.sql` — **TV links** (public presenter screen for smart TVs, no sign-in): `game_screens` (one random 12-character token per game; RLS on, no client access), `screen_link(p_game, p_reset)` (owner only, `authenticated`; drafts refused), `screen_state(p_token)` (service role only: Bring Me player snapshot + side-list fingerprints, BingoSnap presenter view), `can_listen_game_topic` also accepts a `kind=screen` Realtime token for both topics while its `screen_token` is the game's current link (a reset cuts it off), `round_ranking` / `game_results` executable by the service role. Requires 36. Re-runnable. Revert: [`rollback/20261113000003_tv_screen_links_revert.sql`](rollback/20261113000003_tv_screen_links_revert.sql)

## Apply to the existing Supabase project

```bash
npx supabase init                      # once: creates supabase/config.toml (keeps migrations/)
npx supabase login
npx supabase link --project-ref <project-ref>   # from the dashboard URL
npx supabase db push --dry-run         # review what will run
npx supabase db push                   # apply
npm run db:types                       # optional: regenerate lib/supabase/database.types.ts
```

No CLI? Open **SQL Editor** and run the eleven files in order, one at a time.

## After applying
1. Add `SUPABASE_SECRET_KEY` to the server environment (Vercel env, `.env.local`). Never expose it to the browser.
2. Create your account at `/auth/login` (email code), then promote it once in the SQL editor:
   `update public.profiles set role = 'super_admin' where email = 'you@example.com';`
3. To test hosting, give a user a Game Pass (service role / SQL editor; `public.subscriptions` is frozen after the Game Pass cutover):
   `select public.admin_grant_pass(null, '<user-uuid>', 'party', 7, 'test access');`
   (or use Admin → Subscribers → Grant a Game Pass; or let the host claim the free trial).
4. In Auth settings, keep "Confirm email" on; do not enable anonymous sign-ins (guests don't use Auth).
5. Plan limits live in `subscription_plans`; prices in `plan_prices` (PHP and USD separately, minor units). A price becomes purchasable once its `polar_product_id` is set (Phase 3).

## Disposable email protection
New Game Master accounts can't be created with temporary inboxes (Mailinator, YOPmail, Guerrilla Mail, …). Existing accounts, sign-in, purchases and passes are unaffected.

**How it works**
- **Authoritative:** Supabase Auth calls `public.hook_before_user_created` before it creates a user, for every signup path (our form, direct Auth API calls, `signInWithOtp` with `shouldCreateUser`). A rejected signup creates no user and sends no confirmation email. Signing in never creates a user, so the hook never runs for existing accounts.
- **Early answer:** "Create account" first asks `POST /api/auth/email-check` (rate-limited, same-origin, domain only, never logs the address), so the error appears under the email field. If the check is unavailable it answers "allowed" and the hook decides. "Sign in" never calls it.
- **Matching:** the email's domain and each parent with ≥ 2 labels are compared **exactly**, so `x.mailinator.com` is blocked and `bringmailinator.com` is not. At each level the allowlist wins. No network requests during signup: the list lives in the database.
- **Allowlist kinds:** `provider` (Gmail, Outlook, Yahoo, iCloud, Proton, …): an update containing one is refused as corrupt. `privacy_relay` (Apple Hide My Email, DuckDuckGo, Firefox Relay, SimpleLogin, addy.io, Proton Pass): permanent aliases, never blocked. `false_positive`: verified mistakes upstream.

**Enable it (once per project, after applying 33 + 34)**
1. Dashboard → **Authentication → Hooks** (Auth Hooks) → **Before User Created** → *Add hook*.
2. Hook type **Postgres**, schema **public**, function **hook_before_user_created** → **Create/Enable**.
3. Test in an incognito window at `/auth/login?mode=signup`: `you@mailinator.com` shows *"Temporary email addresses aren't supported…"* under the field, and **Authentication → Users** gets no new row. A real address still receives the confirmation link.
4. Bypass test (no UI): `curl -X POST "$SUPABASE_URL/auth/v1/otp" -H "apikey: $PUBLISHABLE_KEY" -H 'content-type: application/json' -d '{"email":"x@mailinator.com","create_user":true}'` → HTTP 400 with the same message, no user created.

The migrations grant the hook to `supabase_auth_admin` and revoke it from `anon`/`authenticated`. The hook is `security definer`, so Auth needs no table access.

**Updating the list** (server key required; validation runs in the script and again in the database, and a failed check leaves the active list untouched)
```bash
npm run disposable:update -- --status      # active version, upstream commit, counts, stored versions
npm run disposable:update -- --dry-run     # download + validate, apply nothing
npm run disposable:update                  # apply as a new version
npm run disposable:update -- --file my-list.txt   # apply a local file (one domain per line, # comments)
npm run disposable:update -- --rollback    # back to the previous version (or --rollback <id>)
```
An update is refused if it has fewer than 1,000 domains, any invalid entry, is missing a sentinel (mailinator.com, guerrillamail.com, yopmail.com, 10minutemail.com), contains a `provider` domain, or shrinks the list by more than 20% (`--allow-shrink` to accept). The five most recent versions are kept for rollback. Schedule it monthly from any trusted runner (cron, GitHub Actions with `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SECRET_KEY` secrets). A failed download simply exits non-zero.

**One-off changes** (SQL editor)
- Allow a verified false positive: `insert into public.disposable_email_allowlist (domain, kind, reason) values ('example.org', 'false_positive', 'Ticket #123: real company');`
- Block a domain before upstream lists it: add it to a file and use `--file`, or wait for upstream. Never block a whole domain because of one suspicious user.

**Rollback the feature:** disable the hook in the Dashboard first, then run [`rollback/20261112000029_30_disposable_email_revert.sql`](rollback/20261112000029_30_disposable_email_revert.sql).

## Supabase Auth settings (passwordless Email OTP)
Hosts and the Super Admin sign in with a 6-digit email code at `/auth/login` (`/admin/login` for admins). New and returning hosts use the same screen.
- **Authentication → URL Configuration:** Site URL = your production URL (`https://bringme.fun`); add Redirect URLs `http://localhost:3000/**` and `https://bringme.fun/**`.
- **Providers → Email:** Email provider ON, "Confirm email" ON. **Email OTP Length** must equal `NEXT_PUBLIC_AUTH_OTP_LENGTH` in the app env (6–10; default 6). Both must change together, and the app needs a rebuild because the value is built in. Keep the OTP expiry at Supabase's value (default 3600 s); the app does not run its own expiry.
- **Email templates:** the login page has explicit **Sign in** and **Create account** tabs (Supabase answers identically for new and known emails, so the app can't safely tell them apart). *Confirm signup* (sent to new / never-confirmed emails from "Create account") must contain the **token-hash confirmation link** `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (see `supabase/templates/confirm-signup.html`), **not** `{{ .ConfirmationURL }}`: the app shows a "Check your email!" screen with no code field, and `/auth/confirm` verifies the hash on the server (`verifyOtp`), so the link works in any browser or device. The link opens a "Confirm my email" page (`/auth/verify`); only its button uses the token, so email scanners that prefetch links can't burn it. *Magic Link* (sent to confirmed emails) must contain the **code** (`{{ .Token }}`, see `magic-link.html`): the app shows the code screen. Site URL must be the canonical production URL (`https://www.bringme.fun`; the apex 308-redirects there keeping the query), since the confirmation link is built from it and must never be localhost. Redirect URLs must still include every host people sign up on (`https://www.bringme.fun/**`, `https://bringme.fun/**`) for `emailRedirectTo`.
- **SMTP (Resend):** host `smtp.resend.com`, port 465, user `resend`, password = Resend API key (stored only in Supabase), sender `login@mail.bringme.fun`. Raise **Rate Limits → emails per hour** above the default after enabling custom SMTP.
- **Rate limits / abuse:** Supabase already enforces one OTP per email every 60 s (the UI cooldown matches it) and verify-attempt limits. CAPTCHA (Turnstile/hCaptcha) is **not** wired into the UI yet. If you enable it in Auth → Attack Protection, sign-in will fail until a widget passes `captchaToken`.
- **Password sign-in:** no UI uses it any more. Leave the password provider enabled until you've confirmed that no admin account, script or integration still signs in with a password. Existing passwords then just go unused.
- Do not enable anonymous sign-ins.

## Manual auth checklist (after applying)
1. New host: `/auth/login` → enter a fresh email → **Check your email** → type/paste the 6-digit code → lands on `/dashboard` with the free trial active. Repeat with an account that used to have a password: same user id, same games and passes. A wrong code, or an old one after **Resend Code**, is rejected. Resend stays disabled for 60 s. Refreshing on the code screen keeps it.
2. Sign in as your promoted super admin at `/admin/login` → `/admin/dashboard` lists the new subscriber; **Activate** (party, 30 days).
3. Reload the subscriber's dashboard → **Active**. Confirm a non-admin who signs in at `/admin/login` is signed out with "not a Super Admin".
4. **Suspend** → subscriber sees the paused screen; creating/starting games stays blocked (DB triggers).
5. Old links `/auth/sign-up`, `/auth/forgot-password` and `/auth/update-password` redirect to `/auth/login` (keeping `?next=`). Start at `/dashboard/subscription?buy=party` signed out → sign in with a code → you land back on the Game Pass checkout pick.
6. Admin console: `/admin/subscribers` search + filter + pagination; open a subscriber → assign plan, change expiry, suspend, deactivate (try signing in as them: blocked), reactivate. `/admin/plans`: create a plan with a games-per-period cap and confirm the subscriber is stopped after that many games. `/admin/settings`: change max photo size and confirm Storage → `submissions` bucket limit follows.
7. Host flow: as an active subscriber open `/dashboard` → **Create game** → add rounds (try reordering/deleting, leave one empty) → lobby opens with a QR. Scan it with a phone (must reach `NEXT_PUBLIC_SITE_URL`): you land on `/play/<CODE>`. Try *Present fullscreen*, copy link, cancel game. As a pending/expired user the Create button is absent and `/dashboard/games/new` shows the restriction screen. Open another host's lobby URL: 404.
8. Player flow (use two phones/browsers): scan the QR → room title + name field → join → "You're In!"; the host lobby count rises within ~3 s and the player's own count updates within ~2 s. Reload the player page: still in, no duplicate. Join with a taken name: friendly error. Remove a player from the host lobby: their screen switches to "removed". Start / cancel the game: players' screens react. Toggle airplane mode: status shows Offline then Connected.
9. Game engine (2+ phones + a host laptop): create a game, join on the phones, **Start game** (new joins are now refused), **Start countdown** → both phones show a synchronised 3-2-1; **Start round** → the item appears on both at the same moment (not before); **Close submissions → Move to review → Announce winner** → winner/others see the right screen; **Next round** → back to waiting. Mid-countdown, refresh a phone (state restored) and toggle airplane mode (offline → caught up on return). Open the host page in two tabs and click the same button in both: only one wins, the other shows "The game just changed". The status chip should read **Connected** (not "basic mode"); if it says basic mode, revisit the Realtime setup above.
10. Camera round (real phones, HTTPS URL): join, allow the camera on the waiting screen, run a round, tap the coral button. Expect **Locked in!** with an SS.mmm time within a couple of seconds; host sees the photo, rank and time in the review step. Try: double tap, airplane mode right after the tap (it should retry/offer Try again and keep the time), deny the camera, lock the phone and return. Check the Storage bucket `submissions` has the file and is **private**; Storage → Policies must still allow only owner reads.
11. Review & winners (host laptop + 2–3 phones): run a round, let two players submit photos within ~100 ms of each other if you can. On the host screen check the live list (name, photo, SS.mmm, status, "close finish"), open a photo (two close photos open side by side), **Disqualify** the one that doesn't show the item, **Approve** the other, then **Declare winner…** and read the confirmation dialog. Players: winner sees "You won!" with confetti, others see the winner's name/time/photo and their own time; a disqualified player sees that only after the announcement. Try **Present fullscreen** (Esc exits) and press **Next round** from inside it. After the last round finish the game, check the results list on host and phones, and **Archive game**. Photos must stay private: opening a photo URL after ~2 minutes should fail.
12. BingoSnap card editor: Extra Fun → Create game → tap squares and type instructions (arrows, Enter/Shift+Enter, Esc, Delete; paste a list), **Save draft**, reload (draft kept), switch to 5×5 and back (a warning lists anything removed), Player preview, **Publish board** (refused until every square is filled). Then the lobby (opens after publishing): scan the QR code from two phones (or enter the code at `/play`), join with a name each → both appear on the host's lobby within a second (Realtime) and the count shows n / your pass cap → refresh a phone (same player, no duplicate) → remove one player (their phone shows "You were removed") → **Start game** → both phones show 3-2-1 and then **their own** board order. A third phone opening the link now sees "This game already started". Then via the API: `GET /api/play/bingosnap/state` on a phone shows **its own** board order → `POST /api/play/bingosnap/claim` with one row's `cellIds` → host `GET /api/host/bingosnap/<id>` lists the claim (name + challenges, no photo) → verify it → `close_hunt` → `announce_results`. Storage → `submissions` must not gain any object.
    Claims (migration 21, on two phones): snap a row → **Submit Bingo** → confirm → "Claim sent" with the received time, and the host's live page lists it in the Claims queue. Turn on airplane mode on the other phone, submit, then turn it back on and tap Submit again → still exactly ONE claim in the queue. Open the same game in a second tab → it shows "Claim sent" (no Submit). Host **End hunt now** → both phones show Time's up; the queue stays. A claim sent from the API after that is refused (`hunt_over`).
13. Log out from each area; visiting `/dashboard` or `/admin/dashboard` while signed out redirects to the matching login.

## Realtime setup (Phase 7)
- Migration 9 creates a policy on `realtime.messages` and sends from SQL with `realtime.send(..., private := true)`. Channels are **private** (`game:<uuid>`); nobody can publish from the browser.
- Add `SUPABASE_JWT_SECRET` (server only) so guests can listen. Check **Realtime → Settings** in the dashboard; leave "Allow public access" **off**.
- If your project uses the newer asymmetric JWT signing keys, confirm Realtime accepts tokens signed with the legacy secret. If not, guests stay in "basic mode" (4 s polling) until you switch the token minting to a supported method.
- Optional concurrency check on real Postgres: `npm i --no-save embedded-postgres pg && npm run test:concurrency`.

## Workflow for future changes
Add a new timestamped file in `supabase/migrations/`, never edit applied ones, run `npm test`, then `db push`. Every new table needs RLS enabled, explicit `revoke … from anon, authenticated`, and minimal grants (Supabase grants everything by default).


## Upgrading a database with an older schema (42703 "column … does not exist")

Symptom: migrations fail with `column players.nickname / p.code / p.max_active_games does not exist`, or login ends on `/auth/login?error=profile_missing`.
Cause: the tables already existed with an older layout, so migration 1's `CREATE TABLE IF NOT EXISTS` skipped them and later files referenced columns that were never created.

1. Run [`supabase/inspect/schema_inspection.sql`](inspect/schema_inspection.sql) (read-only). Check #9 (status/role values) and #10 (duplicates): those are the only things that make the compat migration stop. It stops **before changing anything** and names the values to fix.
2. Back up first (Dashboard → Database → Backups, or `pg_dump`).
3. In the SQL Editor run each file below as its **own** run, wrapping each in `begin; … commit;` so a failure leaves nothing half-applied (migration 4 must not share a transaction with anything that uses `'suspended'`):
   `20261110000000` → `…0001` → `…0002` → … → `…0012`.
   Run **all** of them again, including the ones that "worked" before: every file is re-runnable, and later files depend on objects earlier ones (re)create. Always finish at 12 (10 and 11 redefine the same function).
4. Re-run inspection #11: every marker should be `true`. Then sign in again.

After the upgrade, review in Admin → Plans the limits mapped from legacy plans (`max_players` → players per game, `max_games` → games open at once, rounds default 15). Legacy players get an unusable token hash (their old sessions can't resume). Legacy submissions keep `storage_path = NULL`; new same-game FKs/path check are `NOT VALID` (enforced for new rows) — validate later with `alter table public.submissions validate constraint …`.
