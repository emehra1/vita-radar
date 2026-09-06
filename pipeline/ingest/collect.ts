/**
 * Fetch every source, in isolation, and report honestly on each.
 *
 * Two properties matter more than throughput:
 *
 *  1. ONE DEAD SOURCE CANNOT FAIL THE RUN. Promise.allSettled, then a rejection
 *     degrades into a health record rather than an exception. A digest missing
 *     one feed is worth sending; no digest is not.
 *
 *  2. `ok` REQUIRES ITEMS. A source that returns 200 and a well-formed empty
 *     list is broken, and it is the failure mode that survives longest because
 *     everything about it looks healthy. Gates Cambridge's default /feed/ is
 *     valid RSS with zero items; an unknown Ashby token returns {"jobs":[]};
 *     SmartRecruiters answers totalFound:0 for every board on earth including
 *     names that do not exist. All three would report "no new jobs" forever.
 */

import type { Lane, SourceHealth } from "../../lib/types.ts";
import { enabledSources, PAGE_WATCHES, type PageWatch, type SourceDef } from "../config/sources.ts";
import { HttpCache } from "../net/cache.ts";
import { createHttpClient, FEED_ACCEPT, type HttpClient } from "../net/http.ts";
import type { BodyShape } from "../net/shape.ts";
import { comparePage, type PageChange, type PageHashState } from "../watch/pagehash.ts";
import { assertAtsIdentity, parseAts } from "./ats.ts";
import { parseFeed } from "./feed.ts";
import type { IngestResult, NormalizedItem } from "./types.ts";

export interface CollectOptions {
  now: Date;
  today: string;
  previousHealth: Record<string, { lastSuccessAt?: string; consecutiveFailures: number }>;
  /** sourceId -> median items kept over recent runs. Detects silent collapse. */
  trailingMedian: Record<string, number>;
  pageHashes: PageHashState;
  fromCache?: boolean;
  only?: string[];
}

export interface CollectResult {
  items: NormalizedItem[];
  health: SourceHealth[];
  pageChanges: PageChange[];
  pageHashes: PageHashState;
}

function expectedShape(source: SourceDef): BodyShape {
  switch (source.dialect) {
    case "json":
    case "ats": return "json";
    case "html": return "html";
    case "csv": return "csv";
    case "ics": return "ics";
    default: return "xml";
  }
}

/**
 * Health, with the two states that matter distinguished.
 *
 * `degraded` rather than `ok` when a source parsed nothing, kept nothing, or
 * collapsed against its own recent history. That last check is the only one that
 * catches a feed which has quietly turned into ten sponsored whitepapers a day:
 * the count still looks healthy in absolute terms.
 */
function assessStatus(
  parsed: number,
  kept: number,
  sourceId: string,
  trailingMedian: Record<string, number>,
  filteredByRule = 0,
): SourceHealth["status"] {
  if (parsed === 0) return "degraded";
  // Everything it served was on-spec and OUR filter rejected it. That is the
  // filter working, not the source failing — three fellowship feeds legitimately
  // publish nothing about a cycle for months at a time.
  if (kept === 0 && filteredByRule >= parsed) return "ok";
  if (kept === 0) return "degraded";
  const median = trailingMedian[sourceId];
  if (median !== undefined && median >= 5 && kept < median * 0.3) return "degraded";
  return "ok";
}

async function collectOne(
  source: SourceDef,
  client: HttpClient,
  opts: CollectOptions,
): Promise<{ items: NormalizedItem[]; health: SourceHealth }> {
  const started = Date.now();
  const prior = opts.previousHealth[source.id] ?? { consecutiveFailures: 0 };

  const fail = (error: string, httpStatus?: number): { items: NormalizedItem[]; health: SourceHealth } => ({
    items: [],
    health: {
      sourceId: source.id, sourceName: source.name, status: "failed", httpStatus, error,
      itemsParsed: 0, itemsKept: 0, parseWarnings: [], latencyMs: Date.now() - started,
      lastSuccessAt: prior.lastSuccessAt, consecutiveFailures: prior.consecutiveFailures + 1,
      optional: source.optional,
    },
  });

  const res = await client(source.endpoint, {
    accept: source.dialect === "ats" || source.dialect === "json" ? "application/json, */*;q=0.8" : FEED_ACCEPT,
    crawlDelayMs: source.crawlDelayMs,
    retries: source.retries,
    expect: expectedShape(source),
    cacheKey: source.id,
    fromCache: opts.fromCache,
  });

  if (res.error) return fail(res.error, res.status);

  if (res.notModified) {
    return {
      items: [],
      health: {
        sourceId: source.id, sourceName: source.name, status: "not-modified", httpStatus: 304,
        itemsParsed: 0, itemsKept: 0, parseWarnings: [], latencyMs: Date.now() - started,
        lastSuccessAt: opts.today, consecutiveFailures: 0, optional: source.optional,
      },
    };
  }

  if (!res.body) return fail("empty body", res.status);

  let result: IngestResult;
  try {
    result = source.dialect === "ats"
      ? parseAts(res.body, source, opts.now)
      : await parseFeed(res.body, source, opts.now);
  } catch (err) {
    return fail(`parse failed: ${(err as Error).message}`, res.status);
  }

  const warnings = [...result.warnings];
  const identity = assertAtsIdentity(source, result.items);
  if (identity) warnings.push(identity);

  const status = assessStatus(result.parsed, result.items.length, source.id, opts.trailingMedian, result.filteredByRule ?? 0);

  return {
    items: result.items,
    health: {
      sourceId: source.id, sourceName: source.name, status, httpStatus: res.status,
      itemsParsed: result.parsed, itemsKept: result.items.length, parseWarnings: warnings.slice(0, 5),
      latencyMs: Date.now() - started,
      lastSuccessAt: status === "ok" ? opts.today : prior.lastSuccessAt,
      consecutiveFailures: status === "ok" ? 0 : prior.consecutiveFailures + 1,
      optional: source.optional,
      error: status === "degraded" ? (warnings[0] ?? "parsed nothing usable") : undefined,
      // Recorded even when healthy, so "0 kept" in the log is self-explaining.
      ...(result.filteredByRule ? { parseWarnings: [...warnings.slice(0, 4), `${result.filteredByRule} item(s) filtered by requireAny`] } : {}),
    },
  };
}

async function watchOne(
  watch: PageWatch,
  client: HttpClient,
  opts: CollectOptions,
): Promise<{ change?: PageChange; record?: import("../watch/pagehash.ts").PageHashRecord }> {
  const res = await client(watch.url, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    crawlDelayMs: watch.crawlDelayMs ?? 2000,
    // Deliberately NOT conditional. A 304 tells us the page is unchanged, which
    // is what we want to know — but it also means we never re-verify the hash
    // against real content, so a cache entry poisoned once stays authoritative.
    // These are twelve pages a day; the bandwidth is not worth the ambiguity.
    expect: "html",
    cacheKey: `watch:${watch.programId}`,
    fromCache: opts.fromCache,
  });

  const { record, change } = comparePage(
    watch,
    opts.today,
    opts.pageHashes[watch.programId],
    res.error || !res.body ? undefined : res.body,
    res.status,
    res.error,
  );
  return { change: change ?? undefined, record };
}

export async function collectSources(opts: CollectOptions): Promise<CollectResult> {
  const cache = new HttpCache(".cache/http-meta.json", ".cache/raw");
  await cache.load();
  const client = createHttpClient(cache);

  let sources = enabledSources();
  if (opts.only?.length) sources = sources.filter((s) => opts.only!.includes(s.id));

  const settled = await Promise.allSettled(sources.map((s) => collectOne(s, client, opts)));

  const items: NormalizedItem[] = [];
  const health: SourceHealth[] = [];
  settled.forEach((outcome, i) => {
    const source = sources[i]!;
    if (outcome.status === "fulfilled") {
      items.push(...outcome.value.items);
      health.push(outcome.value.health);
    } else {
      // An unexpected throw degrades to a health record. The whole point of
      // allSettled is that this line exists.
      const prior = opts.previousHealth[source.id] ?? { consecutiveFailures: 0 };
      health.push({
        sourceId: source.id, sourceName: source.name, status: "failed",
        error: String(outcome.reason).slice(0, 200), itemsParsed: 0, itemsKept: 0,
        parseWarnings: [], latencyMs: 0, lastSuccessAt: prior.lastSuccessAt,
        consecutiveFailures: prior.consecutiveFailures + 1, optional: source.optional,
      });
    }
  });

  // Page watches run after the feeds so a shared host is already warm and the
  // per-host gate has settled.
  const watched = await Promise.allSettled(PAGE_WATCHES.map((w) => watchOne(w, client, opts)));
  const pageChanges: PageChange[] = [];
  const pageHashes: PageHashState = { ...opts.pageHashes };
  watched.forEach((outcome, i) => {
    const watch = PAGE_WATCHES[i]!;
    if (outcome.status === "fulfilled") {
      if (outcome.value.change) pageChanges.push(outcome.value.change);
      if (outcome.value.record) pageHashes[watch.programId] = outcome.value.record;
    } else {
      pageChanges.push({
        programId: watch.programId, url: watch.url, kind: "failed",
        detail: String(outcome.reason).slice(0, 160),
      });
    }
  });

  await cache.flush();

  const ok = health.filter((h) => h.status === "ok" || h.status === "not-modified").length;
  console.log(`\nsources ${ok}/${health.length} ok · ${items.length} items · ${pageChanges.length} page changes`);
  for (const h of [...health].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const mark = h.status === "ok" ? "ok " : h.status === "not-modified" ? "304" : h.status === "degraded" ? "DEG" : "ERR";
    console.log(
      `  ${mark} ${h.sourceId.padEnd(26)} ${String(h.itemsKept).padStart(4)}/${String(h.itemsParsed).padEnd(4)} ` +
      `${String(h.latencyMs).padStart(6)}ms  ${(h.error ?? "").slice(0, 68)}`,
    );
  }

  return { items, health, pageChanges, pageHashes };
}

/** Lane hints from a source, used before any lexicon scoring exists. */
export function laneFromHints(hints: Partial<Record<Lane, number>>): Lane {
  let best: Lane = "causal-genetics";
  let bestScore = -1;
  for (const [lane, score] of Object.entries(hints) as [Lane, number][]) {
    if (score > bestScore) { best = lane; bestScore = score; }
  }
  return best;
}
