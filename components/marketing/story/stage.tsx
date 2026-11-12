import { cn } from "@/lib/utils";

export type StoryTone = "night" | "lavender" | "paper";

/**
 * One section's window onto the scroll story (see engine.ts): an empty, clipped layer behind the section's
 * content. The parent must be `relative isolate` (or another stacking context). Decorative: hidden from
 * assistive tech, never interactive, and invisible until the engine has drawn into it.
 */
export function StoryStage({ name, tone, className }: { name: "hero" | "how" | "audience" | "extra" | "pricing"; tone: StoryTone; className?: string }) {
  return (
    <div aria-hidden="true" data-story-stage={name} data-tone={tone} className={cn("story-stage", className)}>
      <div className="story-window" />
    </div>
  );
}
