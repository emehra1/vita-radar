/**
 * The inversion, pinned numerically.
 *
 * These are the tests that would catch somebody "fixing" this project to work
 * like the sibling — which is the most plausible future regression, because every
 * other digest pipeline in the world decays with age.
 */

import { describe, expect, it } from "vitest";

import { deadlineUrgency, canAlert, isStale, rungFor, urgencyFor } from "../pipeline/score/temporal.ts";
import { WEIGHTS } from "../pipeline/score/index.ts";
import type { Deadline, NewsItem, OpportunityItem } from "../lib/types.ts";

const O = { horizonDays: 400, leadDays: 35, steepness: 2.2 };
const CFG = {
  urgency: WEIGHTS.urgency,
  maxAgeDays: WEIGHTS.maxAgeDays,
  maxAgeDaysAcademic: WEIGHTS.maxAgeDaysAcademic,
};

describe("deadlineUrgency", () => {
  it("is exactly 0.5 at leadDays", () => {
    expect(deadlineUrgency(35, O)).toBe(0.5);
  });

  it("is 0 the moment the deadline has passed", () => {
    expect(deadlineUrgency(-1, O)).toBe(0);
  });

  it("is 1 on the day itself", () => {
    expect(deadlineUrgency(0, O)).toBe(1);
  });

  it("is 0 beyond the horizon", () => {
    expect(deadlineUrgency(401, O)).toBe(0);
  });

  it("is monotone non-increasing across the whole horizon", () => {
    let previous = Infinity;
    for (let d = 0; d <= 400; d++) {
      const v = deadlineUrgency(d, O);
      expect(v).toBeLessThanOrEqual(previous + 1e-12);
      previous = v;
    }
  });

  it("rises as the deadline approaches — the inversion itself", () => {
    // If anyone ever swaps this for a recency decay, this is the assertion that
    // fails. 90 days out must be worth LESS than 7 days out.
    expect(deadlineUrgency(7, O)).toBeGreaterThan(deadlineUrgency(90, O));
  });
});

describe("urgencyFor", () => {
  const base: Deadline = {
    kind: "confirmed",
    date: "2026-10-01",
    timeZone: "America/New_York",
    precision: "day",
    cycleYear: 2027,
    cycleYearConfident: true,
    provenance: "yaml",
  };

  it("never lets a projected date outrank a confirmed one at the same distance", () => {
    const confirmed = urgencyFor(base, 30, "fellowships", CFG);
    const projected = urgencyFor({ ...base, kind: "projected" }, 30, "fellowships", CFG);
    expect(projected.raw).toBeLessThan(confirmed.raw);
    expect(projected.penalties).toContain("deadlineProjected");
  });

  it("keeps an unknown deadline visible instead of burying it at zero", () => {
    const unknown = urgencyFor({ ...base, kind: "unknown", date: undefined }, undefined, "fellowships", CFG);
    expect(unknown.raw).toBeGreaterThan(0);
    expect(unknown.penalties).toContain("deadlineUnknown");
  });

  it("distinguishes rolling from unknown — they mean opposite things", () => {
    const rolling = urgencyFor({ ...base, kind: "rolling", date: undefined }, undefined, "fellowships", CFG);
    const unknown = urgencyFor({ ...base, kind: "unknown", date: undefined }, undefined, "fellowships", CFG);
    // Unknown scores HIGHER: there is a deadline and we do not know it, which is
    // actionable. Rolling needs nothing.
    expect(unknown.raw).toBeGreaterThan(rolling.raw);
    expect(rolling.penalties).toHaveLength(0);
  });

  it("discounts month precision", () => {
    const day = urgencyFor(base, 20, "fellowships", CFG);
    const month = urgencyFor({ ...base, precision: "month" }, 20, "fellowships", CFG);
    expect(month.raw).toBeLessThan(day.raw);
  });
});

describe("canAlert", () => {
  const base: Deadline = {
    kind: "confirmed",
    date: "2026-10-01",
    timeZone: "America/New_York",
    precision: "day",
    cycleYear: 2027,
    cycleYearConfident: true,
    provenance: "yaml",
  };

  it("allows a confirmed, day-precision, YAML-sourced date", () => {
    expect(canAlert(base)).toBe(true);
  });

  it("refuses a month-precision date — it would ring on a day nothing is due", () => {
    expect(canAlert({ ...base, precision: "month" })).toBe(false);
  });

  it("refuses anything not sourced from the YAML — THE ONE RULE as a function", () => {
    expect(canAlert({ ...base, provenance: "claude-proposed" })).toBe(false);
    expect(canAlert({ ...base, provenance: "hash-change" })).toBe(false);
    expect(canAlert({ ...base, provenance: "derived" })).toBe(false);
  });

  it("refuses rolling and unknown", () => {
    expect(canAlert({ ...base, kind: "rolling" })).toBe(false);
    expect(canAlert({ ...base, kind: "unknown" })).toBe(false);
  });
});

function opportunity(over: Partial<OpportunityItem> = {}): OpportunityItem {
  return {
    kind: "opportunity",
    id: "x",
    clusterId: "x",
    title: "Rhodes",
    url: "https://example.org",
    canonicalUrl: "https://example.org",
    sourceId: "deadlines-yml",
    sourceName: "config/deadlines.yml",
    publisherGroup: "self",
    sourceKind: "registry",
    datePrecision: "unknown",
    firstSeenAt: "2026-08-22",
    isNew: false,
    bodyProvenance: "yaml",
    lanes: { fellowships: 1 },
    primaryLane: "fellowships",
    score: 50,
    scoreBreakdown: { total: 50, factors: [], penalties: [], laneScores: {}, weightsVersion: "test" },
    watchHits: [],
    eventTypes: [],
    opportunity: {
      programId: "rhodes-us",
      label: "Rhodes",
      status: "active",
      priority: "high",
      deadline: {
        kind: "confirmed",
        date: "2026-10-01",
        timeZone: "America/New_York",
        precision: "day",
        cycleYear: 2027,
        cycleYearConfident: true,
        provenance: "yaml",
      },
      steps: [],
      nextStepIndex: -1,
      needsVerification: false,
    },
    ...over,
  };
}

describe("isStale", () => {
  /**
   * THE named regression from the plan. This is the exact bug the sibling's
   * `maxAgeDays` rule would cause if it were applied to an opportunity, and it is
   * the reason `DigestItem` is a discriminated union rather than one flat type
   * with an optional deadline.
   */
  it("KEEPS a page published 2025-12-01 whose deadline is 2026-10-01, scored 2026-09-24", () => {
    const item = opportunity({ publishedAt: "2025-12-01T00:00:00Z", daysUntil: 7 });
    expect(isStale(item, new Date("2026-09-24T12:00:00Z"), CFG)).toBe(false);
  });

  it("ignores publication age entirely for an opportunity", () => {
    const ancient = opportunity({ publishedAt: "2019-01-01T00:00:00Z", daysUntil: 40 });
    expect(isStale(ancient, new Date("2026-08-22T12:00:00Z"), CFG)).toBe(false);
  });

  it("keeps a just-closed deadline inside the grace window, so it visibly closes", () => {
    expect(isStale(opportunity({ daysUntil: -1 }), new Date(), CFG)).toBe(false);
  });

  it("retires a deadline past the grace window", () => {
    expect(isStale(opportunity({ daysUntil: -3 }), new Date(), CFG)).toBe(true);
  });

  it("never retires a rolling or unknown deadline", () => {
    const rolling = opportunity();
    rolling.opportunity.deadline = { ...rolling.opportunity.deadline, kind: "rolling", date: undefined };
    expect(isStale(rolling, new Date(), CFG)).toBe(false);
  });

  it("still applies age-based staleness to NEWS", () => {
    // Built from the shared core rather than by mutating an opportunity, so the
    // union stays honest: a NewsItem has no `opportunity` field at all.
    const { opportunity: _drop, kind: _kind, ...core } = opportunity();
    const news: NewsItem = {
      ...core,
      kind: "news",
      digest: [],
      digestSource: "dek",
      eventTypes: [],
      paywalled: false,
      primaryLane: "tools-platforms",
      publishedAt: "2026-01-01T00:00:00Z",
    };
    expect(isStale(news, new Date("2026-08-22T12:00:00Z"), CFG)).toBe(true);
  });

  it("keeps recent news", () => {
    const { opportunity: _drop, kind: _kind, ...core } = opportunity();
    const news: NewsItem = {
      ...core,
      kind: "news",
      digest: [],
      digestSource: "dek",
      eventTypes: [],
      paywalled: false,
      primaryLane: "tools-platforms",
      publishedAt: "2026-08-20T00:00:00Z",
    };
    expect(isStale(news, new Date("2026-08-22T12:00:00Z"), CFG)).toBe(false);
  });
});

describe("rungFor", () => {
  const rungs = WEIGHTS.rungs;

  it("fires each card on its exact rung day, not a day early", () => {
    // The regression: written with the comparison inverted, the ladder fired the
    // 180-day card at 364 days out because no rung sits between 365 and 180.
    let last: number | undefined;
    const fired: { day: number; rung: number }[] = [];
    for (let d = 400; d >= 0; d--) {
      const r = rungFor(d, last, rungs, WEIGHTS.rungFloorDays);
      if (r !== null) {
        fired.push({ day: d, rung: r });
        last = r;
      }
    }
    expect(fired).toHaveLength(rungs.length);
    for (const f of fired) expect(f.day).toBe(f.rung);
  });

  it("turns 401 days into 17 cards, not 401 — the anti-nagware property", () => {
    let last: number | undefined;
    let count = 0;
    for (let d = 400; d >= 0; d--) {
      const r = rungFor(d, last, rungs, WEIGHTS.rungFloorDays);
      if (r !== null) {
        count++;
        last = r;
      }
    }
    expect(count).toBe(17);
  });

  it("still fires a rung missed while the cron was down", () => {
    // A month-long outage must not silently swallow the 60-day card.
    const afterNinetyFive = rungFor(95, undefined, rungs, WEIGHTS.rungFloorDays);
    expect(rungFor(58, afterNinetyFive ?? undefined, rungs, WEIGHTS.rungFloorDays)).toBe(60);
  });

  it("fires every day inside the floor", () => {
    expect(rungFor(6, 7, rungs, 7)).toBe(6);
    expect(rungFor(5, 6, rungs, 7)).toBe(5);
  });

  it("never fires for a passed deadline", () => {
    expect(rungFor(-1, undefined, rungs, 7)).toBeNull();
  });
});
