# BringMe! — Development Rules

Stack: **Next.js App Router + TypeScript + Tailwind CSS + Supabase**. Roles: Super Admin, Subscriber/Game Master, Player (QR join, no registration). See [PROJECT_STATUS.md](PROJECT_STATUS.md) for current state.

## Rules
- Preserve existing functionality; don't rewrite working code.
- Reuse existing components (`components/ui/*`) before creating new ones.
- No unnecessary libraries; justify any new dependency.
- Never expose secret credentials (no service-role key in client code or `NEXT_PUBLIC_*`; never commit `.env*`).
- Validate permissions on the server (RLS + server-side role checks); never trust client-provided roles.
- Follow Next.js 16 conventions: `proxy.ts` (not middleware), async `cookies()`/`params`, Cache Components.
- Create a new Supabase client per request on the server; never store it globally.
- Keep the UI playful, responsive, premium, and accessible (contrast, keyboard, labels, reduced motion).
- Implement one development phase at a time.
- Test modified functionality (`npx tsc --noEmit`, `npm run build`, lint, and manual/browser check).
- Keep explanations short.
- Avoid printing entire source files unless requested.
- Update PROJECT_STATUS.md after each completed phase.
- Animations: transform/opacity only, no animation libraries, and every animation must have a sensible resting state for `prefers-reduced-motion`. Reuse `Mascot`, `Backdrop`, `Confetti`, `Countdown` and the motion utilities in `tailwind.config.ts` before adding new ones.
