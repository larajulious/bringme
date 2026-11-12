import { cn } from "@/lib/utils";

const STARS = [
  { left: "12%", top: "14%", size: 14, delay: "0s" },
  { left: "86%", top: "22%", size: 10, delay: "1.2s" },
  { left: "74%", top: "64%", size: 12, delay: "2.1s" },
  { left: "8%", top: "72%", size: 9, delay: "0.7s" },
];

/**
 * One calm background for every dark-purple screen: two soft colour glows, a
 * faint dot grid and four twinkling sparkles. Gradients are static and only the
 * sparkles animate (opacity/transform), so it costs almost nothing per frame.
 */
export function Backdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      <div className="absolute -left-32 -top-32 size-[30rem] [background:radial-gradient(closest-side,hsl(266_85%_58%/0.45),transparent)]" />
      <div className="absolute -bottom-40 -right-24 size-[28rem] [background:radial-gradient(closest-side,hsl(349_82%_55%/0.22),transparent)]" />
      <div className="absolute inset-0 opacity-[0.07] [background-image:radial-gradient(#fff_1px,transparent_1.5px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,#000,transparent_75%)]" />
      {STARS.map((s, i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          className="absolute animate-twinkle fill-white motion-reduce:animate-none"
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }}
        >
          <path d="M12 0l3 9 9 3-9 3-3 9-3-9-9-3 9-3z" />
        </svg>
      ))}
    </div>
  );
}
