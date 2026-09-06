/**
 * The calendar's format guarantees.
 *
 * out/calendar.ics is the one artifact designed to outlive a broken pipeline: it
 * is what gets subscribed to, so once published the deadlines keep arriving even
 * if this repo stops running for a month. That makes it the worst place in the
 * project for a silent corruption, because nothing downstream reports on it —
 * build-ics.ts writes correct bytes and exits 0 whatever happens afterwards.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRegistry } from "../pipeline/config/deadlines.ts";

const ICS_PATH = resolve(process.cwd(), "out/calendar.ics");

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

describe("out/calendar.ics is committable and correctly formed", () => {
  it("is not gitignored", () => {
    // .gitignore ignores out/* and un-ignores exactly this path. If that
    // regresses, commit-data.sh finds new files with `ls-files --others
    // --exclude-standard`, which never lists an ignored path — so the calendar
    // would simply stop being published while every build still reported success.
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", "out/calendar.ics"]);
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(ignored).toBe(false);
  });

  /**
   * RFC 5545 §3.1 makes CRLF part of the format, not a platform convention.
   *
   * GitHub's default .gitattributes ships `* text=auto`, which normalises the
   * file to LF on the way into the repo. Verified concretely: `git add
   * --renormalize` stripped all 347 CRs from a calendar that had been committed
   * correctly before that file existed. `*.ics -text` is what holds it off, and
   * this test is what stops somebody removing that line.
   */
  it("declares -text so git performs no end-of-line conversion", () => {
    const attr = git("check-attr", "text", "--", "out/calendar.ics");
    expect(attr).toMatch(/text: unset$/);
  });

  it("uses CRLF on disk", () => {
    const raw = readFileSync(ICS_PATH, "latin1");
    const cr = (raw.match(/\r/g) ?? []).length;
    const lf = (raw.match(/\n/g) ?? []).length;
    expect(cr).toBeGreaterThan(0);
    // Every LF must be preceded by a CR — no bare newlines anywhere.
    expect(cr).toBe(lf);
    expect(/[^\r]\n/.test(raw)).toBe(false);
  });

  it("keeps CRLF in the bytes git has actually stored", () => {
    // The check that matters: what a subscriber receives is the committed blob,
    // not the working copy. These can differ, and that difference is invisible.
    const blob = git("cat-file", "-p", ":out/calendar.ics");
    // execFileSync with utf8 preserves \r; count them in the stored object.
    expect((blob.match(/\r/g) ?? []).length).toBeGreaterThan(0);
  });

  it("folds every physical line at 75 octets or fewer", () => {
    const raw = readFileSync(ICS_PATH, "utf8");
    for (const line of raw.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });

  it("issues a unique UID per event, so a republish updates rather than duplicates", () => {
    const raw = readFileSync(ICS_PATH, "utf8");
    const uids = [...raw.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
    const events = (raw.match(/^BEGIN:VEVENT$/gm) ?? []).length;
    expect(uids).toHaveLength(events);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("carries every confirmed registry deadline, at the date the registry says", () => {
    // Derived from config/deadlines.yml rather than hardcoded. The previous
    // version pinned Rhodes at 20261002 and broke the day the real date turned
    // out to be the 7th — a test that fails on correct new information is worse
    // than no test, because the reflex is to edit the assertion without reading it.
    const raw = readFileSync(ICS_PATH, "utf8");
    const registry = loadRegistry();
    let checked = 0;
    for (const program of registry.programs) {
      if (program.status === "ruled-out") continue;
      for (const cycle of program.cycles) {
        if (!cycle.confirmed || !cycle.deadline) continue;
        const compact = cycle.deadline.replace(/-/g, "");
        // All-day events carry the date verbatim; timed ones are converted to
        // UTC, so accept the date appearing in either position.
        const present = raw.includes(`VALUE=DATE:${compact}`) || new RegExp(`DTSTART:${compact}|DTSTART:\\d{8}T`).test(raw);
        expect(present, `${program.id} (${cycle.deadline}) missing from the calendar`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("puts the Rhodes national application on 2026-10-07 with a stable UID", () => {
    // The UID must not change when the date does, or a republish creates a
    // SECOND event in the subscriber's calendar instead of moving the first.
    // Verified when the date moved from the 1st to the 7th on 2026-09-06.
    const raw = readFileSync(ICS_PATH, "utf8").replace(/\r\n /g, "");
    const block = raw.split("BEGIN:VEVENT").find((b) => b.includes("rhodes-us-2027-national-app"));
    expect(block).toBeDefined();
    // 2026-10-07 23:59 EDT is 2026-10-08 03:59 UTC.
    expect(block).toMatch(/DTSTART:20261008T035900Z/);
    expect(block).toMatch(/STATUS:CONFIRMED/);
    expect(block).not.toMatch(/\[projected\]/);
  });
});
