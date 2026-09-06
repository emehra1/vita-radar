/**
 * Explainable weighted-sum scoring.
 *
 * Carried over from the sibling project, and the discipline is the point: every
 * term is retained as a `ScoreFactor` with its raw value, its weight, and the
 * signed points it contributed, so the email and the site can always answer "why
 * is this ranked here?".
 *
 * That audit trail is also what makes it safe to add a model to this project at
 * all. Claude touches deadline LOCATION, the daily opener, and near-dup
 * judgement — and none of those may ever produce a ScoreFactor. CI asserts that
 * no factor key starts with `llm` or `claude`, which is the machine-checkable
 * statement of the whole hybrid design.
 */

import { createHash } from "node:crypto";

import type { Lane, OpportunityFacts, ScoreBreakdown, ScoreFactor } from "../../lib/types.ts";
import type { OpportunityEvent } from "../../lib/types.ts";
import type { UrgencyResult } from "./temporal.ts";
import weightsJson from "../config/weights.json" with { type: "json" };

export interface Weights {
  version: string;
  weights: Record<string, number>;
  penalties: Record<string, number>;
  recencyHalfLifeHours: Partial<Record<Lane, number>>;
  maxAgeDays: Partial<Record<Lane, number>>;
  maxAgeDaysAcademic: number;
  urgency: {
    horizonDays: Partial<Record<Lane, number>>;
    leadDays: Partial<Record<Lane, number>>;
    steepness: number;
    graceDays: number;
    projectedConfidence: number;
    rollingFloor: number;
    unknownFloor: number;
    monthPrecisionConfidence: number;
  };
  rungs: number[];
  rungFloorDays: number;
  rollingRedeliveryDays: number;
  countdownStripDays: number;
  subjectEscalationDays: number;
  verifyEveryDaysDefault: number;
  lexiconSaturationK: number;
  keepThreshold: number;
  maxItemsPerDay: number;
  maxItemsPerLane: number;
  maxItemsPerPublisher: number;
  eventBoosts: Record<string, number>;
}

export const WEIGHTS = weightsJson as unknown as Weights;

/**
 * Hash of the weights, stamped onto every scored item.
 *
 * Golden tests pin it, so editing a weight fails loudly instead of silently
 * re-ranking a year of committed archive with no record of why.
 */
export const WEIGHTS_VERSION: string = createHash("sha256")
  .update(JSON.stringify(weightsJson))
  .digest("hex")
  .slice(0, 12);

export interface OpportunityScoreInput {
  facts: OpportunityFacts;
  lane: Lane;
  urgency: UrgencyResult;
  events: OpportunityEvent[];
  daysUntil?: number;
  gating: boolean;
}

function factor(
  key: string,
  label: string,
  raw: number,
  weight: number,
  evidence?: string[],
): ScoreFactor {
  return { key, label, raw, weight, contribution: raw * weight, evidence };
}

export function scoreOpportunity(input: OpportunityScoreInput, w: Weights): ScoreBreakdown {
  const factors: ScoreFactor[] = [];
  const penalties: ScoreFactor[] = [];

  // ── deadline urgency: the largest weight in the file ────────────────────
  // 30 points, above `lexicon` at 22. That ordering is this project's thesis
  // expressed as a number: what matters is not how interesting an item is but
  // how soon it stops being actionable.
  factors.push(
    factor(
      "deadlineUrgency",
      "Deadline urgency",
      input.urgency.raw,
      w.weights.deadlineUrgency ?? 0,
      input.urgency.evidence,
    ),
  );

  // ── gating ─────────────────────────────────────────────────────────────
  // A step that ends the application if missed outranks one that merely costs
  // convenience. This is what lifts the Harvard endorsement above the national
  // deadline it precedes.
  if (input.gating) {
    factors.push(factor("gating", "Gating step", 1, w.weights.gating ?? 0, ["missing this ends the application"]));
  }

  // ── events ─────────────────────────────────────────────────────────────
  // Highest single boost wins rather than summing, so an item cannot climb by
  // accumulating weak signals.
  const boosts = input.events
    .map((e) => ({ e, v: w.eventBoosts[e] ?? 0 }))
    .sort((a, b) => b.v - a.v);
  const top = boosts[0];
  if (top && top.v > 0) {
    factors.push(factor(`event.${top.e}`, `Event: ${top.e}`, top.v, w.weights.event ?? 0, input.events));
  }

  // ── priority as fit ────────────────────────────────────────────────────
  // `priority: high` in the YAML is a hand-authored statement that this program
  // is on the critical path. Treating it as a scoring term rather than a hard
  // override keeps it comparable with everything else.
  if (input.facts.priority === "high") {
    factors.push(factor("fit", "High priority", 1, w.weights.fit ?? 0, ["priority: high"]));
  }

  // ── penalties ──────────────────────────────────────────────────────────
  for (const key of input.urgency.penalties) {
    penalties.push(factor(key, key, 1, -(w.penalties[key] ?? 0)));
  }

  // A ruled-out program should never reach here — buildOpportunities drops it —
  // but if one ever does, sink it hard. An NSF-GRFP-shaped item with a perfect
  // imminent deadline is worse than noise: it is a distraction WITH a deadline.
  if (input.facts.ruledOut) {
    penalties.push(
      factor("eligibilityMismatch", "Ineligible", 1, -(w.penalties.eligibilityMismatch ?? 0), [
        input.facts.ruledOut.reason,
      ]),
    );
  }

  const total =
    factors.reduce((sum, f) => sum + f.contribution, 0) +
    penalties.reduce((sum, f) => sum + f.contribution, 0);

  return {
    total: Math.round(Math.max(0, total) * 100) / 100,
    factors,
    penalties,
    laneScores: { [input.lane]: 1 },
    weightsVersion: WEIGHTS_VERSION,
  };
}

/* ------------------------------- news scoring ------------------------------ */

import type { NewsEvent, NewsItem } from "../../lib/types.ts";
import { ACRONYMS, LEXICONS, MIN_TERM_LENGTH, VETO_PATTERNS } from "../config/lanes.ts";
import type { NormalizedItem } from "../ingest/types.ts";

/** Body characters scored, so a long paper cannot out-score a short one by length. */
const BODY_WINDOW = 1200;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TERM_RE_CACHE = new Map<string, RegExp>();
function termRe(term: string, caseSensitive: boolean): RegExp {
  const key = `${caseSensitive ? "s" : "i"}:${term}`;
  let re = TERM_RE_CACHE.get(key);
  if (!re) {
    // \b does not work against a token ending in a non-word char (CUT&RUN), so
    // the boundaries are asserted explicitly.
    re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, caseSensitive ? "g" : "gi");
    TERM_RE_CACHE.set(key, re);
  }
  return re;
}

function countMatches(haystack: string, term: string, caseSensitive: boolean): number {
  const re = termRe(term, caseSensitive);
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(haystack) !== null) n++;
  return n;
}

export interface LaneScore {
  lane: Lane;
  raw: number;
  hits: string[];
}

/**
 * Score one lane's lexicon against a title and body.
 *
 * Saturating: `x/(x+K)`. Without it a single review article listing forty terms
 * outranks the day's most relevant primary paper, which is the failure the
 * sibling documented as "a honeybee mitophagy paper outranks the biggest merger".
 */
export function scoreLane(lane: Lane, title: string, body: string, w: Weights): LaneScore {
  const terms = LEXICONS[lane] ?? [];
  const window = body.slice(0, BODY_WINDOW);
  let total = 0;
  const hits: string[] = [];

  for (const { term, weight } of terms) {
    if (term.length < MIN_TERM_LENGTH) continue;
    const inTitle = countMatches(title, term, false);
    const inBody = countMatches(window, term, false);
    const count = inTitle + inBody;
    if (count === 0) continue;
    // 1 + ln(count) so repetition helps a little and dominates never.
    const repeat = 1 + Math.log(count);
    // A title hit is what the piece is ABOUT; a body hit is a mention.
    total += weight * repeat * (inTitle > 0 ? 2 : 1);
    hits.push(term);
  }

  for (const { term, weight } of ACRONYMS) {
    if (!LEXICONS[lane]?.length && lane !== "causal-genetics") break;
    const inTitle = countMatches(title, term, true);
    const inBody = countMatches(window, term, true);
    const count = inTitle + inBody;
    if (count === 0) continue;
    total += weight * (1 + Math.log(count)) * (inTitle > 0 ? 2 : 1);
    hits.push(term);
  }

  const k = w.lexiconSaturationK;
  return { lane, raw: total / (total + k), hits };
}

/** True when the item should never appear, whatever it scores. */
export function isVetoed(title: string): string | undefined {
  for (const pattern of VETO_PATTERNS) {
    if (pattern.test(title)) return `vetoed by ${pattern}`;
  }
  return undefined;
}

export interface NewsScoreInput {
  item: NormalizedItem;
  lane: Lane;
  laneScores: Partial<Record<Lane, number>>;
  lexicon: LaneScore;
  events: NewsEvent[];
  ageHours: number;
  /** Distinct publisher groups carrying the same story. */
  publisherCount: number;
}

export function scoreNews(input: NewsScoreInput, w: Weights): ScoreBreakdown {
  const factors: ScoreFactor[] = [];
  const penalties: ScoreFactor[] = [];

  factors.push(
    factor("lexicon", "Topic match", input.lexicon.raw, w.weights.lexicon ?? 0, input.lexicon.hits.slice(0, 8)),
  );

  // Exponential decay with a per-lane half-life. Right for news, and the exact
  // inverse of what pipeline/score/temporal.ts does for an opportunity.
  const halfLife = w.recencyHalfLifeHours[input.lane] ?? 96;
  const recency = Math.pow(2, -input.ageHours / halfLife);
  factors.push(factor("recency", "Recency", recency, w.weights.recency ?? 0, [`${Math.round(input.ageHours)}h old`]));

  factors.push(factor("authority", "Source authority", input.item.authority, w.weights.authority ?? 0));

  const boosts = input.events.map((e) => ({ e, v: w.eventBoosts[e] ?? 0 })).sort((a, b) => b.v - a.v);
  const top = boosts[0];
  if (top && top.v > 0) {
    factors.push(factor(`event.${top.e}`, `Event: ${top.e}`, top.v, w.weights.event ?? 0));
  }

  if (input.publisherCount > 1) {
    // Corroboration counts NEWSROOMS, not URLs, so Fierce Biotech and Fierce
    // Pharma running the same wire story cannot fake independent confirmation.
    const raw = Math.min(1, (input.publisherCount - 1) / 2);
    factors.push(factor("corroboration", "Corroboration", raw, w.weights.corroboration ?? 0,
      [`${input.publisherCount} publisher groups`]));
  }

  if (input.item.bodyText.length < 200) {
    penalties.push(factor("thinContent", "Thin content", 1, -(w.penalties.thinContent ?? 0)));
  }
  if (!input.item.publishedAt) {
    penalties.push(factor("dateMissing", "No date", 1, -(w.penalties.dateMissing ?? 0)));
  }
  // Authority alone must never carry an item over the threshold.
  if (input.lexicon.raw < 0.05) {
    penalties.push(factor("offTopic", "Off topic", 1, -(w.penalties.offTopic ?? 0), ["no lexicon hits"]));
  }

  const total =
    factors.reduce((s, f) => s + f.contribution, 0) + penalties.reduce((s, f) => s + f.contribution, 0);

  return {
    total: Math.round(Math.max(0, total) * 100) / 100,
    factors,
    penalties,
    laneScores: input.laneScores,
    weightsVersion: WEIGHTS_VERSION,
  };
}

export type { NewsItem };
