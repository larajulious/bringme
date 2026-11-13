/* ------------------------------------------------------------------------------------------------
 * Items the scroll story "calls". Each one is an inline SVG (no image files) drawn on a 160 × 120 canvas,
 * resting on a floor line at y ≈ 104 so they all sit the same way in the viewfinder and on the polaroid.
 * Colours are the mascot's palette (components/brand/mascot.tsx). Decorative: always aria-hidden.
 *
 * To add an item, draw an `Art` component on the same canvas and append it to SNAP_ITEMS: the prompt card,
 * the in-frame illustration and the polaroid all read from that entry, and the rotation picks it up.
 * ---------------------------------------------------------------------------------------------- */

type Art = (props: { className?: string }) => React.JSX.Element;

const Shadow = () => <ellipse cx="80" cy="106" rx="62" ry="5" fill="#000" opacity=".28" />;

function Stapler({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={className} aria-hidden="true" focusable="false">
      <Shadow />
      <rect x="14" y="88" width="132" height="15" rx="7.5" fill="#2a0f5c" />
      <rect x="98" y="84" width="42" height="6" rx="3" fill="#cbd5e1" />
      <path d="M18 84C18 63 32 52 56 52h70c12 0 20 8 20 18v6H18z" fill="#e11d48" />
      <rect x="20" y="74" width="126" height="10" rx="4" fill="#be123c" />
      <circle cx="30" cy="80" r="7" fill="#9f1239" />
      <circle cx="30" cy="80" r="2.5" fill="#fff" opacity=".85" />
      <path d="M50 61h66" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".45" />
    </svg>
  );
}

function Mug({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={className} aria-hidden="true" focusable="false">
      <Shadow />
      <g fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity=".55">
        <path d="M64 28c-5-6 5-10 0-17" />
        <path d="M80 26c-5-6 5-10 0-17" />
        <path d="M96 28c-5-6 5-10 0-17" />
      </g>
      <path d="M114 52h6a17 17 0 0 1 0 34h-6" fill="none" stroke="#ede9fe" strokeWidth="10" />
      <rect x="44" y="36" width="72" height="68" rx="12" fill="#fff" />
      <rect x="44" y="88" width="72" height="16" rx="8" fill="#ede9fe" />
      <ellipse cx="80" cy="38" rx="32" ry="5.5" fill="#78350f" />
      <rect x="44" y="50" width="72" height="11" fill="#5b21b6" />
      <path d="M80 66l4.4 9 9.9 1.4-7.2 7 1.7 9.8L80 88.5l-8.8 4.7 1.7-9.8-7.2-7 9.9-1.4z" fill="#e11d48" />
    </svg>
  );
}

function Duck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={className} aria-hidden="true" focusable="false">
      <Shadow />
      <path d="M44 84c0-17 16-28 42-28 17 0 30 4 38-8 4 10 6 18 6 26 0 18-20 30-44 30-24 0-42-6-42-20z" fill="#ffc83d" />
      <path d="M50 92c8 9 24 12 40 12 20 0 36-8 40-20-6 12-22 18-40 18-16 0-30-3-40-10z" fill="#f5b21f" />
      <circle cx="58" cy="52" r="23" fill="#ffc83d" />
      <path d="M36 54c-9 0-14 3-14 6 0 4 6 6 15 5 6-.6 9-3 9-6z" fill="#f97316" />
      <path d="M24 61c4 2 10 2.4 14 1.6" stroke="#c2410c" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="56" cy="46" r="4.5" fill="#2a0f5c" />
      <circle cx="54.6" cy="44.4" r="1.5" fill="#fff" />
      <ellipse cx="66" cy="58" rx="5" ry="3" fill="#e11d48" opacity=".3" />
      <path d="M80 72c10-6 26-6 34 2-8 8-24 10-34-2z" fill="#f5b21f" />
    </svg>
  );
}

function LeftShoe({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" className={className} aria-hidden="true" focusable="false">
      <Shadow />
      {/* upper (toe points left: a left shoe, seen from its outer side) */}
      <path d="M16 90c0-15 14-22 34-25l26-19c8-6 20-7 30-3l22 6c12 3 18 12 18 24v17z" fill="#e11d48" />
      <path d="M16 90c0-13 10-20 28-23l8 23z" fill="#fff" opacity=".92" />
      <g stroke="#fff" strokeWidth="4" strokeLinecap="round">
        <path d="M66 56l10 10" />
        <path d="M76 49l10 10" />
        <path d="M87 45l9 10" />
      </g>
      <path d="M92 80c12-10 26-12 40-8" stroke="#ffc83d" strokeWidth="6" strokeLinecap="round" fill="none" />
      {/* heel tab with an "L" */}
      <rect x="132" y="50" width="16" height="24" rx="5" fill="#ffc83d" />
      <path d="M137 55v11h7" stroke="#2a0f5c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* sole */}
      <path d="M12 90h138v6c0 5-4 8-9 8H22c-6 0-10-4-10-9z" fill="#fff" />
      <path d="M14 99h134" stroke="#2a0f5c" strokeWidth="4" opacity=".85" />
    </svg>
  );
}

export type SnapItem = {
  key: string;
  /** what the host shouts: "Bring me… {prompt}!" */
  prompt: string;
  /** polaroid caption */
  caption: string;
  Art: Art;
};

/** The rotation, in order. Each re-entry into the section (after scrolling back above it) calls the next one. */
export const SNAP_ITEMS: SnapItem[] = [
  { key: "stapler", prompt: "a red stapler", caption: "Red stapler", Art: Stapler },
  { key: "mug", prompt: "a coffee mug", caption: "Coffee mug", Art: Mug },
  { key: "yellow", prompt: "something yellow", caption: "Something yellow", Art: Duck },
  { key: "shoe", prompt: "a left shoe", caption: "A left shoe", Art: LeftShoe },
];
