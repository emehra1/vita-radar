/**
 * Deterministic deadline reader.
 *
 * This exists in phase 1, before any model does, and that ordering is the design.
 * When phase 3 adds Claude it will be a LOCATOR: given a page, it returns a
 * verbatim `quote` it believes contains the deadline. It never returns a date.
 * This function is the READER, and it is the only thing in the codebase allowed
 * to turn prose into a date.
 *
 * Splitting the two is what makes the model safe to use at all. A hallucinated
 * date is byte-identical to a correct one and there is no downstream signal that
 * can contradict it. A hallucinated QUOTE, on the other hand, fails a literal
 * substring check against the page in one line of code.
 *
 * Every rule below rejects. There is no rule that accepts something the reader
 * was unsure about, because the cost of a false positive here is a phantom
 * countdown to a date that does not exist.
 */

import { parseDeadlineDate, type ParsedDeadline } from "../normalize/dates.ts";

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

/**
 * A deadline cue must be present. "October 21st" on its own is not a deadline —
 * it is a date, and a page is full of them.
 */
const DEADLINE_CUE =
  /\b(deadline|closes?|closing|due|apply\s+by|applications?\s+(?:close|are\s+due)|submissions?\s+close|submit\s+by|must\s+be\s+(?:received|submitted)|no\s+later\s+than)\b/i;

/**
 * Contexts that contain a date and a deadline-ish word but are not a deadline.
 * Every entry here is a real sentence from a real page that an earlier, more
 * permissive version accepted.
 */
const REJECT_CONTEXTS: { pattern: RegExp; why: string }[] = [
  { pattern: /\b(were|was)\s+announced\b|\bannounced\s+on\b|\bwere\s+named\b/i, why: "an announcement, not a deadline" },
  { pattern: /\bclosed\s+on\b|\bhave\s+closed\b|\bhas\s+closed\b/i, why: "a past cycle that already closed" },
  { pattern: /\bbegin\s+their\s+studies\b|\bcommences?\b|\bstart\s+date\b/i, why: "the award start, not the application deadline" },
  { pattern: /\blast\s+updated\b|\bcopyright\b|©/i, why: "page metadata" },
  { pattern: /\bwas\s+founded\b|\bsince\s+\d{4}\b|\bhas\s+supported\b/i, why: "institutional history" },
  { pattern: /\binformation\s+session\b|\bwebinar\b|\bopen\s+house\b/i, why: "an event, not a deadline" },
  { pattern: /\bnotifications?\s+(?:go|are)\b|\bdecisions?\s+(?:will\s+be\s+)?announced\b|\baward\s+notifications?\b/i, why: "a notification date" },
  { pattern: /\bcouncil\s+round\b|\breview\s+(?:meets|panel)\b/i, why: "a review milestone, not a submission deadline" },
  { pattern: /\breviewed\s+annually\b|\btypically\s+held\b/i, why: "a recurring habit, not a dated deadline" },
  { pattern: /\boffice\s+is\s+closed\b|\bholiday\b/i, why: "an office closure" },
  { pattern: /\bif\s+you\s+require\b|\baccommodations?\b/i, why: "an accessibility notice" },
];

export interface ReadResult {
  ok: boolean;
  /** ISO YYYY-MM-DD when ok. */
  date?: string;
  parsed?: ParsedDeadline;
  /** Why it was refused. Always populated when ok is false. */
  reason?: string;
}

/**
 * Read a date out of a quote, or refuse.
 *
 * `opts.cycleYear`, when supplied, must match the year found in the quote. A
 * mismatch is a refusal rather than a correction: it is the signal that the page
 * is showing a different cycle than the one being tracked, which is exactly what
 * a page frozen on last year looks like.
 */
export function readDeadlineFromQuote(
  quote: string,
  opts: { timeZone: string; now?: Date; cycleYear?: number },
): ReadResult {
  const text = quote.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty quote" };
  if (text.length > 400) return { ok: false, reason: "quote too long to be one sentence" };

  for (const { pattern, why } of REJECT_CONTEXTS) {
    if (pattern.test(text)) return { ok: false, reason: why };
  }

  if (!DEADLINE_CUE.test(text)) {
    return { ok: false, reason: "no deadline cue (a date alone is not a deadline)" };
  }

  /**
   * A 4-digit year must be present IN THE QUOTE.
   *
   * Never inferred from context, and this is not a stylistic preference:
   * nucleate.org says "Deadline for US chapters is October 21st" with no year,
   * directly beside a "2024 COHORT" block, and agingpharma.org says "The deadline
   * is August 31" with no year while its tidier /deadline page is frozen on 2025.
   * A reader that guesses will be confidently wrong on both, and a model asked to
   * guess will comply politely.
   */
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) {
    return { ok: false, reason: "no 4-digit year in the quote — a year is never inferred" };
  }

  let iso: string | undefined;

  // ISO first: unambiguous.
  const isoMatch = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    iso = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  } else {
    // "1 October 2026" / "October 1, 2026" / "Oct 1 2026". Ordinal suffixes allowed.
    const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/.exec(text);
    const mdy = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/.exec(text);
    if (dmy) {
      const month = MONTHS[(dmy[2] ?? "").toLowerCase()];
      if (month) iso = `${dmy[3]}-${String(month).padStart(2, "0")}-${String(Number(dmy[1])).padStart(2, "0")}`;
    } else if (mdy) {
      const month = MONTHS[(mdy[1] ?? "").toLowerCase()];
      if (month) iso = `${mdy[3]}-${String(month).padStart(2, "0")}-${String(Number(mdy[2])).padStart(2, "0")}`;
    }
  }

  if (!iso) {
    // A month and a year with no day is NOT promoted to the 1st here. Month
    // precision is a legitimate state, but it has to be entered deliberately in
    // the YAML — inferring it from prose is how "October 2026" becomes a card
    // that fires on the 1st when nothing is due.
    return { ok: false, reason: "no full day-month-year date in the quote" };
  }

  const parsed = parseDeadlineDate(iso, { timeZone: opts.timeZone, now: opts.now });
  if (!parsed.instant) return { ok: false, reason: parsed.warning ?? "date failed to parse" };

  if (opts.cycleYear !== undefined) {
    const found = Number(iso.slice(0, 4));
    // A deadline legitimately falls in the calendar year before the award year
    // (Rhodes 2027 closes in October 2026), so allow exactly one year of lead.
    if (found !== opts.cycleYear && found !== opts.cycleYear - 1) {
      return { ok: false, reason: `year ${found} is inconsistent with cycle ${opts.cycleYear}` };
    }
  }

  return { ok: true, date: iso, parsed };
}

/**
 * The check that makes a model-supplied quote trustworthy: it must appear
 * verbatim in the page it was supposedly taken from.
 *
 * Normalise whitespace, case, and smart punctuation first — a genuine quote
 * mangled across a `<br>` or carrying a curly apostrophe must still pass, or the
 * guard is so brittle that somebody will be tempted to remove it.
 */
export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const squish = (s: string) =>
    s
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const needle = squish(quote);
  if (needle.length < 8) return false;
  return squish(pageText).includes(needle);
}
