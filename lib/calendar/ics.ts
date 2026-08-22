/**
 * The .ics feed: the one alarm in this repo that does not depend on this repo.
 *
 * DESIGN DOCTRINE — make the outage survivable, not merely detectable. Every
 * other alarm here needs the pipeline to have run this morning: the email, the
 * countdown strip, the subject-line escalation, the run-status check. A
 * calendar the reader has SUBSCRIBED to keeps ringing when the cron job has
 * been broken for a month, when the SMTP password expired, when the Actions
 * runner image changed under us. Publishing this file converts "the pipeline
 * went dark and I lost a year" into "the pipeline went dark and my calendar is
 * a few weeks stale".
 *
 * That is also why nothing in here is clever. It reads the registry compiled
 * from config/deadlines.yml and writes a flat file: no network, no model, no
 * state, no clock read (see `dtstamp`). The worst failure this component can
 * have is "yesterday's calendar", which is survivable. The failure it must
 * never have is an event that silently moved or silently duplicated.
 *
 * THE ONE RULE bites harder here than anywhere else, because a calendar entry
 * does not look like a guess. An email can hedge in a sentence nobody reads; a
 * 9am phone notification is read as fact. So every unconfirmed date carries
 * "[projected]" in the SUMMARY itself, and a date known only to the month never
 * lands on a day. This file is a change-detector's output, not a date's origin:
 * config/deadlines.yml is the source of truth and this is a copy of it.
 *
 * RFC 5545 is the spec. The four parts that actually bite — folding at 75
 * OCTETS, TEXT escaping, CRLF, and exclusive DTEND on all-day events — are
 * commented where they happen, because each one fails silently: Google does not
 * report a rejected feed, it just shows you fewer events than you wrote.
 */

import type { DeadlinePrecision } from "../types.ts";
import type { ProgramDef, RawCycle, Registry } from "../../pipeline/config/deadlines.ts";
import { resolveDeadline } from "../../pipeline/config/deadlines.ts";
import { formatWhen, isoDate, localDateString, parseDeadlineDate } from "../../pipeline/normalize/dates.ts";

/* ------------------------------- primitives ------------------------------- */

const CRLF = "\r\n";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Fold at 75 OCTETS, not 75 characters.
 *
 * `line.length` counts UTF-16 units, and this file is full of em-dashes and
 * curly quotes copied out of program pages — three bytes each. A 75-character
 * SUMMARY of em-dashes is a 225-octet line, which is over the limit by 3x, and
 * a feed with over-long lines does not error: Google fetches it, drops what it
 * cannot parse, and shows a calendar that is quietly missing deadlines.
 *
 * The other half of the rule is that a continuation line begins with exactly
 * one space, and that space is part of its 75 octets — so continuations carry
 * 74 octets of payload. And the split must never land inside a multi-byte
 * sequence: cutting an em-dash in half yields two invalid bytes, which is how
 * you get a feed that imports with mojibake or not at all.
 */
const FOLD_LIMIT = 75;

export function foldLine(line: string): string {
  const bytes = ENCODER.encode(line);
  if (bytes.length <= FOLD_LIMIT) return line;

  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = chunks.length === 0 ? FOLD_LIMIT : FOLD_LIMIT - 1;
    let end = Math.min(start + limit, bytes.length);
    // 0b10xxxxxx is a UTF-8 continuation byte. If the next chunk would begin
    // with one, we are mid-character: back up until it begins with a lead byte.
    while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    chunks.push((chunks.length === 0 ? "" : " ") + DECODER.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks.join(CRLF);
}

/**
 * Escape a TEXT value. Backslash FIRST, or we would escape the backslashes we
 * are about to introduce.
 *
 * The comma is the one that has actually cost people data: an unescaped comma
 * in a TEXT value is a value-list separator, so "Rubenstein Treehouse, Harvard"
 * truncates at the comma and the rest of the field is parsed as a second value
 * and thrown away. Program labels in this registry are full of commas and
 * semicolons ("Keystone — Epigenetics in Health and Disease (D42027, Banff)").
 *
 * Newlines become the two-character sequence backslash-n. A raw newline inside
 * a property value ends the line as far as the parser is concerned, which turns
 * the rest of a DESCRIPTION into a garbage property name and usually takes the
 * whole VEVENT with it.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/**
 * A URI value is NOT a TEXT value and must not be escaped. Backslash-escaping a
 * URL corrupts it, because the parser does not unescape URI values — the reader
 * ends up clicking a link with literal backslashes in the query string. All we
 * do is strip control characters that would break the line.
 */
function sanitizeUri(value: string): string {
  return value.replace(/[\r\n\t]/g, "").trim();
}

/** "20261002T035900Z". */
function utcStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** "2026-10-01" -> "20261001". */
function dateStamp(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Calendar day after `iso`, in the calendar, not in any zone. */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/**
 * 32-bit FNV-1a. Hand-rolled rather than node:crypto so this module stays
 * import-cheap; its only job is to restore the distinctness that slugification
 * throws away (see stableUid).
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * THE most important correctness property in this file.
 *
 * A UID identifies the event across publications. Derive it from anything that
 * varies run to run — a timestamp, an array index, a hash of the description —
 * and re-publishing does not update the reader's Rhodes deadline, it adds a
 * second one. Do that nightly and by October the reader has thirty copies of
 * every deadline and stops looking at the calendar, which is worse than never
 * having built it.
 *
 * So the key is exactly the three things that identify the obligation:
 * programId, cycleYear, and step id (or "deadline" for the headline date). None
 * of them depends on when we ran, on the order of the YAML file, or on the text
 * of the event. Editing a label or fixing a date UPDATES the existing entry;
 * only renaming a program id or moving it to a different cycle year creates a
 * new one, which is correct — that genuinely is a different obligation.
 *
 * The readable prefix is for debugging: when a duplicate does show up in a
 * client, you want to read the UID and know which row produced it. The hash
 * suffix is over the RAW key, so two ids that differ only in punctuation or
 * case ("foo bar" vs "foo-bar") cannot collide after slugification.
 */
export function stableUid(programId: string, cycleYear: number, stepId?: string): string {
  const key = `${programId}|${cycleYear}|${stepId ?? ""}`;
  return `${slug(programId)}-${cycleYear}-${slug(stepId ?? "deadline")}-${fnv1a(key)}@vita-radar`;
}

/* --------------------------------- events --------------------------------- */

export interface IcsEvent {
  /** Stable across runs. Build it with stableUid(); see the argument there. */
  uid: string;
  /** Carries "[projected]" and "(day unknown — verify)" itself, not just the description. */
  summary: string;
  /** The instant the obligation expires, already resolved to UTC. */
  at: Date;
  /**
   * The zone `at` was authored in. All-day dates are rendered in THIS zone and
   * never in the runner's: Keystone's 17 Dec deadline is America/Denver, and a
   * GitHub Actions box in UTC would place it on the 18th.
   */
  timeZone: string;
  precision: DeadlinePrecision;
  description?: string;
  url?: string;
  /**
   * CONFIRMED only when a human read the page and the date has day precision or
   * better. Everything else is TENTATIVE, which is the iCalendar vocabulary for
   * exactly the distinction this project cares about.
   */
  status: "CONFIRMED" | "TENTATIVE";
  /** Gating steps only. Missing one ends the application, so only those ring. */
  alarm: boolean;
  categories?: string[];
}

export interface IcsOptions {
  calendarName: string;
  /** Advertised via X-WR-TIMEZONE. Per-event zones still come from IcsEvent.timeZone. */
  timeZone: string;
  /**
   * Required, and required for a reason: taking it from `new Date()` in here
   * would make the output differ on every call, so no test could pin the bytes
   * and no build could tell "the registry changed" from "the clock moved". The
   * caller reads the clock once, at the top of main().
   */
  dtstamp: Date;
  description?: string;
}

/**
 * Where an event actually lands. `key` is what we sort by, so a month-precision
 * row sorts by the first of its month rather than by the placeholder day the
 * YAML happens to carry.
 */
interface Placement {
  lines: string[];
  key: string;
}

function placeEvent(ev: IcsEvent): Placement {
  if (ev.precision === "minute") {
    // A UTC instant, so there is no VTIMEZONE to get wrong. parseDeadlineDate
    // already did the DST-correct conversion from wall clock to instant, and
    // shipping our own VTIMEZONE would mean shipping our own DST rules — a
    // second, staler copy of the tzdata Node already has.
    //
    // No DTEND. RFC 5545 requires DTEND to be strictly later than DTSTART, so a
    // zero-duration instant cannot be written with one; omitting it is the
    // spec's own way of saying "ends when it starts". Inventing a 30-minute
    // block instead would draw a 23:59 deadline across midnight and onto the
    // following day — the one day it must not appear on.
    const stamp = utcStamp(ev.at);
    return { lines: [`DTSTART:${stamp}`], key: stamp };
  }

  const localDay = isoDate(ev.at, ev.timeZone);
  // Month precision resolves to the FIRST of the month, never to the day the
  // YAML carries as a placeholder. pd-soros is the case that proves it: the row
  // reads `deadline: 2028-10-26` with `precision: month`, and the note says the
  // 2 PM close is the most likely way to lose it. Publishing "26 Oct, 14:00" as
  // a hard event would present a date the file explicitly says it does not know
  // as the one fact the reader plans around.
  const day = ev.precision === "month" ? `${localDay.slice(0, 7)}-01` : localDay;

  // DTEND is EXCLUSIVE for all-day events: an event on 1 Oct ends 20261002.
  // Writing 20261001 makes a zero-length all-day event, which clients render
  // inconsistently — some drop it, some shift it back a day — so a whole
  // calendar can come out off by one and still look plausible.
  const start = dateStamp(day);
  return {
    lines: [`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${dateStamp(nextDay(day))}`],
    key: start,
  };
}

function eventLines(ev: IcsEvent, dtstamp: string): string[] {
  if (ev.precision === "unknown") {
    // Not a defensive nicety: an unknown-precision date cannot be placed on any
    // day OR any month, so silently skipping it would publish a calendar that
    // is missing a deadline for a reason nobody can see. Loud beats silent.
    throw new Error(`ics: event ${ev.uid} has precision "unknown" and cannot be placed on a calendar`);
  }

  const placement = placeEvent(ev);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(ev.uid)}`,
    `DTSTAMP:${dtstamp}`,
    ...placement.lines,
    `SUMMARY:${escapeText(ev.summary)}`,
    `STATUS:${ev.status}`,
    // A deadline is not a meeting. Marked OPAQUE, an all-day deadline blanks the
    // whole day in free/busy and the reader stops being bookable on the busiest
    // days of the cycle.
    "TRANSP:TRANSPARENT",
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.url) lines.push(`URL:${sanitizeUri(ev.url)}`);
  if (ev.categories?.length) {
    // CATEGORIES is a comma-separated list of TEXT values, so each element is
    // escaped but the separators are not.
    lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(",")}`);
  }
  if (ev.alarm) {
    // Seven days is the shortest lead that still contains a weekend plus two
    // working days — enough to chase a letter-writer or an endorsement
    // signature, which is the actual work a gating step represents.
    // DISPLAY alarms require a DESCRIPTION; without one the alarm is invalid
    // and some clients discard the whole VEVENT rather than just the VALARM.
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(ev.summary)}`,
      "TRIGGER:-P7D",
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  // Unfolded. buildIcs folds every line exactly once at the end, so a value can
  // never be folded twice — double-folding inserts a space into the payload and
  // the reader sees "1 Oct 2026, 2 3:59".
  return lines;
}

/** Serialize a calendar. Deterministic: identical input gives identical bytes. */
export function buildIcs(rows: IcsEvent[], opts: IcsOptions): string {
  const seen = new Map<string, string>();
  for (const ev of rows) {
    const prior = seen.get(ev.uid);
    if (prior !== undefined) {
      // Two events sharing a UID is the duplicate-accumulation bug arriving from
      // the other direction: the client keeps one of them, arbitrarily, and the
      // other deadline disappears. Refuse to write the file.
      throw new Error(
        `ics: duplicate UID ${ev.uid} ("${prior}" and "${ev.summary}") — ` +
          `one of the two deadlines would vanish in the reader's client`,
      );
    }
    seen.set(ev.uid, ev.summary);
  }

  const dtstamp = utcStamp(opts.dtstamp);
  const placed = rows
    .map((ev) => ({ ev, key: placeEvent(ev).key }))
    .sort((a, b) => (a.key === b.key ? a.ev.uid.localeCompare(b.ev.uid) : a.key < b.key ? -1 : 1));

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//vita-radar//deadline calendar//EN",
    "CALSCALE:GREGORIAN",
    // Deliberately NO METHOD property. With METHOD present the file is an iTIP
    // message, and Outlook in particular then treats a subscription feed as a
    // batch of meeting invitations to accept or decline. A published calendar
    // has no organizer and no attendees; leaving METHOD out is what says so.
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(opts.timeZone)}`,
  ];
  if (opts.description) lines.push(`X-WR-CALDESC:${escapeText(opts.description)}`);
  // Google ignores both of these and re-polls on its own schedule; Apple honours
  // REFRESH-INTERVAL. Two lines for the clients that do listen.
  lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H");

  for (const { ev } of placed) lines.push(...eventLines(ev, dtstamp));
  lines.push("END:VCALENDAR");

  // CRLF, and a trailing one. LF-only files are the single most common reason a
  // hand-written feed imports as empty: the spec says CRLF, and the strict
  // parsers simply find no properties at all.
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/* ------------------------------ registry -> ics ---------------------------- */

/**
 * True when the reader should not see this program at all yet.
 *
 * A `watch` row before its watchFrom is one the reader is not yet ELIGIBLE for:
 * Hertz funds the PhD half of an MD/PhD, GRC needs a bachelor's degree in hand.
 * An alarm for something you cannot act on is how a calendar teaches you to
 * dismiss its alarms, and by the time a real one arrives you have stopped
 * reading them. ISO dates compare correctly as strings, so no parsing.
 */
function isSuppressed(program: ProgramDef, now: Date): boolean {
  if (program.status === "ruled-out") return true;
  if (program.status === "watch" && program.watchFrom) {
    return localDateString(program.timeZone, now) < program.watchFrom;
  }
  return false;
}

function describe(
  program: ProgramDef,
  cycle: RawCycle,
  when: string,
  projected: boolean,
  dayUnknown: boolean,
  stepNote?: string,
): string {
  const parts: string[] = [];
  parts.push(`Closes ${when}`);
  if (dayUnknown) {
    parts.push(
      "DAY NOT KNOWN. This is pinned to the first of the month so it is visible, " +
        "not because it is due then. Find the real date before you plan around it.",
    );
  } else if (projected) {
    parts.push(
      "PROJECTED date, rolled forward from a previous cycle and not confirmed against the source page. Verify it.",
    );
  }
  parts.push(`Cycle ${cycle.year}${program.org ? ` · ${program.org}` : ""}`);
  if (cycle.evidence) parts.push(`Evidence: "${cycle.evidence}"`);
  if (stepNote) parts.push(stepNote.trim());
  if (cycle.note) parts.push(cycle.note.trim());
  if (program.note) parts.push(program.note.trim());
  if (program.eligibility?.notes) parts.push(`Eligibility: ${program.eligibility.notes.trim()}`);
  if (cycle.verifyBy) parts.push(`Re-confirm by ${cycle.verifyBy}`);
  if (program.url) parts.push(program.url);
  parts.push(`From config/deadlines.yml (${program.id}) — the YAML is the source of truth, this is a copy.`);
  return parts.join("\n\n");
}

/**
 * One event per gating step that has a real date, plus one per cycle deadline
 * that no gating step already covers.
 *
 * Gating only, because that is the field the whole project turns on: missing a
 * gating step ends the application regardless of the headline date, and a
 * calendar that alarms on every optional poster-abstract window buries the two
 * rows that actually bind.
 */
export function registryToIcsEvents(registry: Registry, now: Date): IcsEvent[] {
  const readerZone = registry.defaults.timeZone;
  const events: IcsEvent[] = [];

  for (const program of registry.programs) {
    if (isSuppressed(program, now)) continue;

    for (const cycle of program.cycles) {
      // resolveDeadline owns the kind/precision decision and deliberately hands
      // back no instant, so we parse the same string with the same options to
      // get one. Do not reimplement the kind logic here: "projected vs
      // confirmed" is the distinction the SUMMARY prefix depends on.
      const deadline = resolveDeadline(program, cycle, now);
      const categories = ["vita-radar", program.lane ?? "deadlines"];

      let headlineCovered = false;

      for (const step of cycle.steps ?? []) {
        if (!step.gating) continue;
        // A gating step with no date is the Harvard endorsement row: real,
        // binding, and known only as "mid-September". There is nothing to place,
        // and inventing a day would be the exact failure this repo exists to
        // prevent. It stays in the email's Verify block, not in the calendar.
        if (!step.due) continue;

        // A step never claims more precision than the headline it IS. When the
        // step's due date equals the cycle deadline, the step is that deadline
        // and inherits its uncertainty; pd-soros would otherwise publish a hard
        // 2 PM alarm on a day its own row says is unknown. A step with its own
        // distinct date (AMCAS "lock letter writers", 2028-02-01) keeps day
        // precision, because that one is the reader's own plan, not a guess
        // about somebody else's page.
        const hint = step.due === deadline.date ? deadline.precision : undefined;
        const parsed = parseDeadlineDate(step.due, {
          timeZone: program.timeZone,
          timeOfDay: step.timeOfDay,
          now,
          precisionHint: hint,
        });
        if (!parsed.instant || parsed.precision === "unknown") continue;

        if (step.due === deadline.date) headlineCovered = true;

        // Steps carry no confirmation flag of their own, so they inherit the
        // cycle's. The cautious reading is the only safe one: labelling an
        // unconfirmed date as fact is unrecoverable, labelling a confirmed one
        // "[projected]" costs the reader one click.
        const projected = deadline.kind === "projected";
        const dayUnknown = parsed.precision === "month";
        const prefix = projected ? "[projected] " : "";
        const suffix = dayUnknown ? " (day unknown — verify)" : "";
        const summary = `${prefix}${program.label} — ${step.label}${suffix}`;

        events.push({
          uid: stableUid(program.id, cycle.year, step.id),
          summary,
          at: parsed.instant,
          timeZone: program.timeZone,
          precision: parsed.precision,
          description: describe(
            program,
            cycle,
            formatWhen(parsed.instant, program.timeZone, parsed.precision, readerZone),
            projected,
            dayUnknown,
            step.note ?? (step.system ? `Portal: ${step.system}` : undefined),
          ),
          url: program.url,
          status: projected || dayUnknown ? "TENTATIVE" : "CONFIRMED",
          alarm: step.status !== "done" && step.status !== "missed",
          categories: [...categories, "gating"],
        });
      }

      if (headlineCovered) continue;
      // `rolling` has no date by definition and `unknown` has one we do not
      // know. Neither becomes an event: a calendar entry for "there is a
      // deadline and we have not found it" is an entry the reader cannot act
      // on, and the email's Verify block is where that belongs.
      if (deadline.kind === "rolling" || deadline.kind === "unknown" || !deadline.date) continue;

      const parsed = parseDeadlineDate(cycle.deadline, {
        timeZone: program.timeZone,
        timeOfDay: cycle.timeOfDay,
        now,
        precisionHint: cycle.precision,
      });
      if (!parsed.instant || parsed.precision === "unknown") continue;

      const projected = deadline.kind === "projected";
      const dayUnknown = parsed.precision === "month";
      const prefix = projected ? "[projected] " : "";
      const suffix = dayUnknown ? " (day unknown — verify)" : "";

      events.push({
        uid: stableUid(program.id, cycle.year),
        summary: `${prefix}${program.label} — deadline${suffix}`,
        at: parsed.instant,
        timeZone: program.timeZone,
        precision: parsed.precision,
        description: describe(
          program,
          cycle,
          formatWhen(parsed.instant, program.timeZone, parsed.precision, readerZone),
          projected,
          dayUnknown,
        ),
        url: program.url,
        status: projected || dayUnknown ? "TENTATIVE" : "CONFIRMED",
        // The headline date with no gating step behind it is still the thing
        // that closes, so it rings. What does not ring is a non-gating step.
        alarm: true,
        categories,
      });
    }
  }

  return events;
}
