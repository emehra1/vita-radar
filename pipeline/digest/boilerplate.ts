/**
 * Strip the text a source repeats across all of its own items.
 *
 * The motivating case, found on the first live run: every NewLimit job posting —
 * including the one for an Executive Assistant — opens with
 *
 *   "NewLimit is a biotechnology company working to radically extend human
 *    healthspan. We're developing medicines to treat aging by reprogramming the
 *    epigenome... We leverage functional genomics, pooled perturbation
 *    screening, and machine learning..."
 *
 * which contains five of the highest-weighted terms in the causal-genetics
 * lexicon. Scored naively, an administrative role at a reprogramming company
 * outranks primary literature about reprogramming.
 *
 * No keyword list can fix this, because the words are exactly the right words —
 * they are simply the COMPANY's words, not the ITEM's. The general property is
 * that a phrase appearing in most items from one source distinguishes none of
 * them, so it should not contribute to any of their scores.
 *
 * This is self-maintaining in a way a hand-written blocklist is not: when a
 * company rewrites its blurb, the new blurb is detected on the next run.
 */

/** Below this, "appears in most items" is not a meaningful statement. */
const MIN_ITEMS = 4;
/** Appearing in at least this fraction of a source's items makes it boilerplate. */
const REPEAT_FRACTION = 0.5;
/** Short fragments repeat innocently ("Apply now", "Full time"). */
const MIN_SENTENCE_CHARS = 40;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_CHARS);
}

/** Normalised key, so trivial whitespace or case differences still match. */
function key(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Find the sentences a group of items share.
 *
 * `items` should be everything from ONE source — the whole point is comparing
 * an item against its own siblings.
 */
export function findBoilerplate(bodies: string[]): Set<string> {
  if (bodies.length < MIN_ITEMS) return new Set();

  const counts = new Map<string, number>();
  for (const body of bodies) {
    // A sentence repeated inside one item still counts once for that item.
    for (const k of new Set(sentences(body).map(key))) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const threshold = Math.max(2, Math.ceil(bodies.length * REPEAT_FRACTION));
  const boiler = new Set<string>();
  for (const [k, n] of counts) if (n >= threshold) boiler.add(k);
  return boiler;
}

/** Remove known-boilerplate sentences from one body. */
export function stripBoilerplate(body: string, boiler: Set<string>): string {
  if (boiler.size === 0) return body;
  return sentences(body)
    .filter((s) => !boiler.has(key(s)))
    .join(" ")
    .trim();
}

/**
 * Group by source, learn each source's boilerplate, strip it.
 *
 * Returns bodies in the same order as the input. An item left with almost
 * nothing after stripping was almost entirely boilerplate, which is itself the
 * correct signal: it had nothing specific to say.
 */
export function stripSourceBoilerplate<T extends { sourceId: string; bodyText: string }>(
  items: T[],
): { stripped: string[]; removedBySource: Record<string, number> } {
  const bySource = new Map<string, T[]>();
  for (const item of items) {
    const list = bySource.get(item.sourceId) ?? [];
    list.push(item);
    bySource.set(item.sourceId, list);
  }

  const boilerBySource = new Map<string, Set<string>>();
  const removedBySource: Record<string, number> = {};
  for (const [sourceId, group] of bySource) {
    const boiler = findBoilerplate(group.map((i) => i.bodyText));
    boilerBySource.set(sourceId, boiler);
    if (boiler.size > 0) removedBySource[sourceId] = boiler.size;
  }

  return {
    stripped: items.map((i) => stripBoilerplate(i.bodyText, boilerBySource.get(i.sourceId) ?? new Set())),
    removedBySource,
  };
}
