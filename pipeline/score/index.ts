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
