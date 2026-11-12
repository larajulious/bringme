# BringMe! — Project Status

_Last updated: 2026-11-12 (BingoSnap Phase 10: polish; Phase 9: host validation dashboard; Phase 8: server-enforced timer + reliable submissions; Phase 7: completion engine + Submit; Phase 6: local photo capture, browser-only; BingoSnap migrations 17–21 not yet applied to the hosted DB. Earlier: Passwordless Email OTP sign-in replaces password login/sign-up; browser-checked with stubbed Supabase, **not yet run against the hosted project or a real inbox**. Earlier: admin plan edits synchronise to Polar (migration 14), not run against the Polar sandbox. **Not launch-ready**: see GAME_PASS_QA_REPORT.md blockers.)_

## Product
Real-time party game with three roles: **Super Admin** (platform owner), **Subscriber / Game Master** (hosts games), **Player** (joins via QR, no registration).

## Existing architecture
- **Next.js 16.4.6** (App Router), React 19, strict TypeScript, Tailwind **3.4** + tailwindcss-animate, shadcn-style UI on Radix, lucide-react. `cacheComponents: true`.
- **Supabase** via `@supabase/ssr`: [lib/supabase/client.ts](lib/supabase/client.ts), [server.ts](lib/supabase/server.ts), [proxy.ts](lib/supabase/proxy.ts); root [proxy.ts](proxy.ts) (Next 16 convention). Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- **Design tokens** (light-only theme): HSL CSS variables in [app/globals.css](app/globals.css), mapped in [tailwind.config.ts](tailwind.config.ts). Semantic shadcn tokens (primary = deep purple, background = lavender) plus `brand-yellow`, `brand-coral`, `brand-night`, `brand-success`. Fonts: Fredoka (`font-display`) + Nunito (`font-sans`) via `next/font`. Shadows: `shadow-card`, `shadow-pop*` (chunky button shadows).
- **UI kit** (`components/ui/`): Button (variants: default=yellow, secondary=purple, camera=coral, outline, outline-light, ghost, destructive, link), Card, Input, Label, Badge, Modal (native `<dialog>`), Toast (`ToastProvider` in root layout + `useToast`), Loading/Spinner, EmptyState, Checkbox, DropdownMenu.
- **Brand/layout**: `components/brand/logo.tsx` (CSS wordmark), `layout/dashboard-shell.tsx` (desktop-first sidebar shell for admin/host), `layout/player-shell.tsx` (mobile-first), `layout/site-header.tsx`, `layout/error-panel.tsx`.
- **Motion**: CSS-only page transition via `app/template.tsx` (`.page-enter`); global `prefers-reduced-motion` override.
- **Routes**: `/` landing, `/play` (public player placeholder), `/auth/{login,error}` (login = unified passwordless email-code page; old sign-up/forgot/update-password URLs redirect to it) + route handlers `/auth/confirm` (email links) and `/auth/continue` (server-side role router), `/dashboard`, `/dashboard/games/new`, `/dashboard/games/[id]` (lobby), `/dashboard/subscription` (Game Master), `/play` (public room-code entry), `/join/[code]` (QR landing + name form), `/join/[code]/lobby` (player waiting lobby), `/play/[code]` (redirects to `/join/[code]`), `/admin/login` (public) and the Super Admin console: `/admin/dashboard`, `/admin/subscribers`, `/admin/subscribers/[id]`, `/admin/plans`, `/admin/settings` (`/admin` redirects). `loading.tsx`/`error.tsx` at root and per area; `not-found.tsx`.

## Auth: "localhost:3000/?error=access_denied&error_code=otp_expired" in production (2026-11-12)
- **Cause:** a sign-in email link that had expired or was already used (newer email, or an email security scanner pre-opening it) was sent by Supabase to its **Site URL**, still `http://localhost:3000` in the dashboard, because `signInWithOtp` passed no `emailRedirectTo`.
- **Code:**
  - `email-otp-form.tsx` passes `emailRedirectTo: <origin>/auth/confirm`, so a failed link lands on `/auth/error` of the right site;
  - `proxy.ts` redirects any non-auth page carrying `?error_code=` to `/auth/error?error=link_invalid` (covers links already sent). Checked on a production build: `/?error_code=otp_expired` → 307 `/auth/error?error=link_invalid`, plain `/` → 200.
- **First-time hosts got a "Confirm your email address" link instead of a code:** Supabase sends the *Confirm signup* template to new emails, and its default has no `{{ .Token }}`. Paste-ready templates are in `supabase/templates/confirm-signup.html` and `magic-link.html`: the code plus a cross-device backup button `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` (handled by `/auth/confirm`; never the Site URL). supabase/README.md updated. The code screen now says a Confirm / Sign in button also works, and it continues by itself when the session appears.
- **No localhost in production, whatever the settings:**
  - the template backup button is hard-coded to `https://bringme.fun/auth/confirm?token_hash=…`, so it doesn't depend on Supabase's Site URL or Redirect URLs;
  - `resolveSiteUrl` gives production builds without `NEXT_PUBLIC_SITE_URL` / Vercel vars `https://bringme.fun` (as configured, so `redirectBase` uses it instead of a proxy's internal `localhost` origin). This covers QR codes, join links, checkout return URLs and the `/auth/confirm` / `/auth/continue` redirects. +1 unit test.
- **Dashboard (manual, required):** Authentication → URL Configuration: Site URL `https://bringme.fun`; Redirect URLs `https://bringme.fun/**` and `http://localhost:3000/**`. Optionally remove `{{ .ConfirmationURL }}` from the Magic Link and Confirm signup templates (code-only sign-in; scanners can't consume a code).

## Checkout: "You have several unfinished checkouts" on Continue checkout (2026-11-12)
- **Cause:** `start_checkout_order` reused a pending order only while it was < 30 minutes old, but closed one only once its Polar checkout expired (or after 24 h). An order 30+ minutes old with a still-valid checkout was neither, so every "Continue checkout" / Buy created another order until the 3-pending limit (`too_many_pending_orders`).
- **Fix:** migration `20261112000028_reuse_live_checkouts.sql` (**not yet applied to the hosted DB**). A live checkout (> 2 min left) for the same plan / currency / environment / product is reused for up to 24 h; one without a Polar expiry is reused for 1 h. Live checkouts are still never closed by this function, because a late payment on a closed order lands in admin review (`order_was_expired`). The host message now says what to do.
- **Tests:** +2 in `tests/db/checkout-flow.test.ts`. Both fail without the migration and pass with it; the existing 24 h abandonment test caught and shaped the 24 h cap. `npm test` 613/613.

## BingoSnap: camera, review, confirmations (2026-11-12)
- **Camera stuck on a black "Starting the preview…"** (`components/bingosnap/photo-capture.tsx`). Two races, both cleared only by closing and reopening:
  - (1) overlapping starts: the open effect, a visibility change (some permission prompts fire one) or a quick reopen could start the camera twice. The late start then killed or held the newer stream.
  - (2) the `<video>` was re-attached only when `cam` *changed*, so a new stream arriving while `cam` was already "live" never reached it.
  - **Fix:**
    - a start generation (`genRef`): a start that resolves after a newer start or a stop stops its own tracks;
    - `streamKey` re-attaches every new stream, also on `loadedmetadata` / `resize`;
    - no second start while one is in flight, and a paused-but-live preview resumes on return (iOS);
    - automatic restart (≤ 2) when a live stream shows no frames for 2.5 s;
    - a **Restart camera** button next to "Use the camera app".
  - The Bring Me camera (`camera-context.tsx`) already has an `opening` lock and keys the preview on the stream, so it is unchanged.
- **Reviewing claims** (`components/bingosnap/host-dashboard.tsx`):
  - the "Call forward" card turns the claim's squares into a tick-off checklist (`aria-pressed`, local only), with "n of m seen". Verify reads "All seen: Verify <name>" once everything is ticked;
  - Reject pre-fills "Photo(s) missing: …" from the unticked squares (editable);
  - "Also waiting" entries get **Review now** (brings that claim into the Call forward card and scrolls to it) instead of inline Verify / Reject;
  - Verify / Reject stack full width on phones.
- **Many claims to verify:**
  - presenter: a "Come forward with your phone" call list (next 6 pending names in received order, "+n more"; hidden once a First-wins winner is verified);
  - host: "Find a player…" search over the waiting list (from 6);
  - host: **Not here? Skip for now** (moves the claim to the back of the host's local order, still pending, with a "skipped" badge);
  - host: a First-Bingo-wins banner ("the n other claims can't change the winner") with End game & show winner;
  - host: laptop keys V / R / S, and compact waiting rows (squares only on the claim being checked).
  - **Check modal:** checking claims now happens in a modal ("Call forward: <name>": checklist, Verify / Reject / Skip, "Next in line", keys). It moves on to the next claim after each decision and ends with "Everyone in line has been checked". The page keeps a compact "Next to check · n waiting" card with **Check claims**, and "Review now" opens the modal on that claim. Reject stacks on top of it. Keys work only while the modal is open.
  - **Claim lists modal:** "Also waiting", "Verified players" and "Verification history" moved off the page into one "Bingo claims" modal. It has Waiting / Verified / History tabs, a sticky "Find a player…" search (from 6 claims) across all tabs, Review now (closes the list and opens the check modal), and Undo. It opens from the Pending / Verified / Rejected count tiles (now buttons) and from "See everyone in line" on the Next-to-check card.
  - `npm test`: the intermittent single failure (also seen in Phase 4) appeared once more and passed on the next 2 runs; the failing test name still wasn't captured.
  - **Announce winners** (it was missing from the host UI; the server action `announce_results` already existed). After time's up or End hunt, an "Announce the winners" card shows the first-wins winner or the ranked count. It is blocked, with a **Check <name> now** button, while a claim received before the leader is unchecked (the server's `earlier_claim_pending` rule). A confirmation says how many later waiting claims won't be checked. It sends the leader's submission id as the confirmation and retries once on `stale_state` (e.g. the hunt just settled). The check modal's "Everyone in line has been checked" state also offers it. After announcing, the card shows "Winners are on the presenter screen" with **Finish game**.
  - Client only. Not built: the player's own "you're #n in line" on their phone (needs a change to the player snapshot function).
- **Confirmations:** Bring Me "Stop the hunt now" now opens "Stop the hunt now?" (shows the time left) instead of the 5 s undo window, and "Finish game & show results" opens "Finish the game?". BingoSnap's "End hunt now" and "End game" already confirmed.
- tsc ✅, lint ✅, build ✅, `npm test` 611/611. **Not checked in a browser or on real phones.**

## BingoSnap card editor: square editor in a modal (2026-11-12)
- **Why:** on phones the square editor sat below the grid, so hosts scrolled back and forth between the square and what they were typing.
- **Now** (`components/bingosnap/board-editor.tsx`): tapping a square (or Enter / typing on it) opens a **modal over the card**, top-aligned on phones so the keyboard doesn't cover it. It contains:
  - a live preview tile that shows the square as it is typed;
  - a clickable mini map of the card (current, done, empty, problem and free squares) to jump between squares;
  - the instruction field (focused straight away, `enterKeyHint="next"`), counter, Clear and ideas;
  - Previous / Next / Done.
- **Unchanged:** Enter / Shift+Enter move to the next / previous square, Esc or Done closes and focuses the square, pasting a list still fills the following squares, and Ctrl/Cmd+S still saves. Publish validation opens the modal on the first problem square.
- **Under the card:** "Fill in squares (n left)" opens the first empty square, plus "Fill empty with ideas". The inline editor panel and its scroll-into-view are gone.
- **Shared `Modal`:** it now opens in `useLayoutEffect`, so a field inside can be focused in the same event (keeps the Phase 4 "no lost keystrokes" behaviour).
- tsc ✅, lint ✅, build ✅. **Not checked in a browser**, including the fast-typing case.

## Bring Me host console: fewer presses (2026-11-12)
- **Flow:** Start game also starts round 1. A single **Start round** runs the 3-2-1 and the reveal together (the server already sets `opened_at = greatest(now, countdown_ends_at)`). Photos **stop by themselves** at the time limit + 5 s upload grace and the review opens, with "Stop the hunt now" for an early stop. **Start round N+1** goes from the winner straight into the next 3-2-1. Each round now takes Start → Announce winner (with its confirmation) → Start next round, down from 7 presses.
- **Layout** (`components/game/host-console.tsx`): one card with Hunt / Review / Winner progress, the item, the timer, one sentence and one big button, plus a "Presenter screen: …" line. Players and Add round fold away. "Replay 3-2-1" is gone: the round is already started during the countdown.
- **Shared code:** `runSteps` in `host-api.ts` chains actions, each against the state the previous one returned. During a started-but-not-yet-open round the presenter shows the big 3-2-1 (it used to say "On your marks…").
- **Upcoming item:** before every round (the lobby, between rounds, and the winner screen) the host sees the item that round will reveal, labelled "only you can see it". The round list is loaded on the server, so it shows on the first paint.
- **Submissions modal:** the Submissions list is no longer on the page. It is a modal ("Photos · round N": counts, fastest first, Approve / Disqualify / Undo, and an **Announce winner…** footer during review). It opens by itself once per round when photos stop and there are photos; "See photos (n · k to review)" in the main card reopens it, also while photos are coming in. Tapping a photo opens the large viewer on top, which moves on to the next waiting photo after each decision and returns to the list after the last one. `ReviewPanel` gained `plain` for this; the card version is unchanged.
- **Undo an early stop:** _(superseded: "Stop the hunt now" now asks for confirmation instead, see the BingoSnap section above)_. Originally a 5 s "Ending the hunt in N…" window with **Undo, keep hunting**. We deliberately don't reopen a closed round on the server: the `game_rounds` trigger forbids closed → open, and the timing and winner rules depend on that. The automatic stop at the time limit has no undo window.
- **Button always visible:** the step button is pinned to the bottom of the scroll area (it was below the fold on phones). It is always shown: during the 3-2-1 it is a disabled "Starting…". "Stop the hunt now" is solid coral instead of a faint outline.
- **Hide / show items** (`components/game/item-privacy.tsx`): an eye button (with `aria-pressed`) masks the item on the host's own screen. It covers the console's current / next item, the lobby's round 1 item and the "What players will bring" list. All toggles stay in sync, and the choice is remembered on that device (localStorage in try/catch; shown by default). The presenter and players are unaffected.
- **Phones (360–390 px):**
  - Long button labels wrap instead of running off the screen: the main step button, "See photos", "Replay this round", and the announce button with a long name.
  - Item and timer sit side by side; the "Game on" heading is screen-reader-only on phones.
  - During review the main button is "Check photos (n left)" until every photo is decided, then "Announce winner…", so there is one action at a time.
  - The shared `Modal` footer is sticky, so Announce stays reachable in a long photo list. On phones its buttons stack full width with the main action on top.
  - Touch targets are ≥ 44 px: the review buttons, Faster / Slower and the modal ✕.
  - **Not checked in a browser** (no Playwright in the repo).
- **"That's a wrap!" on the presenter** (`FinalScreen` in `components/game/presenter-screen.tsx`): the per-round winners list used to be `overflow-hidden`, so later rounds were cut off. Now every round fits the screen, because a projector can't scroll:
  - columns grow with the round count (landscape 1 → 4, portrait 1 → 2);
  - rows share the height through equal `grid-template-rows` tracks (at least 4–5, so short games keep normal-sized rows);
  - each row's badge, photo, item, name and time scale with the row (`container-type: size` + `cqh`/`cqw`), with the full text in a tooltip.
  - Example: 15 rounds on a 1080p projector = 3 × 5, about 125 px per row. The player phone version already scrolls and is unchanged.
  - Not checked in a browser.
- **5-second countdown** (migration `20261112000027_countdown_5s.sql`, **not yet applied to the hosted DB**): `game_transition` (start / restart countdown) and `replay_round` are re-created with `interval '5 seconds'`; nothing else changed. Player phones, the presenter and the host clock count from the server timestamps, so they show 5-4-3-2-1 with no code change. Host copy says "5-second countdown". BingoSnap keeps 3 s. The engine test now expects ≈5 s.
- **Reviewing many photos** (`components/game/photo-review-grid.tsx` in the Submissions modal, now `max-w-5xl`, titled "Does it show: <item>?"):
  - **Grid:** square photos, 2 / 3 / 4 per row, with a rank chip, a "Would win" crown, a status mark, the time and close / server-time badges, plus one-tap ✓ / ✕ (icon-only on phones, ≥ 44 px) or Undo.
  - **Progress and tabs:** a sticky "n of m checked" progress bar and To review / Approved / Disqualified / All tabs (starts on To review, so decided photos leave the view).
  - **Stop early:** "you can announce now" appears once no photo faster than the approved leader is still waiting, since slower photos can't win.
  - **Keyboard:** the large viewer adds A approve / D reject / ← → (not during a close-finish comparison or while typing).
  - The modal no longer uses `ReviewPanel` (my earlier `plain` mode was removed; the original card is unchanged). `npm test` 611/611; one earlier run had a single unidentified failure that didn't reproduce in 3 later runs, as already noted for Phase 4. Not checked in a browser.
- **Replay a round** (migration `20261112000026_replay_round.sql`, **not yet applied to the hosted DB**): after photos stop and before the result is announced, "Hunt ended too early? Replay this round" (with a confirmation) calls `POST /api/host/games/[id]/replay` → `replay_round(p_game, p_expected_version)` (owner + version checked, `authenticated` only). In one transaction it closes the stopped round as "no winner" and marks `replayed_at` (new column, no client grant; its photos and reviews are kept). It then inserts a copy with the same item, limit and points as the next round (later pending rounds move down one) and starts it with a new 3-2-1. Replayed rounds don't count toward the plan's round limit (`enforce_round_insert`). They are also left out of "Round n of N", the round numbers and the results (`game_state_json`, `game_results_json` and `game_results` re-created with only that change; same signatures).
- **Verification:** tsc ✅, lint ✅, build ✅, `npm test` **611/611**. The new `tests/db/replay.test.ts` covers the copy and order, keeping the round's number for host and players, the item withheld until GO, Time's up and review, refused while open / after the winner / stale / another host, the round limit, results excluding the replay, and no client write to `replayed_at`. Also fixed: the 2 audit tests that already failed because `add_game_round` (migration 23) was missing from the allowlist and types count. **Not browser-checked yet.**

## BingoSnap (Extra Fun) — Phase 0: architecture audit (summary)
Audit only; no code, schema or behaviour changed. Full report: [BINGOSNAP_AUDIT.md](BINGOSNAP_AUDIT.md).
- **Approach:** BingoSnap games are `games` rows with a new `game_type`, so they inherit the pass, player cap, expiry, join/QR and Realtime unchanged. They get their own state machine, snapshot and claim tables. The server stores claimed cell positions, never photos; photos live in IndexedDB on the player's phone.
- **Phase 1 (design) done:** [BINGOSNAP_DESIGN.md](BINGOSNAP_DESIGN.md), decisions B-1…B-14. BingoSnap counts toward game limits; all board sizes on every plan; each player gets the prompts in their own order; host toggle between Ranked and First wins; re-claim after a rejection (max 5 attempts); free centre (default on); presenter screen included.
- **Phase 2 (database & backend) done**, as built in BINGOSNAP_DESIGN.md §13:
  - **DB:** migrations `20261112000017_bingosnap_schema.sql` (`games.game_type`, `bingo_games` / `bingo_cells` / `bingo_submissions`, RLS: owner/admin read, no client writes, guards so Bring Me paths refuse BingoSnap games) and `…18_bingosnap_functions.sql` (create, state machine with a database-clock timer, per-player layout, claim validation, review, results). Not a migration: `supabase/rollback/20261112000017_18_bingosnap_revert.sql` (refuses while BingoSnap games exist). Read-only check: `supabase/inspect/bingosnap_postflight.sql`.
  - **Entitlement:** BingoSnap games are `games` rows, so the Game Pass, the open-game/period limits and the 3/10/50/100 cap come from the existing triggers.
  - **Photos:** no photo data is stored anywhere: no column, no Storage path, and strict request bodies (only `cellIds`).
  - **API (no UI yet):** `POST /api/host/bingosnap`, `GET /api/host/bingosnap/[id]` (`?view=presenter`), `POST …/[id]/transition`, `PATCH …/[id]/settings`, `POST …/[id]/submissions/[submissionId]/review`, `GET /api/play/bingosnap/state`, `POST /api/play/bingosnap/claim`. Code in `lib/bingosnap/*`; types in `database.types.ts`.
  - **Verification:** tsc ✅, lint ✅, build ✅. `npm test` **482/482** (+27 BingoSnap DB tests, +10 unit tests; `qa-audit` allowlist +5 host functions, types parity 64). `test:concurrency` **28/28** (12 joins into a 3-player room → 3; 10 racing claims → 1; claim racing close_hunt never lands after the deadline). Mutation checks: removing the engine guard, the review owner check, the pattern check, or the deadline (both layers) each fail tests. HTTP probes on a production build: signed-out/forged → 401; a claim with a `photo` field → 400; 9 KB body → 413; multipart → 415. Postflight and revert scripts run on PGlite.
  - **Not done:** not applied to the hosted Supabase project; no UI; Realtime still unverified on a real project (existing note).
- **Phase 3 (Extra Fun + board builder) done:**
  - **Navigation:** "Extra Fun" item in the Game Master nav → `/dashboard/extra-fun`. The BingoSnap card has the mark (3×3 card, snapped diagonal, camera badge), the description, feature chips, the player cap read from `my_entitlement`, **Create game**, and open/past BingoSnap game lists with an empty state. Without a pass it shows the existing restriction screen and no Create button.
  - **Builder** (`/dashboard/extra-fun/bingosnap/new`, `components/bingosnap/bingosnap-builder.tsx`): title, Traditional / Full Card, Ranked / First wins, 3×3 / 4×4 / 5×5 (native radios, keyboard arrows), free centre (only odd + Traditional; disabled with an explanation otherwise), timer presets plus custom minutes (clamped 3–120), one field per challenge (resizes and keeps what was typed; pasting a list fills the following squares; "Fill empty squares with ideas"), inline empty/duplicate/too-long errors, and a live board preview (sidebar on desktop, inline on phones). Posts to `POST /api/host/bingosnap`.
  - **Game page** (`/dashboard/extra-fun/bingosnap/[id]`): board, settings, players n/cap, room code, Cancel (confirm). Lobby/live controls come in the next phase.
  - **Existing screens (minimal edits):** `GameList` links each game to its own page and shows a "BingoSnap" badge; the dashboard query reads `game_type`; `/dashboard/games/<bingo id>` redirects to the BingoSnap page. Bring Me screens are otherwise unchanged.
  - **No new pricing, checkout or quota:** caps and access come only from the existing entitlement functions.
  - **Fixed during QA:** on narrow screens, after typing the title and scrolling down, Chromium scrolled `<main>` during a press (scroll anchoring on the collapsed text selection), so taps hit the wrong element. Fixed with `overflow-anchor: none` on the builder form; there is a regression check. The Bring Me builder may be affected too (not verified).
  - **Verification:** tsc ✅, lint ✅, build ✅; `npm test` **490/490** (+8 builder unit tests). Browser QA on a production build against a fake Supabase backend (scratchpad): **56/56**. Covered: nav, entry, empty and restricted states, every size/mode/free combination, keyboard, validation and focus, paste, ideas, timer clamp, the exact request body, game page, cancel, dashboard badge and link, redirect, not found, 360/390/768/1280 px with no overflow, reduced motion, and axe (WCAG A/AA + best practice) clean on every page at 390 and 1280. **Not run against the real Supabase project.**
- **Phase 4 (card editor + drafts) done**, as built in BINGOSNAP_DESIGN.md §14:
  - **DB:** migration `20261112000019_bingosnap_board_drafts.sql`. Drafts may leave squares empty; `board_revision` gives a `stale_board` refusal for a second tab's save; `bingo_save_board` creates, saves and publishes; a trigger refuses to publish or start an incomplete board or duplicate instructions; editing ends at Start game (`board_locked`). The revert script covers it.
  - **Editor** (`components/bingosnap/board-editor.tsx`) replaces the Phase 3 list builder: a visual grid with keyboard editing, the instruction editor with a counter, ideas, paste, Clear/Previous/Next, warnings before destructive resizes, a free centre that can't be edited, Player preview, Save draft (Ctrl/Cmd+S), Publish, Discard, and an unsaved-changes guard. The game page shows the editor while the game is a draft or in the lobby, and a read-only summary after the start. Phase 3's Extra Fun page and game list are unchanged.
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **512/512**, twice: +15 DB tests (drafts, revision, dimensions, free centre, publish rules, rollback on refusal, lobby edits, lock after start, discard, pass expiry, cap) and +25 unit tests
    - `test:concurrency` **29/29**: 10 racing saves → 1 wins, 9 `stale_board`
    - mutation checks: removing the trigger, the revision check, the lock or the free-centre check each fail tests
    - browser QA on a production build against a stateful fake Supabase: **58/58**, covering click and keyboard editing, typing to replace, Delete, Esc, Enter / Shift+Enter, the counter limit, paste, Ctrl+S → draft URL, reopening, the revision sent, resize keeping work, both destructive-change warnings (cancel and confirm), publish blocked inline, the message clearing once fixed, preview, publish → lobby, lobby saves needing a complete board, stale save, the unsaved-changes guard, the locked board after start, 360/390/768/1280 px with touch-sized squares (≥ 44 px), and axe clean at 390 and 1280
  - **Fixed during QA:** fast typing on a square lost letters (the editor was focused a frame late); a pristine new board showed "Unsaved changes"; square names didn't contain their visible text (label-in-name); the action bar covered the editor on phones; a validation message stayed after the fix; the label overlapped the text on small 5×5 squares.
  - **One unexplained failure:** one `npm test` run failed one test while the concurrency suite was running alongside; the test wasn't captured and two later full runs passed.
  - **Not run against the real Supabase project.**
- **Phase 5 (joining + lobby) done**, as built in BINGOSNAP_DESIGN.md §15:
  - **DB:** migration `20261112000020_bingosnap_lobby.sql`: `bingo_room_info` (service role), the room code in `bingo_player_state`, and `bingo_start` (start + 3 s countdown + hunt in one transaction). Joining reuses `join_game` and the capacity trigger unchanged. The revert script covers it.
  - **Players:** QR or `/play` code → BingoSnap invitation → name → waiting lobby (title, mode, rules, blank card preview, headcount) → 3-2-1 → their own board and timer, moved on by Realtime (or the 4 s fallback). Refresh restores the same participant; removed, cancelled, started, draft and full rooms each get a clear screen.
  - **Host:** the game page becomes the lobby once published: QR, room code, join link (copy), live arrivals, n / pass cap, removal, Start, Cancel, fullscreen, and Edit card (`…/[id]/edit`). After the start: a live panel with the countdown, timer and End game.
  - **Changed in shared code (additive):** `useGameSync` takes an optional guest `tokenUrl`; `/join/[code]` and `/join/[code]/lobby` branch on the game type first; `BoardPreview` gained `large` / `compact`.
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **529/529** (+15 DB tests: room info, join/restore, token-only identity, refused states, trial cap 3 + seat freed by removal, removed session, Bring Me sessions, broadcasts, channel access, one-step start, refusals incl. expired pass change nothing; +2 unit tests)
    - `test:concurrency` **30/30**: 12 joins racing Start game in a 3-player room → started, players = successful joins ≤ 3, the rest `game_full` / `game_not_joinable`; both orderings observed
    - mutation checks: granting the room lookup to browsers, or dropping the room code from the player snapshot, each fail tests
    - browser QA on a production build against a stateful fake Supabase: **58/58**, twice (host lobby, QR/code/link, `/play` entry, invite, join, HttpOnly cookie, refresh restore, live arrivals, duplicate name, cap 3 + the 4th visitor and the API both refused, forged cookie 401, removal on both screens, Edit card, stale-version start retry, automatic countdown → own board on two phones in different orders, live panel, late joiner refused, edit locked, End game, expired pass, draft, cancelled, unknown code, 360/390/1280 px, reduced motion, axe clean on every screen)
  - **Not verified:** Realtime itself (the fake has no Realtime, so the browser run used the 4 s fallback; the DB tests check the broadcasts). Not run against the real Supabase project.
- **Phase 6 (local photo capture) done**, as built in BINGOSNAP_DESIGN.md §16. **No server, API or database change**: photos exist only in the player's browser.
  - **Player:** tap a square → full-screen camera (rear camera preferred) → shutter → review (Retake / Save to card) → the photo shows in its square with a check, "n of m snapped". Saved squares open for review, **Save a copy** and Retake; squares in a pending or verified claim are locked; after time's up the card is view-only. Finished / cancelled / removed screens list the photos still on the phone with Save copies and Delete (never automatic for that game).
  - **Storage:** IndexedDB `bingosnap` (`photos` = meta + thumbnail, `images` = full photo), key `[gameId, playerId, cellId]`, both written in one transaction. JPEG ≤ 1280 px / ≤ 800 KB plus a 360 px thumbnail, re-encoded on the device (no EXIF). `navigator.storage.persist()` after the first save. Memory fallback with a warning when IndexedDB is unavailable. Other games' photos older than 7 days are pruned; the current game's never are.
  - **Fallbacks and errors:** permission denied, no camera, busy, insecure page, unsupported browser, stalled preview → guidance plus "Use the camera app" (`<input type=file accept=image/* capture=environment>`, re-encoded the same way); quota exceeded, interrupted write and missing / evicted photos each get a message, and the photo is kept for a retry.
  - **New code:** `lib/photos/{process,store,export}.ts`, `components/bingosnap/{photo-capture,photo-board,hunt-board}.tsx`, `use-cell-photos.ts`; `lockedCellIds` / `snapProgress` in `lib/bingosnap/board.ts`.
  - **Changed in shared code (additive):** `grabFrame` takes an optional max edge; `classifyCameraError` maps `NotSupportedError` to "unsupported" (Bring Me benefits too).
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **541/541** (+12: store contract and game/player isolation on the memory implementation, keys, error classes, pruning, claim locks, progress, file names, and static checks that photo code has no network / service-worker / localStorage / base64 path)
    - mutation checks: adding a `fetch` to the photo code, or unlocking pending claims, each fail tests
    - browser QA (Chromium fake camera, production build, stateful fake Supabase): **72/72**, twice, covering capture → retake → save, the IndexedDB records (key, size, no APP1/EXIF), refresh restore, viewer, Save a copy, replacement, interrupted write keeping the old photo, quota exceeded then retry, Esc/keyboard and the stream stopping, claim lock / unlock, time's up, isolation between two games with the same cell ids, delete after the game, 25 squares at 360×640 (≈ 0.7 s per capture, 25 live object URLs, 10 MB JS heap), denied / unsupported / insecure camera, the file fallback stripping planted GPS EXIF, the no-IndexedDB fallback, reduced motion, axe clean on every screen, and a network audit: 342 requests, none to another host, none > 8 KB or carrying JPEG bytes
  - **Not verified:** real phones (iOS Safari / Android Chrome camera, share sheet, eviction behaviour). Claims (the BINGO button) and host review are the next phase.
- **Phase 7 (completion engine + Submit) done**, as built in BINGOSNAP_DESIGN.md §17. **No server or database change**: the claim endpoint and `bingo_pattern` from Phase 2 are reused.
  - **Engine:** `lib/bingosnap/completion.ts` (pure, no UI or storage): `evaluateCard` gives completed / required / percent, complete rows, columns and both diagonals, full card, eligibility, the exact claim (one line's photographed cells, or every non-free cell) and the fewest photos still needed; `boardLines`, `patternLabel`. The free centre counts as done and is never sent. It only checks that photos exist; the Game Master judges them.
  - **Player UI:**
    - count, percentage and progress bar, the mode chip and the timer
    - the winning line (or whole card) ringed in yellow, plus a "BINGO!" / "Full card!" banner with a one-off confetti burst (none on refresh or with reduced motion)
    - **Submit Bingo / Submit Full Card**, enabled only with an eligible card while the hunt runs; when unavailable it says what's missing
    - a confirmation, then "Claim sent", rejected (with the reason and claims left) or verified states
  - **Recalculates** on capture, retake, a missing / evicted photo, and after a refresh restores photos.
  - **New code:** `lib/bingosnap/completion.ts`, `components/bingosnap/claim-panel.tsx` (the only photo-adjacent file with a network call: it posts `{ cellIds }`). `HuntBoard` / `PhotoBoard` take the mode and the winning positions. `snapProgress` was removed (superseded by the engine).
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **580/580**:
      - +24 engine unit tests: every row, column and both diagonals on 3×3/4×4/5×5, one short of each line, empty and scattered cards, free centre (3×3 and 5×5), several lines, foreign ids, full card on every size, free squares excluded, rounding, removing / replacing / restoring photos, input checks, labels
      - +16 DB tests on PGlite: the engine ⇔ SQL `bingo_pattern` for 8 configurations (every claim the engine offers is accepted with the same pattern; every server pattern is recognised; one short is refused by both)
    - mutation check: not counting the free centre fails tests
    - browser QA (fake camera, production build, stateful fake Supabase with a claim RPC mirroring the SQL rules): **37/37**, twice:
      - 3×3 with the free centre: count / % / mode / timer, Submit disabled with "n more", a scattered card isn't a win, the row win banner and highlight, confetti, Submit enabled
      - refresh recalculates with no repeat confetti; a removed photo breaks the line and a retake restores it
      - confirmation; the claim sends exactly the two cells (pattern `row:1`, body `{ cellIds }` only); locked after sending; rejected → reason, claims left, Submit again; time's up hides Submit
      - 4×4 Full Card: a row isn't enough, 93 % is still disabled, 100 % shows the banner and the whole card highlighted; the claim sends all 16
      - 5×5 anti-diagonal with the free centre at 360 px (4 cells, `diag:anti`) under reduced motion (nothing animates)
      - axe clean on every screen
    - Phase 6 photo QA re-run: 72/72
  - **Fixed during QA:** words in unsnapped 5×5 squares broke mid-word at 360 px (smaller text and padding on narrow screens).
  - **Not verified:** real phones; the real Supabase project (migrations 17–20 are not applied yet). The host's review screen comes next, so claims stay "being checked" until then.
- **Phase 8 (server-enforced timer + reliable submissions) done**, as built in BINGOSNAP_DESIGN.md §18:
  - **Already in place, audited and kept:**
    - the start and deadline come from the database clock (`bingo_start`) and are broadcast to every phone
    - timers on both screens use the server clock offset
    - `bingo_submit_claim` locks the game row and checks membership via the cookie token, removal, verified / pending claims, at most 5 attempts, the pattern and the deadline
    - one row per attempt, and unique indexes allow one open claim per player
  - **DB:** migration `20261112000021_bingosnap_claims.sql`:
    - **idempotent retries:** a `request_id` column with a unique index per player, and a 3-argument `bingo_submit_claim`; a replay returns the existing claim and creates nothing
    - **deadline judged on arrival** (`statement_timestamp()`): a claim that arrived in time but waited on the lock still counts, and `submitted_at` is the arrival time
    - the 2 s grace for the natural deadline only: after **End hunt now** (`close_hunt`) claims stop at once
    - the 2-argument function delegates to it with the same rules; the revert script and postflight check 10 cover it
  - **API:** `POST /api/play/bingosnap/claim` takes `{ cellIds, requestId? }` (strict keys, uuid); nothing else is accepted.
  - **Player:**
    - one request id per attempt, kept for automatic retries (network errors / 5xx, at 0.8 s and 2 s) and for a manual retry, and renewed after a rejection
    - a synchronous double-tap lock
    - "already sent" (another tab) is treated as success
    - "Claim sent" shows the server's receipt time
    - Time's up arrives through a re-read at the deadline and again after the grace (`useGameSync` gained an optional `deadlineOf`)
  - **Host:**
    - the live panel shows the claim queue in received order: name, pattern, attempt, the challenges, the time since the start and the status
    - **End hunt now** stops claims and keeps reviewing open; End game finishes
    - verify / reject buttons come next (the backend already exists)
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **595/595**: +15 DB tests (server time and the host queue, not before the hunt opens, replays create nothing, two tabs, the duplicate request-id constraint, reject → resubmit with history, verified → refused, 5 attempts, the grace and expiry, claims kept and reviewable after the deadline, a replay after the deadline, End hunt with no grace, End game, membership, the 2-argument function, no direct access); validation tests for `requestId`
    - `test:concurrency` **34/34** (+4, real Postgres): the same request 10× at once → one claim and ten OK answers; two tabs → one claim + `claim_pending`; a claim queued behind a lock past the deadline + grace is accepted with its arrival time; a later one is refused
    - mutation check: re-reading the clock after the lock fails the queued-claim test
    - browser QA **36/36**, twice:
      - host and player timers agree, including a phone whose clock is 5 minutes fast
      - a lost response is retried with the same id → one claim; an outage gives 3 tries, then a message, then a manual retry + double tap → one more request, one claim
      - second tab; payload only `{ cellIds, requestId }`; the host queue; rejection → resubmit with a new id and history; verified refused
      - deadline → Time's up, accepted within the grace, refused after; refresh after expiry
      - End hunt (players Time's up, queue intact) then End game (claims refused)
      - axe clean
    - Phase 7 QA re-run: 37/37
  - **Fixed during the phase:**
    - a Phase 2 test caught that my first version gave early closes the 2 s grace (reverted to an immediate stop)
    - PL/pgSQL cut an `IF` with an inline `CASE … THEN` short, so the limit now goes in a variable
  - **Not verified:** real phones, the real Supabase project (migrations 17–21 not applied).
- **Phase 9 (host validation dashboard) done**, as built in BINGOSNAP_DESIGN.md §19. **No server or database change**: the Phase 2 `bingo_review_submission` (owner only, live game, `already_reviewed`, `claim_superseded`, no verifying removed players) and its route are reused.
  - **Dashboard** (`components/bingosnap/host-dashboard.tsx`, replaces `host-live.tsx`):
    - title, mode, board size, winner rule, status and the timer
    - players / pending / verified / rejected tiles, End hunt now / End game, and the connection state
  - **Queue:**
    - **Call forward** shows the earliest pending claim: the name at 60 px, its order, pattern, attempt and server time, and the squares to check on the player's phone, with big Verify / Reject buttons
    - then the rest of the pending claims in server order (time, then id)
    - **Verified players** in finish order (trophy for #1; First-wins names the leader)
    - **Verification history**: every decision, the most recent first, with the reason and time
    - **Undo** while the game is live
    - reject with quick reasons or a typed one (≤ 120)
    - a double tap sends one decision; a stale second tab is told "already decided" and refreshes
    - after End game the dashboard stays as read-only history
  - **Realtime:** the existing hint + authoritative re-read. The queue is derived from the snapshot and keyed by submission id (`lib/bingosnap/queue.ts`), so repeated events can't duplicate entries, and a reconnect re-reads the exact state. New claims are announced to screen readers.
  - **Player:** a rejection after time's up now reaches the phone ("no more claims this game"). Verified and rejected (with the reason and claims left) were already shown.
  - **Verification:**
    - tsc ✅, lint ✅, build ✅
    - `npm test` **602/602** (+7 queue unit tests: order and tie-break, numbering across attempts, no duplicates, verified and history sorting, First-wins leader, error texts)
    - `test:concurrency` **37/37** (+3: 10 simultaneous Verify taps → one decision and nine `already_reviewed`; Verify vs Reject from two tabs → exactly one wins; Undo racing a resubmission → exactly one open claim)
    - browser QA **38/38**, twice:
      - the dashboard facts, timer and counts; claims arriving without a reload in server order; the 60 px name; the squares to inspect
      - repeated re-reads with no duplicates; verify → the player shows Verified and a re-claim is refused
      - reject with a quick reason → the player sees the reason and resubmits as attempt 2, with history kept
      - double tap → one decision; Undo; finish order; a stale second tab
      - a player calling the host API → 401; another game's URL → 404; strict bodies
      - offline, then reconnect shows the claim sent meanwhile
      - time's up: still reviewable, and the late rejection reaches the player
      - phone-sized host view; End game → read-only
      - axe clean at 1280 and 390, the reject dialog and the finished view
  - **Fixed during QA:** the rank badge used `aria-label` on a plain `<span>` (axe) and now uses screen-reader text.
  - **Not verified:** real phones and Realtime against the real Supabase project.
- **Phase 10 (polish) done**, as built in BINGOSNAP_DESIGN.md §20. **UI only**: no business logic, API, database or security change. Bring Me screens are untouched; the only shared change is an additive `success` Button variant.
  - **Player card:**
    - a **Card / List** toggle (remembered on the device): the list shows every instruction at full size with its row and column, thumbnail and status, in 64 px rows
    - Submit and the claim status move **above** the card once they matter, and the BINGO! banner steps aside once a claim is sent
    - the squares of a rejected claim are **flagged** (coral badge, "check this one") until retaken
    - winning squares pop in sequence, and a fresh photo's check badge bounces in
    - **Verified** gets a green panel with a one-off confetti burst on the phone (none on refresh)
    - "Claim sent" pops in, and focus moves to it after Submit
    - the timer turns coral in the last minute
  - **Screen readers:** "Saved: … n of m snapped", "1 minute left", "10 seconds left" and "Time's up" are announced once each. The progress line is no longer a second live region (no double announcements).
  - **Performance:**
    - the capture screen + on-device processing is a separate ~13 KB chunk, loaded on the first tap or prefetched while idle once the hunt starts
    - the card / list components are memoised, so the 4×/s timer tick doesn't re-render 25 thumbnails
    - the camera starts only when needed, as before
  - **Host:** Verify uses the new `success` button (no stray yellow shadow), and "Call forward" and newly verified players pop in.
  - **Verification:**
    - tsc ✅, lint ✅, build ✅; `npm test` 602/602
    - browser QA **26/26** (twice) for the new behaviour:
      - the camera loads lazily (not in the initial JS, then prefetched)
      - a long instruction is clamped on the card but complete in List view, and the view is remembered
      - announcements, the staggered win, the panel moving above the card, focus after Submit
      - rejected squares flagged, and the flag cleared by a retake
      - verified confetti once; the urgent timer and its announcement; the host success style
      - at 320×568 on 5×5: squares ≥ 44 px, every touch target ≥ 44 px, no sideways scroll, nothing animating under reduced motion
      - axe clean
    - regression on the same build: Phase 6 72/72, Phase 7 37/37, Phase 8 36/36, Phase 9 38/38
  - **Fixed during QA:**
    - List rows' `aria-label` hid their visible status (axe label-content mismatch); the visible text is now the name
    - the progress line doubled the save announcement
  - **Not verified:** real midrange Android / iOS devices (performance measured only in desktop Chromium).
- **Homepage:** a new "Extra Fun" section (`components/marketing/extra-fun.tsx`, between "Who is it for?" and Pricing; anchor `#extra-fun`) introduces BingoSnap and links to `/dashboard/extra-fun` (sign-in first if needed). Browser-checked at 1280 and 390 px and with reduced motion: no sideways scroll, axe clean.
- **Next:** apply migrations 17–21 (supabase/README.md items 28–32), then results (announce winners to players and on the presenter screen).

## Passwordless authentication — Email OTP (summary)
- **Before:** email + password login (`LoginForm`, also `/admin/login`), a separate sign-up (display name + password, email-link confirmation), and forgot/update-password screens.
- **Now:** one page, [components/auth/email-otp-form.tsx](components/auth/email-otp-form.tsx), on `/auth/login` and `/admin/login`. Step 1 is "Welcome to Bring Me" plus an email field: `signInWithOtp({ shouldCreateUser: true })`, or `false` on the admin page, where an unknown email gets the same screen and no account is created. Step 2 is "Check your email" with a segmented 6-digit field ([otp-code-input.tsx](components/auth/otp-code-input.tsx): one real input with `one-time-code` autofill, a numeric keyboard and paste support). `verifyOtp({ type: "email" })` must return a session before anything happens. Then a full navigation to `/auth/continue` (unchanged): role routing, `ensure_my_trial`, and `?next=` kept.
- **Resend:** 60 s cooldown with a countdown (adopts Supabase's own retry hint when it is rate limited). Resending clears the typed code; Supabase invalidates the old one. Double submits are blocked by a synchronous guard, and each distinct 6-digit value auto-submits once.
- **State:** only `{email, sentAt}` in sessionStorage (refresh recovery, 1 h). The code is never stored, and no code is sent from an effect. Another tab that verifies triggers `SIGNED_IN`, which moves this tab on.
- **Compatibility:** an existing email signs into the same `auth.users` row, so profiles, games, passes and the Polar `external_customer_id` (= user id) don't change. Verifying sets `email_confirmed_at`, so the existing trial trigger still fires for new hosts. No migrations. New hosts have no display name (UI falls back to the email).
- **Removed:** `login-form`, `sign-up-form`, `forgot-password-form`, `update-password-form`, and the pages `sign-up`, `sign-up-success`, `forgot-password`, `update-password` (now redirects in `next.config.ts`). `/auth/confirm` stays for links already in inboxes.
- **Manual Supabase config:** OTP length 6, `{{ .Token }}` in **both** Magic Link and Confirm signup templates, Resend SMTP (see supabase/README.md). Password provider left enabled until confirmed unused. CAPTCHA not wired.
- **Verification:** tsc ✅, lint ✅, build ✅, `npm test` **444/444** (+14 auth/OTP unit tests). Chromium on a production build with Supabase's `/otp` and `/verify` stubbed: 67/67 checks, run 3×, at 390/1280 px. Covered: copy, no password UI, validation, normalisation, a single request on double submit, `create_user` flag, countdown, autofill attributes, wrong code, digits kept, refresh restore without re-send, paste "123 456", `next` preserved, change email, resend after a fake-clock 60 s, rate-limit and offline messages, admin non-enumeration plus `area=admin`, guest `/join` stays public, landing links. Not run: a real email/code round trip, a real session after verify, real mobile autofill, Polar checkout after sign-in.

## Admin ↔ Polar product synchronisation (summary)
- **Root cause:** the Phase 8 plan/price editor wrote only to Supabase. No code called Polar's write API (it only *read* Polar for the price-sync guard), so Starter's USD 20.00 never reached Polar. The guard correctly kept $20.00 off sale.
- **Now:** **Edit & sync** (name, PHP, USD, max players; duration fixed at 7 days).
  - Flow: a sync job is recorded → Polar `PATCH /v1/products/{id}` (minimal: keep unchanged prices by `{id}`, add a new fixed price per changed currency, never recurring/archive fields) → **re-read and verify** → local save in one transaction → new price ids stored per environment.
  - Honest results: synced / BringMe! only (no product) / failed (local unchanged) / Polar ahead (local save failed) → **Retry Sync**, which re-verifies and creates no duplicate prices.
  - The old local-only edit routes now refuse paid-plan name, players and price (`use_sync_editor`).
- **Polar-side edits:** the `product.updated` webhook and **Check Polar** mark a plan "Changed in Polar". They **never overwrite** local values, and stale reads or reads during an open job are ignored. Checkout stays blocked by the price-sync guard while the two differ.
- **Open checkouts after a price change:** honoured at the price they showed (order snapshot); new checkouts use the new price.
- **DB:** migration `20261112000014_plan_polar_sync.sql` (`plan_polar_state`, `plan_sync_jobs`, functions). Admin-only reads; service-role writes; the actor is re-checked.
- **Verification:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **424/424**: `plan-sync.test.ts` 16 (real SQL + fake Polar: rename, USD 1.99→20.00, PHP independent, mapping ids, checkout at the new amount, Polar failure, old price left active, Supabase save failure + retry without duplicates, old purchases unchanged, open checkout honoured, authorization, product.updated stale/drift/duplicate, one-time only, wrong org, concurrent edit, DB finish guard) and `product-sync.test.ts` 8.
  - **Mutation checks:** disabling verification, or the DB finish guard, makes tests fail.
  - `test:concurrency` **25/25**.
  - Signed-out / guest → 401.
  - Chromium check of the dialog states at 390/1280 px.
- **Next:** add Polar sandbox credentials and run POLAR_PRODUCT_SETUP.md §12 "Sandbox test"; apply migration 14 to the hosted DB.

## Game Pass — Phase 9: end-to-end QA & security audit (summary)
Full record: [GAME_PASS_QA_REPORT.md](GAME_PASS_QA_REPORT.md).
- **Executed:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **400/400**: +10 audit tests (privilege allowlists for anon/authenticated, no client table writes, RLS everywhere, no role escalation, types↔schema parity for all 50 functions, unique constraints, timestamps, the postflight SQL with its own expectations, reconcile idempotency) and +2 throttle tests.
  - `test:concurrency` **25/25**.
  - Bundle secret-value scan: 0 hits.
  - HTTP probes (guest cookie and forged session → 401; webhook GET/oversize/unsigned/forged → 405/413/403/403).
  - Chromium: DST display (EDT/EST, GMT+1/GMT+0), expired-session, offline and out-of-sync messages.
- **Fixed:** the checkout status endpoint could be used to make unbounded Polar API calls with our token. Polar's answer is now reused per checkout for 10 s (`lib/billing/poll-throttle.ts`).
- **Failed / open:** **rate limiting not implemented** (60-request bursts → no 429): production blocker. No real Polar run (no credentials). Real devices untested.
- **Live DB (read-only):** migrations through 13 applied; legacy backfill exact; plans correct; Starter USD set to $20.00 by an admin on purpose (sync test); no Polar product ids or orders yet.

## Game Pass — Phase 8: Game Pass UI & admin management (summary)
- **Host `/dashboard/subscription` ("Your Game Pass"):**
  - **Current pass:** active plan, max players, activated, expires on (viewer's locale **with time-zone name**, stored in UTC), time remaining, status, source, queued/paused passes, and **Upgrade Pass / Purchase Again** actions.
  - **Buy Game Pass:** Free Trial card (3 players, Free, 7 days; available/active/used), Starter/Party/Pro with exact PHP and USD prices, and contextual **Buy Game Pass / Upgrade Pass / Purchase Again** buttons with a one-line effect ("Adds 7 days…", "Starts now…").
  - **"One-time payment. Seven days of access. No automatic renewal."** is shown verbatim, plus a "Checkout initiated" state.
  - **Purchase History:** order date, pass, price, currency, payment status, activated, expires, refund, and a Test badge for sandbox.
  - **Return page:** "Payment received — confirming…" until the backend has fulfilled, then "Payment successful: Pass activated!", or payment unsuccessful / expired / cancelled with **Purchase Again**.
  - Recurring wording ("auto-renewal", "monthly subscription"…) is absent; this was checked in the browser.
- **Pricing safety:** a read-only Polar product check (5-minute cache). A plan/currency is offered for checkout **only if Polar charges exactly the local price**. The checkout route refuses otherwise (`pricing_out_of_sync`) before any Polar session. Local price edits never touch Polar (POLAR_PRODUCT_SETUP.md §11).
- **Super Admin:**
  - **Plans:** columns Plan, Players, PHP, USD, Duration, Status, Actions, with a per-price **Polar ✓ / Needs sync** badge. Edit name, capacity and limits (audited, sold passes keep their cap). Per-currency **Prices** dialog (exact minor units, history kept). Availability toggle; disabling the Free Trial plan stops new trials. Recent plan changes listed.
  - **Subscriber:** trial eligibility reason, grant, **Extend** (complimentary days of the current plan, queued), set plan/expiry (manual passes only), **Revoke** a specific pass (reason required), suspend/**unsuspend**, Purchase History, audit history.
  - **Revenue** (new): per environment (production vs **sandbox = test data**) × currency — gross, refunds, net, refunded and under-review orders. **Never sums across currencies.** Purchases are separate from complimentary grants and trials.
- **Security:** all new mutations go through `requireSuperAdmin()` plus service-role functions that re-check the actor (`assert_admin_actor`). Hosts see only their own history (`my_*`). The catalogue audit log (`admin_audit_events`) is append-only and admin-readable. Signed-out probes of every new route → 401.
- **DB:** migration `20261112000013`.
- **Verification:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **388/388**: +10 DB tests (own-only history incl. refunds; admin-only; price history and audit; invalid currency, trial and zero prices, non-admin actor; plan edits keep sold caps; trial availability; extension queued; revocation audited; revenue per env × currency, comps excluded) and +12 UI-rule tests (action labels, price parsing, sync decisions, admin actions, refund labels, out-of-sync checkout).
  - Chromium check at 390/1280 px on a production build: current pass with queue, picker labels in PHP/USD, unsynced PHP disabled with a USD fallback, purchase history with a refund, price editor rejecting 209.999 and sending 20900. No errors, no overflow. A plan-grid that clipped in narrow containers was fixed (container-sized columns).
- **Next:** apply migrations 1–13 to the hosted project, then the live Polar sandbox run (POLAR_PRODUCT_SETUP.md §9–§11).

## Game Pass — Phase 7: entitlements & game-limit enforcement (summary)
- **Audit:** every app check goes through `my_entitlement`, and every database check through `pass_entitlement` (13 functions). **No function reads the frozen `subscriptions` table.** Clients can write only `games(title, max_players)`, which is capped, and `players.kicked_at`. Rules documented in GAME_PASS_DESIGN.md §14.
- **Fixed:** restoring a removed player (`kicked_at → null` over REST) skipped the capacity check, so a full 3-player trial room could reach 4. Migration `20261112000012` makes it a locked, capacity-checked join. Mutation check: the test fails without it.
- **Policy (unchanged, now fully tested):**
  - Half-open UTC access on the database clock; expiry immediate, no job.
  - Upgrade now, same tier queued (+7 days), lower tier after the current pass; the trial ends on the first purchase.
  - Revoked/refunded passes stop at once, and the next queued pass takes over.
  - A pass expiring during a live game lets it finish its rounds, with no joins, no new rounds and no new games.
  - The dashboard and results stay available after expiry.
- **UI:**
  - Restriction screen shows **Purchase required / Trial expired / Pass expired** with a "Choose a Game Pass" link.
  - Host lobby shows **"Player limit reached (n/n)"** with **"Upgrade required…"** and an upgrade link.
  - Players see **"Player limit reached"** ("this room is full").
  - Create/start errors now say *Purchase required* / *Pass expired* / *Player limit reached* instead of "subscription".
- **Verification:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **366/366**: +15 enforcement tests covering 3/10/50/100 exact limits, reconnects, unauthorized capacity and plan edits, un-remove over capacity, expired trial/pass, repurchase, first purchase, purchase during trial, same-tier extension, upgrade, queued downgrade, repeated payment events, revoke/refund, and a running game at expiry.
  - `test:concurrency` **25/25** ×2: 10 joins for the last trial slot → exactly 1; un-remove racing a join → never 4.
  - Chromium check of the new states and the full-lobby banner at 390/1280 px on a production build, with no errors.
- **Next:** apply migrations 1–12 to the hosted project; live Polar sandbox run (POLAR_PRODUCT_SETUP.md §9–§10).

## Game Pass — Phase 6: payment verification & activation (summary)
Full record: [PAYMENT_VERIFICATION.md](PAYMENT_VERIFICATION.md).
- **Webhook** `POST /api/webhooks/polar` (exact path public in the proxy): Standard Webhooks signature on the raw body. It tries both secret schemes as Polar's SDKs do, compares in constant time, enforces a ±5 min window, and returns 403 otherwise. It then **fetches the order or checkout from Polar's API** and decides from that state; the event body is only a trigger. No SDK was added.
- **Activation:** only a Polar order that is `paid`, `billing_reason = purchase`, in our organization, with no discount. The database (migration `20261112000011`, six marked edits to `apply_payment_event`) also checks environment, product, buyer (`customer.external_id`), checkout, currency and exact amount (total, or net when tax is added on top). It is atomic with dedupe, grant and audit, and the queue policy applies (upgrade now, same tier queued, lower tier after).
- **Idempotent and safe:** stable effect ids plus unique `payment_events`, `duplicate_effect` for the same Polar order, one pass per order. Transient failures → 503 → Polar retries; a failed transaction leaves nothing. Out-of-order events converge. Refunds revoke only that order's pass; partial refunds keep it; repeated refunds are no-ops.
- **Ops:** `POLAR_ORGANIZATION_ID` required. Production checkout needs `BILLING_PRODUCTION_APPROVED=true`. Webhook processing doesn't depend on the checkout switch. Admin reconcile route `POST /api/admin/billing/reconcile`. Webhook setup in POLAR_PRODUCT_SETUP.md §10.
- **Verification:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **351/351**: webhook integration on real SQL for all 19 required cases, plus the signature spec vector.
  - `test:concurrency` **23/23** (10× same delivery, 10× different deliveries → one pass).
  - HTTP probes on a production build: 403 unsigned/forged/replayed; a signed request reached real `sandbox-api.polar.sh` (dummy token refused → 503 retry); nothing secret logged.
  - A real bug was found and fixed: a repeated refund under a new event id went to review.
- **Next:** live sandbox run (POLAR_PRODUCT_SETUP.md §9–§10, record in PAYMENT_VERIFICATION.md §3), apply migrations 1–11 to the hosted DB, then set `BILLING_PRODUCTION_APPROVED` in production.

## Game Pass — Phase 5: secure one-time checkout (summary)
- **Flow:**
  - `POST /api/billing/checkout` requires a signed-in Game Master (401/403 otherwise) and reads only `{planCode, currency}`. The plan is validated against the paid list and the currency against PHP/USD.
  - The product comes from this deployment's env, the amount from `plan_prices`.
  - The buyer is bound by `external_customer_id` = Supabase user id, plus a prefilled email from the profile. Correlation is `metadata.bringme_order_id`.
  - A pending order is snapshotted (buyer, plan, provider, price, currency, environment, product), a Polar **hosted** checkout is created, Polar's response is verified (product, currency, exact amount, no discount, no tax on top), and only then is the URL returned and the browser redirected.
  - The logic lives in `lib/billing/checkout-flow.ts`, independent of Next.js and Supabase and tested with fakes.
- **Idempotency:** `start_checkout_order` (migration `20261112000010`) reuses the same open, verified checkout for repeated clicks. A click racing an in-flight start waits for that start's URL. Real-PG: 10 simultaneous clicks give 1 order.
- **Return handling:**
  - Polar's back link goes to `?checkout=canceled` ("Checkout canceled. You were not charged.").
  - The success URL goes to `/dashboard/subscription/checkout?checkout_id=…`, which polls `GET /api/billing/checkout/status`. That endpoint reads the host's own order (`my_checkout_status`) and, while the order is pending, Polar's checkout status server-to-server. Failed or expired sessions are shown and the order closed (idempotent), but **nothing is ever granted** there.
  - States: payment received — confirming…, not finished (resume link), confirmed, payment unsuccessful, expired, canceled, review, not found.
- **UI:** "Buy Starter · ₱99.00 PHP" buttons, a "Opening secure checkout…" loading state, a persistent inline error (`role=alert`) plus toast, and the terms **"One-time purchase" · "7 days of access" · "No automatic renewal"**. No recurring-billing UI.
- **Never an entitlement from:** checkout creation, the redirect, `?checkout=`/`checkout_id` in the URL, or Polar status polling. Only `apply_payment_event('order_paid')` from the verified webhook (Phase 6) grants a pass.
- **Verification:**
  - tsc ✅, lint ✅, build ✅.
  - `npm test` **319/319**: +14 flow tests (authenticated buyer, manipulated body, wrong plan, unsupported currency, disabled/unmapped plan, wrong product, USD-for-PHP, double-click reuse, in-flight race, Polar down/malformed, return states) and +10 DB tests (abandoned, failed, success without webhook, cross-account).
  - `test:concurrency` **21/21**.
  - Signed-out probes → 401.
  - Chromium check of every return state and the picker error at 390/1280 px on a fresh production build, with no hydration or page errors. A hydration warning seen on the long-running dev server came from a stale server module.
- **Next:** run the sandbox checklist (POLAR_PRODUCT_SETUP.md §9), then Phase 6 (verified webhook → pass).

## Game Pass — Phase 4: Polar products & regional price mapping (summary)
- **Audit:** there was **no existing Polar integration** (no SDK, routes, ids or env). The Polar organization and its products could **not** be audited (no credentials). `npm run billing:audit` (read-only) does it once ids are set.
- **Polar facts (official docs):**
  - One product can hold fixed prices in several currencies.
  - A default-currency price is required (otherwise the product is "free").
  - Polar picks the checkout currency by geolocation, falling back to the default.
  - One-time = `recurring_interval: null`, locked at creation.
  - Sandbox `sandbox-api.polar.sh` vs production `api.polar.sh`.
- **Design:** one one-time product per paid plan, with fixed USD + PHP prices (₱99/$1.99, ₱199/$3.49, ₱299/$4.99). No product for the trial. No SDK: `fetch` + typed checks.
- **Code:**
  - `lib/billing/config.ts`: env → plan→product map. Off by default; sandbox and production can't cross; production blocked until the webhook ships.
  - `lib/billing/currency.ts`: PHP/USD only; PH defaults to PHP.
  - `lib/billing/verify.ts`: checkout response must match product, currency and exact amount, with no discount and no tax on top.
  - `lib/billing/audit.ts`, `lib/billing/polar.ts`.
  - `POST /api/billing/checkout`: the client sends only `{planCode, currency}`; any mismatch cancels the order and nothing is redirected.
  - Migration `20261112000009` (order snapshot of environment + product, `create_checkout_order`, `attach_verified_checkout`, webhook checks against the snapshot).
  - `scripts/polar-audit.ts`.
- **UI:** Game Pass page with a **Pay in ₱ PHP / $ USD** toggle, both regional prices, a button stating the exact charge ("Pay ₱99.00 PHP"), the terms line "One-time payment. Seven days of access. No automatic renewal.", a "Test mode" badge in sandbox, and disabled buttons when checkout isn't configured.
- **Verification:** tsc ✅, lint ✅, build ✅, `npm test` **295/295** (+15 billing unit, +14 mapping DB). Client bundle scan has no Polar secrets or API hosts; unauthenticated checkout → 401. Chromium check of the picker at 390/1280 px (toggle, keyboard, exact-charge label, refusal message, disabled state).
- **Next:** set up the sandbox products (POLAR_PRODUCT_SETUP.md §2), fill in the verification log (§7), then the webhook phase.

## Game Pass — Phase 3: automatic free trial (summary)
- **Activation:** one-time 7-day trial with 3 players, granted **automatically** when a Game Master's email is confirmed. A trigger on `auth.users` does this, runs after profile creation, and never blocks sign-up. `/auth/continue` re-checks after every sign-in (`ensure_my_trial`, idempotent) for older accounts, and a dashboard "Start my free trial" button calls the same function. No card is required and no checkout is involved.
- **Rules:** trial claims are permanent `game_passes` rows guarded by a unique index, so logout, login, refresh, password reset, a new browser or a profile edit can't restart it. Timestamps come only from the database. Any previous pass, including a manual grant, makes an account ineligible. Expiry is pure time, with no job involved.
- **DB:** migration `20261112000008_auto_trial.sql`, with `ensure_trial_for`, `ensure_my_trial`, the `on_auth_user_trial` trigger, a tightened `trial_eligibility`, and `my_game_pass_summary`.
- **UI:**
  - Dashboard card "Free Trial Active": maximum 3 players, end time in the viewer's zone, a live remaining-time counter based on server seconds, and an "Upgrade to Game Pass" button.
  - After the trial: "Your free trial has ended. Choose a 7-Day Game Pass to continue hosting."
  - Nav renamed to "Game Pass". The page lists Starter, Party and Pro with PHP and USD prices; "Buy" stays disabled until checkout exists.
  - New `POST /api/host/trial` (JSON-only, so it keeps the CSRF guard).
- **Verification:** tsc ✅, lint ✅, build ✅, `npm test` **266/266**, `test:concurrency` **20/20** ×2, Chromium check of all card states at 390 px and 1280 px. This fixed a cramped two-column layout inside narrow containers.
- **Next:** apply migrations 1–8 to the hosted project (runbook in MIGRATION_VERIFICATION.md §3), then Polar checkout + webhook.

## Game Pass — Phase 2: non-destructive Supabase migration (summary)
Results and runbook: [MIGRATION_VERIFICATION.md](MIGRATION_VERIFICATION.md). **Not executed on the hosted DB** (only REST access exists); a fresh read-only probe confirms no Game Pass objects there yet.
- **Migrations `20261112000001..7`:** enums → plan catalogue (Free Trial plan, `tier`/`duration_seconds`/`is_trial`, `plan_prices` with PHP/USD minor units) → ledger (`game_passes`, `pass_segments` with a `btree_gist` no-overlap exclusion, append-only `entitlement_events`, `profiles.hosting_suspended_at`) → `pass_orders` + `payment_events` (unique Polar ids, `(provider, event_id)` dedupe) → functions (replan, trial, admin grant/revoke/suspend, orders, `apply_payment_event`, review) → legacy backfill (identical intervals; then Pro 200→100) → **cutover** (only behaviour change; same function signatures; `subscriptions` frozen). Compensating revert in `supabase/rollback/`; read-only `inspect/game_pass_preflight.sql` / `postflight.sql`.
- **Behaviour after cutover:** rooms get the pass cap (Party 50, Pro 100; platform default now only for admin games), upgrades raise open lobbies, over-full rooms can't start after a downgrade (`player_limit_exceeded`), live games survive expiry, admin "activate" queues a pass, paid passes can't be edited by admins.
- **App:** `database.types.ts` (ledger types), admin subscription route → audited `admin_*` functions with the admin's id, subscriber page shows Game Pass history, 7-day default, new error messages.
- **Verification:** tsc ✅, lint ✅, build ✅, `npm test` **255/255** (+45 Game Pass tests: plans, prices, trial, queue/upgrade/pause, DST, webhook idempotency/evidence, refunds, admin, capacity, RLS, immutability, live-shaped backfill, re-runs, revert), `test:concurrency` **20/20** ×3 on real PostgreSQL 18 (trial race, 10× webhook, simultaneous purchases, trial vs purchase).
- **Next:** run the preflight on the hosted project, back up, repair migration history, apply 1–6, then 7 with this app build; Phase 3 = Polar checkout + webhook + pricing UI.

## Game Pass — Phase 1: domain design (summary)
Design only, no DB/app changes. Full spec: [GAME_PASS_DESIGN.md](GAME_PASS_DESIGN.md) (decisions D-1…D-22, invariants I-1…I-11, 60-row acceptance matrix).
- **Model:** payment (`pass_orders`: pending/paid/failed/expired/canceled/needs_review/refunded/partially_refunded) is separate from entitlement (`game_passes` + `pass_segments`). Access = the half-open UTC segment containing `now()`, so it's pure time with no cron. A GiST exclusion constraint guarantees ≤1 active pass per host.
- **Queue rule:** after every grant/revoke, remaining time is re-laid from `now()` ordered by tier desc, then purchase order. This gives immediate first purchase, same-plan +7 d queue, immediate upgrade with the paused remainder resuming later, and downgrades after the current pass. Paid value is never lost. Trial is forfeited by the first paid pass.
- **Key decisions:** trial claimed explicitly, once per account (unique index); Pro cap 200→100, other limits kept; room capacity follows the current pass until start (fixes the 20-player cap); live games may finish their rounds after expiry; full refund revokes the remaining time; admin grants 1–366 d with reason; account-level suspension; PHP/USD as minor-unit rows in `plan_prices` (one Polar product per plan × currency).
- **Migration:** 7 additive files. Files 1–6 cause no behaviour change; file 7 is the single cutover with a tested compensating revert. The live 30-day Starter subscription is backfilled as a `legacy_subscription` pass with an identical interval. `subscriptions` is frozen as history.
- **Before Phase 2:** run the audit's read-only catalog queries (migration 12, indexes, `btree_gist`), repair migration history, confirm Polar PHP/USD product layout and webhook event names.

## Game Pass — Phase 0: repository & database audit (summary)
New business model: one-time **7-Day Game Passes** (Free Trial 3 players / Starter 10 / Party 50 / Pro 100; PHP and USD priced separately) via Polar.sh, replacing manual "subscriptions". Audit only, no code/DB/Polar changes. Full report: [GAME_PASS_AUDIT.md](GAME_PASS_AUDIT.md).
- **Live DB (read-only PostgREST check):** compat + migrations 1–11 applied (all their RPCs/columns exist; legacy columns kept alongside); migration 12, policies, triggers, indexes and `schema_migrations` **unverified** (no catalog access). Earlier 42703 errors (`players.nickname`, `subscription_plans.code`/`max_active_games`, `subscriptions.current_period_end`) are resolved on live. Data: 2 profiles, 3 plans (all price 0; Pro = 200 players), 1 active 30-day Starter subscription (ends 2026-12-11), 2 games.
- **Polar:** nothing implemented (no SDK, checkout, webhook, product mapping or order tables).
- **Key gaps:** no per-currency prices/duration/trial; game capacity = `least(platform default 20, plan)` so Party/Pro hosts get 20; entitlement re-checked each round (a pass ending mid-game blocks the next round); one-live-row index + admin "activate" overwrites the row (no purchase history).
- **Validation:** tsc ✅, lint ✅, `npm test` 210/210 ✅.
- **Next:** answer the open questions in the audit, run its read-only catalog queries, confirm Polar PHP/USD product setup, then Phase 1 (additive schema migration).

## Phase 11 — Production readiness audit (summary)
Audit only; full report with passed/failed checks, risks, manual tests and launch blockers in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
- **Executed:** tsc, lint, build, `npm test` 203/203, real-Postgres concurrency 16/16, a privilege inventory under emulated Supabase default grants, 37 HTTP probes on the production build (unauthenticated/forged admin, host and guest calls, CSRF shapes, body limits, name/code validation, open redirects, headers, secrets in bundle), and 27 Playwright checks (5 viewports, axe WCAG A/AA on 8 public pages, reduced motion, keyboard, camera under Permissions-Policy, framing).
- **Fixed:** (1) hosts could DELETE their own games/rounds over REST and so **reset the per-period game cap** (migration `20261111000012_production_hardening.sql` + regression test); (2) unauthenticated `/api/*` now gets `401 {"error":"unauthenticated"}` instead of a redirect that surfaced as an HTML 405 (`lib/supabase/proxy.ts`); (3) security headers (no framing, nosniff, referrer policy, `camera=(self)`, no `X-Powered-By`) in `next.config.ts`.
- **Open:** no rate limiting; no full CSP; photo retention not enforced; nothing verified on real Supabase or real phones.

## Phase 10 — Visual polish & interaction design (summary)
Presentation only: no game rules, schema, auth or information architecture changed. The mockup referenced in the brief was not provided, so this follows the written direction (premium but playful, purple/yellow/lavender, coral for camera actions).
- **Shared visual language:** `components/brand/mascot.tsx` ("Snappy", an SVG camera character that bobs, blinks and looks around; moods happy/waiting/cheer/judging) and `components/brand/backdrop.tsx` (one calm background for every dark screen: two soft glows, a faint dot grid, four twinkling sparkles) replace the old repeating blobs. Motion vocabulary in `app/globals.css` / `tailwind.config.ts` (`bob`, `blink`, `tick-pop`, `tick-ring`, `drop-in`, `rise`, `join-in`, `draw`, `ping-soft`, …): transform/opacity only, no animation library.
- **Landing:** mascot hero with decorative game moments (3·2·1, 02.418, Locked in!), clear Play / Host buttons with icon wiggle on hover, staggered rise-in, "How it works" cards with a connecting line and hover lift, roles section.
- **Join / play code:** mascot peeking over a friendly "You're invited" card, large 64 px form, reassuring footnote.
- **Waiting room:** mascot, "You're In!" / "Game on!", name pill, **PlayerCount** (digit pop, soft ring pulse and a floating "+1" when someone arrives), waiting dots, connection chip.
- **Countdown** (`components/game/countdown.tsx`, shared with the projector): each second pops over a disc while a ring expands; **GO!** gets a coral disc, a starburst and a full-area yellow flash.
- **Camera screen:** deep-purple frame, item title above in a label + 4xl type, readable SS.mmm pill with a live dot, viewfinder corner brackets + thirds guide, white shutter flash on capture, shutter with a double ring and a gentle pulse when ready ("Tap to snap").
- **Photo submitted:** drawn check mark with ring, one-shot confetti burst, "Locked in!" drop-in, your time in a pill, waiting dots.
- **Winner screen:** slowly turning sunburst, trophy drop-in, name reveal, time pill, winning photo as a tilted polaroid, confetti, Next round (host/projector).
- **Game Master lobby:** QR in a yellow viewfinder frame with a soft ring, room code as tiles, arriving players pop in as chips (stage + list), **large pulsing Start game** (80 px), and a numbered **"What players will bring"** list (the page now also reads the round prompts; read-only).
- **Accessibility/motion:** reduced-motion shows resting states (eyes open, no confetti/rings/flash); `axe-core` (WCAG 2.0/2.1 A/AA + best-practice) reports **no violations** on landing, play, join, waiting, countdown, camera, submitted, judging, winner, next-round and the host lobby after adding missing h1s and fixing an invalid `aria-label` on the room code.

## Phase 9 — Live submissions, photo review & winners (summary)
- **Game Master live screen** (`components/game/host-console.tsx`): projector-style stage + stats row (round, item, players, **submissions received**, phase, connection) + live **ReviewPanel** (fastest first by the TIMING.md policy: thumbnail, player, SS.mmm, status, "would win", close-finish / server-time badges). Updates on every Realtime hint; stale responses can't overwrite newer ones.
- **Photo review:** open any photo large (`PhotoViewer`, with side-by-side comparison for close finishes), **Approve / Disqualify / Undo** through `review_submission()` (SQL, owner-checked, current round only, locked once the winner is official). Direct client edits of status are revoked.
- **Winner = fastest APPROVED photo, computed by the server** (`announce_winner`). The host's "Declare winner…" opens a confirmation dialog (leader, time, photo, close finishers, unreviewed count, server-time note); the id it sends is only a confirmation, so a changed ranking returns `winner_mismatch` instead of announcing the wrong player. "No winner" is only possible when nothing is approved. **Write-once** (`winner_confirmed_at`): no second winner for a round, even for trusted roles.
- **Winner announcement** (`WinnerStage`): trophy illustration, CSS-only confetti (hidden for reduced motion), large name, winning photo, time, **Next round**. Same component on the host screen, the projector and players' phones.
- **Projector mode:** `ProjectorStage` goes fullscreen (Fullscreen API); the phase's main button is inside it, so the whole game can be run from the projector. Only the winner's photo is ever shown there, after the announcement.
- **Players:** winner screen with winner name, time and photo (via `GET /api/play/winner-photo`: a 2-minute signed URL the database only allows while the announcement is showing), **their own time**, the disqualification notice (revealed only once the winner is official), "You won!" celebration, then back to waiting for the next round.
- **Final results:** `FinishedResults` (host, also when revisiting) and the players' "That's a wrap!" list the winner, time (and host: photo) of every round; players see "You won N rounds". **Archive game** (`archive` transition, finished games only, once) moves it to an "Archived games" section; archived games stay frozen but readable.
- **Privacy:** all photos stay in the private bucket; hosts get 2-minute signed URLs scoped by RLS; players only ever get the winner's photo during the announcement.
- Migration `20261111000011_review_winners.sql`. No points or tournament systems.

## Phase 8 — Camera capture, automatic submission & timing (summary)
- **Docs:** [TIMING.md](TIMING.md) explains the measurement, the cross-checks, the ranking policy, near ties and the limits (no claim of perfect millisecond fairness).
- **Player camera** (`components/game/camera-*.tsx`, `lib/game/{camera,photo,upload}.ts`): permission requested on the waiting screen *before the first round* (opened silently if already granted); rear camera preferred (`facingMode: ideal environment`, no microphone, fallback to any camera, denial is not retried); immersive full-screen round view: item above, large live preview, live **SS.mmm** timer (drawn straight into the DOM at 60 fps), big coral shutter (96 px) that stays disabled until the preview shows real frames. Capture happens on **pointer-down**; camera interruptions (`ended`/`mute`), backgrounded tabs (auto re-open on return), denial, busy, no camera, insecure page and unsupported browsers each get a clear message + Try again. No file input exists.
- **Timing:** `lib/game/clock.ts` (monotonic `performance.now()` offset estimate, lowest-RTT sample, quality reported with every measurement); elapsed is fixed **at the tap**; `begin` is sent immediately, in parallel with JPEG compression (≤1600 px, ≤1.5 MB), so upload speed can't change the time.
- **Submission flow** (`lib/game/submit-flow.ts`): tap → begin → auto-upload with progress (XHR to a single-use signed URL) → complete; two automatic retries (500 ms / 1.5 s) with the **same** capture and timing, then a manual **Try again**; double taps ignored; no retake after acceptance; a rejected photo may be captured again (timing restarts).
- **Server** (migration `20261111000010_submissions_timing.sql`): `submission_intents` + `begin_submission` / `complete_submission` / `discard_submission_intent` (service role only) and `round_ranking` (host, RLS). Per-player row lock + unique constraints make begin/complete **idempotent and race-safe**; one submission per player per round; the server records `intent_at` and receipt time independently, flags inconsistent claims (hard flags ⇒ rank by server-observed time) and soft-flags poor sync; a tap before the host closes submissions still counts if its upload lands in time (straggler rule). Direct inserts into `submissions` now require an intent (trigger).
- **Handlers:** `POST /api/play/submissions/begin` (validates session, round, timing; issues the signed URL for a **server-derived** path) and `/complete` (verifies the stored object: `image/jpeg`, size within the platform limit, real JPEG signature; discards junk). Old `prepare`/finalize routes removed. `GET /api/host/games/[id]/submissions` returns the ranked photos with 2-minute signed URLs (host only).
- **Host:** `SubmissionsPanel` shows rank, SS.mmm, thumbnails, "too close to call" and "server time used" badges, and a Pick button feeding Announce winner (nothing is awarded automatically).
- **Snapshots:** round `id`, `submissionCount`, and the player's own `submission` (so a refresh shows "Locked in!" with the same time).

## Phase 7 — Real-time game engine (summary)
- **State machine in PostgreSQL** (`game_transition`, migration `20261111000009_game_engine.sql`). `games.status` stays the lifecycle; new `games.phase` is the engine state: `lobby → countdown → active → reviewing → winner_announced → finished` (a CHECK ties status and phase together). Host actions: **start_game** (lobby→live, ≥1 player), **start_countdown** (3 s, server timestamp `countdown_ends_at`), **start_round** (opens the round; `opened_at = max(now, countdown end)`), **close_submissions**, **move_to_review**, **announce_winner** (superseded in Phase 9: the server computes the winner from approved photos), **next_round** (back to the waiting screen), **end_game**, plus **cancel**. Any other (phase, action) pair is rejected with `invalid_transition`; nothing else can change status/phase (column grants revoked, even for the host).
- **Concurrency / duplicates:** `SELECT … FOR UPDATE` on the game row + a required `expectedVersion` (optimistic check) → a double click, second tab or replayed request gets `stale_state` and changes nothing; a partial unique index allows one open round per game. The host UI re-reads state on `stale_state` and retries once only if nothing but the version moved (e.g. a player joined), otherwise it refuses to act.
- **Versioning:** `games.state_version` bumps on every visible change (phase, round, player join/removal). Every snapshot carries it; clients drop anything older.
- **Snapshots:** `game_state_json` is the single builder (host / player views). Players receive the round item **only after `opened_at`** (server-side withholding, verified over the API). `GET /api/play/state` (cookie) and `host_game_state()` (host session) return the authoritative state; first paint is server-rendered from it, so refresh restores the exact screen.
- **Realtime:** the DB broadcasts `{version, phase}` (no content) on the **private channel `game:<id>`** via `realtime.send` after every transition/join/removal (failures never fail a transition). Authorization policy on `realtime.messages`: the owning host (Supabase session) or a guest whose token has `kind=guest` + that `game_id`; **no client can publish**. Guests get a 1 h HS256 token (`role: anon`, no DB privileges) from `GET /api/play/realtime-token` (cookie-authorized; needs `SUPABASE_JWT_SECRET`, else 503 → "basic mode").
- **Client sync** (`lib/game/sync.ts`, `components/game/use-game-sync.ts`): broadcasts are hints → serialised re-read of the authoritative snapshot; stale/duplicate hints cost nothing; resync on every (re)subscribe, tab focus, `online`, and exactly at the countdown end / official round start; a 30 s safety re-read while connected; slow 4 s polling **only** while Realtime is down (chip says "basic mode"). Server clock offset (lowest-RTT sample) keeps 3-2-1 and timers aligned across devices.
- **Players:** waiting → animated 3-2-1 / GO! → item revealed at the official start + camera **placeholder** (not a button) + timer → "Time's up" / waiting after submit → judging → winner screen ("You won!" / "<name> wins!" / no winner) → waiting for next round → "That's a wrap!". Joining is now allowed **only while the lobby is open (before Start Game)**; existing players can always reconnect.
- **Host:** `HostConsole` shows one obvious next step per phase (round info, timer, winner picker, End game with confirm); lobby uses the same sync (no fixed polling). All controls go through `POST /api/host/games/[id]/transition`; the old start/cancel routes are gone.
- **Replaced from Phase 6:** the SSE stream and `player_lobby_state` (removed). `create_game_with_rounds` is now SECURITY DEFINER (still owner = `auth.uid()`; same triggers).
- Not built (by request): scoring beyond a winner pick, chat, teams, photo capture/submissions UI.

## Phase 6 — Guest joining & waiting lobby (summary)
- **Flow:** QR → `/join/<CODE>` (server checks the room via `public_room_info`: not found / ended / not open / full → friendly screens; otherwise shows the room title + one name field + **Join Game**) → `POST /api/play/join` → `/join/<CODE>/lobby`. Returning players (valid cookie for that room) are redirected straight to the lobby. `/play` has a room-code entry form for players who can't scan.
- **Join is atomic in SQL** (`join_game`, service-role only): restores the existing player when the cookie's token hash belongs to this game (no duplicates, stored name wins), otherwise inserts through the Phase 2 trigger (locks the game row, lobby/live only, max players), names unique per game case-insensitively, removed players can't re-enter. Names are sanitised by `parsePlayerName` (strips control/zero-width/bidi chars, 1–24 code points, must contain a letter/number/emoji) and are never used as credentials.
- **Session:** raw token only in the `bm_player` HttpOnly, SameSite=Lax cookie (Secure in production, 12 h); DB stores only SHA-256. Join links/QR now use `/join/<CODE>`.
- **Waiting lobby:** "You're In!" bounce-in, player name, live player count, "Waiting for the Game Master…", game-started / ended / removed / session-expired states, connection chip (Connected / Reconnecting / Offline), floating background shapes (animations disabled for reduced-motion). No home link in the player shell.
- **Live updates (superseded in Phase 7 by Realtime Broadcast + authoritative snapshots; SSE removed):** `GET /api/play/state?stream=1` was a cookie-authorized Server-Sent Events stream (the server checks the DB every 2 s via `player_lobby_state` and pushes only changes, ≤55 s per connection, browser auto-reconnects); without `stream=1` it returns one JSON snapshot (also used to detect an expired session). **Not Supabase Realtime:** guests have no Supabase JWT, so Realtime/RLS cannot authorize them. Cost: one small query per connected player every 2 s.
- **Migration** `20261111000008_guest_join.sql`: `public_room_info`, `join_game`, `player_lobby_state` (all service-role only).
- **Testing done:** PGlite tests for the three functions (reconnect, duplicates, full, removed, ended, token-hash only, no client access) + unit tests for name validation. Plus a real multi-session browser run (see health checks).

## Phase 5 — Game Master dashboard, creation & lobby (summary)
- **Dashboard** (`/dashboard`): welcome, large *Create game* button (shown only to active subscribers; others get the restriction screen), subscription badge, metrics (created / open now / completed), active games, history (finished + cancelled). All from the host's own rows (RLS).
- **Create game** (`/dashboard/games/new`): optional title, round count stepper (capped by plan), one item per round, edit / delete / reorder (up/down buttons), every round must have an item (client + server). `POST /api/host/games` → `requireActiveSubscription()` → `parseGameInput` (plan round limit) → SQL `create_game_with_rounds()` (SECURITY INVOKER, one transaction: game + all rounds + lobby opened). Plan limits (open games, games per period, rounds) are enforced by the existing triggers, so a failure leaves nothing behind.
- **Identifiers:** game id = random UUID (used in host URLs, 404 for other hosts); room code = 6 chars from a CSPRNG with a uniqueness check + unique index. Items are stored in `game_rounds` (`prompt`, `round_no` = order).
- **Lobby** (`/dashboard/games/[id]`): large server-rendered SVG QR (library `qrcode-generator`, no client QR code), copyable join URL, huge room code, player count + list (polls every 3 s until Realtime exists), remove player (confirm), Start game (needs ≥1 player + active subscription → status `live`), Cancel game (confirm), **fullscreen presentation mode** (QR, code, URL, count, player names). After start the page shows a "game is live" placeholder with an End game button; the round engine/camera are not built.
- **Join link:** `NEXT_PUBLIC_SITE_URL` (config, never the Host header) + `/play/<CODE>`; the QR encodes exactly that URL. The lobby warns if the variable is not set. `/play/[code]` is a real page that confirms the code; joining UI comes later.
- **API:** `POST /api/host/games`, `POST /api/host/games/[id]/start`, `POST /api/host/games/[id]/cancel`, `POST /api/host/games/[id]/players/[playerId]/remove` — all run as the signed-in host (RLS), 404 for games they don't own.
- Migration `20261111000007_game_creation.sql` (one function). The mockup referenced in the brief was not provided; layout follows the written direction.

## Phase 4 — Super Admin dashboard (summary)
- **Overview** (`/admin/dashboard`): total / active / pending / expired subscribers (+ suspended/deactivated hint), games created, completed games, active rooms (lobby + live). All numbers from SQL `admin_overview()`; cards drill into the filtered list.
- **Subscribers:** server-side search (name/email, wildcard-safe), status filter, pagination (20/page, filters in the URL) via `admin_list_subscribers(search, state, limit, offset)`. Detail page: status, subscription history, the subscriber's games (paginated), and actions — activate/renew, assign plan, change expiration, suspend (confirm), deactivate/reactivate account (confirm). Deactivation flags the profile (removes entitlement in the DB) **and** bans the auth user; rolled back if the ban fails.
- **Plans:** create/edit (name, price, max players, games per subscription period, open-at-once, rounds) and activate/deactivate (confirm). Inactive plans can't be newly assigned; current subscribers keep them. No payments. New DB column `max_games_per_period` is enforced by the game-insert trigger (period = since activation).
- **Settings:** `platform_settings` (single row): default max players (DB default for new games, still capped by plan), max photo size (a trigger syncs it to the storage bucket limit), photo retention days (**stored only; the cleanup job that deletes old photos is not built**), support email (shown on subscriber restriction screens).
- **Security:** every admin handler runs `requireSuperAdmin()` → `lib/admin/validation.ts` (pure, tested) → service-role/SQL call. Reads run under the admin's own session (SQL functions re-check super_admin). Pages call `requireAdminPage()`. New migration: `20261111000006_admin_dashboard.sql`.
- **API:** `POST /api/admin/users/[id]/subscription` (activate | set_plan | set_expiry | suspend), `POST /api/admin/users/[id]/account` (deactivate | reactivate), `POST /api/admin/plans`, `PATCH /api/admin/plans/[id]`, `PUT /api/admin/settings`.
- Gameplay modules untouched (only the plan-limit rule inside the existing game-insert trigger changed).

## Phase 3 — Authentication & subscription access (summary)
- **Session refresh:** root `proxy.ts` → `lib/supabase/proxy.ts` (`@supabase/ssr`, `getClaims()`); coarse redirect only. Unauthenticated → `/auth/login` (or `/admin/login`) with `?next=`; a leftover `sb-*auth-token` cookie adds `?reason=expired`.
- **Server verification:** `lib/auth/session.ts` (`getSession`, `requireSubscriberPage`, `requireAdminPage`, `getMyAccessStatus`) runs in every protected layout **and** page; role is read from `profiles.role`. `/auth/continue` picks the destination from the DB role (admin → `/admin/dashboard`, subscriber → `/dashboard`); `?area=admin` signs out non-admins.
- **Signup:** display name + email + password, no role field; DB trigger fixes role = subscriber. Email verification via `/auth/confirm` (supports `token_hash` and PKCE `code` links, open-redirect-safe via `safeNext`). Forgot/reset flow with non-enumerating messages.
- **Access states** (SQL `access_state_for`): `pending` (no subscription, default for signups) / `active` / `expired` / `suspended`. Migrations 4–5 add enum value `suspended`, `my_access_status()`, `admin_list_subscribers()`, service-role-only `admin_set_subscription()`.
- **Admin:** `/admin/dashboard` lists subscribers with Activate/Extend/Suspend (`POST /api/admin/users/[id]/subscription`, `requireSuperAdmin()` first). No payments.
- **Subscriber:** dashboard shows status; non-active users see a friendly restriction screen; `/dashboard/subscription` shows plan/dates. Create/start is blocked in the DB by Phase 2 triggers.
- Removed `/host` and `/admin` placeholders (replaced). Players still have no accounts.

## Phase 2 — Database & security (summary)
- Migrations in [supabase/migrations](supabase/migrations) (+ [deploy guide](supabase/README.md)); boundaries documented in [docs/SECURITY.md](docs/SECURITY.md).
- Tables: `profiles`, `subscription_plans`, `subscriptions`, `games`, `game_rounds`, `players`, `submissions`; private storage bucket `submissions`.
- Server code: `lib/supabase/admin.ts` (server-only service client), `lib/auth/guards.ts`, `lib/players/{token,session,submission}.ts`, `lib/api/http.ts`, typed `lib/supabase/database.types.ts` (hand-written; regenerate with `npm run db:types`).
- API: `POST /api/play/join`, `POST /api/play/submissions/begin`, `POST /api/play/submissions/complete` (replaced the Phase 2 prepare/finalize), `PATCH /api/admin/users/[id]/role`. Proxy allow-list now includes `/api/play`.
- Tests: `npm test` (26 authorization tests on PGlite, dev dependency `@electric-sql/pglite`).

## Completed features
- Supabase email/password auth flow (sign-up, login, logout, forgot/update password, email confirm). Post-login/confirm redirect now goes to `/host`.
- **Phase 1:** design system, role shells, landing page, loading/error/404 states, reusable UI kit, reduced-motion support.
- ESLint now ignores `.next/`; starter/tutorial components and `/protected` removed.

## Missing features
- Points/leaderboards (intentionally not built), Polar checkout/webhook + pricing UI (Game Pass Phase 3; ledger ready), photo-retention cleanup job, device attestation / stronger anti-cheat (see TIMING.md).
- Realtime has not been exercised against a real Supabase project (see Known issues).
- Photo-retention cleanup job (setting exists, nothing deletes yet); admin audit log of changes.
- ~~Migrations 1–12 are not applied yet~~ — **corrected 2026-11-11:** compat + 1–11 are applied on the hosted project (migration 12 unverified; migration history likely empty because files were run in the SQL Editor — repair before `supabase db push`). `SUPABASE_SECRET_KEY` is now set locally.
- Rate limiting (edge/WAF) on `/api/play/*` and host/admin APIs; full nonce-based CSP.

## Important technical decisions
- Use Next 16 `proxy.ts` (not `middleware.ts`).
- Use `supabase.auth.getClaims()` for session checks (as in the starter).
- Players are unregistered: plan on Supabase anonymous sign-in or short-lived room-scoped tokens, with RLS; decide in the player-join phase.
- Real-time via Supabase Realtime (Broadcast/Presence) — no extra socket library.
- Roles stored in DB (`profiles.role`), enforced by RLS + server checks — never trusted from the client.

## Known issues
0. **Fixed (2026-11-11): dev-only "uncached data during prerendering or a navigation" (blocking-prerender-dynamic)** on 8 host/admin routes. Pages read the session at their top level, and on client navigations between sibling pages only the part below the shared layout re-renders, so the area-level `loading.tsx` didn't count. Added a `loading.tsx` per route (dashboard/subscription, games/new, games/[id], admin dashboard/subscribers/subscribers/[id]/plans/settings). Verified in an isolated dev run with a fake signed-in session: 8 errors → 0. Layouts/pages unchanged.
0. **Login → `profile_missing` / migrations failing with 42703 (2026-11-11):** the hosted project (`rjjnwy…`) already had an OLDER BringMe! schema (room_code, item_name, round_number, starts_at/expires_at, price/max_players/max_games…), so migration 1's `CREATE TABLE IF NOT EXISTS` kept it and later files failed; RLS is on with no real policies, so the own-profile query returns 0 rows. Fix: new `20261110000000_legacy_schema_compat.sql` (non-destructive, tested on a simulated legacy DB in PGlite + real PostgreSQL, applied twice), then re-run 1–12 — steps in supabase/README.md. Also fixed: migration 9's phase backfill failed on databases with finished games (`game_is_closed`), and migration 10 wasn't re-runnable after 11 (`round_ranking` return type). Profile lookup errors are now reported separately (`profile_lookup_failed`), and **temporary** diagnostics in `lib/auth/profile.ts` log user id / error code / found; remove them once login is verified.
0. **Game Master review UI has not been driven end-to-end in a browser** (it sits behind Supabase login, which the fake backend can't provide). Its logic is covered by SQL tests, real-Postgres races and the confirmation-logic unit tests; its look by component previews with mock data. Run the host steps in supabase/README.md.
0. **Camera/upload against real Supabase + real phones is unverified.** Tested with Chromium's fake camera against a fake backend. Still to confirm on a live project and real devices: the signed-upload `PUT` (raw body + `apikey`/`authorization` headers + CORS, from the browser), iOS Safari / Android Chrome camera behaviour (permission prompts, interruptions), and real-world clock-sync error.
0. **Supabase Realtime is unverified on a real project.** The SQL (broadcasts, channel policy) is tested in PGlite/real Postgres with a stub `realtime` schema, and the browser code was run against a protocol-level fake Realtime server, but not against Supabase's actual Realtime service. Things to confirm: `realtime.send` availability, that Realtime accepts the HS256 guest token (projects on new asymmetric signing keys may reject tokens signed with the legacy secret), and the `realtime.messages` policy. If anything is off the game still works in "basic mode" (4 s polling).
0. Handlers/browser flows are untested end-to-end (needs a Supabase project); only DB-level behaviour is tested.
1. Auth/email flows (signup verification, reset, login redirects) are verified only up to the server boundary (unauthenticated requests, build, DB tests); a manual pass on a real project is required — checklist in supabase/README.md.
2. `eslint-config-next` is 15.3.1 while Next is 16.4.6; `next`, `@supabase/*` are `"latest"` (unpinned).
3. Proxy allow-list: `/`, `/auth*`, `/admin/login`, `/play*`, `/join*`, `/api/play*`. Unknown paths redirect unauthenticated users to login instead of a 404; unauthenticated `/api/*` calls get a JSON 401 (Phase 11).
4. Mockup referenced in the Phase 1 brief was not available; visuals follow the written direction. Game copy on the landing page ("find it, snap it") is an assumption — confirm game rules.
5. Dark mode removed (light-only theme); `next-themes` is now unused and can be uninstalled.
6. Auth uses a branded passwordless page (logo, mascot, segmented code). CAPTCHA is not wired yet.
7. Repo has no commits yet and `bringme/` sits inside a parent git repo (`~/Development`) with unrelated staged projects; give it its own repo before CI/deploy. `.env.local` is ignored and untracked.

## Health checks (2026-11-11)
| Check | Result |
|---|---|
| Legacy-schema upgrade | ✅ `npm test` **210/210** (+7 legacy-compat tests: 42703 reproduced without the fix; compat + 1–12 applied twice keeps every row; legacy policies removed and own-profile RLS works; create game / join / admin overview work; invalid legacy status stops with no changes; no-op on fresh DB). Same upgrade on real PostgreSQL 18: applied twice, all rows kept. Fixed a pre-existing flaky timestamp-tie test in `submissions.test.ts`. Build ✅, concurrency 16/16. **Not yet run on the hosted project.** |
| Phase 11 audit | ✅ tsc, lint, build; `npm test` **203/203**; `test:concurrency` **16/16** (re-run with migration 12); HTTP probe **37/37**; Playwright audit **27/27** (first run 21/27: harness timing + missing local `SUPABASE_SECRET_KEY`, not app defects); mutation check for the delete fix. Details in PRODUCTION_READINESS.md. |
| `tsc --noEmit` | ✅ pass |
| `next build` | ✅ pass (41 route entries incl. 14 API handlers, Proxy detected) |
| `npm run lint` | ✅ clean |
| `npm test` | ✅ 202/202 (Phase 9 adds 21 SQL review/winner tests + 4 confirmation-logic tests: approve/disqualify/undo, authorization, review lock, fastest-approved-wins, disqualified/pending/removed/flagged cases, close finishes and their resolution, stale confirmations, write-once winners, no-winner, results, archive, what players may see, winner-photo gating). Mutation checks (winner taken from the caller, pending photos eligible, winner not write-once, disqualified still contending, plus all earlier ones) make them fail. |
| `npm run test:concurrency` | ✅ 16/16 on **real PostgreSQL** (Phase 9 adds: a disqualification racing an announcement over 8 rounds — both orders occurred — never yields a disqualified winner or two successes; 10 simultaneous announcements → exactly one; concurrent review decisions stay valid). Earlier: 13/13 (Phase 8 adds: 10 racing `begin`s → one intent; 10 racing `complete`s → one accepted + nine idempotent duplicates; two devices racing different captures → one survives; a capture racing the host's Close submissions is never lost or doubled). Phase 7 part: 7/7 with genuinely simultaneous connections (opt-in: `npm i --no-save embedded-postgres pg`): 10 racing `start_game` / `start_round` → exactly one wins, 9 `stale_state`; racing different actions → one wins; 12 joins into 3 slots → exactly 3; joins racing Start Game → nobody admitted after start. |
| Visual QA (Phase 10) | ✅ Screenshot tour of the full player journey (landing → play → join → waiting → count change → game on → countdown 3/2/GO → camera → submitting → submitted → judging → winner (me/other) → next round) at **360×640, 390×844, 768×1024, 1280×800 and 1920×1080**: no horizontal overflow, no page errors. Host lobby/projector previewed with mock data at 1440, 768 and 390 wide. axe-core clean (see Phase 10), reduced-motion pass done. Camera run (43/43) and winner journey (28/28) re-run after the polish: still green. Screenshots/harness live in the session scratchpad, not the repo. |
| Player winner journey (Phase 9) | ✅ 28/28 (Chromium + fake camera, 390×844, 3 players, fake backend that mirrors the winner rules): real photos captured and uploaded, review hidden until the announcement, announcing a disqualified player refused, "You won!" + confetti + trophy + personal time, others see winner/time/photo (signed URL, not a public path), disqualification notice, no-photo message, refresh keeps the result, reduced motion hides confetti, back to waiting, no-winner round, final results with "You won 1 round", no overflow. The Game Master screens (behind login) were checked visually as components with mock data at desktop and phone sizes, **not** end-to-end. |
| Camera browser run (Phase 8) | ✅ 43/43 (Chromium + fake camera, 390×844 phones, 7 players): permission before round 1, rear-camera constraint, live preview, SS.mmm timer ticking, coral 96 px shutter, tap-time elapsed within ~30 ms of the browser's own tap timestamp, `begin` sent before the upload, double tap → one begin, 3 s slow upload doesn't change the time, 2 failed PUTs recover automatically, persistent failure → Try again keeps the original time, camera interruption + background recovery, permission denied guidance, non-JPEG disguised as JPEG rejected, metadata whitelisting, idempotent complete, no retake, refresh restores. Fake backend, not real Supabase. Harness is in the scratchpad. |
| Multi-device browser run (Phase 7) | ✅ 33/33 (Playwright, 390×844 phones, separate sessions) against the real Next app + a fake backend that also speaks the Supabase Realtime websocket protocol: private channel join with token, push updates in ~50 ms, synchronised 3-2-1, item withheld until start (API + DOM), refresh restore, second tab, stale broadcast ignored / newer one re-reads, Realtime outage → basic mode → reconnect resync, offline catch-up, winner / next round / finish. Harness is in the session scratchpad. |
| Multi-session browser run | ✅ 42/42 (Playwright, Chromium, 390×844 and 360×640 mobile viewports, 4+ separate cookie jars) against the real Next app with a **fake PostgREST backend** standing in for the 3 RPCs (the SQL itself is covered by the PGlite tests). Checked: join, live count updates across sessions, reconnect/no duplicates, duplicate name, full room, ended/unknown rooms, removal, game start/cancel push, offline → reconnect, HttpOnly cookie + hash-only storage, 44px+ touch targets, no horizontal overflow, reduced motion. Harness lives in the session scratchpad, not in the repo. |
| QR decode check | ✅ the exact SVG path data rasterised and decoded by OpenCV returns the join URL (one-off scratch check, not part of the suite) |
| Dev server (signed-out requests) | ✅ `/dashboard/**` and `/api/host/*` redirect to login; `/play/<code>` 200, bad codes show not-found |

## Recommended next steps
1. Clear the **launch blockers in PRODUCTION_READINESS.md**: apply migrations 1–12, set `SUPABASE_SECRET_KEY`, `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_SITE_URL`, then run the manual checklist in PRODUCTION_READINESS.md §7 (and supabase/README.md) with a host laptop on a projector and 3+ real phones; add edge rate limits; pin dependencies.
2. Photo-retention cleanup job; rate limiting (join, auth, tokens, `/api/play/*`); billing; admin audit log.
3. Optional: points/leaderboard if wanted later; export/share results.
4. Housekeeping: pin dependency versions, align `eslint-config-next`, remove `next-themes`.

## Homepage boop counter (2026-11-12, simplified)
- One global number (`snappy_counter`, migration `20261112000016_snappy_counter_simplify.sql`, replacing 000015's shards + per-client table). No history, nothing stored per visitor.
- Browser (`components/marketing/use-boop-counter.ts`): loads the total once; counts taps locally; sends ONE request after 5 s without a tap (or at 500 taps, or when the page is hidden); failed sends retry a few times, 15 s apart.
- API (`app/api/snappy/route.ts`): ≤ 500 taps per request; in-memory per-client limits only (requests ~0.5/s burst 5; taps ~25/s burst 1,000; excess not counted). Production still needs an edge/WAF rate limit for volumetric traffic.
- Tests: `tests/snappy.test.ts`, `tests/db/snappy-taps.test.ts`.

## Presenter screen (2026-11-12)
- `/present/[id]` (`components/game/presenter-screen.tsx`): audience-safe display for the projector/TV, opened from the host game page ("Open presenter screen", new window). Same auth as the console (signed-in host + owner check in `host_game_state`); loads no item list.
- Follows every phase automatically via `useGameSync`: lobby wall (QR, room code, players arriving) → countdown → live round → judging → winner (official winner photo only) → final results with champion. No host controls on screen.
- Controls auto-hide with the cursor after 2.5 s; `F` toggles fullscreen; screen wake lock while open.
- `ProjectorStage` gained `presenter` mode and no longer shows the item between "Start round" and the official start ("On your marks…").
