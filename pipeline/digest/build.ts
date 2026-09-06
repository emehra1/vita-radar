/**
 * Turn collected NormalizedItems into scored NewsItems.
 *
 * Deliberately thin. The sibling project carries entity extraction, clustering
 * and extractive summarisation because it is a news reader and that is its whole
 * job. Here news is the SUPPORTING act — the deadline tracker is the product —
 * so this does the minimum that makes a news lane trustworthy: veto, score,
 * dedupe by canonical URL, group by publisher for corroboration, and cap.
 */

import type { DropReason, Lane, NewsEvent, NewsItem } from "../../lib/types.ts";
import { LANES } from "../../lib/types.ts";
import type { NormalizedItem } from "../ingest/types.ts";
import { itemId } from "../normalize/ids.ts";
import { isVetoed, scoreLane, scoreNews, WEIGHTS, type Weights } from "../score/index.ts";
import { LEXICONS } from "../config/lanes.ts";
import { stripSourceBoilerplate } from "./boilerplate.ts";

/** Terms weighted >= 3 in the lexicons — present only when a posting really is about this work. */
const HIGH_SIGNAL = new Set(
  Object.values(LEXICONS).flat().filter((t) => t.weight >= 3).map((t) => t.term.toLowerCase()),
);

export interface NewsBuildResult {
  items: NewsItem[];
  dropped: Partial<Record<DropReason, number>>;
}

/**
 * Text a job posting should be SCORED on.
 *
 * Not the whole body. Company boilerplate is the problem: every NewLimit and
 * Altos posting carries an "about us" paragraph containing "reprogramming",
 * "healthspan" and "aging", so on the first live run "Scientist, LNP-Lipid
 * Chemistry" scored as causal-genetics research at 24 points. The boilerplate is
 * identical across every posting from that employer, which means it distinguishes
 * nothing — it is the company's marketing, not the job's content.
 *
 * The title plus the opening of the description is where the actual role lives.
 */
function scorableText(item: NormalizedItem, stripped: string): string {
  // The stripped body is what the item itself says, with its source's shared
  // marketing removed. Fall back to a truncated raw body when stripping left
  // nothing, so a genuinely short item is not silently zeroed.
  const text = stripped.length >= 80 ? stripped : item.bodyText.slice(0, 700);
  return item.sourceKind === "jobs" ? text.slice(0, 1200) : text;
}

function classify(item: NormalizedItem, stripped: string, w: Weights) {
  const laneScores: Partial<Record<Lane, number>> = {};
  const text = scorableText(item, stripped);
  let best = scoreLane("causal-genetics", item.title, text, w);

  /**
   * A job is an OPPORTUNITY, not a finding.
   *
   * Even with boilerplate trimmed, a genuinely genomics-heavy posting will
   * out-match the causal-genetics lexicon and land beside primary literature,
   * where it reads as a paper until you click it. Pinning the lane keeps the
   * reader's mental model intact: causal-genetics is what the field published,
   * venture-founder is what you could go and do.
   */
  if (item.sourceKind === "jobs") {
    const score = scoreLane("venture-founder", item.title, text, w);
    const genetics = scoreLane("causal-genetics", item.title, text, w);
    laneScores["venture-founder"] = Math.max(score.raw, genetics.raw * 0.8);
    return {
      lane: "venture-founder" as Lane,
      laneScores,
      best: { ...score, raw: Math.max(score.raw, genetics.raw * 0.8), hits: [...new Set([...score.hits, ...genetics.hits])] },
    };
  }

  for (const lane of LANES) {
    const score = scoreLane(lane, item.title, text, w);
    if (score.raw > 0) laneScores[lane] = score.raw;
    // A source's laneHints act as a prior, never a filter: a Nature Aging paper
    // about instruments still lands in tools-platforms if that is what it is about.
    const adjusted = score.raw + (item.laneHints[lane] ?? 0) * 0.15;
    const bestAdjusted = best.raw + (item.laneHints[best.lane] ?? 0) * 0.15;
    if (adjusted > bestAdjusted) best = score;
  }
  return { lane: best.lane, laneScores, best };
}

function detectEvents(item: NormalizedItem): NewsEvent[] {
  const text = `${item.title} ${item.bodyText.slice(0, 600)}`;
  const events: NewsEvent[] = [];
  if (item.sourceKind === "journal") events.push("major-journal-primary");
  if (item.sourceKind === "preprint") events.push("preprint");
  if (item.sourceKind === "jobs") events.push("personnel");
  if (/\bseries [a-d]\b|\braises?\s+\$|\bfinancing\b|\bseed round\b/i.test(text)) events.push("financing");
  if (/\bacquires?\b|\bacquisition\b|\bmerger\b|\bto buy\b/i.test(text)) events.push("ma");
  if (/\bapprovals?\b|\bapproved\b|\bFDA clears?\b/i.test(text)) events.push("approval");
  if (/\breadout\b|\btopline\b|\bmet the primary\b|\bmissed the primary\b/i.test(text)) events.push("readout");
  return events;
}

/** First N sentences, in document order, verbatim. Never generated. */
function firstSentences(text: string, n: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < n) {
    const s = m[0].trim();
    if (s.length >= 40) out.push(s);
  }
  if (out.length === 0 && text.trim()) out.push(text.trim().slice(0, 240));
  return out;
}

export function buildNews(
  raw: NormalizedItem[],
  now: Date,
  today: string,
  firstSeen: (id: string) => string,
  w: Weights = WEIGHTS,
): NewsBuildResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => { dropped[r] = (dropped[r] ?? 0) + 1; };

  // Identity is the canonical URL, never `${source}-${url}` — a syndicated story
  // must not look new because a second outlet carried it.
  const byId = new Map<string, NormalizedItem>();
  for (const item of raw) {
    if (!item.title) { drop("no-title"); continue; }
    if (!item.canonicalUrl) { drop("no-url"); continue; }
    if (isVetoed(item.title)) { drop("below-threshold"); continue; }

    const id = itemId(item.canonicalUrl);
    const existing = byId.get(id);
    if (existing) {
      drop("duplicate");
      if (item.authority > existing.authority || item.bodyText.length > existing.bodyText.length * 1.5) {
        byId.set(id, item);
      }
      continue;
    }
    byId.set(id, item);
  }

  // Corroboration counts distinct publisher GROUPS carrying a near-identical
  // headline, so one newsroom's two mastheads count once.
  const titleKey = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  const groupsByTitle = new Map<string, Set<string>>();
  for (const item of byId.values()) {
    const key = titleKey(item.title);
    const set = groupsByTitle.get(key) ?? new Set<string>();
    set.add(item.publisherGroup);
    groupsByTitle.set(key, set);
  }

  // Learn each source's boilerplate from its own items before scoring any of them.
  const surviving = [...byId.entries()];
  const { stripped, removedBySource } = stripSourceBoilerplate(surviving.map(([, i]) => i));
  for (const [sourceId, n] of Object.entries(removedBySource)) {
    console.log(`  boilerplate: stripped ${n} shared sentence(s) from ${sourceId}`);
  }

  const items: NewsItem[] = [];
  surviving.forEach(([id, item], index) => {
    const { lane, laneScores, best } = classify(item, stripped[index] ?? "", w);
    const ageHours = item.publishedAt
      ? Math.max(0, (now.getTime() - item.publishedAt.getTime()) / 3_600_000)
      : 24 * 30;

    const maxAge = w.maxAgeDays[lane] ?? 14;
    if (item.publishedAt && ageHours / 24 > maxAge) { drop("too-old"); return; }

    const events = detectEvents(item);
    const publisherCount = groupsByTitle.get(titleKey(item.title))?.size ?? 1;
    const breakdown = scoreNews({ item, lane, laneScores, lexicon: best, events, ageHours, publisherCount }, w);

    if (breakdown.total < w.keepThreshold) { drop("below-threshold"); return; }

    /**
     * A job needs a SPECIFIC hit, not an accumulation of vague ones.
     *
     * Requiring either a lexicon term in the title or one high-weight term
     * (>= 3, the terms that only appear when a posting genuinely concerns this
     * work: "Mendelian randomization", "target discovery", "epigenetic
     * editing", "perturbation screen") is what separates a role worth reading
     * from the twentieth LNP chemistry posting at the same company.
     */
    if (item.sourceKind === "jobs") {
      const titleHit = best.hits.some((h) => new RegExp(`(?<![A-Za-z0-9])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(item.title));
      const specific = best.hits.some((h) => HIGH_SIGNAL.has(h.toLowerCase()));
      if (!titleHit && !specific) { drop("below-threshold"); return; }
    }

    const seenAt = firstSeen(id);
    items.push({
      kind: "news",
      id,
      clusterId: id,
      title: item.title,
      url: item.url,
      canonicalUrl: item.canonicalUrl,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      publisherGroup: item.publisherGroup,
      sourceKind: item.sourceKind,
      publishedAt: item.publishedAt?.toISOString(),
      datePrecision: item.datePrecision,
      firstSeenAt: seenAt,
      isNew: seenAt === today,
      bodyProvenance: item.bodyProvenance,
      digest: firstSentences(item.bodyText, 2),
      digestSource: item.bodyProvenance === "api" ? "abstract" : "dek",
      eventTypes: events,
      paywalled: item.paywalled,
      lanes: laneScores,
      primaryLane: lane,
      score: breakdown.total,
      scoreBreakdown: breakdown,
      watchHits: [],
    });
  });

  items.sort((a, b) => b.score - a.score);
  return { items, dropped };
}
