/**
 * The catalyst reader, on fixtures.
 *
 * Nothing here touches the network. These two feeds are somebody else's free
 * Google Calendars: a test suite that polls them is both rude and useless, since
 * it would pass or fail on what the FDA happens to have scheduled this week.
 *
 * What is tested is the set of things that fail SILENTLY. A folded line yields a
 * truncated company name, a VTIMEZONE yields phantom 1970 events, an all-day
 * date read as UTC yields every catalyst one day early — none of those throw,
 * none of them make the section look broken, and all of them put a wrong date in
 * front of a reader who has been trained to trust the dates in this email.
 */

import { describe, expect, it } from "vitest";

import { parseIcs, unfoldIcs } from "../pipeline/ingest/ics.ts";
import {
  CATALYST_FEEDS,
  extractTicker,
  fetchCatalysts,
} from "../pipeline/market/catalysts.ts";
import type { HttpClient } from "../pipeline/net/http.ts";

const NOW = new Date("2026-09-06T12:00:00Z"); // 08:00 EDT, a Sunday morning
const TODAY = "2026-09-06";

/** CRLF, because that is what RFC 5545 says and what Google actually sends. */
function ics(...lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

function vevent(uid: string, dtstart: string, summary: string, ...extra: string[]): string[] {
  return [
    "BEGIN:VEVENT",
    `DTSTART${dtstart}`,
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "STATUS:CONFIRMED",
    ...extra,
    "END:VEVENT",
  ];
}

function calendar(...events: string[][]): string {
  return ics(
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    ...events.flat(),
    "END:VCALENDAR",
  );
}

/**
 * An HttpClient that serves fixtures. Keyed by a substring of the URL so the
 * test names the feed rather than repeating a 120-character calendar URL.
 */
function stubClient(bodies: Record<string, string | { error: string; status: number }>): HttpClient {
  return (async (url: string) => {
    const hit = Object.entries(bodies).find(([key]) => url.includes(key))?.[1];
    const base = {
      notModified: false,
      finalUrl: url,
      timingMs: 1,
      attempts: 1,
      fromCache: false,
      redirects: 0,
    };
    if (hit === undefined) return { ...base, status: 404, error: "HTTP 404" };
    if (typeof hit !== "string") return { ...base, status: hit.status, error: hit.error };
    return { ...base, status: 200, body: hit };
  }) as HttpClient;
}

const PDUFA_KEY = "5dso8589486irtj53sdkr4h6ek";
const ADCOMM_KEY = "evgohovm2m3tuvqakdf4hfeq84";

describe("unfoldIcs", () => {
  it("joins continuation lines for CRLF, bare LF and tab folds", () => {
    expect(unfoldIcs("SUMMARY:Nuva\r\n lent")).toBe("SUMMARY:Nuvalent");
    expect(unfoldIcs("SUMMARY:Nuva\n lent")).toBe("SUMMARY:Nuvalent");
    expect(unfoldIcs("SUMMARY:Nuva\r\n\tlent")).toBe("SUMMARY:Nuvalent");
  });

  it("removes exactly one whitespace character, keeping the value's own spaces", () => {
    // Google folds mid-word AND mid-space. Eating two characters here silently
    // glues "Pharmaceuticals Ltd" into "PharmaceuticalsLtd".
    expect(unfoldIcs("SUMMARY:Telix\r\n  Pharma")).toBe("SUMMARY:Telix Pharma");
  });

  it("rejoins a surrogate pair split across the fold", () => {
    // RFC 5545 folds at 75 OCTETS, and Google's writer does not always respect
    // character boundaries. Once decoded to UTF-16 each half is a lone,
    // invalid surrogate; anything that inspects a line before the join is
    // looking at a broken string.
    const dna = "\u{1F9EC}"; // 🧬, one astral code point, two UTF-16 units
    const folded = `SUMMARY:Gene\uD83E\r\n \uDDECtherapy`;
    expect(unfoldIcs(folded)).toBe(`SUMMARY:Gene${dna}therapy`);
    expect([...unfoldIcs(folded)].length).toBe("SUMMARY:Genetherapy".length + 1);
  });
});

describe("parseIcs", () => {
  it("does not mistake VTIMEZONE sub-components for events", () => {
    // THE bug this file exists to prevent. VTIMEZONE carries STANDARD and
    // DAYLIGHT blocks, each with its own DTSTART at the rule's 1970 epoch. A
    // scan for DTSTART without a component stack invents two events, which are
    // then filtered out by date and merely inflate `itemsParsed` — so the
    // health row reports three events parsed from a feed that has one.
    const body = ics(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "TZNAME:EDT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "TZNAME:EST",
      "DTSTART:19701101T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
      ...vevent("a@google.com", ";VALUE=DATE:20260911", "TLX Telix Pharmaceuticals Ltd PDUFA"),
      "END:VCALENDAR",
    );

    const events = parseIcs(body);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("TLX Telix Pharmaceuticals Ltd PDUFA");
    expect(events[0]?.dtstartRaw).toBe("20260911");
  });

  it("reassembles a folded SUMMARY and DESCRIPTION", () => {
    const body = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260918",
      "UID:b@google.com",
      "DESCRIPTION:2026-09-18 The Prescription Drug User Fee Act (PDUFA) date f",
      " or the NDA is September 18\\, 2026.",
      "SUMMARY:NUVL Nuvalent\\, Inc. P",
      " DUFA",
      "END:VEVENT",
      "END:VCALENDAR",
    );

    const events = parseIcs(body);
    expect(events[0]?.summary).toBe("NUVL Nuvalent, Inc. PDUFA");
    expect(events[0]?.description).toContain("September 18, 2026.");
  });

  it("unescapes TEXT values, and does not turn an escaped backslash into a newline", () => {
    const body = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;VALUE=DATE:20260918",
      "UID:c@google.com",
      "SUMMARY:NUVL Nuvalent\\, Inc. PDUFA",
      // "line one" NEWLINE "semi\; and a literal C:\new"
      "DESCRIPTION:line one\\nsemi\\; and a literal C:\\\\new",
      "END:VEVENT",
      "END:VCALENDAR",
    );

    const event = parseIcs(body)[0];
    expect(event?.summary).toBe("NUVL Nuvalent, Inc. PDUFA");
    // The ordering trap: a chain of replaces that ends with \\ -> \ reads the
    // backslash it just produced and emits a line break inside "C:\new".
    expect(event?.description).toBe("line one\nsemi; and a literal C:\\new");
  });

  it("keeps an all-day DTSTART as a calendar date and a UTC one as an instant", () => {
    const body = calendar(
      vevent("d@google.com", ";VALUE=DATE:20260911", "TLX Telix PDUFA"),
      vevent("e@google.com", ":20260911T140000Z", "GSK GSK plc PDUFA"),
      vevent("f@google.com", ";TZID=America/New_York:20260911T090000", "MRK Merck PDUFA"),
    );

    const [allDay, utc, zoned] = parseIcs(body);
    expect(allDay?.allDay).toBe(true);
    expect(allDay?.dtstart).toBe("2026-09-11");
    expect(utc?.allDay).toBe(false);
    expect(utc?.dtstart).toBe("2026-09-11T14:00:00.000Z");
    // 09:00 EDT is 13:00Z. Getting this wrong by an hour is invisible; getting
    // it wrong by a zone moves the day.
    expect(zoned?.dtstart).toBe("2026-09-11T13:00:00.000Z");
  });

  it("ignores a VALARM's own DESCRIPTION", () => {
    const body = calendar(
      vevent(
        "g@google.com",
        ";VALUE=DATE:20260911",
        "TLX Telix PDUFA",
        "DESCRIPTION:the real one",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:Reminder",
        "TRIGGER:-PT10M",
        "END:VALARM",
      ),
    );
    expect(parseIcs(body)[0]?.description).toBe("the real one");
  });

  it("drops an event with no usable DTSTART rather than inventing one", () => {
    const body = ics(
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:h@google.com",
      "SUMMARY:MRK Merck PDUFA",
      "END:VEVENT",
      ...vevent("i@google.com", ";VALUE=DATE:20260911", "TLX Telix PDUFA"),
      "END:VCALENDAR",
    );
    expect(parseIcs(body).map((e) => e.uid)).toEqual(["i@google.com"]);
  });

  it("tolerates bare LF input", () => {
    const body = calendar(vevent("j@google.com", ";VALUE=DATE:20260911", "TLX Telix PDUFA"))
      .replace(/\r\n/g, "\n");
    expect(parseIcs(body)).toHaveLength(1);
  });
});

describe("extractTicker", () => {
  it("takes a leading all-caps token", () => {
    expect(extractTicker("TLX Telix Pharmaceuticals Ltd PDUFA")).toBe("TLX");
    expect(extractTicker("RHHBY F. Hoffmann-La Roche Ltd PDUFA")).toBe("RHHBY");
    expect(extractTicker("EW Adcom")).toBe("EW");
  });

  it("refuses to invent a ticker from a capitalised company name", () => {
    // Both are real SUMMARY values from these feeds. "Genentech" as a ticker is
    // not merely useless, it is a symbol that resolves to a different company.
    expect(extractTicker("Genentech PDUFA")).toBeUndefined();
    expect(extractTicker("Astellas Adcom")).toBeUndefined();
  });

  it("refuses numeric, punctuated and boilerplate leading tokens", () => {
    expect(extractTicker("4568 DAIICHI SANKYO PDUFA")).toBeUndefined();
    expect(extractTicker("THRX/GSK Adcom")).toBeUndefined();
    expect(extractTicker("FDA Advisory Committee on gene therapy")).toBeUndefined();
  });
});

describe("fetchCatalysts", () => {
  const opts = { today: TODAY, horizonDays: 365 };

  it("lands an all-day DTSTART on the right New York day", async () => {
    const client = stubClient({
      [PDUFA_KEY]: calendar(
        vevent("k@google.com", ";VALUE=DATE:20260911", "TLX Telix Pharmaceuticals Ltd PDUFA"),
      ),
      [ADCOMM_KEY]: calendar(),
    });

    const { catalysts } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts).toHaveLength(1);
    // Midnight-UTC parsing would say 2026-09-10 and 4 days, which for a PDUFA
    // date is a day early every single time.
    expect(catalysts[0]?.date).toBe("2026-09-11");
    expect(catalysts[0]?.daysUntil).toBe(5);
  });

  it("converts a timed UTC DTSTART into the New York day it falls on", async () => {
    const client = stubClient({
      // 02:00Z on the 11th is 22:00 on the 10th in New York.
      [PDUFA_KEY]: calendar(vevent("l@google.com", ":20260911T020000Z", "MRK Merck PDUFA")),
      [ADCOMM_KEY]: calendar(),
    });
    const { catalysts } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts[0]?.date).toBe("2026-09-10");
  });

  it("splits SUMMARY into ticker, company and label", async () => {
    const client = stubClient({
      [PDUFA_KEY]: calendar(
        vevent("m@google.com", ";VALUE=DATE:20260918", "NUVL Nuvalent\\, Inc. PDUFA"),
        vevent("n@google.com", ";VALUE=DATE:20260919", "Genentech PDUFA"),
        vevent("o@google.com", ";VALUE=DATE:20260920", "PFE Adcom"),
      ),
      [ADCOMM_KEY]: calendar(),
    });

    const { catalysts } = await fetchCatalysts(client, NOW, opts);
    const byDate = Object.fromEntries(catalysts.map((c) => [c.date, c]));

    expect(byDate["2026-09-18"]).toMatchObject({
      ticker: "NUVL",
      company: "Nuvalent, Inc.",
      label: "Nuvalent, Inc. PDUFA",
      kind: "pdufa",
    });
    expect(byDate["2026-09-19"]?.ticker).toBeUndefined();
    expect(byDate["2026-09-19"]?.company).toBe("Genentech");
    // Stripping "PFE" would leave the label as the bare word "Adcom", so the
    // whole summary is kept instead. A row with no label is never acceptable.
    expect(byDate["2026-09-20"]).toMatchObject({
      ticker: "PFE",
      label: "PFE Adcom",
      kind: "adcomm",
    });
    expect(byDate["2026-09-20"]?.company).toBeUndefined();
  });

  it("keeps only what is inside the horizon, today included", async () => {
    const client = stubClient({
      [PDUFA_KEY]: calendar(
        vevent("p@google.com", ";VALUE=DATE:20260905", "AAA Yesterday Inc PDUFA"),
        vevent("q@google.com", ";VALUE=DATE:20260906", "BBB Today Inc PDUFA"),
        vevent("r@google.com", ";VALUE=DATE:20261005", "CCC In A Month Inc PDUFA"),
        vevent("s@google.com", ";VALUE=DATE:20261106", "DDD Too Far Inc PDUFA"),
      ),
      [ADCOMM_KEY]: calendar(),
    });

    const { catalysts } = await fetchCatalysts(client, NOW, { today: TODAY, horizonDays: 30 });
    expect(catalysts.map((c) => c.ticker)).toEqual(["BBB", "CCC"]);
    expect(catalysts[0]?.daysUntil).toBe(0);
  });

  it("sorts watched tickers ahead of sooner unwatched ones", async () => {
    const client = stubClient({
      [PDUFA_KEY]: calendar(
        vevent("t@google.com", ";VALUE=DATE:20260907", "ZZZZ Nobody Watches This PDUFA"),
        vevent("u@google.com", ";VALUE=DATE:20261016", "VRTX Vertex Pharmaceuticals PDUFA"),
        vevent("v@google.com", ";VALUE=DATE:20260908", "YYYY Also Unwatched PDUFA"),
        vevent("w@google.com", ";VALUE=DATE:20260925", "ILMN Illumina Inc PDUFA"),
      ),
      [ADCOMM_KEY]: calendar(),
    });

    const { catalysts } = await fetchCatalysts(client, NOW, opts);
    // Watched first even at 40 days, then chronological inside each group.
    expect(catalysts.map((c) => c.ticker)).toEqual(["ILMN", "VRTX", "ZZZZ", "YYYY"]);
    expect(catalysts.map((c) => c.watched)).toEqual([true, true, false, false]);
  });

  it("calls a feed with no upcoming events healthy, and one with no events at all degraded", async () => {
    const client = stubClient({
      // 243 events, one of them upcoming, is the AdCom calendar's normal state.
      [ADCOMM_KEY]: calendar(
        vevent("x@google.com", ";VALUE=DATE:20200604", "MRK MERCK Adcom"),
        vevent("y@google.com", ";VALUE=DATE:20210701", "PFE Adcom"),
      ),
      [PDUFA_KEY]: calendar(),
    });

    const { catalysts, health } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts).toHaveLength(0);

    const adcomm = health.find((h) => h.sourceId === "fda-adcomm");
    expect(adcomm?.status).toBe("ok");
    expect(adcomm?.itemsParsed).toBe(2);
    expect(adcomm?.itemsKept).toBe(0);
    expect(adcomm?.lastSuccessAt).toBe(TODAY);

    // A calendar that parses nothing has changed format or stopped being a
    // calendar, and no other signal would show it: the fetch was a 200.
    const pdufa = health.find((h) => h.sourceId === "fda-pdufa");
    expect(pdufa?.status).toBe("degraded");
    expect(pdufa?.error).toBe("parsed zero VEVENTs");
  });

  it("skips a cancelled meeting", async () => {
    const client = stubClient({
      [ADCOMM_KEY]: calendar([
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20260923",
        "UID:z@google.com",
        "SUMMARY:GRAL GRAIL\\, Inc. FDA AdCom",
        "STATUS:CANCELLED",
        "END:VEVENT",
      ]),
      [PDUFA_KEY]: calendar(),
    });
    const { catalysts, health } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts).toHaveLength(0);
    expect(health.find((h) => h.sourceId === "fda-adcomm")?.parseWarnings).toContain(
      "1 cancelled event(s) skipped",
    );
  });

  it("reports a dead feed as failed and still returns the live one", async () => {
    const client = stubClient({
      [PDUFA_KEY]: calendar(
        vevent("aa@google.com", ";VALUE=DATE:20260911", "TLX Telix PDUFA"),
      ),
      [ADCOMM_KEY]: { error: "expected ICS, got a Cloudflare challenge page", status: 200 },
    });

    const { catalysts, health } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts).toHaveLength(1);

    const adcomm = health.find((h) => h.sourceId === "fda-adcomm");
    expect(adcomm?.status).toBe("failed");
    expect(adcomm?.error).toContain("Cloudflare");
    // Optional is what keeps a calendar outage out of the exit-code contract.
    expect(adcomm?.optional).toBe(true);
  });

  it("never throws when the client itself blows up", async () => {
    const exploding = (async () => {
      throw new Error("getaddrinfo ENOTFOUND calendar.google.com");
    }) as HttpClient;

    const { catalysts, health } = await fetchCatalysts(exploding, NOW, opts);
    expect(catalysts).toEqual([]);
    expect(health).toHaveLength(2);
    expect(health.every((h) => h.status === "failed" && h.optional)).toBe(true);
    expect(health[0]?.error).toContain("ENOTFOUND");
  });

  it("collapses the same catalyst appearing in both calendars", async () => {
    const row = vevent("bb@google.com", ";VALUE=DATE:20260923", "GRAL GRAIL\\, Inc. FDA AdCom");
    const client = stubClient({ [PDUFA_KEY]: calendar(row), [ADCOMM_KEY]: calendar(row) });
    const { catalysts } = await fetchCatalysts(client, NOW, opts);
    expect(catalysts).toHaveLength(1);
    expect(catalysts[0]?.kind).toBe("adcomm");
  });

  it("points at the two calendars that were verified live", () => {
    expect(CATALYST_FEEDS.map((f) => f.id)).toEqual(["fda-pdufa", "fda-adcomm"]);
    for (const feed of CATALYST_FEEDS) {
      expect(feed.url).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/ical\/.+basic\.ics$/);
    }
  });
});
