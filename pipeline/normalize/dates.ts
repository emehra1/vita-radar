/**
 * Date handling for a deadline tracker.
 *
 * Adapted from the sibling project's normalize/dates.ts, which parses PUBLICATION
 * dates. The two jobs pull in opposite directions and mixing them up is the most
 * dangerous edit anyone could make in this repo — see parseDeadlineDate below.
 *
 * Doctrine carried over verbatim, because it is right: a date we cannot parse
 * becomes null with confident: false. It NEVER becomes Date.now(). That would
 * fabricate a fact, and a fabricated deadline is the one output of this system
 * that is both invisible and unrecoverable.
 */

export type DeadlinePrecision = "minute" | "day" | "month" | "unknown";

const MS_PER_DAY = 86_400_000;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY_RE = /^(\d{4})-(\d{2})$/;
const ANCHOR_RE = /^(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Offset of a named zone at a given instant, via ICU (ships with Node).
 * Returns milliseconds to ADD to UTC to get local time (negative for the US).
 */
export function zoneOffsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000;
}

/**
 * Interpret wall-clock fields as a specific zone. Two-pass fixpoint because the
 * offset itself depends on the instant (DST) — one pass is wrong for the hour
 * either side of a transition.
 */
export function wallClockToUtc(
  timeZone: string,
  y: number,
  monthIndex: number,
  d: number,
  h = 0,
  mi = 0,
): Date {
  const naive = Date.UTC(y, monthIndex, d, h, mi);
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - zoneOffsetMs(timeZone, t);
  return new Date(t);
}

/**
 * Short zone abbreviation for display: "BST", "EDT", "MDT".
 *
 * Locale matters and the wrong one is silently wrong: en-US renders
 * Europe/London as "GMT+1" rather than "BST", which is technically the same
 * instant but reads as a UTC offset rather than a named zone the reader
 * recognises. Ask the zone's own locale first, then fall back.
 */
const ZONE_LOCALES: Record<string, string> = {
  "Europe/London": "en-GB",
  "Europe/Copenhagen": "en-GB",
  "Europe/Berlin": "en-GB",
};

export function zoneAbbrev(timeZone: string, at: number): string {
  const locale = ZONE_LOCALES[timeZone] ?? "en-US";
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(at);
  const value = parts.find((p) => p.type === "timeZoneName")?.value;
  return value ?? timeZone;
}

/** Calendar date in a zone, as YYYY-MM-DD. "Today" means the reader's today. */
export function localDateString(timeZone: string, at: Date | number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface ParsedDeadline {
  /** The instant the deadline expires, or null if unparseable. */
  instant: Date | null;
  precision: DeadlinePrecision;
  confident: boolean;
  warning?: string;
}

/**
 * Parse a deadline.
 *
 * ⚠️ READ THIS BEFORE EDITING ⚠️
 *
 * The sibling project's parseDate() ends with a `clampFuture` guard that rejects
 * anything more than ~36 hours ahead, because a PUBLICATION date in the future is
 * always a feed bug. Copying that guard into this file would silently destroy
 * every deadline in the system — a deadline is future BY DEFINITION, and the
 * Fall 2028 rows are two years out. There is deliberately no upper clamp here.
 *
 * The bound that DOES apply is sanity, not recency: reject beyond ~3 years, since
 * nothing in this tracker legitimately sits further out, and a 4-digit year typo
 * ("2036" for "2026") is the realistic failure.
 *
 * Ambiguity resolves DOWNWARD — the earlier interpretation wins. Being early is
 * free; being late costs a cycle. A bare date with no time is treated as expiring
 * at 23:59 local, because that is what institutions mean, but a MONTH-precision
 * value resolves to the FIRST of the month, not the last.
 */
export function parseDeadlineDate(
  value: string | undefined,
  opts: { timeZone: string; timeOfDay?: string; now?: Date; precisionHint?: DeadlinePrecision },
): ParsedDeadline {
  if (!value) return { instant: null, precision: "unknown", confident: false };
  const raw = value.trim();
  const now = opts.now ?? new Date();

  let y: number;
  let monthIndex: number;
  let day: number;
  let precision: DeadlinePrecision;

  const full = DATE_ONLY_RE.exec(raw);
  const monthOnly = MONTH_ONLY_RE.exec(raw);

  if (full) {
    y = Number(full[1]);
    monthIndex = Number(full[2]) - 1;
    day = Number(full[3]);
    precision = "day";
  } else if (monthOnly) {
    y = Number(monthOnly[1]);
    monthIndex = Number(monthOnly[2]) - 1;
    // First of the month, not the last: resolve ambiguity toward the earlier date.
    day = 1;
    precision = "month";
  } else {
    return {
      instant: null,
      precision: "unknown",
      confident: false,
      warning: `unrecognised deadline format: ${raw}`,
    };
  }

  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) {
    return { instant: null, precision: "unknown", confident: false, warning: `out of range: ${raw}` };
  }

  let hour = 23;
  let minute = 59;
  if (opts.timeOfDay) {
    const t = TIME_RE.exec(opts.timeOfDay.trim());
    if (!t) {
      return {
        instant: null,
        precision: "unknown",
        confident: false,
        warning: `unrecognised timeOfDay: ${opts.timeOfDay}`,
      };
    }
    hour = Number(t[1]);
    minute = Number(t[2]);
    if (hour > 23 || minute > 59) {
      return { instant: null, precision: "unknown", confident: false, warning: `bad time: ${opts.timeOfDay}` };
    }
    if (precision === "day") precision = "minute";
  }

  const instant = wallClockToUtc(opts.timeZone, y, monthIndex, day, hour, minute);

  // Guard against a YEAR TYPO, never against futureness.
  //
  // The bound has to admit real rows that are genuinely distant: the NIH F30's
  // receipt dates are policy-fixed (Apr 8 / Aug 8 / Dec 8, unchanging), and the
  // whole point of holding the Fall 2028 stack in the file today is that the
  // ladder starts ringing at T-365 rather than T-30. So this cannot be tight.
  //
  // What it must still catch is a mistyped leading digit — 2036 for 2026 — which
  // lands a decade or more out. Eight years threads both: it admits everything
  // this tracker legitimately holds a KNOWN date for, and rejects every plausible
  // typo. Rows further out than that (Flagship in MD/PhD year 7, Schmidt
  // post-PhD) are `kind: unknown` precisely because their dates are not known
  // yet, so they never reach this parser at all.
  //
  // If a real row ever exceeds this, the config validator says so loudly at load
  // time and you widen the bound on purpose. Loud and wrong beats silent.
  const MAX_HORIZON_DAYS = 8 * 365;
  if (instant.getTime() > now.getTime() + MAX_HORIZON_DAYS * MS_PER_DAY) {
    return {
      instant: null,
      precision: "unknown",
      confident: false,
      warning: `deadline more than 8 years out (${raw}) — likely a year typo`,
    };
  }

  // A month-precision value may never be treated as a real day (it cannot ring an
  // alert). Honour an explicit weaker hint from the YAML, never a stronger one.
  if (opts.precisionHint === "month" && precision !== "month") precision = "month";
  if (opts.precisionHint === "unknown") precision = "unknown";

  return { instant, precision, confident: precision === "day" || precision === "minute" };
}

/**
 * Whole days from `now` to `instant`, counted in CALENDAR days in `timeZone`
 * rather than as elapsed milliseconds.
 *
 * The difference matters. At 11pm on September 30th a deadline at 23:59 on
 * October 1st is 25 hours away; elapsed-ms division floors that to 1, which is
 * right. But at 1am on September 30th it is 47 hours away and floors to 1 as
 * well, when the honest answer for a human reading "closes in N days" is 1 —
 * tomorrow. Counting calendar days makes "in 1 day" always mean "tomorrow",
 * which is what the reader acts on.
 */
export function daysUntil(instant: Date, timeZone: string, now: Date = new Date()): number {
  const a = localDateString(timeZone, now);
  const b = localDateString(timeZone, instant);
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY);
}

/** Hours remaining, for the final day where "in 6 hours" beats "due today". */
export function hoursUntil(instant: Date, now: Date = new Date()): number {
  return (instant.getTime() - now.getTime()) / 3_600_000;
}

/**
 * The next occurrence of a "MM-DD" anchor strictly after `from`.
 * Used to roll a closed cycle forward into the next one.
 */
export function nextAnnualAnchor(anchor: string, from: Date, timeZone: string): Date | null {
  const m = ANCHOR_RE.exec(anchor.trim());
  if (!m) return null;
  const monthIndex = Number(m[1]) - 1;
  const day = Number(m[2]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const year = Number(localDateString(timeZone, from).slice(0, 4));
  for (const y of [year, year + 1, year + 2]) {
    const candidate = wallClockToUtc(timeZone, y, monthIndex, day, 23, 59);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/** The soonest of several "MM-DD" anchors after `from` — the F30's Apr 8 / Aug 8 / Dec 8. */
export function nextOfAnchors(anchors: string[], from: Date, timeZone: string): Date | null {
  const candidates = anchors
    .map((a) => nextAnnualAnchor(a, from, timeZone))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * MS_PER_DAY);
}

export function isoDate(instant: Date, timeZone: string): string {
  return localDateString(timeZone, instant);
}

/**
 * "1 Oct 2026, 23:59 BST (18:59 ET)" — always both zones when they differ.
 *
 * A deadline in Europe/London read by somebody in Boston is a 5-hour shift that
 * can move the DAY. Printing one zone is how you submit a day late.
 */
export function formatWhen(
  instant: Date,
  timeZone: string,
  precision: DeadlinePrecision,
  readerZone = "America/New_York",
): string {
  const dayFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  if (precision === "month") {
    return `${new Intl.DateTimeFormat("en-GB", { timeZone, month: "long", year: "numeric" }).format(instant)} (day unknown)`;
  }
  if (precision === "unknown") return "date unknown";
  if (precision === "day") {
    // A day-precision deadline has no time to convert, but the zone still has to
    // be named when it is not the reader's own. "15 Oct 2026" for a London
    // deadline read in Boston looks like a local date; it is not, and the day
    // itself can differ. Naming the zone is the difference between "I have all
    // of the 15th" and "London's 15th ends at 7pm my time".
    if (timeZone === readerZone) return dayFmt.format(instant);
    const city = timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
    return `${dayFmt.format(instant)} (${city} time)`;
  }

  const timeIn = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
      .format(instant);
  const here = `${dayFmt.format(instant)}, ${timeIn(timeZone)} ${zoneAbbrev(timeZone, instant.getTime())}`;
  if (timeZone === readerZone) return here;
  return `${here} (${timeIn(readerZone)} ${zoneAbbrev(readerZone, instant.getTime())})`;
}

/** "in 9 days" / "tomorrow" / "in 6 hours" / "closed yesterday". */
export function formatCountdown(days: number, hours: number): string {
  if (days < -1) return `closed ${Math.abs(days)} days ago`;
  if (days === -1) return "closed yesterday";
  if (days === 0) {
    if (hours <= 0) return "closed today";
    // Never "due today" — a reader needs to know whether there are 6 hours or 1.
    const h = Math.max(1, Math.floor(hours));
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}
