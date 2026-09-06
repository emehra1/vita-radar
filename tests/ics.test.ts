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

  it("carries the deadlines that are live right now", () => {
    const raw = readFileSync(ICS_PATH, "utf8");
    // ARDD 2026 abstract, verified live 2026-08-22 against agingpharma.org.
    expect(raw).toMatch(/DTSTART;VALUE=DATE:20260831/);
    // Rhodes national application, 2026-10-01 23:59 EDT.
    expect(raw).toMatch(/DTSTART:20261002T035900Z/);
  });
});
