import Parser from "rss-parser";

import type { BodyProvenance } from "../../lib/types.ts";
import { parseFeedDate } from "../normalize/pubdates.ts";
import { wallClockToUtc } from "../normalize/dates.ts";
import { cleanTitleMarkup, htmlToText, stripJournalBoilerplate } from "../normalize/html.ts";
import { canonicalizeUrl, extractDoi } from "../normalize/url.ts";
import { cleanText, squish, truncateWords } from "../normalize/text.ts";
import type { RawFeedItem, SourceDef } from "../config/sources.ts";
import type { IngestResult, NormalizedItem } from "./types.ts";

/**
 * Feed parsing. We hand rss-parser a string we fetched ourselves — never
 * `parseURL`, which hung >120s in testing and 403s on endpoints.news.
 */
const parser: Parser<Record<string, unknown>, RawFeedItem> = new Parser({
  customFields: {
    item: [
      ["content:encoded", "ce"],
      ["dc:date", "dcDate"],
      ["dc:creator", "dcCreator"],
      ["prism:publicationDate", "prismDate"],
      ["prism:doi", "doi"],
      ["description", "rawDescription"],
    ],
  },
});

const NCT_RE = /\bNCT\s?0?\d{7,8}\b/gi;

/** Body text, in order of preference, with the origin recorded honestly. */
function pickBody(
  raw: RawFeedItem,
  source: SourceDef,
): { text: string; provenance: BodyProvenance } {
  const encoded = cleanText(raw.ce);
  if (encoded) {
    const text = source.kind === "journal" || source.kind === "preprint"
      ? stripJournalBoilerplate(htmlToText(encoded))
      : htmlToText(encoded);
    if (text.length > 40) return { text, provenance: "content:encoded" };
  }

  const description = cleanText(raw.rawDescription ?? raw.contentSnippet ?? raw.content);
  if (description) {
    const text = source.kind === "journal" || source.kind === "preprint"
      ? stripJournalBoilerplate(htmlToText(description))
      : htmlToText(description);
    // Short bodies are deks, not articles. Say so rather than implying more.
    if (text.length > 0) {
      return { text, provenance: text.length >= 400 ? "description" : "dek" };
    }
  }

  return { text: "", provenance: "none" };
}

function pickDate(raw: RawFeedItem, source: SourceDef, now: Date) {
  // Named strategies rather than inline functions, so the registry stays plain
  // serialisable data and a per-publisher quirk is a documented string instead
  // of a closure buried in a config array.
  if (source.parser?.date === "fierce") {
    const parsed = parseFierceDate(raw.pubDate ?? raw.isoDate);
    if (parsed.date) return parsed;
    // Fall through rather than return a miss: if Fierce ever fixes its dates,
    // the generic path below should quietly start working.
  }

  const zone = source.timeZone ?? "UTC";
  const candidates: unknown[] = [raw.isoDate, raw.pubDate, raw.dcDate, raw.prismDate];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const parsed = parseFeedDate(candidate, { assumeTimeZone: zone, now });
    if (parsed.date) return parsed;
  }
  return parseFeedDate(undefined);
}

function isExcluded(source: SourceDef, url: string, title: string): boolean {
  const exclude = source.exclude;
  if (!exclude) return false;
  if (exclude.urlPatterns?.some((re) => re.test(url))) return true;
  if (exclude.titlePatterns?.some((re) => re.test(title))) return true;
  return false;
}

export async function parseFeed(
  xml: string,
  source: SourceDef,
  now: Date,
): Promise<IngestResult> {
  const warnings: string[] = [];
  const feed = await parser.parseString(xml);
  const rawItems = (feed.items ?? []) as RawFeedItem[];
  const items: NormalizedItem[] = [];

  let unparseableDates = 0;
  let objectTitles = 0;
  let filteredByRule = 0;

  for (const raw of rawItems.slice(0, source.maxItems)) {
    if (raw.title != null && typeof raw.title !== "string") objectTitles++;

    // cleanTitleMarkup strips the <a href> that Fierce puts inside <title> and
    // <dc:creator>, which is why it runs on every source rather than just theirs.
    const title = squish(cleanTitleMarkup(cleanText(raw.title)));
    const link = squish(cleanText(raw.link));

    if (!title || !link) continue;
    if (isExcluded(source, link, title)) continue;

    const canonicalUrl = canonicalizeUrl(link);
    if (!canonicalUrl) continue;

    const date = pickDate(raw, source, now);
    if (!date.date) unparseableDates++;
    if (date.warning) warnings.push(date.warning);

    const body = pickBody(raw, source);
    const paywalled = source.paywalled || /^\s*STAT\+:/i.test(title);
    const cleanTitle = title.replace(/^\s*STAT\+:\s*/i, "");

    const categories = Array.isArray(raw.categories)
      ? raw.categories.map((c) => cleanText(c)).filter(Boolean)
      : [];
    const creator = cleanText(raw.dcCreator ?? raw.creator);

    // requireAny: for a source whose every item matches the lexicon trivially
    // (a fellowship org writing about its own fellowship), keep only the items
    // that are actually about a cycle. Checked against title AND body, because
    // the date-bearing sentence is usually not in the headline.
    if (source.requireAny?.length) {
      const hay = `${cleanTitle} ${body.text.slice(0, 1200)}`;
      if (!source.requireAny.some((re) => re.test(hay))) {
        filteredByRule++;
        continue;
      }
    }


    const nctIds = [...new Set((`${cleanTitle} ${body.text}`.match(NCT_RE) ?? []).map((n) => n.replace(/\s/g, "").toUpperCase()))];

    items.push({
      sourceId: source.id,
      sourceName: source.name,
      publisherGroup: source.publisherGroup,
      sourceKind: source.kind,
      authority: source.authority,
      laneHints: source.laneHints,
      paywalled,

      title: cleanTitle,
      url: link,
      canonicalUrl,
      guid: cleanText(raw.guid) || undefined,

      publishedAt: date.date ?? undefined,
      datePrecision: date.precision,
      dateConfident: date.confident,

      bodyText: truncateWords(body.text, 6000),
      bodyProvenance: body.provenance,

      categories,
      authors: creator ? [creator] : [],
      doi: cleanText(raw.doi) || extractDoi(`${link} ${body.text}`),
      nctIds,
      warnings: [],
    });
  }

  if (objectTitles > 0) warnings.push(`title-was-object:${objectTitles}`);
  if (unparseableDates > 0) warnings.push(`unparseable-date:${unparseableDates}`);

  return { items, parsed: rawItems.length, warnings , filteredByRule };
}


/**
 * Fierce Biotech / Fierce Pharma publish "Aug 21, 2026 9:15am" — not RFC-822,
 * and not anything rss-parser recognises, so `isoDate` comes back undefined and
 * every Fierce item silently becomes undated. An undated item cannot be scored
 * on recency and cannot be ordered, so the whole source degrades to noise
 * without ever failing.
 *
 * The publisher is US Eastern; there is no zone in the string.
 */
const FIERCE_RE =
  /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i;

const FIERCE_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseFierceDate(raw: unknown): { date: Date | null; precision: "minute" | "unknown"; from: "pubDate" | "none"; confident: boolean; warning?: string } {
  const miss = { date: null, precision: "unknown" as const, from: "none" as const, confident: false };
  if (raw == null) return miss;
  const m = FIERCE_RE.exec(String(raw).replace(/\s+/g, " ").trim());
  if (!m) return miss;

  const month = FIERCE_MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  if (month === undefined) return miss;

  let hour = Number(m[4]);
  if ((m[6] ?? "").toLowerCase() === "p" && hour !== 12) hour += 12;
  if ((m[6] ?? "").toLowerCase() === "a" && hour === 12) hour = 0;

  return {
    date: wallClockToUtc("America/New_York", Number(m[3]), month, Number(m[2]), hour, Number(m[5])),
    precision: "minute",
    from: "pubDate",
    confident: true,
  };
}
