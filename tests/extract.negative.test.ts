/**
 * The negative corpus.
 *
 * Modelled on the sibling project's fifteen real sentences that must yield ZERO
 * drug names, whose comment says it is worth more than all the positive cases —
 * because the previous implementation turned every capitalised word into a drug
 * name and nothing in the output revealed it.
 *
 * The same logic applies here and the stakes are higher. A phantom deadline is
 * invisible until the day it does not happen, and a reader who has seen one stops
 * trusting the countdown that is load-bearing.
 *
 * Every string below is real page text or a close paraphrase of it.
 */

import { describe, expect, it } from "vitest";

import { quoteAppearsIn, readDeadlineFromQuote } from "../pipeline/deadlines/extract.ts";

const TZ = "America/New_York";
const NOW = new Date("2026-08-22T12:00:00Z");

const MUST_YIELD_NOTHING: [string, string][] = [
  ["The 2026 Rhodes Scholars were announced on November 22, 2025.", "an announcement"],
  ["Applications for the 2025 cohort closed on October 1, 2024.", "a past cycle"],
  ["Scholars begin their studies in October 2027.", "the award start date"],
  ["Interviews are typically held in late November.", "no date at all"],
  ["Last updated: 14 March 2026.", "page metadata"],
  ["See the FAQ, updated 2026-02-02, for eligibility details.", "nested metadata"],
  ["Stipends are reviewed annually each April.", "a recurring habit, no year"],
  ["The Trust was founded in 1903.", "institutional history"],
  ["The program has supported 4,000 scholars since 1902.", "history with a number"],
  ["Copyright © 2026 The Rhodes Trust. All rights reserved.", "a footer"],
  ["Please contact us by 5 PM if you require accommodations.", "a time, no date"],
  ["Our office is closed December 24 through January 2.", "an office closure"],
  ["Sign up for the October 15 information session.", "an event, not a deadline"],
  ["Award notifications go out in mid-February 2027.", "a notification date"],
  ["The next NIH F30 council round meets in October.", "a review milestone"],
  // The two live cases that motivated the whole design.
  ["Deadline for US chapters is October 21st.", "nucleate.org — a real deadline with NO YEAR"],
  ["The deadline is August 31, and decisions will be announced in September.", "agingpharma.org — real deadline, NO YEAR"],
];

describe("the negative corpus: these must yield ZERO deadlines", () => {
  for (const [text, why] of MUST_YIELD_NOTHING) {
    it(`refuses (${why}): ${text.slice(0, 58)}`, () => {
      const result = readDeadlineFromQuote(text, { timeZone: TZ, now: NOW });
      expect(result.ok).toBe(false);
      expect(result.date).toBeUndefined();
      expect(result.reason).toBeTruthy();
    });
  }
});

describe("the positive cases it must still read", () => {
  it("reads an explicit day-month-year deadline", () => {
    const r = readDeadlineFromQuote("Applications close on 1 October 2026.", { timeZone: TZ, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.date).toBe("2026-10-01");
  });

  it("reads US ordering with an ordinal suffix", () => {
    const r = readDeadlineFromQuote("The deadline is October 1st, 2026.", { timeZone: TZ, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.date).toBe("2026-10-01");
  });

  it("reads an ISO date", () => {
    const r = readDeadlineFromQuote("Submissions close 2026-12-17 at 5pm.", { timeZone: TZ, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.date).toBe("2026-12-17");
  });

  it("allows a deadline one calendar year before the award year", () => {
    // Rhodes 2027 closes in October 2026. This must not read as a mismatch.
    const r = readDeadlineFromQuote("Applications are due 1 October 2026.", {
      timeZone: TZ,
      now: NOW,
      cycleYear: 2027,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a date from the wrong cycle — a page frozen on last year", () => {
    const r = readDeadlineFromQuote("Applications are due 1 October 2024.", {
      timeZone: TZ,
      now: NOW,
      cycleYear: 2027,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/inconsistent with cycle/);
  });

  it("refuses a month-and-year with no day rather than promoting it to the 1st", () => {
    const r = readDeadlineFromQuote("Application deadline: October 2026.", { timeZone: TZ, now: NOW });
    expect(r.ok).toBe(false);
  });
});

describe("quoteAppearsIn — the guard that makes a model-supplied quote checkable", () => {
  const page =
    "Applications for the Rhodes\n  Scholarship 2027 are open! Applications close on 1 October\n2026 at 23:59.";

  it("accepts a genuine quote mangled across a line break", () => {
    expect(quoteAppearsIn("Applications close on 1 October 2026", page)).toBe(true);
  });

  it("accepts a different casing", () => {
    expect(quoteAppearsIn("APPLICATIONS CLOSE ON 1 OCTOBER 2026", page)).toBe(true);
  });

  it("accepts a curly apostrophe where the page has a straight one", () => {
    expect(quoteAppearsIn("Rhodes‐Scholarship 2027 are open", page.replace("Rhodes\n  Scholarship", "Rhodes-Scholarship"))).toBe(true);
  });

  it("REFUSES a paraphrase — the hallucination case", () => {
    expect(quoteAppearsIn("The application deadline is the first of October 2026", page)).toBe(false);
  });

  it("refuses a quote genuinely absent from the page", () => {
    expect(quoteAppearsIn("Applications close on 15 November 2026", page)).toBe(false);
  });

  it("refuses an empty or trivially short quote", () => {
    expect(quoteAppearsIn("", page)).toBe(false);
    expect(quoteAppearsIn("close", page)).toBe(false);
  });
});
