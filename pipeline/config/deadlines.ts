/**
 * Loader and validator for config/deadlines.yml.
 *
 * Mirrors the sibling's watchlist compiler: hand-rolled validation that collects
 * EVERY problem into a list and throws once with all of them, rather than dying
 * on the first. Editing 37 programs by hand means typos arrive in batches, and a
 * validator that reports one per run turns a five-minute fix into five runs.
 *
 * No zod. The schema is small, stable, and the error messages a hand-rolled
 * checker produces ("programs[3].cycles[0]: deadline 2026-13-01 …") are better
 * than a library's path dump.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

import type {
  Deadline,
  DeadlineKind,
  DeadlinePrecision,
  Eligibility,
  Lane,
  OpportunityStep,
  OpportunityStatus,
  RuledOut,
} from "../../lib/types.ts";
import { LANES } from "../../lib/types.ts";
import { parseDeadlineDate } from "../normalize/dates.ts";

const DEFAULT_PATH = resolve(process.cwd(), "config/deadlines.yml");

const VALID_STATUS: OpportunityStatus[] = [
  "active",
  "watch",
  "ruled-out",
  "closed",
  "submitted",
  "won",
];
const VALID_PRECISION: DeadlinePrecision[] = ["minute", "day", "month", "unknown"];
const VALID_KIND: DeadlineKind[] = ["confirmed", "projected", "rolling", "unknown"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Recurrence {
  cadence: "annual" | "biennial" | "thrice-yearly" | "none";
  anchor?: string;
  anchors?: string[];
}

/** One cycle as written in YAML, before any date resolution. */
export interface RawCycle {
  year: number;
  deadline?: string;
  confirmed?: boolean;
  kind?: DeadlineKind;
  timeOfDay?: string;
  precision?: DeadlinePrecision;
  verifyBy?: string;
  evidence?: string;
  steps?: OpportunityStep[];
  note?: string;
}

export interface ProgramDef {
  id: string;
  label: string;
  org?: string;
  lane?: Lane;
  status: OpportunityStatus;
  priority: "high" | "normal";
  url?: string;
  timeZone: string;
  verifiedOn?: string;
  verifyEvery: number;
  watchFrom?: string;
  eventStart?: string;
  eventEnd?: string;
  venue?: string;
  eligibility?: Eligibility;
  ruledOut?: RuledOut;
  cycles: RawCycle[];
  recurrence?: Recurrence;
  note?: string;
}

export interface Registry {
  version: number;
  defaults: { timeZone: string; verifyEvery: number; horizonDays: number };
  programs: ProgramDef[];
}

export class DeadlineConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`config/deadlines.yml has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
    this.name = "DeadlineConfigError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function compileRegistry(input: unknown): Registry {
  const problems: string[] = [];
  const root = asRecord(input);
  if (!root) throw new DeadlineConfigError(["top level is not a mapping"]);

  const defaultsRaw = asRecord(root.defaults) ?? {};
  const defaults = {
    timeZone: typeof defaultsRaw.timeZone === "string" ? defaultsRaw.timeZone : "America/New_York",
    verifyEvery: typeof defaultsRaw.verifyEvery === "number" ? defaultsRaw.verifyEvery : 90,
    horizonDays: typeof defaultsRaw.horizonDays === "number" ? defaultsRaw.horizonDays : 400,
  };

  const rawPrograms = Array.isArray(root.programs) ? root.programs : [];
  if (rawPrograms.length === 0) problems.push("programs: empty or missing");

  const seenIds = new Set<string>();
  const programs: ProgramDef[] = [];

  rawPrograms.forEach((entry, i) => {
    const at = `programs[${i}]`;
    const p = asRecord(entry);
    if (!p) {
      problems.push(`${at}: not a mapping`);
      return;
    }

    const id = typeof p.id === "string" ? p.id : "";
    const where = id ? `${at} (${id})` : at;
    if (!id) problems.push(`${at}: missing id`);
    else if (seenIds.has(id)) problems.push(`${where}: duplicate id`);
    seenIds.add(id);

    const label = typeof p.label === "string" ? p.label : "";
    if (!label) problems.push(`${where}: missing label`);

    const status = (typeof p.status === "string" ? p.status : "active") as OpportunityStatus;
    if (!VALID_STATUS.includes(status)) problems.push(`${where}: unknown status "${String(p.status)}"`);

    const lane = p.lane as Lane | undefined;
    if (lane !== undefined && !LANES.includes(lane)) problems.push(`${where}: unknown lane "${String(lane)}"`);

    const timeZone = typeof p.timeZone === "string" ? p.timeZone : defaults.timeZone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    } catch {
      problems.push(`${where}: unknown IANA timeZone "${timeZone}"`);
    }

    // A ruled-out program MUST say why. An unexplained exclusion gets re-added
    // in two years by someone who cannot tell it was deliberate.
    const ruledOut = asRecord(p.ruledOut);
    if (status === "ruled-out" && !(ruledOut && typeof ruledOut.reason === "string")) {
      problems.push(`${where}: status is ruled-out but no ruledOut.reason given`);
    }

    for (const field of ["verifiedOn", "watchFrom", "eventStart", "eventEnd"] as const) {
      const v = p[field];
      if (v !== undefined && !(typeof v === "string" && DATE_RE.test(v))) {
        problems.push(`${where}: ${field} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
      }
    }

    const rawCycles = Array.isArray(p.cycles) ? p.cycles : [];
    if (rawCycles.length === 0 && status !== "ruled-out") {
      problems.push(`${where}: no cycles (only a ruled-out program may omit them)`);
    }

    const cycles: RawCycle[] = [];
    rawCycles.forEach((cEntry, ci) => {
      const cAt = `${where}.cycles[${ci}]`;
      const c = asRecord(cEntry);
      if (!c) {
        problems.push(`${cAt}: not a mapping`);
        return;
      }
      const year = typeof c.year === "number" ? c.year : NaN;
      if (!Number.isInteger(year) || year < 2024 || year > 2045) {
        problems.push(`${cAt}: year must be an integer 2024-2045, got ${JSON.stringify(c.year)}`);
      }

      const kind = c.kind as DeadlineKind | undefined;
      if (kind !== undefined && !VALID_KIND.includes(kind)) {
        problems.push(`${cAt}: unknown kind "${String(kind)}"`);
      }
      const precision = c.precision as DeadlinePrecision | undefined;
      if (precision !== undefined && !VALID_PRECISION.includes(precision)) {
        problems.push(`${cAt}: unknown precision "${String(precision)}"`);
      }

      const deadline = typeof c.deadline === "string" ? c.deadline : undefined;
      if (deadline !== undefined) {
        const parsed = parseDeadlineDate(deadline, {
          timeZone,
          timeOfDay: typeof c.timeOfDay === "string" ? c.timeOfDay : undefined,
          now: new Date(),
        });
        if (!parsed.instant) problems.push(`${cAt}: ${parsed.warning ?? `unparseable deadline ${deadline}`}`);
      }

      // The kind/deadline contract, stated so the two can never disagree.
      if (kind === "rolling" && deadline) {
        problems.push(`${cAt}: kind is rolling but a deadline is set — pick one`);
      }
      if (kind === "unknown" && deadline) {
        problems.push(`${cAt}: kind is unknown but a deadline is set — pick one`);
      }
      if (!deadline && kind === undefined) {
        problems.push(`${cAt}: no deadline and no kind — say "kind: unknown" or "kind: rolling" explicitly`);
      }

      if (c.verifyBy !== undefined && !(typeof c.verifyBy === "string" && DATE_RE.test(c.verifyBy))) {
        problems.push(`${cAt}: verifyBy must be YYYY-MM-DD`);
      }

      const steps: OpportunityStep[] = [];
      const stepIds = new Set<string>();
      const rawSteps = Array.isArray(c.steps) ? c.steps : [];
      rawSteps.forEach((sEntry, si) => {
        const sAt = `${cAt}.steps[${si}]`;
        const s = asRecord(sEntry);
        if (!s) {
          problems.push(`${sAt}: not a mapping`);
          return;
        }
        const sid = typeof s.id === "string" ? s.id : "";
        if (!sid) problems.push(`${sAt}: missing id`);
        else if (stepIds.has(sid)) problems.push(`${sAt}: duplicate step id "${sid}"`);
        stepIds.add(sid);
        if (typeof s.label !== "string" || !s.label) problems.push(`${sAt}: missing label`);
        if (s.due !== undefined && !(typeof s.due === "string" && DATE_RE.test(s.due))) {
          problems.push(`${sAt}: due must be YYYY-MM-DD, got ${JSON.stringify(s.due)}`);
        }
        steps.push({
          id: sid,
          label: typeof s.label === "string" ? s.label : sid,
          due: typeof s.due === "string" ? s.due : undefined,
          timeOfDay: typeof s.timeOfDay === "string" ? s.timeOfDay : undefined,
          precondition: typeof s.precondition === "string" ? s.precondition : undefined,
          system: typeof s.system === "string" ? s.system : undefined,
          gating: s.gating === true,
          status: (typeof s.status === "string" ? s.status : "pending") as OpportunityStep["status"],
          note: typeof s.note === "string" ? s.note : undefined,
        });
      });

      // A precondition pointing at nothing silently disables the ordering, which
      // is the whole reason multi-step programs are modelled at all.
      for (const s of steps) {
        if (s.precondition && !stepIds.has(s.precondition)) {
          problems.push(`${cAt}.steps.${s.id}: precondition "${s.precondition}" is not a step in this cycle`);
        }
        if (s.precondition === s.id) problems.push(`${cAt}.steps.${s.id}: precondition points at itself`);
      }

      // Deadline sanity against the event, when we know the event. This is the
      // check that catches a page frozen on last year's cycle.
      const eventStart = typeof p.eventStart === "string" ? p.eventStart : undefined;
      if (deadline && eventStart && DATE_RE.test(eventStart)) {
        const d = Date.parse(`${deadline}T00:00:00Z`);
        const ev = Date.parse(`${eventStart}T00:00:00Z`);
        if (d > ev) problems.push(`${cAt}: deadline ${deadline} is AFTER the event start ${eventStart}`);
        if (ev - d > 400 * 86_400_000) {
          problems.push(`${cAt}: deadline ${deadline} is more than 400 days before the event ${eventStart}`);
        }
      }

      cycles.push({
        year,
        deadline,
        confirmed: c.confirmed === true,
        kind,
        timeOfDay: typeof c.timeOfDay === "string" ? c.timeOfDay : undefined,
        precision,
        verifyBy: typeof c.verifyBy === "string" ? c.verifyBy : undefined,
        evidence: typeof c.evidence === "string" ? c.evidence : undefined,
        steps,
        note: typeof c.note === "string" ? c.note : undefined,
      });
    });

    const rec = asRecord(p.recurrence);
    let recurrence: Recurrence | undefined;
    if (rec) {
      const cadence = String(rec.cadence ?? "none") as Recurrence["cadence"];
      if (!["annual", "biennial", "thrice-yearly", "none"].includes(cadence)) {
        problems.push(`${where}.recurrence: unknown cadence "${cadence}"`);
      }
      const anchors = Array.isArray(rec.anchors) ? rec.anchors.map(String) : undefined;
      if (cadence === "thrice-yearly" && (!anchors || anchors.length === 0)) {
        problems.push(`${where}.recurrence: thrice-yearly needs an anchors list`);
      }
      recurrence = {
        cadence,
        anchor: typeof rec.anchor === "string" ? rec.anchor : undefined,
        anchors,
      };
    }

    programs.push({
      id,
      label,
      org: typeof p.org === "string" ? p.org : undefined,
      lane,
      status,
      priority: p.priority === "high" ? "high" : "normal",
      url: typeof p.url === "string" ? p.url : undefined,
      timeZone,
      verifiedOn: typeof p.verifiedOn === "string" ? p.verifiedOn : undefined,
      verifyEvery: typeof p.verifyEvery === "number" ? p.verifyEvery : defaults.verifyEvery,
      watchFrom: typeof p.watchFrom === "string" ? p.watchFrom : undefined,
      eventStart: typeof p.eventStart === "string" ? p.eventStart : undefined,
      eventEnd: typeof p.eventEnd === "string" ? p.eventEnd : undefined,
      venue: typeof p.venue === "string" ? p.venue : undefined,
      eligibility: (asRecord(p.eligibility) as Eligibility | null) ?? undefined,
      ruledOut: (ruledOut as RuledOut | null) ?? undefined,
      cycles,
      recurrence,
      note: typeof p.note === "string" ? p.note : undefined,
    });
  });

  if (problems.length > 0) throw new DeadlineConfigError(problems);
  return { version: typeof root.version === "number" ? root.version : 1, defaults, programs };
}

/**
 * CORE_SCHEMA, not the default.
 *
 * js-yaml's DEFAULT_SCHEMA implements the YAML 1.1 `timestamp` type, so an
 * unquoted `2026-08-22` is silently resolved to a JS Date — which is to say to
 * 2026-08-22T00:00:00Z, which in America/New_York is the evening of August 21st.
 * A library quietly reinterpreting a calendar date as a UTC instant is the exact
 * class of bug this project exists to prevent, and it would have shifted every
 * date in the file by one day for a reader on the US east coast.
 *
 * CORE_SCHEMA still resolves ints, floats, bools and nulls (so `year: 2027` and
 * `gating: true` keep their types) but leaves dates as strings, so
 * parseDeadlineDate owns every date interpretation in the codebase. There is
 * exactly one place that turns text into an instant, and it is ours.
 */
export function loadRegistry(path = DEFAULT_PATH): Registry {
  return compileRegistry(yaml.load(readFileSync(path, "utf8"), { schema: yaml.CORE_SCHEMA }));
}

/** Resolve the Deadline for a cycle. Pure — no clock reads beyond `now`. */
export function resolveDeadline(program: ProgramDef, cycle: RawCycle, now: Date): Deadline {
  const base = {
    timeZone: program.timeZone,
    cycleYear: cycle.year,
    cycleYearConfident: true,
    verifyBy: cycle.verifyBy,
    evidence: cycle.evidence,
  };

  if (cycle.kind === "rolling") {
    return { ...base, kind: "rolling", precision: "unknown", provenance: "yaml" };
  }
  if (cycle.kind === "unknown" || !cycle.deadline) {
    return { ...base, kind: "unknown", precision: "unknown", provenance: "yaml" };
  }

  const parsed = parseDeadlineDate(cycle.deadline, {
    timeZone: program.timeZone,
    timeOfDay: cycle.timeOfDay,
    now,
    precisionHint: cycle.precision,
  });

  // A date the parser refused is `unknown`, never a guess. This is the branch
  // that keeps a typo from becoming a countdown.
  if (!parsed.instant) {
    return { ...base, kind: "unknown", precision: "unknown", provenance: "yaml" };
  }

  return {
    ...base,
    kind: cycle.confirmed ? "confirmed" : "projected",
    date: cycle.deadline,
    timeOfDay: cycle.timeOfDay,
    precision: parsed.precision,
    provenance: "yaml",
  };
}
