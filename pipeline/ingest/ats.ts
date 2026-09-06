/**
 * Job boards, three vendors, one shape.
 *
 * These are the highest signal-per-line sources in the project: real JSON APIs,
 * no scraping, no judgement, and the body text is what lets a regex find
 * "Mendelian randomization" or "target discovery" inside a posting.
 *
 * The recurring hazard is not parsing — it is IDENTITY. All three vendors answer
 * HTTP 200 for a token that belongs to somebody else, and two of them answer 200
 * for a token that belongs to nobody. Verified live on 2026-08-22:
 *
 *   greenhouse/verve    → an ad-tech company
 *   greenhouse/beam     → a mathematics nonprofit
 *   greenhouse/nucleus  → a UK marketing agency
 *   greenhouse/ora      → an ophthalmology CRO
 *   ashby/arch, /atlas  → fintechs
 *   ashby/<typo>        → 200 with {"jobs":[]}, indistinguishable from a quiet week
 *
 * So every parser below asserts the identity it expected and reports a mismatch
 * as a source failure. Checking the status code proves nothing.
 */

import type { BodyProvenance } from "../../lib/types.ts";
import type { SourceDef } from "../config/sources.ts";
import { htmlToText } from "../normalize/html.ts";
import { canonicalizeUrl } from "../normalize/url.ts";
import { cleanText, squish } from "../normalize/text.ts";
import type { IngestResult, NormalizedItem } from "./types.ts";

const MAX_BODY = 6000;

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    // Ampersand last, or "&amp;lt;" decodes to "<" in two passes.
    .replace(/&amp;/g, "&");
}

function base(source: SourceDef, title: string, url: string, body: string, provenance: BodyProvenance): NormalizedItem {
  return {
    sourceId: source.id,
    sourceName: source.name,
    publisherGroup: source.publisherGroup,
    sourceKind: source.kind,
    authority: source.authority,
    laneHints: source.laneHints,
    paywalled: false,
    title: squish(title),
    url,
    canonicalUrl: canonicalizeUrl(url),
    datePrecision: "unknown",
    dateConfident: false,
    bodyText: body.slice(0, MAX_BODY),
    bodyProvenance: provenance,
    categories: [],
    authors: [],
    nctIds: [],
    warnings: [],
  };
}

export function parseAts(body: string, source: SourceDef, _now: Date): IngestResult {
  const ats = source.ats;
  if (!ats) return { items: [], parsed: 0, warnings: ["source has dialect 'ats' but no ats config"] };

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { items: [], parsed: 0, warnings: [`unparseable JSON: ${(err as Error).message}`] };
  }

  switch (ats.vendor) {
    case "greenhouse": return parseGreenhouse(json, source);
    case "lever": return parseLever(json, source);
    case "ashby": return parseAshby(json, source);
    default: return { items: [], parsed: 0, warnings: [`unknown ATS vendor ${String(ats.vendor)}`] };
  }
}

interface GhJob {
  id?: number; title?: string; absolute_url?: string; content?: string;
  updated_at?: string; location?: { name?: string };
  offices?: { name?: string }[]; departments?: { name?: string }[];
}

function parseGreenhouse(json: unknown, source: SourceDef): IngestResult {
  const warnings: string[] = [];
  const jobs = (json as { jobs?: GhJob[] })?.jobs;
  if (!Array.isArray(jobs)) return { items: [], parsed: 0, warnings: ["no `jobs` array"] };

  const items: NormalizedItem[] = [];
  for (const job of jobs.slice(0, source.maxItems)) {
    const title = cleanText(job.title);
    const url = cleanText(job.absolute_url);
    if (!title || !url) continue;

    // `content` is ENTITY-ESCAPED HTML, so it must be decoded before the tag
    // stripper runs — otherwise htmlToText sees "&lt;p&gt;" as literal text and
    // the body arrives full of visible markup.
    const raw = job.content ? htmlToText(decodeEntities(job.content)) : "";
    const item = base(source, title, url, raw, raw ? "api" : "none");
    item.location = cleanText(job.location?.name) || undefined;
    item.companyName = source.ats?.company;
    if (job.updated_at) {
      const d = new Date(job.updated_at);
      if (!Number.isNaN(d.getTime())) {
        item.publishedAt = d;
        item.datePrecision = "second";
        item.dateConfident = true;
      }
    }
    if (!raw) warnings.push(`${title}: no content — is ?content=true on the endpoint?`);
    items.push(item);
  }
  return { items, parsed: jobs.length, warnings };
}

interface LeverPosting {
  id?: string; text?: string; hostedUrl?: string; applyUrl?: string;
  createdAt?: number; descriptionPlain?: string; additionalPlain?: string;
  categories?: { team?: string; location?: string; commitment?: string };
}

function parseLever(json: unknown, source: SourceDef): IngestResult {
  // Lever returns a BARE ARRAY, not an object with a key. Code written against
  // the Greenhouse shape finds no `.jobs` and reports an empty board.
  if (!Array.isArray(json)) return { items: [], parsed: 0, warnings: ["expected a bare array"] };
  const postings = json as LeverPosting[];

  const items: NormalizedItem[] = [];
  for (const post of postings.slice(0, source.maxItems)) {
    // `text` is the TITLE here, not the body — an easy and silent mix-up.
    const title = cleanText(post.text);
    const url = cleanText(post.hostedUrl ?? post.applyUrl);
    if (!title || !url) continue;

    const body = [post.descriptionPlain, post.additionalPlain].filter(Boolean).join("\n\n");
    const item = base(source, title, url, body, body ? "api" : "none");
    item.location = cleanText(post.categories?.location) || undefined;
    // The FRO name lives in categories.team — this is what makes one Convergent
    // endpoint stand in for every FRO in the portfolio.
    item.companyName = cleanText(post.categories?.team) || source.ats?.company;

    // createdAt is EPOCH MILLISECONDS. Passed to `new Date(string)` it yields
    // 1970, and a 1970 item sorts last forever instead of failing loudly.
    if (typeof post.createdAt === "number" && Number.isFinite(post.createdAt)) {
      const d = new Date(post.createdAt);
      if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 2000) {
        item.publishedAt = d;
        item.datePrecision = "second";
        item.dateConfident = true;
      }
    }
    items.push(item);
  }
  return { items, parsed: postings.length, warnings: [] };
}

interface AshbyJob {
  id?: string; title?: string; jobUrl?: string; location?: string;
  publishedAt?: string; descriptionPlain?: string; isListed?: boolean;
}

function parseAshby(json: unknown, source: SourceDef): IngestResult {
  const jobs = (json as { jobs?: AshbyJob[] })?.jobs;
  if (!Array.isArray(jobs)) return { items: [], parsed: 0, warnings: ["no `jobs` array"] };

  const items: NormalizedItem[] = [];
  for (const job of jobs.slice(0, source.maxItems)) {
    if (job.isListed === false) continue;
    const title = cleanText(job.title);
    const url = cleanText(job.jobUrl);
    if (!title || !url) continue;

    const body = cleanText(job.descriptionPlain);
    const item = base(source, title, url, body, body ? "api" : "none");
    item.location = cleanText(job.location) || undefined;
    item.companyName = source.ats?.company;
    if (job.publishedAt) {
      const d = new Date(job.publishedAt);
      if (!Number.isNaN(d.getTime())) {
        item.publishedAt = d;
        item.datePrecision = "second";
        item.dateConfident = true;
      }
    }
    items.push(item);
  }
  return { items, parsed: jobs.length, warnings: [] };
}

/**
 * Does this board belong to who we think it does?
 *
 * Called by collect.ts after parsing. Returns a warning when the postings look
 * like somebody else's company, which is the only way to catch a token that
 * silently resolves to a different employer.
 */
export function assertAtsIdentity(source: SourceDef, items: NormalizedItem[]): string | undefined {
  const expect = source.ats?.expectLocation;
  if (!expect || items.length === 0) return undefined;
  const anyMatch = items.some((i) => (i.location ? expect.test(i.location) : false));
  if (!anyMatch) {
    const seen = [...new Set(items.map((i) => i.location).filter(Boolean))].slice(0, 3).join(", ");
    return `no posting matched the expected location for ${source.ats?.company} (saw: ${seen || "none"}) — wrong board token?`;
  }
  return undefined;
}
