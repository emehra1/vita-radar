/**
 * Tests over the REAL config/deadlines.yml, not a fixture.
 *
 * A fixture would drift from the file that actually ships. These run against the
 * live registry so a bad hand edit fails in CI rather than at 6am in an email.
 */

import { describe, expect, it } from "vitest";

import { loadRegistry } from "../pipeline/config/deadlines.ts";
import { buildOpportunities } from "../pipeline/deadlines/build.ts";
import { WEIGHTS } from "../pipeline/score/index.ts";

const NOW = new Date("2026-08-22T15:00:00Z");
const ZONE = "America/New_York";

function build(now = NOW) {
  const registry = loadRegistry();
  return {
    registry,
    result: buildOpportunities(registry, now, {
      weights: WEIGHTS,
      rungs: {},
      rollingLastDelivered: {},
      firstSeen: () => "2026-08-22",
      readerZone: ZONE,
    }),
  };
}

describe("config/deadlines.yml", () => {
  it("loads with zero validation problems", () => {
    // loadRegistry throws a DeadlineConfigError listing EVERY problem at once.
    expect(() => loadRegistry()).not.toThrow();
  });

  it("gives every ruled-out program a recorded reason", () => {
    for (const p of loadRegistry().programs) {
      if (p.status === "ruled-out") expect(p.ruledOut?.reason).toBeTruthy();
    }
  });

  it("declares a valid IANA timezone for every program", () => {
    for (const p of loadRegistry().programs) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: p.timeZone }).format(0)).not.toThrow();
    }
  });
});

describe("buildOpportunities over the real registry", () => {
  it("never surfaces a ruled-out program", () => {
    const { registry, result } = build();
    const ruledOut = new Set(registry.programs.filter((p) => p.status === "ruled-out").map((p) => p.id));
    expect(ruledOut.size).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(ruledOut.has(item.opportunity.programId)).toBe(false);
    }
    // And it is counted as an eligibility drop, not lost silently.
    expect(result.dropped["ruled-out"]).toBe(ruledOut.size);
  });

  it("stays silent about a watch program before its watchFrom", () => {
    const { result } = build();
    const shown = new Set(result.items.map((i) => i.opportunity.programId));
    // HHMI Gilliam only became MD/PhD-eligible on 2026-09-01.
    expect(shown.has("hhmi-gilliam")).toBe(false);
    expect(result.dropped["not-yet-watched"]).toBeGreaterThan(0);
  });

  it("surfaces a watch program once watchFrom arrives", () => {
    const { result } = build(new Date("2026-09-02T15:00:00Z"));
    const ids = new Set(result.verify.map((v) => v.programId).concat(result.items.map((i) => i.opportunity.programId)));
    expect(ids.has("hhmi-gilliam")).toBe(true);
  });

  /**
   * THE regression that matters most.
   *
   * Rhodes has a dated national deadline AND an undated Harvard endorsement step
   * that precedes it by weeks. The first implementation only reported an undated
   * gating step when the headline deadline was ALSO missing, so Rhodes rendered a
   * tidy 40-day countdown and said nothing about the obligation that actually
   * binds. uraf.harvard.edu 403s every path including robots.txt, so no scraper
   * will ever fill this in — the only correct behaviour is to say loudly that it
   * is missing.
   */
  it("forces verification when a GATING step has no date, even beside a dated deadline", () => {
    // Asserted against the MECHANISM, not against one program's current state.
    //
    // This test named Rhodes until 2026-09-06, when the endorsement was obtained
    // and its date confirmed — at which point a test that was correct for two
    // weeks started failing on a change that was pure good news. A test over the
    // live registry has to assert the rule, and let the data move.
    const { result } = build();
    const flagged = result.verify.filter((v) => v.reason.includes("GATING step has no date"));
    expect(flagged.length).toBeGreaterThan(0);
    for (const row of flagged) {
      // Whatever is flagged must genuinely have a pending, gating, undated step.
      const program = loadRegistry().programs.find((p) => p.id === row.programId);
      const steps = program?.cycles.flatMap((c) => c.steps ?? []) ?? [];
      expect(steps.some((st) => st.gating && st.status !== "done" && !st.due)).toBe(true);
    }
  });

  it("stops flagging a program once its gating prerequisite is done", () => {
    // The Rhodes endorsement was obtained on 2026-09-06. Marking a step `done`
    // must clear both the Verify row and the "comes first" parenthetical, or the
    // tracker keeps nagging about work that is finished — which is how a reader
    // learns to skim the Verify block.
    const { result } = build();
    const rhodesVerify = result.verify.find(
      (v) => v.programId === "rhodes-us" && v.reason.includes("GATING step has no date"),
    );
    expect(rhodesVerify).toBeUndefined();
    const row = result.countdown.find((r) => r.programId === "rhodes-us");
    expect(row?.target).not.toMatch(/comes first/);
  });

  it("names the missing prerequisite in the countdown target too", () => {
    // Gates Cambridge still carries an undated gating step (the separate
    // University of Cambridge MPhil application), so it is the live example now.
    const { result } = build();
    const row = result.countdown.find((r) => r.programId === "gates-cambridge-us");
    expect(row?.target).toMatch(/comes first/);
    expect(row?.needsVerification).toBe(true);
  });

  it("catches every multi-step program whose prerequisite is undated", () => {
    const { result } = build();
    const flagged = result.verify.filter((v) => v.reason.includes("GATING step has no date")).map((v) => v.programId);
    // Rhodes was here until its endorsement was obtained on 2026-09-06.
    expect(flagged).toContain("gates-cambridge-us");
    expect(flagged).toContain("broad-bbps");
  });

  it("puts the ARDD abstract deadline 9 days out and marks it gating", () => {
    // Verified live on 2026-08-22: agingpharma.org/registration, Oct 1-3 in Boston.
    const { result } = build();
    const ardd = result.countdown.find((r) => r.programId === "ardd-2026");
    expect(ardd?.daysUntil).toBe(9);
    expect(ardd?.gating).toBe(true);
    expect(ardd?.kind).toBe("confirmed");
  });

  it("sorts the countdown by days remaining and keeps it inside the horizon", () => {
    const { result } = build();
    expect(result.countdown.length).toBeGreaterThan(0);
    for (let i = 1; i < result.countdown.length; i++) {
      const prev = result.countdown[i - 1]!;
      const cur = result.countdown[i]!;
      expect(cur.daysUntil).toBeGreaterThanOrEqual(prev.daysUntil);
    }
    for (const row of result.countdown) {
      expect(row.daysUntil).toBeLessThanOrEqual(WEIGHTS.countdownStripDays);
      expect(row.daysUntil).toBeGreaterThanOrEqual(-WEIGHTS.urgency.graceDays);
    }
  });

  it("names the zone for a foreign deadline so a local date is never assumed", () => {
    const { result } = build();
    const gates = result.countdown.find((r) => r.programId === "gates-cambridge-us");
    // Gates is Europe/London. This cycle is day-precision, so there is no clock
    // time to convert — but the zone must still be named, because London's 15th
    // ends at 7pm Eastern and "15 Oct 2026" alone reads as a local date.
    expect(gates?.displayWhen).toMatch(/London time/);
  });

  it("prints both clock times when a foreign deadline has a time of day", () => {
    const { result } = build();
    // PD Soros closes at 2 PM ET, which is the single most likely way to lose it,
    // so a timed deadline must always render the reader's zone alongside.
    const soros = result.countdown.find((r) => r.programId === "pd-soros");
    if (soros) expect(soros.displayWhen).toMatch(/\d{2}:\d{2}/);
  });

  it("marks a projected date as projected rather than presenting it as fact", () => {
    const { result } = build();
    // Gates Cambridge is still a projection — /apply/ 302s to a broken root, so
    // nothing has ever confirmed its date.
    const gates = result.countdown.find((r) => r.programId === "gates-cambridge-us");
    expect(gates?.kind).toBe("projected");
  });

  it("marks a human-confirmed date as confirmed", () => {
    // Rhodes: 2026-10-07, confirmed by Eshan on 2026-09-06. Six days later than
    // the projection it replaced, and no fetch could have found it.
    const { result } = build();
    const rhodes = result.countdown.find((r) => r.programId === "rhodes-us");
    expect(rhodes?.kind).toBe("confirmed");
    expect(rhodes?.date).toBe("2026-10-07");
  });

  /**
   * THE audit-trail firewall.
   *
   * The machine-checkable statement of the whole hybrid design: Claude may locate
   * a quote, write the daily opener, and judge near-duplicates, and it may never
   * contribute a point to a score. If this ever fails, the model has been wired
   * into the ranking and the explainability claim is void.
   */
  it("lets no score factor come from a model", () => {
    const { result } = build();
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      for (const f of [...item.scoreBreakdown.factors, ...item.scoreBreakdown.penalties]) {
        expect(f.key.startsWith("llm")).toBe(false);
        expect(f.key.startsWith("claude")).toBe(false);
      }
    }
  });

  it("stamps a weights version on every scored item", () => {
    const { result } = build();
    for (const item of result.items) {
      expect(item.scoreBreakdown.weightsVersion).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("keeps deadlinesTracked and the strip consistent with the horizon", () => {
    const { result } = build();
    expect(result.deadlinesTracked).toBeGreaterThan(0);
    // Everything on the strip is inside the horizon, so the strip can only ever
    // be a subset of what is tracked.
    expect(result.countdown.length).toBeLessThanOrEqual(result.deadlinesTracked);
  });
});

describe("identity is the cycle, not the URL", () => {
  it("gives a refreshed cycle a NEW id at the same URL", () => {
    // rhodeshouse.ox.ac.uk/apply is the same URL in 2026 and 2027. URL-only
    // hashing (correct for news) would make a refreshed cycle invisible forever:
    // never `isNew`, no alert on the one day it matters.
    const registry = loadRegistry();
    const idsIn = (now: Date) =>
      new Map(
        buildOpportunities(registry, now, {
          weights: WEIGHTS,
          rungs: {},
          rollingLastDelivered: {},
          firstSeen: () => "2026-08-22",
          readerZone: ZONE,
        }).items.map((i) => [i.opportunity.programId, { id: i.id, cycle: i.opportunity.deadline.cycleYear }]),
      );

    const now = idsIn(NOW);
    // A year later the Fall-2026 cycles have closed and rolled forward.
    const later = idsIn(new Date("2027-08-22T15:00:00Z"));

    const rhodesNow = now.get("rhodes-us");
    const rhodesLater = later.get("rhodes-us");
    expect(rhodesNow).toBeDefined();
    expect(rhodesLater).toBeDefined();
    expect(rhodesLater!.cycle).toBeGreaterThan(rhodesNow!.cycle);
    expect(rhodesLater!.id).not.toBe(rhodesNow!.id);
  });

  it("keeps ids stable across two runs on the same day", () => {
    const a = build().result.items.map((i) => i.id);
    const b = build().result.items.map((i) => i.id);
    expect(a).toEqual(b);
  });

  it("issues a unique id per item", () => {
    const ids = build().result.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
