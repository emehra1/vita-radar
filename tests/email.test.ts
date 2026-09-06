/**
 * The email renderer, tested at the two places it can fail invisibly.
 *
 * One: the catalyst section is read off two public FDA-tracker calendars, so it
 * carries a stranger's strings into HTML and it can be arbitrarily long. Both of
 * those are ways an outside feed reaches into an email about the reader's own
 * deadlines.
 *
 * Two: the size ladder. Gmail clips around 102 KB, render.ts sheds blocks until
 * the message fits, and the block it must never reach is the countdown strip —
 * an email whose deadline section went missing for want of bytes reads exactly
 * like a quiet day, which is the one failure this project cannot recover from.
 * So the ladder is exercised against a digest engineered to drive it to the
 * floor, and the strip is asserted at every rung on the way down.
 */

import { describe, expect, it } from "vitest";

import type {
  Catalyst,
  CountdownRow,
  DailyDigest,
  DigestItem,
  MarketSection,
  NewsItem,
  OpportunityItem,
  ScoreBreakdown,
  SourceHealth,
} from "../lib/types.ts";
import { renderDigestEmail, renderSubject, renderText } from "../lib/email/render.ts";

/* -------------------------------- fixtures -------------------------------- */

const BREAKDOWN: ScoreBreakdown = {
  total: 42,
  factors: [{ key: "deadlineUrgency", label: "closes soon", raw: 1, weight: 40, contribution: 40 }],
  penalties: [],
  laneScores: {},
  weightsVersion: "test",
};

function countdownRow(over: Partial<CountdownRow> = {}): CountdownRow {
  return {
    programId: "rhodes",
    label: "Rhodes Scholarship (US)",
    target: "Harvard endorsement",
    date: "2026-09-24",
    daysUntil: 18,
    kind: "confirmed",
    precision: "day",
    gating: true,
    displayWhen: "24 Sep 2026, 23:59 EDT",
    needsVerification: false,
    url: "https://example.org/rhodes",
    ...over,
  };
}

function catalyst(over: Partial<Catalyst> = {}): Catalyst {
  return {
    date: "2026-10-15",
    ticker: "NVLT",
    company: "Nuvalent, Inc.",
    label: "NVLT Nuvalent, Inc. PDUFA",
    kind: "pdufa",
    source: "FDA PDUFA calendar",
    daysUntil: 39,
    watched: false,
    ...over,
  };
}

function okHealth(over: Partial<SourceHealth> = {}): SourceHealth {
  return {
    sourceId: "fda-pdufa-ics",
    sourceName: "FDA PDUFA calendar",
    status: "ok",
    itemsParsed: 1553,
    itemsKept: 64,
    parseWarnings: [],
    latencyMs: 310,
    consecutiveFailures: 0,
    optional: true,
    ...over,
  };
}

function markets(over: Partial<MarketSection> = {}): MarketSection {
  return { asOf: "2026-09-06", catalysts: [catalyst()], health: [okHealth()], ...over };
}

function newsItem(id: string, title: string, body: string): NewsItem {
  return {
    kind: "news",
    id,
    clusterId: id,
    title,
    url: `https://example.org/${id}`,
    canonicalUrl: `https://example.org/${id}`,
    sourceId: "src",
    sourceName: "Example Wire",
    publisherGroup: "example",
    sourceKind: "news",
    datePrecision: "day",
    firstSeenAt: "2026-09-06T00:00:00Z",
    isNew: false,
    bodyProvenance: "description",
    lanes: {},
    primaryLane: "causal-genetics",
    score: 30,
    scoreBreakdown: BREAKDOWN,
    watchHits: [],
    digest: [body],
    digestSource: "extractive",
    eventTypes: ["preprint"],
    paywalled: false,
  };
}

function opportunityItem(): OpportunityItem {
  return {
    kind: "opportunity",
    id: "opp-rhodes",
    clusterId: "opp-rhodes",
    title: "Rhodes Scholarship (US)",
    url: "https://example.org/rhodes",
    canonicalUrl: "https://example.org/rhodes",
    sourceId: "registry",
    sourceName: "config/deadlines.yml",
    publisherGroup: "registry",
    sourceKind: "registry",
    datePrecision: "day",
    firstSeenAt: "2026-09-06T00:00:00Z",
    isNew: false,
    bodyProvenance: "yaml",
    lanes: {},
    primaryLane: "deadlines",
    score: 88,
    scoreBreakdown: BREAKDOWN,
    watchHits: [],
    daysUntil: 18,
    eventTypes: ["deadline-imminent"],
    opportunity: {
      programId: "rhodes",
      label: "Rhodes Scholarship (US)",
      org: "Rhodes Trust",
      status: "active",
      priority: "high",
      deadline: {
        kind: "confirmed",
        date: "2026-10-01",
        timeZone: "Europe/London",
        precision: "day",
        cycleYear: 2027,
        cycleYearConfident: true,
        provenance: "yaml",
      },
      steps: [],
      nextStepIndex: -1,
      needsVerification: false,
    },
  };
}

function digest(over: Partial<DailyDigest> = {}): DailyDigest {
  return {
    schemaVersion: 1,
    date: "2026-09-06",
    generatedAt: "2026-09-06T14:47:00Z",
    windowStart: "2026-09-05T00:00:00Z",
    windowEnd: "2026-09-06T14:47:00Z",
    health: [okHealth()],
    items: {},
    lanes: [],
    countdown: [countdownRow()],
    verify: [{ programId: "gates", label: "Gates Cambridge", reason: "Confirm this year's date", staleDays: 97 }],
    stats: {
      fetched: 10,
      kept: 4,
      deadlinesTracked: 1,
      verifiedLast7d: 0,
      medianScore: 20,
      dropped: {},
    },
    ...over,
  };
}

/* ------------------------------- the section ------------------------------ */

describe("the catalyst section", () => {
  it("renders upcoming FDA decision dates, with the T-number, date, ticker, company and kind", () => {
    const { html } = renderDigestEmail(
      digest({ markets: markets({ catalysts: [catalyst({ daysUntil: 39, watched: true })] }) }),
    );
    expect(html).toContain("Upcoming FDA decision dates");
    expect(html).toContain("T-39");
    expect(html).toContain("2026-10-15");
    expect(html).toContain("NVLT");
    expect(html).toContain("Nuvalent");
    expect(html).toContain("PDUFA");
  });

  it("names the calendars it read, so a row can be weighed", () => {
    const { html } = renderDigestEmail(digest({ markets: markets() }));
    expect(html).toMatch(/public tracker calendars read as ICS/);
    expect(html).toContain("FDA PDUFA calendar");
  });

  it("labels an advisory committee AdCom rather than the feed's raw enum", () => {
    const { html } = renderDigestEmail(
      digest({ markets: markets({ catalysts: [catalyst({ kind: "adcomm", label: "" })] }) }),
    );
    expect(html).toContain("AdCom");
    expect(html).not.toContain("adcomm");
  });

  it("sorts watched tickers first even when they are furthest out", () => {
    const { html } = renderDigestEmail(
      digest({
        markets: markets({
          catalysts: [
            catalyst({ ticker: "AAAA", company: "Soonest Bio", label: "", daysUntil: 2, date: "2026-09-08" }),
            catalyst({ ticker: "BBBB", company: "Middle Bio", label: "", daysUntil: 9, date: "2026-09-15" }),
            catalyst({ ticker: "WTCH", company: "Watched Bio", label: "", daysUntil: 120, date: "2027-01-04", watched: true }),
          ],
        }),
      }),
    );
    expect(html.indexOf("WTCH")).toBeGreaterThan(-1);
    expect(html.indexOf("WTCH")).toBeLessThan(html.indexOf("AAAA"));
    expect(html.indexOf("AAAA")).toBeLessThan(html.indexOf("BBBB"));
  });

  it("marks a watched row so it is not read as one more unheard-of ticker", () => {
    const { html, text } = renderDigestEmail(
      digest({ markets: markets({ catalysts: [catalyst({ watched: true })] }) }),
    );
    expect(html).toContain("watched");
    expect(text).toContain("[WATCHED]");
  });

  it("caps the unwatched rows and says how many were not shown", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      catalyst({
        ticker: `T${String(index).padStart(3, "0")}`,
        company: `Company ${index}`,
        label: "",
        daysUntil: index + 1,
        date: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
      }),
    );
    const { html, text } = renderDigestEmail(digest({ markets: markets({ catalysts: many }) }));
    // 30 unwatched, 8 shown: the other 22 are counted out loud rather than
    // vanishing, because a silently shortened list reads as a complete one.
    expect(html).toContain("+22 more on the calendars, not shown");
    expect(text).toContain("+22 more on the calendars, not shown");
    expect(html).toContain("T000");
    expect(html).not.toContain("T029");
  });

  it("says how many watched rows were cut when even those overflow", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      catalyst({ ticker: `W${index}`, company: `Watched ${index}`, label: "", daysUntil: index, watched: true }),
    );
    const { html } = renderDigestEmail(digest({ markets: markets({ catalysts: many }) }));
    expect(html).toContain("8 more not shown, 8 of them on your watchlist");
  });

  it("says nothing is in range when the feed is healthy and empty — that is information", () => {
    const { html, text } = renderDigestEmail(
      digest({ markets: markets({ catalysts: [] }) }),
      { catalystHorizonDays: 90 },
    );
    expect(html).toContain("No FDA decisions inside the next 90 days");
    expect(text).toContain("No FDA decisions inside the next 90 days");
  });

  it("renders nothing at all when the feed failed, rather than an empty box", () => {
    // An empty box after a failed fetch claims there are no FDA dates. The
    // section removing itself is a different, honest state.
    const { html, text } = renderDigestEmail(
      digest({
        markets: markets({ catalysts: [], health: [okHealth({ status: "failed", error: "ETIMEDOUT" })] }),
      }),
    );
    expect(html).not.toContain("Upcoming FDA decision dates");
    expect(text).not.toContain("UPCOMING FDA DECISION DATES");
  });

  it("renders nothing when a degraded feed would show a subset as if it were the whole", () => {
    const { html } = renderDigestEmail(
      digest({
        markets: markets({ health: [okHealth({ status: "degraded" })] }),
      }),
    );
    expect(html).not.toContain("Upcoming FDA decision dates");
    expect(html).not.toContain("NVLT");
  });

  it("renders nothing when the digest carries no market section", () => {
    const { html } = renderDigestEmail(digest());
    expect(html).not.toContain("Upcoming FDA decision dates");
  });

  it("escapes a company name carrying markup", () => {
    const { html } = renderDigestEmail(
      digest({
        markets: markets({
          catalysts: [
            catalyst({ company: "<script>alert('xss')</script> Therapeutics", label: "", ticker: "EVIL" }),
          ],
        }),
      }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("EVIL");
  });
});

/* -------------------------------- the ladder ------------------------------ */

describe("the size ladder", () => {
  /** 200 catalysts and 12 items whose titles alone blow the budget at `titleKb`. */
  function overloaded(titleKb: number): DailyDigest {
    const items: Record<string, DigestItem> = {};
    const newsIds: string[] = [];
    for (let index = 0; index < 12; index++) {
      const id = `news-${index}`;
      newsIds.push(id);
      items[id] = newsItem(
        id,
        `Item ${index} ${"perturbation screen readout ".repeat(Math.ceil((titleKb * 1024) / 28))}`,
        "body ".repeat(2000),
      );
    }
    const opportunity = opportunityItem();
    items[opportunity.id] = opportunity;

    return digest({
      items,
      lanes: [
        { id: "deadlines", label: "Deadlines & Actions", blurb: "Dated obligations.", itemIds: [opportunity.id] },
        { id: "causal-genetics", label: "Causal Human Genetics", blurb: "GWAS and friends.", itemIds: newsIds },
      ],
      countdown: [
        countdownRow(),
        countdownRow({ programId: "gates", label: "Gates Cambridge", daysUntil: 41, gating: false, url: undefined }),
      ],
      editorial: "A model-written opener that is allowed to be shed.",
      markets: markets({
        catalysts: Array.from({ length: 200 }, (_, index) =>
          catalyst({
            ticker: `Z${String(index).padStart(3, "0")}`,
            company: `Biotech ${index}`,
            label: "",
            daysUntil: index,
            watched: index < 3,
          }),
        ),
      }),
      stats: {
        fetched: 300,
        kept: 13,
        deadlinesTracked: 2,
        verifiedLast7d: 0,
        medianScore: 20,
        dropped: {},
      },
    });
  }

  /**
   * The regression this whole file exists for. Every rung, including the floor,
   * must still contain the strip and the verify block: both are rendered into
   * locals before the ladder array exists, so no BuildStep field can reach them.
   */
  it("keeps the countdown strip and the verify block at every rung", () => {
    for (const titleKb of [0, 1, 2, 4, 8, 16, 32, 64, 128, 220]) {
      const { html } = renderDigestEmail(overloaded(titleKb));
      expect(html, `titleKb=${titleKb}`).toContain("Countdown ·");
      expect(html, `titleKb=${titleKb}`).toContain("Rhodes Scholarship (US)");
      expect(html, `titleKb=${titleKb}`).toContain("Gates Cambridge");
      expect(html, `titleKb=${titleKb}`).toContain("VERIFY:");
    }
  });

  it("sheds the catalyst section before it would touch the strip", () => {
    // 220 KB of title survives every rung that trims detail or per-lane counts,
    // so the ladder is forced all the way past the opener and the catalysts to
    // the pinned-only floor. The strip is still there when it lands.
    const small = renderDigestEmail(overloaded(0)).html;
    const huge = renderDigestEmail(overloaded(220)).html;
    expect(small).toContain("Upcoming FDA decision dates");
    expect(huge).not.toContain("Upcoming FDA decision dates");
    expect(huge).toContain("Countdown ·");
  });

  it("gets under Gmail's clip once the ladder has run", () => {
    const { html } = renderDigestEmail(overloaded(8));
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(95_000);
  });

  it("keeps the heartbeat, which is the proof the run happened", () => {
    const { html } = renderDigestEmail(overloaded(220));
    expect(html).toContain("run 2026-09-06T14:47:00Z");
    expect(html).toContain("2 deadlines tracked");
  });
});

/* ------------------------------- the subject ------------------------------ */

describe("renderSubject", () => {
  it("cannot be moved by a catalyst", () => {
    // The subject is the only alarm that works on a locked phone, and these
    // dates come from a third party's calendar. A PDUFA date closer than the
    // reader's own gating step must not be able to take the line.
    const base = digest();
    const withCatalysts = digest({
      markets: markets({
        catalysts: [catalyst({ ticker: "IMMINENT", company: "Tomorrow Bio", daysUntil: 1, watched: true })],
      }),
    });
    expect(renderSubject(withCatalysts)).toBe(renderSubject(base));
    expect(renderSubject(withCatalysts)).not.toContain("IMMINENT");
    expect(renderSubject(withCatalysts)).toContain("Rhodes");
  });
});

/* -------------------------------- text/plain ------------------------------ */

describe("renderText", () => {
  it("carries the catalysts too, with the same rows the HTML shows", () => {
    const text = renderText(
      digest({
        markets: markets({
          catalysts: [
            catalyst({ ticker: "WTCH", company: "Watched Bio", label: "", daysUntil: 30, watched: true }),
            catalyst({ ticker: "OTHR", company: "Other Bio", label: "", daysUntil: 5 }),
          ],
        }),
      }),
    );
    expect(text).toContain("UPCOMING FDA DECISION DATES");
    expect(text).toContain("T-30");
    expect(text).toContain("WTCH — Watched Bio [WATCHED]");
    expect(text).toContain("OTHR — Other Bio");
    expect(text.indexOf("WTCH")).toBeLessThan(text.indexOf("OTHR"));
  });
});
