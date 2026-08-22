/**
 * Rolling a closed cycle forward into the next one.
 *
 * A deadline tracker that only knows about cycles a human typed in goes quiet
 * the day after each one closes, which is precisely when the next cycle becomes
 * the thing to work on. So the day after a confirmed deadline passes, its row
 * becomes next cycle's PROJECTION — plausible, discounted, and carrying a
 * `verifyBy` date that will eventually promote itself to the top of the email
 * with "Confirm this year's date".
 *
 * One function covers three cases that look different and are not: the annual
 * roll, the NIH F30's fixed Apr 8 / Aug 8 / Dec 8 anchors, and post-close
 * continuity.
 */

import type { Deadline } from "../../lib/types.ts";
import type { ProgramDef, RawCycle, Recurrence } from "../config/deadlines.ts";
import { addDays, isoDate, nextAnnualAnchor, nextOfAnchors, parseDeadlineDate } from "../normalize/dates.ts";

/** How far ahead of a projected date to ask for confirmation. */
const VERIFY_LEAD_DAYS = 60;

/**
 * The next occurrence for a recurrence, strictly after `after`.
 *
 * `biennial` deliberately returns null. Keystone's epigenetics meeting runs every
 * other year and guessing "same anchor, two years on" would produce a confident
 * date for a meeting that may not be scheduled — worse than no row, because a
 * projection renders as a countdown. A biennial program that closes goes to
 * `unknown` and asks a human, which is the honest answer.
 */
export function nextOccurrence(
  recurrence: Recurrence | undefined,
  after: Date,
  timeZone: string,
): Date | null {
  if (!recurrence) return null;
  switch (recurrence.cadence) {
    case "annual":
      return recurrence.anchor ? nextAnnualAnchor(recurrence.anchor, after, timeZone) : null;
    case "thrice-yearly":
      return recurrence.anchors ? nextOfAnchors(recurrence.anchors, after, timeZone) : null;
    case "biennial":
    case "none":
    default:
      return null;
  }
}

/**
 * Turn a closed cycle into the next one's projection.
 *
 * Returns null when there is nothing defensible to project, in which case the
 * caller should surface an `unknown` deadline rather than invent a date.
 */
export function rollForward(
  program: ProgramDef,
  closed: Deadline,
  now: Date,
): Deadline | null {
  const next = nextOccurrence(program.recurrence, now, program.timeZone);
  if (!next) return null;

  const date = isoDate(next, program.timeZone);
  const verifyBy = isoDate(addDays(next, -VERIFY_LEAD_DAYS), program.timeZone);

  return {
    kind: "projected",
    date,
    // The time of day carries over: an institution that closed at 2 PM ET last
    // cycle will almost certainly do so again, and dropping it would silently
    // move the deadline to 23:59 and lose ten hours of margin.
    timeOfDay: closed.timeOfDay,
    timeZone: program.timeZone,
    precision: closed.timeOfDay ? "minute" : "day",
    cycleYear: closed.cycleYear + (program.recurrence?.cadence === "annual" ? 1 : 1),
    // A rolled date is never confident about its cycle year. Worst case is one
    // spurious re-alert per calendar year, which beats both "never" and "daily".
    cycleYearConfident: false,
    verifyBy,
    provenance: "derived",
  };
}

/**
 * The cycle to show for a program right now: the soonest cycle that has not
 * closed past the grace window, else a roll-forward of the most recent one.
 */
export function activeCycle(
  program: ProgramDef,
  now: Date,
  graceDays: number,
): { cycle: RawCycle; rolled: false } | { cycle: RawCycle; rolled: true; projected: Deadline | null } | null {
  if (program.cycles.length === 0) return null;

  const dated = program.cycles
    .map((cycle) => {
      const parsed = cycle.deadline
        ? parseDeadlineDate(cycle.deadline, {
            timeZone: program.timeZone,
            timeOfDay: cycle.timeOfDay,
            now,
            precisionHint: cycle.precision,
          })
        : null;
      return { cycle, instant: parsed?.instant ?? null };
    })
    .sort((a, b) => (a.instant?.getTime() ?? Infinity) - (b.instant?.getTime() ?? Infinity));

  const graceMs = graceDays * 86_400_000;

  // Prefer the soonest cycle still open (or inside its grace window).
  for (const entry of dated) {
    if (!entry.instant) continue;
    if (entry.instant.getTime() + graceMs >= now.getTime()) return { cycle: entry.cycle, rolled: false };
  }

  // Undated cycles (kind: unknown / rolling) are shown as-is — they have nothing
  // to close past.
  const undated = dated.find((e) => !e.instant);
  if (undated) return { cycle: undated.cycle, rolled: false };

  // Everything has closed. Roll the most recent forward.
  const last = dated[dated.length - 1];
  if (!last) return null;
  const closedDeadline: Deadline = {
    kind: last.cycle.confirmed ? "confirmed" : "projected",
    date: last.cycle.deadline,
    timeOfDay: last.cycle.timeOfDay,
    timeZone: program.timeZone,
    precision: last.cycle.timeOfDay ? "minute" : "day",
    cycleYear: last.cycle.year,
    cycleYearConfident: true,
    provenance: "yaml",
  };
  return {
    cycle: rollCycleSteps(last.cycle),
    rolled: true,
    projected: rollForward(program, closedDeadline, now),
  };
}

/**
 * Strip the dates off a rolled-forward cycle's steps, keeping their labels,
 * ordering and gating flags.
 *
 * The bug this fixes was silent and total. Rolling Rhodes forward produced a
 * correct 2027 projection for the headline deadline while the steps still carried
 * the 2026 cycle's dates, so the "soonest pending gating step" was the previous
 * October and the whole program was dropped as already-closed. Rhodes vanished
 * from the tracker entirely for a year, with nothing in the output to indicate it
 * had ever been there.
 *
 * Shifting the step dates by the same delta would be worse than dropping them:
 * an institution can move a step without moving the deadline, and a fabricated
 * step date is indistinguishable from a real one. So the honest state after a
 * roll-forward is exactly what it is — we know the steps exist, we know which
 * ones gate, and we do not know when they are due. That makes the projection
 * self-announcing: every gating step becomes undated, which forces the row into
 * the Verify block with "GATING step has no date".
 */
function rollCycleSteps(cycle: RawCycle): RawCycle {
  if (!cycle.steps || cycle.steps.length === 0) return cycle;
  return {
    ...cycle,
    steps: cycle.steps.map((step) => ({
      ...step,
      due: undefined,
      timeOfDay: undefined,
      status: "pending" as const,
    })),
  };
}
