/** Starter items for Bring Me rounds: short, safe to find at a party or at home. */
export const ITEM_IDEAS = [
  "Something red", "A shoe", "Something that glows", "Your funniest hat", "A pair of socks", "Something round",
  "A phone charger", "Something older than you", "A book", "Something that smells nice", "A spoon",
  "A coin from another country", "Something fuzzy", "A pen that works", "Something blue", "A keychain",
  "Your favourite mug", "Something that makes noise", "A photo of someone you love", "Something shiny",
  "A piece of fruit", "Sunglasses", "Something striped", "A toy", "A remote control", "Something heart-shaped",
  "A scarf", "A water bottle", "A playing card", "Something that starts with the letter B",
];

const norm = (s: string) => s.trim().toLowerCase();

/** A few ideas no round uses yet, rotated by seed so each round shows different ones. */
export function itemSuggestions(items: string[], count = 3, seed = 0): string[] {
  const used = new Set(items.map(norm).filter(Boolean));
  const pool = ITEM_IDEAS.filter((i) => !used.has(norm(i)));
  if (!pool.length) return [];
  const start = seed % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)].slice(0, count);
}

/** Fills only empty rounds, with ideas not already used. */
export function fillItemsWithIdeas(items: string[]): string[] {
  const pool = itemSuggestions(items, ITEM_IDEAS.length);
  let k = 0;
  return items.map((t) => (t.trim() ? t : (pool[k++] ?? "")));
}
