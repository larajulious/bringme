/** Three bouncing dots: calm "something is happening" feedback (still when motion is reduced). */
export function WaitingDots({ className = "bg-white" }: { className?: string }) {
  return (
    <div className="flex gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={`size-3 animate-bounce rounded-full motion-reduce:animate-none ${className}`} style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </div>
  );
}
