/**
 * A hand-rolled RFC 5545 reader.
 *
 * Hand-rolled rather than pulled in, in keeping with the rest of the project,
 * because the grammar we need is four rules — fold, escape, component, property
 * — and the two that matter are the two that most quick implementations get
 * wrong on exactly the feeds this project consumes.
 *
 * The traps, each of which is a real one and each of which has a test:
 *
 *  1. FOLDING. RFC 5545 §3.1 breaks a long line at 75 octets and continues it
 *     on the next line, prefixed by one space or one tab. Any regex run before
 *     unfolding reads a truncated value: "SUMMARY:Nuvalent" instead of
 *     "SUMMARY:NUVL Nuvalent\, Inc. PDUFA". Google folds nearly every
 *     DESCRIPTION in the PDUFA calendar, so this is not an edge case there.
 *
 *  2. VTIMEZONE. A timezone component contains STANDARD and DAYLIGHT
 *     sub-components, and each of those carries its own DTSTART — usually
 *     19700308T020000, the rule's epoch. A parser that scans for DTSTART
 *     without tracking which component it is inside invents events in 1970,
 *     which then either flood the digest or (once filtered by date) silently
 *     inflate the "events parsed" count that health reporting runs on.
 *
 *  3. ESCAPING. Commas and semicolons are escaped in TEXT values, so
 *     "Nuvalent\, Inc." is what a company name actually looks like on the wire.
 *
 * Nothing in here throws. A malformed component is skipped, because a calendar
 * is a decoration in this project and a decoration may never take the run down.
 */

import { wallClockToUtc } from "../normalize/dates.ts";

export interface IcsEvent {
  /** As published. Empty string when the event omits UID; callers dedupe. */
  uid: string;
  summary: string;
  /**
   * Normalised start, in one of three forms the caller must distinguish:
   *
   *   all-day        "2026-09-11"              — a calendar date, no instant
   *   zoned / UTC    "2026-09-11T14:00:00.000Z" — a real instant
   *   floating       "2026-09-11T14:00:00"      — a wall clock with no zone
   *
   * All-day is deliberately NOT converted to an instant here. `DTSTART;VALUE=
   * DATE:20260911` means the 11th wherever you are reading; turning it into
   * midnight UTC and formatting that in America/New_York yields the 10th, which
   * is the single most common way a calendar importer is off by one day.
   */
  dtstart: string;
  /** The value exactly as it appeared, for provenance and for debugging. */
  dtstartRaw: string;
  allDay: boolean;
  description?: string;
  url?: string;
  /** "CONFIRMED" | "TENTATIVE" | "CANCELLED", upper-cased. */
  status?: string;
}

/**
 * Undo RFC 5545 line folding.
 *
 * Two details, both load-bearing:
 *
 * Line endings are normalised FIRST so one rule covers all of CRLF, bare LF and
 * the CRLF-plus-tab form. Writing three separate replacements instead means the
 * third one is the one nobody adds, and it fails on precisely one publisher.
 *
 * The join runs over the whole string rather than line by line. Splitting into
 * lines first and stitching them afterwards looks equivalent and is not: a fold
 * may land between the two halves of a surrogate pair — Google folds by octet
 * count, not by code point — and each half is a lone, invalid UTF-16 unit until
 * the pieces are rejoined. Anything that inspects, trims or measures a line in
 * between is operating on a broken string.
 */
export function unfoldIcs(text: string): string {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalised.replace(/\n[ \t]/g, "");
}

/**
 * Unescape an RFC 5545 TEXT value, in one left-to-right pass.
 *
 * The obvious implementation is a chain of `.replace()` calls, and every
 * ordering of that chain is wrong for some input. Put `\\` → `\` first and the
 * literal Windows path "C:\\new" becomes "C:\new" and then, on the next pass,
 * "C:" followed by a line break. Put it last and the same input turns into a
 * line break on the earlier pass instead. A single pass consumes the escaped
 * backslash as one unit and never re-reads what it produced, which is the only
 * version that is right in both directions.
 */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * Split "NAME;PARAM=value:the value" into its three parts.
 *
 * Both splits are quote-aware. A parameter value may be double-quoted precisely
 * so that it can contain a colon or a semicolon — `X-THING="a:b";TZID=…` — and
 * a naive `indexOf(":")` cuts that line in the middle of the parameter, leaving
 * a property whose name is garbage and whose value is the back half of a quoted
 * string. Rare on these two feeds, free to get right, and impossible to notice
 * later if it is wrong.
 */
function parseProperty(line: string): IcsProperty | undefined {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return undefined;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const segments: string[] = [];
  let start = 0;
  quoted = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ";" && !quoted) {
      segments.push(head.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(head.slice(start));

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq < 1) continue;
    params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1).replace(/^"|"$/g, "");
  }

  return { name: (segments[0] ?? "").toUpperCase(), params, value };
}

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/** True when ICU recognises the zone, so an unknown TZID degrades instead of throwing. */
function knownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface NormalisedStart {
  dtstart: string;
  allDay: boolean;
}

/**
 * Are these calendar components a real date?
 *
 * The regexes above match SHAPE only, and `Date.UTC` silently rolls anything
 * out of range rather than rejecting it. Left unchecked that produced four wrong
 * catalysts from one hostile feed, none of which raised a warning:
 *
 *   20260999        -> the string "2026-09-99" emitted verbatim into the digest
 *   20261301        -> "2026-13-01"
 *   20260911T996000 -> 2026-09-15, four days past the date the publisher wrote,
 *                      and completely plausible-looking on arrival
 *   20260231        -> rolls BACKWARD to 03-03, so a real row silently vanishes
 *                      through the horizon filter instead of being counted
 *
 * The last two are the dangerous ones: one invents a date that looks fine, the
 * other deletes a row with no trace. Both violate this file's own rule that a
 * dated thing with an invented date is worse than no row at all.
 *
 * Neither live feed contains an out-of-range value today. That is not a reason
 * to skip the check — it is the reason the check has to exist before one does.
 */
function isRealDate(y: number, month: number, day: number, hour = 0, minute = 0, second = 0): boolean {
  if (y < 1970 || y > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Leap years included, via a round-trip: constructing the date and reading it
  // back catches Feb 30 without a days-per-month table.
  const probe = new Date(Date.UTC(y, month - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return false;
  }
  // 24:00:00 is legal in ISO 8601 but not in RFC 5545, and 60 is only ever a
  // leap second we have no use for.
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}

function normaliseStart(raw: string, params: Record<string, string>): NormalisedStart | undefined {
  const value = raw.trim();

  const dateOnly = DATE_ONLY.exec(value);
  // `VALUE=DATE` is the correct marker, but writers omit it and an 8-digit value
  // has no other meaning, so either is enough. Requiring the parameter would
  // reject a valid all-day event; requiring the shape alone cannot misfire,
  // since a date-time always carries a "T".
  if (dateOnly || params.VALUE === "DATE") {
    if (!dateOnly) return undefined;
    if (!isRealDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))) return undefined;
    return { dtstart: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, allDay: true };
  }

  const dateTime = DATE_TIME.exec(value);
  if (!dateTime) return undefined;

  const y = Number(dateTime[1]);
  const monthIndex = Number(dateTime[2]) - 1;
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = Number(dateTime[6]);
  const isUtc = dateTime[7] === "Z";

  if (!isRealDate(y, monthIndex + 1, day, hour, minute, second)) return undefined;

  if (isUtc) {
    return {
      dtstart: new Date(Date.UTC(y, monthIndex, day, hour, minute, second)).toISOString(),
      allDay: false,
    };
  }

  const tzid = params.TZID;
  if (tzid && knownZone(tzid)) {
    // wallClockToUtc is the project's only wall-clock-to-instant conversion, and
    // it runs a two-pass fixpoint because the offset depends on the instant. A
    // one-pass conversion is wrong for the hour either side of a DST change.
    const at = wallClockToUtc(tzid, y, monthIndex, day, hour, minute);
    return { dtstart: new Date(at.getTime() + second * 1000).toISOString(), allDay: false };
  }

  // Floating, or a TZID this runtime has never heard of (Outlook writes
  // "Eastern Standard Time", which ICU rejects). Hand back the wall clock
  // unresolved and let the caller decide what zone it means, rather than
  // guessing UTC and shifting the day by five hours.
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dtstart: `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    allDay: false,
  };
}

interface PartialEvent {
  uid?: string;
  summary?: string;
  dtstart?: string;
  dtstartRaw?: string;
  allDay?: boolean;
  description?: string;
  url?: string;
  status?: string;
}

/**
 * Every VEVENT in the calendar, in document order.
 *
 * An event with no parseable DTSTART is dropped rather than defaulted: a dated
 * thing with an invented date is worse than no row, and `IcsEvent.dtstart` is
 * non-optional so that no downstream code can forget to check.
 */
export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  // The component stack is what keeps VTIMEZONE's DTSTART out of the results.
  // Depth matters, not just the name: STANDARD and DAYLIGHT nest inside
  // VTIMEZONE, and VALARM nests inside VEVENT.
  const stack: string[] = [];
  let current: PartialEvent | undefined;

  for (const line of unfoldIcs(text).split("\n")) {
    if (!line) continue;
    const prop = parseProperty(line);
    if (!prop) continue;

    if (prop.name === "BEGIN") {
      const component = prop.value.trim().toUpperCase();
      stack.push(component);
      if (component === "VEVENT") current = {};
      continue;
    }

    if (prop.name === "END") {
      const closed = stack.pop();
      if (closed === "VEVENT") {
        if (current?.dtstart && current.dtstartRaw !== undefined) {
          events.push({
            uid: current.uid ?? "",
            summary: current.summary ?? "",
            dtstart: current.dtstart,
            dtstartRaw: current.dtstartRaw,
            allDay: current.allDay ?? false,
            ...(current.description ? { description: current.description } : {}),
            ...(current.url ? { url: current.url } : {}),
            ...(current.status ? { status: current.status } : {}),
          });
        }
        current = undefined;
      }
      continue;
    }

    if (!current) continue;
    // Properties only count when the VEVENT is the component we are actually
    // inside. Without this, a VALARM's own DESCRIPTION ("Reminder") overwrites
    // the event's, and the reader gets a row that says nothing.
    if (stack[stack.length - 1] !== "VEVENT") continue;

    switch (prop.name) {
      case "UID":
        current.uid = unescapeText(prop.value).trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(prop.value).trim();
        break;
      case "DESCRIPTION":
        current.description = unescapeText(prop.value).trim();
        break;
      case "URL":
        // A URI, not a TEXT value: a backslash in a URL is a literal backslash
        // and unescaping it would corrupt the link.
        current.url = prop.value.trim();
        break;
      case "STATUS":
        current.status = prop.value.trim().toUpperCase();
        break;
      case "DTSTART": {
        const start = normaliseStart(prop.value, prop.params);
        if (!start) break;
        current.dtstart = start.dtstart;
        current.dtstartRaw = prop.value.trim();
        current.allDay = start.allDay;
        break;
      }
      default:
        break;
    }
  }

  return events;
}
