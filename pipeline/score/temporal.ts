/**
 * The temporal model, and the one file to read if you read only one.
 *
 * The sibling project scores recency: `2^(-age/halfLife)`, so an item is worth
 * most the moment it appears and decays from there. That is right for news and
 * exactly backwards here. Rhodes is worthless in April and unmissable on
 * September 28th. So urgency is a function of days REMAINING, not days elapsed,
 * and `isStale` must never let a page's publication date retire an opportunity.
 */

import type {
  Deadline,
  DigestItem,
  DeadlinePrecision,
  Lane,
  OpportunityItem,
} from "../../lib/types.ts";

export interface UrgencyOpts {
  horizonDays: number;
  leadDays: number;
  steepness: number;
}

/**
 * Deadline urgency in [0, 1].
 *
 * Shape: ~0 beyond the horizon, EXACTLY 0.5 at `leadDays`, saturating toward 1
 * inside the final days, hard 0 once passed.
 *
 * `leadDays` is deliberately not "the deadline" but "the distance at which you
 * should already be working on it" — 35d for a fellowship that needs letters,
 * 21d for a conference abstract, 60d for MSTP because of secondaries. Anchoring
 * the half-way point there is what makes the score say "start now" rather than
 * "panic now".
 */
export function deadlineUrgency(daysUntil: number, o: UrgencyOpts): number {
  if (!Number.isFinite(daysUntil)) return 0;
  // Passed. Retirement is isStale()'s job, not the scorer's — a closed item
  // still needs one grace day of visible "closed yesterday".
  if (daysUntil < 0) return 0;
  if (daysUntil > o.horizonDays) return 0;
  if (daysUntil === 0) return 1;
  return 1 / (1 + Math.pow(daysUntil / o.leadDays, o.steepness));
}

export interface UrgencyResult {
  raw: number;
  /** Why the raw value is what it is, for the ScoreFactor audit trail. */
  evidence: string[];
  /** Penalty keys this deadline earns. */
  penalties: ("deadlineProjected" | "deadlineUnknown")[];
}

export interface TemporalConfig {
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
}

/**
 * Urgency for a resolved deadline, with the three non-dated cases handled
 * explicitly rather than falling through to zero.
 *
 * The reason each case is a named branch and not a default: a `rolling` program
 * and an `unknown` deadline look identical to a naive scorer (both have no date)
 * and mean opposite things. One needs no action ever; the other means there IS a
 * deadline and we do not know it, which is the single most actionable state in
 * the system. Collapsing them is how you silently stop looking.
 */
export function urgencyFor(
  deadline: Deadline,
  daysUntil: number | undefined,
  lane: Lane,
  cfg: TemporalConfig,
): UrgencyResult {
  const u = cfg.urgency;
  const horizonDays = u.horizonDays[lane] ?? 400;
  const leadDays = u.leadDays[lane] ?? 35;

  if (deadline.kind === "rolling") {
    // Flat, and deliberately low. "Nucleate applications are open" is identical
    // on day 1 and day 200, so scoring cannot fix the repetition — frequency
    // can, via the rollingRedeliveryDays cap in selection.
    return { raw: u.rollingFloor, evidence: ["rolling — no deadline"], penalties: [] };
  }

  if (deadline.kind === "unknown" || daysUntil === undefined) {
    // A floor, not zero and not high. Zero would bury a real opportunity
    // forever; high would assert urgency we cannot justify. The floor keeps it
    // visible and the penalty plus the Verify block make the gap the point.
    return {
      raw: u.unknownFloor,
      evidence: ["deadline unknown — needs a human"],
      penalties: ["deadlineUnknown"],
    };
  }

  const base = deadlineUrgency(daysUntil, { horizonDays, leadDays, steepness: u.steepness });
  const evidence = [`${daysUntil}d until ${deadline.date ?? "?"}`];
  const penalties: UrgencyResult["penalties"] = [];
  let raw = base;

  if (deadline.kind === "projected") {
    // Discounted so a projection can NEVER outrank a confirmed date at the same
    // distance. That ordering is the whole value of tracking `confirmed`.
    raw *= u.projectedConfidence;
    evidence.push(`projected (x${u.projectedConfidence})`);
    penalties.push("deadlineProjected");
  }

  if (deadline.precision === "month") {
    // A month-precision value is a real signal and a bad alarm. Discount it and
    // let the renderer print "(day unknown)". It may not ring the subject line —
    // see canAlert().
    raw *= u.monthPrecisionConfidence;
    evidence.push(`month precision (x${u.monthPrecisionConfidence})`);
  }

  return { raw, evidence, penalties };
}

/**
 * May this deadline drive an alert — the subject-line escalation and the
 * calendar alarm?
 *
 * Only a day-or-better precision date from the YAML. A month-precision value
 * cannot ring, because "September 2026" resolved to the 1st would fire an alarm
 * on a day nothing is due; and a date whose provenance is a scrape or a model
 * cannot ring at all, which is THE ONE RULE expressed as a function.
 */
export function canAlert(deadline: Deadline): boolean {
  if (deadline.kind !== "confirmed" && deadline.kind !== "projected") return false;
  if (deadline.precision !== "day" && deadline.precision !== "minute") return false;
  return deadline.provenance === "yaml";
}

/**
 * Should this item be dropped as stale?
 *
 * ⚠️ The branch on `kind` is the point. If this dispatched on an optional
 * `deadline` field instead, the first opportunity whose date failed to resolve
 * would fall through to the news path and be dropped for being eight months
 * old — producing a plausible digest with Rhodes silently missing from it.
 *
 * The named regression, which lives in tests/temporal.test.ts: a page published
 * 2025-12-01 with a deadline of 2026-10-01, scored on 2026-09-24, must be KEPT.
 */
export function isStale(
  item: DigestItem,
  now: Date,
  cfg: TemporalConfig & { maxAgeDays: Partial<Record<Lane, number>>; maxAgeDaysAcademic: number },
): boolean {
  if (item.kind === "opportunity") {
    const d = item.opportunity.deadline;

    // Page age is NOT a quality signal for an opportunity. A Rhodes page last
    // edited in March is not stale in September; the deadline is the thing with
    // a date. So `publishedAt` is deliberately not consulted here at all.
    if (d.kind === "rolling" || d.kind === "unknown") return false;
    if (item.daysUntil === undefined) return false;

    // Only a PASSED deadline retires an opportunity, and not immediately: the
    // grace window is what teaches the reader it closed, rather than having it
    // vanish overnight and leave them wondering whether they missed it or
    // whether the pipeline broke.
    return item.daysUntil < -cfg.urgency.graceDays;
  }

  const maxAge = cfg.maxAgeDays[item.primaryLane] ?? 14;
  if (!item.publishedAt) return false;
  const ageDays = (now.getTime() - Date.parse(item.publishedAt)) / 86_400_000;
  return ageDays > maxAge;
}

/**
 * Which ladder rung, if any, this item crossed today.
 *
 * Urgency alone keeps Rhodes above threshold for 400 consecutive days, which is
 * how a tracker becomes nagware and stops being read. So a CARD is emitted only
 * on a rung crossing; the countdown STRIP renders continuously every day. Cards
 * are episodic, the strip is continuity, and the two together are what let this
 * be both loud and ignorable-free.
 *
 * Returns the rung, or null when today is not a rung day.
 */
export function rungFor(
  daysUntil: number,
  lastRungDelivered: number | undefined,
  rungs: number[],
  rungFloorDays: number,
): number | null {
  if (daysUntil < 0) return null;

  // Inside the floor, every day is a rung. At six days out a daily reminder is
  // not noise.
  if (daysUntil <= rungFloorDays) {
    if (lastRungDelivered === undefined || lastRungDelivered > daysUntil) return daysUntil;
    return null;
  }

  // CROSSING a rung means the distance has fallen to it or below, so the
  // candidates are rungs >= daysUntil and the one just crossed is the SMALLEST
  // of those.
  //
  // The comparison direction is not cosmetic. Written the other way round —
  // largest rung <= daysUntil — the ladder cascades early: with no rung between
  // 365 and 180, the day the distance drops to 364 the "largest rung at or
  // below" becomes 180 and the 180-day card fires six months ahead of time.
  // Simulated over 401 days that produced cards at 400, 364, 179, 89 … each one
  // a rung too soon, which is exactly the failure that erodes trust in a
  // countdown: the reader learns the numbers are decorative.
  const crossed = rungs.filter((r) => r >= daysUntil).sort((a, b) => a - b);
  const rung = crossed[0];
  if (rung === undefined) return null;
  // Rungs are delivered in decreasing order, so an equal-or-larger recorded rung
  // means this one already went out.
  if (lastRungDelivered !== undefined && lastRungDelivered <= rung) return null;
  return rung;
}

/** Human label for a precision, used in both the email and the site. */
export function precisionNote(precision: DeadlinePrecision): string | undefined {
  if (precision === "month") return "day unknown — check";
  if (precision === "unknown") return "date unknown";
  return undefined;
}

/** True when the item is a gating obligation — drives the subject line. */
export function isGating(item: OpportunityItem): boolean {
  const next = item.opportunity.steps[item.opportunity.nextStepIndex];
  if (next) return next.gating;
  return item.opportunity.steps.some((s) => s.gating);
}
