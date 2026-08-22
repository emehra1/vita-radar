/**
 * Turn the YAML registry into scored items, the continuous countdown strip, and
 * the Verify block.
 *
 * This module has NO network calls and NO LLM calls. That is deliberate and it is
 * the reason phase 1 shipped before anything else: the highest-value component in
 * the project is a timezone-correct countdown over hand-entered dates, and it has
 * no dependencies at all. Nothing here can break because a website was redesigned.
 */

import type {
  CountdownRow,
  Deadline,
  DropReason,
  Lane,
  OpportunityFacts,
  OpportunityItem,
  OpportunityStep,
  VerifyRow,
} from "../../lib/types.ts";
import { resolveDeadline, type ProgramDef, type Registry } from "../config/deadlines.ts";
import {
  daysUntil as calendarDaysUntil,
  formatWhen,
  hoursUntil,
  localDateString,
  parseDeadlineDate,
} from "../normalize/dates.ts";
import { activeCycle } from "./project.ts";
import { canAlert, isGating, rungFor, urgencyFor, type TemporalConfig } from "../score/temporal.ts";
import { scoreOpportunity, type Weights } from "../score/index.ts";

export interface BuildOpts {
  weights: Weights;
  /** programId -> last rung delivered, from data/state/deadline-rungs.json. */
  rungs: Record<string, number>;
  /** programId -> ISO date of last rolling delivery. */
  rollingLastDelivered: Record<string, string>;
  /** Set of item ids already seen, for isNew. */
  firstSeen: (id: string) => string;
  readerZone: string;
}

export interface BuildResult {
  items: OpportunityItem[];
  countdown: CountdownRow[];
  verify: VerifyRow[];
  dropped: Partial<Record<DropReason, number>>;
  /** programId -> rung, to persist for the next run. */
  rungsDelivered: Record<string, number>;
  deadlinesTracked: number;
  verifiedLast7d: number;
}

const MS_PER_DAY = 86_400_000;

function laneFor(program: ProgramDef): Lane {
  return program.lane ?? "fellowships";
}

/** Stable id: the CYCLE, not the URL. See the README on identity. */
function opportunityId(programId: string, cycleYear: number, stepId?: string): string {
  const key = stepId ? `${programId}#${cycleYear}#${stepId}` : `${programId}#${cycleYear}`;
  // Short, deterministic, and readable in a JSON file. Not a security boundary,
  // so a cheap hash is fine — but it must be STABLE across runs and machines.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * 31) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * The next actionable step: the first pending step whose precondition is done.
 * -1 when every step is blocked or complete.
 */
function nextStepIndex(steps: OpportunityStep[]): number {
  const doneIds = new Set(steps.filter((s) => s.status === "done").map((s) => s.id));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || s.status !== "pending") continue;
    if (s.precondition && !doneIds.has(s.precondition)) continue;
    return i;
  }
  return -1;
}

/**
 * The date the ladder actually runs off.
 *
 * NOT the headline deadline. Rhodes is the reason: the Harvard endorsement step
 * precedes the national deadline by weeks and missing it ends the application
 * regardless of the October date. So the countdown targets the earliest UNMET
 * GATING step, and only falls back to the cycle deadline when no gating step has
 * a date of its own. Getting this one thing right is worth more than the entire
 * scraping layer.
 */
function effectiveTarget(
  program: ProgramDef,
  deadline: Deadline,
  steps: OpportunityStep[],
  now: Date,
): {
  date?: string;
  timeOfDay?: string;
  label: string;
  gating: boolean;
  /** Set when a pending GATING step has no date. Always forces verification. */
  undatedGating?: string;
} {
  const gatingWithDates = steps
    .filter((s) => s.gating && s.status === "pending" && s.due)
    .map((s) => ({
      step: s,
      instant: parseDeadlineDate(s.due, {
        timeZone: program.timeZone,
        timeOfDay: s.timeOfDay,
        now,
      }).instant,
    }))
    .filter((x): x is { step: OpportunityStep; instant: Date } => x.instant !== null)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());

  // Computed BEFORE the dated branch, because an undated gating step must be
  // reported even when a perfectly good dated one exists alongside it.
  const undatedGating = steps.find((s) => s.gating && s.status === "pending" && !s.due);

  const soonest = gatingWithDates[0];
  if (soonest) {
    return {
      date: soonest.step.due,
      timeOfDay: soonest.step.timeOfDay,
      // The countdown runs to the soonest date we actually KNOW. When an earlier
      // gating step has no date we cannot count down to it, but we must not let
      // the reader believe the date being shown is the binding one, so it is
      // named in the label and forced into the Verify block.
      label: undatedGating
        ? `${soonest.step.label} (but ${undatedGating.label} comes first)`
        : soonest.step.label,
      gating: true,
      undatedGating: undatedGating?.label,
    };
  }

  if (undatedGating && !deadline.date) {
    return { label: undatedGating.label, gating: true, undatedGating: undatedGating.label };
  }

  return {
    date: deadline.date,
    timeOfDay: deadline.timeOfDay,
    label: undatedGating ? `${undatedGating.label} (date unknown)` : "Application deadline",
    gating: steps.some((s) => s.gating),
    // Reported even when the headline deadline HAS a date, and that is the whole
    // point of this field.
    //
    // The bug it fixes was in the single most important row in the file. Rhodes
    // has a national deadline (Oct 1) and a Harvard endorsement step that
    // precedes it by weeks with no date we know. The first version only surfaced
    // an undated gating step when the headline deadline was ALSO missing, so
    // Rhodes rendered a tidy 40-day countdown to the national portal and said
    // nothing at all about the endorsement — the one obligation that, missed,
    // ends the application regardless of October 1st. A countdown that is
    // confidently wrong about WHICH date binds is worse than no countdown.
    undatedGating: undatedGating?.label,
  };
}

export function buildOpportunities(registry: Registry, now: Date, opts: BuildOpts): BuildResult {
  const items: OpportunityItem[] = [];
  const countdown: CountdownRow[] = [];
  const verify: VerifyRow[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const rungsDelivered: Record<string, number> = {};
  const cfg: TemporalConfig & { maxAgeDays: Partial<Record<Lane, number>>; maxAgeDaysAcademic: number } = {
    urgency: opts.weights.urgency as TemporalConfig["urgency"],
    maxAgeDays: opts.weights.maxAgeDays,
    maxAgeDaysAcademic: opts.weights.maxAgeDaysAcademic,
  };
  const today = localDateString(opts.readerZone, now);
  let deadlinesTracked = 0;
  let verifiedLast7d = 0;

  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  for (const program of registry.programs) {
    // A ruled-out program is never scored and never emailed — but it stays in the
    // file so nobody re-adds it in two years, and so an item that LOOKS like it
    // can be recognised and penalised rather than given a slot.
    if (program.status === "ruled-out") {
      drop("ruled-out");
      continue;
    }

    // `watch` before `watchFrom` is silent by design: HHMI Gilliam only became
    // MD/PhD-eligible on 2026-09-01, and surfacing it earlier trains the reader
    // to skim past rows that are not yet actionable.
    if (program.status === "watch" && program.watchFrom && today < program.watchFrom) {
      drop("not-yet-watched");
      continue;
    }
    if (program.status === "closed" || program.status === "won") continue;

    const picked = activeCycle(program, now, opts.weights.urgency.graceDays);
    if (!picked) continue;

    const { cycle } = picked;
    let deadline: Deadline =
      "rolled" in picked && picked.rolled
        ? picked.projected ?? {
            kind: "unknown",
            timeZone: program.timeZone,
            precision: "unknown",
            cycleYear: cycle.year + 1,
            cycleYearConfident: false,
            provenance: "derived",
          }
        : resolveDeadline(program, cycle, now);

    const steps = (cycle.steps ?? []).map((s) => ({ ...s }));
    const target = effectiveTarget(program, deadline, steps, now);

    // The countdown targets the gating step, so the deadline the item is SCORED
    // on must be the same date the reader is shown. Otherwise the email says
    // "endorsement in 20 days" while the ranking thinks it has 40.
    const targetParsed = target.date
      ? parseDeadlineDate(target.date, {
          timeZone: program.timeZone,
          timeOfDay: target.timeOfDay,
          now,
          precisionHint: cycle.precision,
        })
      : null;

    if (targetParsed?.instant && target.date !== deadline.date) {
      deadline = {
        ...deadline,
        date: target.date,
        timeOfDay: target.timeOfDay,
        precision: targetParsed.precision,
      };
    }

    const instant = targetParsed?.instant ?? null;
    const days = instant ? calendarDaysUntil(instant, program.timeZone, now) : undefined;

    if (deadline.kind !== "rolling" && deadline.kind !== "unknown") deadlinesTracked++;

    // ── the Verify block ────────────────────────────────────────────────────
    // Two independent reasons a row needs a human, and both must be visible.
    let needsVerification = false;
    let verifyReason: string | undefined;

    // Checked FIRST and unconditionally. A gating step with no date is the most
    // actionable state the system can represent: it means the application has a
    // prerequisite and we do not know when it is due. It must outrank every
    // other verify reason, including a perfectly good headline deadline sitting
    // right beside it.
    if (target.undatedGating) {
      needsVerification = true;
      verifyReason = `GATING step has no date: ${target.undatedGating}`;
    } else if (deadline.kind === "unknown") {
      needsVerification = true;
      verifyReason = "deadline unknown";
    } else if (deadline.precision === "month") {
      needsVerification = true;
      verifyReason = "only known to the month — cannot alert";
    } else if (deadline.verifyBy && today >= deadline.verifyBy) {
      needsVerification = true;
      verifyReason = `verifyBy ${deadline.verifyBy} has passed — confirm this cycle's date`;
    }

    // The staleness timer catches the failure mode a hand-maintained file
    // introduces: a row nobody has looked at in a season, which reads exactly
    // like a row that is still correct.
    let staleDays: number | undefined;
    if (program.verifiedOn) {
      staleDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${program.verifiedOn}T00:00:00Z`)) / MS_PER_DAY);
      if (staleDays <= 7) verifiedLast7d++;
      if (staleDays > program.verifyEvery) {
        needsVerification = true;
        verifyReason = verifyReason ?? `unverified for ${staleDays} days`;
      }
    } else if (deadline.kind === "confirmed" || deadline.kind === "projected") {
      needsVerification = true;
      verifyReason = verifyReason ?? "never verified — no verifiedOn date";
    }

    if (needsVerification) {
      verify.push({
        programId: program.id,
        label: program.label,
        reason: verifyReason ?? "needs a look",
        staleDays,
        url: program.url,
      });
    }

    // ── the continuous strip ────────────────────────────────────────────────
    // Rendered EVERY day for everything inside the horizon, independent of the
    // rung ladder. Cards are episodic; this is continuity, and it is the last
    // thing the email sheds under Gmail's size limit.
    if (instant && days !== undefined && days >= -opts.weights.urgency.graceDays && days <= opts.weights.countdownStripDays) {
      countdown.push({
        programId: program.id,
        label: program.label,
        target: target.label,
        date: deadline.date ?? "",
        daysUntil: days,
        kind: deadline.kind,
        precision: deadline.precision,
        gating: target.gating,
        displayWhen: formatWhen(instant, program.timeZone, deadline.precision, opts.readerZone),
        needsVerification,
        url: program.url,
      });
    }

    // ── build the item ──────────────────────────────────────────────────────
    const lane = laneFor(program);
    const id = opportunityId(program.id, deadline.cycleYear);
    const firstSeenAt = opts.firstSeen(id);

    const facts: OpportunityFacts = {
      programId: program.id,
      label: program.label,
      org: program.org,
      status: program.status,
      priority: program.priority,
      deadline,
      steps,
      nextStepIndex: nextStepIndex(steps),
      effectiveDate: deadline.date,
      eligibility: program.eligibility,
      ruledOut: program.ruledOut,
      needsVerification,
      verifyReason,
      url: program.url,
      verifiedOn: program.verifiedOn,
    };

    const urgency = urgencyFor(deadline, days, lane, cfg);

    // Rolling programs get a frequency cap rather than a score penalty. Scoring
    // cannot fix "this text is identical on day 1 and day 200"; only delivery
    // cadence can.
    if (deadline.kind === "rolling") {
      const last = opts.rollingLastDelivered[program.id];
      if (last) {
        const since = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / MS_PER_DAY);
        if (since < opts.weights.rollingRedeliveryDays) {
          drop("rolling-cooldown");
          continue;
        }
      }
    }

    // The rung gate. Without it, urgency alone keeps Rhodes above threshold for
    // 400 consecutive days and the digest becomes wallpaper.
    let rung: number | null = null;
    if (days !== undefined && days >= 0) {
      rung = rungFor(days, opts.rungs[program.id], opts.weights.rungs, opts.weights.rungFloorDays);
      if (rung !== null) rungsDelivered[program.id] = rung;
    }

    const events: OpportunityItem["eventTypes"] = [];
    if (days !== undefined && days >= 0 && days <= 7) events.push("deadline-imminent");
    if (days !== undefined && days < 0) events.push("deadline-passed");
    if (deadline.verifyBy && today >= deadline.verifyBy) events.push("verify-deadline");
    const next = steps[facts.nextStepIndex];
    if (next?.due) {
      const nd = parseDeadlineDate(next.due, { timeZone: program.timeZone, now }).instant;
      if (nd && calendarDaysUntil(nd, program.timeZone, now) <= 14) events.push("step-due");
    }

    const title = target.gating && target.label !== "Application deadline"
      ? `${program.label} — ${target.label}`
      : program.label;

    const breakdown = scoreOpportunity(
      { facts, lane, urgency, events, daysUntil: days, gating: target.gating },
      opts.weights,
    );

    const item: OpportunityItem = {
      kind: "opportunity",
      id,
      clusterId: id,
      title,
      url: program.url ?? "",
      canonicalUrl: program.url ?? `vita-radar:program/${program.id}`,
      sourceId: "deadlines-yml",
      sourceName: "config/deadlines.yml",
      publisherGroup: "self",
      sourceKind: "registry",
      // Deliberately NOT set. A registry row has no publication date, and
      // supplying one would invite a recency term to score it.
      publishedAt: undefined,
      datePrecision: "unknown",
      firstSeenAt,
      isNew: firstSeenAt === today,
      bodyProvenance: "yaml",
      lanes: { [lane]: breakdown.laneScores[lane] ?? 1 },
      primaryLane: lane,
      score: breakdown.total,
      scoreBreakdown: breakdown,
      watchHits: [],
      opportunity: facts,
      eventTypes: events,
      daysUntil: days,
      rung: rung ?? undefined,
    };

    // A closed row past its grace window is gone. Inside it, it stays visible so
    // the reader learns it closed rather than wondering whether the pipeline broke.
    if (days !== undefined && days < -opts.weights.urgency.graceDays) {
      drop("deadline-passed");
      continue;
    }

    // High priority pins a row regardless of threshold. Everything else must earn
    // its slot — but a rung crossing, an imminent deadline, or a verify prompt is
    // itself sufficient reason to appear.
    const mustShow =
      program.priority === "high" ||
      rung !== null ||
      needsVerification ||
      events.includes("deadline-imminent") ||
      events.includes("verify-deadline");

    if (!mustShow && breakdown.total < opts.weights.keepThreshold) {
      drop("below-threshold");
      continue;
    }
    if (!mustShow && rung === null && deadline.kind !== "rolling") {
      drop("no-rung");
      continue;
    }

    items.push(item);
  }

  countdown.sort((a, b) => a.daysUntil - b.daysUntil || a.label.localeCompare(b.label));
  verify.sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0) || a.label.localeCompare(b.label));
  items.sort((a, b) => b.score - a.score);

  return { items, countdown, verify, dropped, rungsDelivered, deadlinesTracked, verifiedLast7d };
}

/** Re-exported so callers do not need to reach into temporal.ts. */
export { canAlert, isGating, hoursUntil };
