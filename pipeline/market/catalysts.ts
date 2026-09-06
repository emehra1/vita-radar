/**
 * FDA catalyst dates.
 *
 * This is the whole "market" section. There are no quotes and no movers here,
 * and that is a finding rather than an omission: every keyless price source was
 * probed and rejected — Yahoo 429s from residential IPs, Stooq answers 200 with
 * a SHA-256 proof-of-work challenge, Alpha Vantage allows 25 requests a DAY, and
 * Tiingo's free tier licenses the data for internal use only, so emailing it
 * would breach the terms. The two that work want an API key.
 *
 * That turned out to be the good outcome. A daily percentage move is the one
 * number in this digest that is embarrassing when wrong and worthless when
 * right. A PDUFA date is the same object as a fellowship deadline — a dated
 * thing you can prepare for — so it runs through the same countdown machinery as
 * everything else and nothing else is needed.
 *
 * SOURCE. Two public Google Calendars, confirmed live on 2026-09-06: 1,553
 * PDUFA events (64 upcoming) and 243 AdCom events (1 upcoming). fdatracker.com's
 * free calendar is an iframe of these same two calendars, so the ICS is the
 * intended interface and not a workaround.
 *
 * PROVENANCE. Nothing in this file may move a date. These are somebody else's
 * hand-maintained calendars, they carry `provenance` nowhere near "yaml", and
 * `canAlert()` will not let one ring a subject line or a calendar alarm. They
 * are context, ranked by a watchlist, and an outage here must be invisible to
 * the deadline tracker — hence: never throws, always returns health.
 */

import type { Catalyst, SourceHealth } from "../../lib/types.ts";
import { WATCHED_TICKERS } from "../config/tickers.ts";
import { parseIcs, type IcsEvent } from "../ingest/ics.ts";
import type { HttpClient } from "../net/http.ts";
import { daysUntil, localDateString, wallClockToUtc } from "../normalize/dates.ts";

/** The FDA runs on Eastern time, and so does the reader. */
const MARKET_TZ = "America/New_York";

/**
 * A year. Far enough that the watchlist's next event is almost always in view —
 * the nearest watched PDUFA can be eight months out — and the watched-first sort
 * is what keeps that from turning into 64 rows of noise.
 */
export const CATALYST_HORIZON_DAYS = 365;

export interface CatalystFeed {
  id: string;
  name: string;
  url: string;
  /** What this feed publishes, used when a SUMMARY does not say. */
  kind: Catalyst["kind"];
}

export const CATALYST_FEEDS: CatalystFeed[] = [
  {
    id: "fda-pdufa",
    name: "FDA PDUFA calendar",
    url: "https://calendar.google.com/calendar/ical/5dso8589486irtj53sdkr4h6ek%40group.calendar.google.com/public/basic.ics",
    kind: "pdufa",
  },
  {
    id: "fda-adcomm",
    name: "FDA AdCom calendar",
    url: "https://calendar.google.com/calendar/ical/evgohovm2m3tuvqakdf4hfeq84%40group.calendar.google.com/public/basic.ics",
    kind: "adcomm",
  },
];

/**
 * All-caps tokens that lead a SUMMARY and are not tickers.
 *
 * "FDA Advisory Committee on X" would otherwise be read as ticker FDA, and a
 * fabricated ticker is worse than a missing one: it is the kind of wrong that
 * looks authoritative. Short on purpose — the general rule below (a leading
 * token must be all uppercase letters) already rejects "Genentech" and
 * "Astellas", which is the failure that actually shows up in this feed.
 */
const NOT_A_TICKER = new Set([
  "FDA", "PDUFA", "ADCOM", "ADCOMM", "EMA", "NDA", "BLA", "SBLA", "ANDA",
  "CRL", "US", "USA", "EU", "UK", "TBD", "TBA",
]);

/**
 * Two to five uppercase letters, optionally with a one-or-two-letter class
 * suffix after a dot (BRK.A). Deliberately strict in three directions:
 *
 *  - Mixed case is rejected, so "Genentech PDUFA" yields no ticker rather than
 *    the ticker "Genentech".
 *  - Digits are rejected, so "4568 DAIICHI SANKYO PDUFA" — a Tokyo listing, and
 *    a real row in this feed — yields no ticker rather than a symbol no US
 *    reader can look up.
 *  - Punctuation is rejected, so "THRX/GSK Adcom" yields no ticker rather than
 *    silently picking one of the two companies.
 *
 * A single letter is also rejected, which costs us Agilent ("A") and is the
 * right trade: a one-letter leading token is far more often an initial.
 */
const TICKER_RE = /^[A-Z]{2,5}(?:\.[A-Z]{1,2})?$/;

/** The trailing "PDUFA" / "FDA AdCom" phrase, which is event type and not company. */
const EVENT_PHRASE_RE = /\s*\b(?:FDA\s+)?(?:PDUFA|ADCOMM?|ADVISORY\s+COMMITTEE)\b\s*$/i;

export function extractTicker(summary: string): string | undefined {
  const first = summary.trim().split(/\s+/)[0];
  if (!first) return undefined;
  if (!TICKER_RE.test(first)) return undefined;
  if (NOT_A_TICKER.has(first)) return undefined;
  return first;
}

function detectKind(summary: string, fallback: Catalyst["kind"]): Catalyst["kind"] {
  // AdCom is checked first: an advisory committee meeting is often described
  // alongside the PDUFA date it feeds into, and the meeting is what is dated.
  if (/\bad\s?comm?\b/i.test(summary) || /advisory\s+committee/i.test(summary)) return "adcomm";
  if (/\bpdufa\b/i.test(summary)) return "pdufa";
  return fallback;
}

/**
 * Which calendar day, in `MARKET_TZ`, this event falls on.
 *
 * The all-day branch is the one that matters. `DTSTART;VALUE=DATE:20260911` —
 * the form every event in both feeds uses — is a calendar date, not an instant.
 * Parsing it as midnight UTC and formatting that in America/New_York returns the
 * 10th, so every catalyst in the digest would be one day early, which for a
 * PDUFA date is exactly the wrong direction to be wrong in.
 */
function calendarDay(event: IcsEvent): string | undefined {
  if (event.allDay) return event.dtstart;
  if (event.dtstart.endsWith("Z")) {
    const at = new Date(event.dtstart);
    if (Number.isNaN(at.getTime())) return undefined;
    return localDateString(MARKET_TZ, at);
  }
  // Floating wall clock: the day as written is the day meant.
  return event.dtstart.slice(0, 10);
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An instant that lands on `day` in `MARKET_TZ`, so the frozen `daysUntil()` can
 * count calendar days against it.
 *
 * Noon, not midnight. Midnight does not exist on every DST-transition day in
 * every zone, and wallClockToUtc resolves a non-existent wall clock to the hour
 * either side — which is a day boundary crossed for the sake of nothing.
 */
function instantForDay(day: string): Date | undefined {
  const m = YMD_RE.exec(day);
  if (!m) return undefined;
  return wallClockToUtc(MARKET_TZ, Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0);
}

export interface CatalystOptions {
  /** The digest's own date. Recorded as `lastSuccessAt` on a healthy feed. */
  today: string;
  /** Keep catalysts between 0 and this many calendar days out, inclusive. */
  horizonDays: number;
}

interface FeedOutcome {
  catalysts: Catalyst[];
  health: SourceHealth;
}

async function fetchFeed(
  feed: CatalystFeed,
  client: HttpClient,
  now: Date,
  opts: CatalystOptions,
): Promise<FeedOutcome> {
  const started = Date.now();

  const fail = (error: string, httpStatus?: number): FeedOutcome => ({
    catalysts: [],
    health: {
      sourceId: feed.id,
      sourceName: feed.name,
      status: "failed",
      httpStatus,
      error,
      itemsParsed: 0,
      itemsKept: 0,
      parseWarnings: [],
      latencyMs: Date.now() - started,
      consecutiveFailures: 1,
      // The whole section is decoration. Marked optional so a calendar outage
      // can never push a run into the "unusable" exit code and stop the email
      // that carries the deadlines.
      optional: true,
    },
  });

  let res;
  try {
    res = await client(feed.url, {
      accept: "text/calendar, text/plain;q=0.9, */*;q=0.8",
      // Two requests to one host, and Google is generous, but this is somebody
      // else's free calendar being polled every morning forever.
      crawlDelayMs: 1500,
      expect: "ics",
      cacheKey: `catalysts:${feed.id}`,
    });
  } catch (err) {
    return fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }

  if (res.error) return fail(res.error, res.status);
  // We never send a validator for these, so a 304 means the client asked on our
  // behalf and we hold nothing to satisfy it. Reported rather than silently
  // returning zero catalysts, which is what a broken feed also looks like.
  if (res.notModified) return fail("304 with no cached body", res.status);
  if (!res.body) return fail("empty body", res.status);

  let events: IcsEvent[];
  try {
    events = parseIcs(res.body);
  } catch (err) {
    return fail(`parse failed: ${(err as Error).message}`, res.status);
  }

  const warnings: string[] = [];
  const catalysts: Catalyst[] = [];
  let cancelled = 0;
  let untitled = 0;
  let undated = 0;

  for (const event of events) {
    // A withdrawn advisory committee meeting still sits in the calendar with
    // STATUS:CANCELLED. Rendering it as upcoming states a fact that is not true.
    if (event.status === "CANCELLED") {
      cancelled++;
      continue;
    }

    const summary = event.summary.trim();
    if (!summary) {
      untitled++;
      continue;
    }

    const day = calendarDay(event);
    const instant = day ? instantForDay(day) : undefined;
    if (!day || !instant) {
      undated++;
      continue;
    }

    const until = daysUntil(instant, MARKET_TZ, now);
    if (until < 0 || until > opts.horizonDays) continue;

    const ticker = extractTicker(summary);
    const rest = ticker ? summary.slice(ticker.length).trim() : summary;
    const company = rest.replace(EVENT_PHRASE_RE, "").trim();

    catalysts.push({
      date: day,
      ...(ticker ? { ticker } : {}),
      ...(company ? { company } : {}),
      // The summary minus its ticker, so a row reading "GRAL · GRAIL, Inc. FDA
      // AdCom" does not say GRAL twice. When stripping the ticker would leave
      // nothing but the event word ("PFE Adcom"), the full summary is kept —
      // an empty label is the one outcome that is never acceptable.
      label: company ? rest : summary,
      kind: detectKind(summary, feed.kind),
      source: feed.name,
      daysUntil: until,
      watched: ticker !== undefined && WATCHED_TICKERS.has(ticker),
    });
  }

  if (cancelled) warnings.push(`${cancelled} cancelled event(s) skipped`);
  if (untitled) warnings.push(`${untitled} event(s) with no SUMMARY`);
  if (undated) warnings.push(`${undated} event(s) with an unreadable DTSTART`);

  /*
   * Zero UPCOMING events is healthy; zero events AT ALL is not.
   *
   * This distinction is the whole point of assessing these two feeds
   * separately. The AdCom calendar legitimately has exactly one upcoming
   * meeting today out of 243 — advisory committees are scheduled weeks ahead and
   * there are stretches with none. Calling that degraded would fire the health
   * warning most mornings and teach the reader to ignore it. A feed that parses
   * zero VEVENTs, on the other hand, has either changed format or been replaced
   * by something that is not a calendar, and that is invisible any other way:
   * the fetch succeeded, the parse succeeded, and the section is simply empty.
   */
  const status: SourceHealth["status"] = events.length === 0 ? "degraded" : "ok";

  return {
    catalysts,
    health: {
      sourceId: feed.id,
      sourceName: feed.name,
      status,
      httpStatus: res.status,
      itemsParsed: events.length,
      itemsKept: catalysts.length,
      parseWarnings: warnings.slice(0, 5),
      latencyMs: Date.now() - started,
      lastSuccessAt: status === "ok" ? opts.today : undefined,
      consecutiveFailures: status === "ok" ? 0 : 1,
      optional: true,
      error: status === "degraded" ? "parsed zero VEVENTs" : undefined,
    },
  };
}

/**
 * Both FDA calendars, filtered to the horizon and ranked.
 *
 * Never throws and never rejects. Every failure path returns an empty catalyst
 * list plus a `failed` health row, because the catalyst block shares a process
 * with the deadline tracker and must not share a fate with it.
 */
export async function fetchCatalysts(
  client: HttpClient,
  now: Date,
  opts: CatalystOptions,
): Promise<{ catalysts: Catalyst[]; health: SourceHealth[] }> {
  const outcomes = await Promise.all(
    CATALYST_FEEDS.map((feed) =>
      fetchFeed(feed, client, now, opts).catch(
        (err): FeedOutcome => ({
          catalysts: [],
          health: {
            sourceId: feed.id,
            sourceName: feed.name,
            status: "failed",
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            itemsParsed: 0,
            itemsKept: 0,
            parseWarnings: [],
            latencyMs: 0,
            consecutiveFailures: 1,
            optional: true,
          },
        }),
      ),
    ),
  );

  const seen = new Set<string>();
  const catalysts: Catalyst[] = [];
  for (const outcome of outcomes) {
    for (const catalyst of outcome.catalysts) {
      // The two calendars overlap: an AdCom meeting is sometimes also entered in
      // the PDUFA calendar. Same day, same company, one row.
      const key = `${catalyst.date}|${catalyst.kind}|${catalyst.ticker ?? catalyst.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      catalysts.push(catalyst);
    }
  }

  /*
   * Watched first, then by date.
   *
   * Not "soonest first". A Vertex PDUFA forty days out is worth more to this
   * reader than a company they have never heard of deciding tomorrow, and a
   * strictly chronological list buries every watched name behind whatever
   * happens to be imminent. Ticker then label break the remaining ties so the
   * order is stable across runs — an unstable sort makes yesterday's email and
   * today's differ for no reason, which is exactly the noise the rung ladder
   * exists to suppress elsewhere.
   */
  catalysts.sort((a, b) => {
    if (a.watched !== b.watched) return a.watched ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ticker = (a.ticker ?? "").localeCompare(b.ticker ?? "");
    if (ticker !== 0) return ticker;
    return a.label.localeCompare(b.label);
  });

  return { catalysts, health: outcomes.map((o) => o.health) };
}
