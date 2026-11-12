/** BringMe! trophy illustration (inline SVG, brand colours; shines gently unless motion is reduced). */
export function TrophyIllustration({ className = "", dim = false }: { className?: string; dim?: boolean }) {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Trophy" className={`${className} ${dim ? "opacity-40" : "animate-trophy-shine motion-reduce:animate-none"}`}>
      <ellipse cx="80" cy="150" rx="46" ry="6" fill="#000" opacity=".18" />
      {/* handles */}
      <path d="M34 40c-18 0-22 14-18 26s18 22 36 24" fill="none" stroke="#e8a317" strokeWidth="9" strokeLinecap="round" />
      <path d="M126 40c18 0 22 14 18 26s-18 22-36 24" fill="none" stroke="#e8a317" strokeWidth="9" strokeLinecap="round" />
      {/* cup */}
      <path d="M36 24h88v34c0 26-19 46-44 46S36 84 36 58z" fill="#ffc83d" />
      <path d="M36 24h88v10H36z" fill="#ffd96b" />
      <path d="M96 30c8 0 14 6 14 14v14c0 16-8 28-20 34 18-3 34-20 34-44V30z" fill="#e8a317" opacity=".55" />
      {/* star */}
      <path d="M80 40l6.6 13.4 14.8 2.1-10.7 10.4 2.5 14.7L80 73.6l-13.2 7 2.5-14.7-10.7-10.4 14.8-2.1z" fill="#fff" opacity=".92" />
      {/* stem + base */}
      <rect x="70" y="102" width="20" height="22" rx="3" fill="#e8a317" />
      <rect x="48" y="124" width="64" height="14" rx="5" fill="#5b21b6" />
      <rect x="56" y="138" width="48" height="8" rx="4" fill="#3b1480" />
    </svg>
  );
}
