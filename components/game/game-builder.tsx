"use client";

import { ArrowDown, ArrowUp, Minus, Plus, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { fillItemsWithIdeas, itemSuggestions } from "@/lib/host/ideas";
import { ITEM_MAX_LENGTH, TITLE_MAX_LENGTH } from "@/lib/host/validation";

type Item = { key: number; text: string };

const EXAMPLES = ["Something red", "A shoe", "Something that glows", "Your funniest hat", "A pair of socks", "Something round"];

const errorCopy: Record<string, string> = {
  subscription_required: "Purchase required: your Game Pass isn't active (expired or not bought yet). Choose a 7-Day Game Pass to create games.",
  game_limit_reached: "You've reached the number of games your Game Pass allows at once (drafts, Bring Me and BingoSnap games count together). Finish, cancel or discard one first.",
  period_game_limit_reached: "You've used all the games included in your current Game Pass.",
  round_limit_reached: "That's more rounds than your plan allows.",
  too_many_items: "That's more rounds than your plan allows.",
  unauthenticated: "Your session has ended. Please sign in again.",
};

/** Builds the round list client-side; the server re-validates everything. */
export function GameBuilder({ maxRounds, defaultRounds = 5 }: { maxRounds: number; defaultRounds?: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const nextKey = useRef(0);
  const blank = (): Item => ({ key: nextKey.current++, text: "" });

  const [title, setTitle] = useState("");
  const [items, setItems] = useState<Item[]>(() => Array.from({ length: Math.min(defaultRounds, maxRounds) }, blank));
  const [invalid, setInvalid] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});

  const setCount = (n: number) => {
    const count = Math.max(1, Math.min(maxRounds, n));
    setItems((cur) => (count >= cur.length ? [...cur, ...Array.from({ length: count - cur.length }, blank)] : cur.slice(0, count)));
  };
  const update = (key: number, text: string) => {
    setItems((cur) => cur.map((i) => (i.key === key ? { ...i, text } : i)));
    setInvalid((cur) => cur.filter((k) => k !== key));
  };
  const move = (index: number, dir: -1 | 1) =>
    setItems((cur) => {
      const j = index + dir;
      if (j < 0 || j >= cur.length) return cur;
      const copy = [...cur];
      [copy[index], copy[j]] = [copy[j], copy[index]];
      return copy;
    });
  const texts = items.map((i) => i.text);
  const fillEmpty = () => {
    const filled = fillItemsWithIdeas(texts);
    setItems((cur) => cur.map((i, n) => ({ ...i, text: filled[n] })));
    setInvalid([]);
    toast("Filled the empty rounds with ideas. Edit any of them.", "success");
  };
  const remove = (key: number) => setItems((cur) => (cur.length > 1 ? cur.filter((i) => i.key !== key) : cur));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const empty = items.filter((i) => i.text.trim() === "").map((i) => i.key);
    if (empty.length) {
      setInvalid(empty);
      setError(
        empty.length === 1
          ? `Round ${items.findIndex((i) => i.key === empty[0]) + 1} needs an item.`
          : `${empty.length} rounds still need an item.`,
      );
      inputs.current[empty[0]]?.focus();
      return;
    }
    setBusy(true);
    const res = await fetch("/api/host/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, items: items.map((i) => i.text) }),
    }).catch(() => null);
    if (res?.ok) {
      const { id } = (await res.json()) as { id: string };
      toast("Game created. Your lobby is open!", "success");
      router.push(`/dashboard/games/${id}`);
      return;
    }
    const code = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "network";
    setError(errorCopy[code ?? ""] ?? "We couldn't create the game. Please try again.");
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="grid gap-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Game details</CardTitle>
          <CardDescription>Give your game a name, or skip it and we&apos;ll call it &ldquo;Untitled game&rdquo;.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="g-title">Title (optional)</Label>
            <Input id="g-title" value={title} maxLength={TITLE_MAX_LENGTH} onChange={(e) => setTitle(e.target.value)} placeholder="Friday night showdown" />
          </div>
          <div className="grid gap-2">
            <Label id="rounds-label">Number of rounds</Label>
            <div role="group" aria-labelledby="rounds-label" className="flex items-center gap-2">
              <Button type="button" size="icon" variant="outline" onClick={() => setCount(items.length - 1)} disabled={items.length <= 1 || busy} aria-label="Fewer rounds">
                <Minus aria-hidden="true" />
              </Button>
              <output aria-live="polite" className="w-12 text-center font-display text-3xl font-bold text-primary">{items.length}</output>
              <Button type="button" size="icon" variant="outline" onClick={() => setCount(items.length + 1)} disabled={items.length >= maxRounds || busy} aria-label="More rounds">
                <Plus aria-hidden="true" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Up to {maxRounds} on your plan.</p>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="items-h">
        <h2 id="items-h" className="mb-1 text-xl font-bold text-primary">What should players bring?</h2>
        <p className="mb-4 text-muted-foreground">One item per round. Use the arrows to change the order.</p>
        <ol className="grid gap-3">
          {items.map((item, index) => {
            const bad = invalid.includes(item.key);
            return (
              <li key={item.key} className="flex items-start gap-2 rounded-3xl border bg-card p-3 shadow-card sm:gap-3 sm:p-4">
                <span aria-hidden="true" className="mt-1 grid size-10 shrink-0 place-items-center rounded-2xl bg-brand-yellow font-display text-lg font-bold text-brand-night">
                  {index + 1}
                </span>
                <div className="grid min-w-0 flex-1 gap-1">
                  <Label htmlFor={`item-${item.key}`} className="sr-only">Round {index + 1} item</Label>
                  <Input
                    id={`item-${item.key}`}
                    ref={(el) => { inputs.current[item.key] = el; }}
                    value={item.text}
                    maxLength={ITEM_MAX_LENGTH}
                    placeholder={`e.g. ${EXAMPLES[index % EXAMPLES.length]}`}
                    onChange={(e) => update(item.key, e.target.value)}
                    aria-invalid={bad}
                    aria-describedby={bad ? `item-err-${item.key}` : undefined}
                  />
                  {bad ? <p id={`item-err-${item.key}`} className="text-sm font-semibold text-destructive">Add an item for this round.</p> : null}
                  {!item.text.trim() ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">Try:</span>
                      {itemSuggestions(texts, 3, index * 7).map((idea) => (
                        <button key={idea} type="button" disabled={busy} onClick={() => update(item.key, idea)}
                          className="min-h-9 rounded-full bg-secondary px-3 text-left text-sm font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40">
                          {idea}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="icon" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0 || busy} aria-label={`Move round ${index + 1} up`}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => move(index, 1)} disabled={index === items.length - 1 || busy} aria-label={`Move round ${index + 1} down`}>
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => remove(item.key)} disabled={items.length <= 1 || busy} aria-label={`Delete round ${index + 1}`}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="outline" className="mt-4" onClick={() => setCount(items.length + 1)} disabled={items.length >= maxRounds || busy}>
          <Plus aria-hidden="true" /> Add another round
        </Button>
        <Button type="button" variant="ghost" className="mt-4 ml-2" onClick={fillEmpty} disabled={busy || items.every((i) => i.text.trim())}>
          <Sparkles aria-hidden="true" /> Fill empty rounds
        </Button>
      </section>

      {error ? (
        <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 font-semibold text-destructive">{error}</p>
      ) : null}
      <div>
        <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto">
          {busy ? "Creating your room…" : "Create game & open lobby"}
        </Button>
      </div>
    </form>
  );
}
