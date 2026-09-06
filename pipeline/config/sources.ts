/**
 * The source registry.
 *
 * A flat array of plain config objects, not an abstract base class. Adding a
 * source should be an edit to data, and the only reason to write code is a
 * genuinely new wire format.
 *
 * Every entry below was probed live on 2026-08-22 and again before shipping.
 * Where a source has a trap, the trap is recorded in `note` rather than in a
 * commit message nobody will find — these notes ARE the maintenance manual, and
 * the sibling project's equivalent file is the most useful thing in it.
 *
 * DIVISION OF LABOUR, and it is the project's central rule:
 *   config/deadlines.yml  owns every DATE. Hand-verified, changes once a year.
 *   this file             owns everything whose CONTENT changes without warning.
 * A source's job is never to discover a deadline. It is to notice that a page
 * changed, or to bring in news and jobs that have no date of their own.
 */

import type { Lane, SourceKind } from "../../lib/types.ts";

export type SourceRole = "news" | "opportunity" | "pagewatch";
export type FeedDialect = "rss2" | "rdf" | "atom" | "json" | "ats" | "html" | "csv" | "ics";
export type AtsVendor = "greenhouse" | "lever" | "ashby";
export type FullTextPolicy = "feed-only" | "scrape-allowed" | "api-body";

/** Shape of an rss-parser item after our custom fields are merged in. */
export interface RawFeedItem {
  title?: string;
  link?: string;
  guid?: string;
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  dcCreator?: string;
  dcDate?: string;
  content?: string;
  contentSnippet?: string;
  contentEncoded?: string;
  summary?: string;
  description?: string;
  categories?: string[];
  [key: string]: unknown;
}

export interface HtmlSelectors {
  /** Rows. Each match is one candidate item. Absent = the page is one item. */
  item?: string;
  title: string;
  link?: string;
  date?: string;
  body?: string;
  /** Removed before text extraction: nav, cookie banners, footers. */
  drop?: string[];
  /**
   * Fewer matches than this and the source is `degraded`, not `ok`.
   *
   * A CSS selector that stops matching is the HTML equivalent of a dead feed and
   * fails just as silently — the request succeeds, the parse succeeds, and you
   * get zero rows that read as "no news today".
   */
  requireMin?: number;
  /**
   * Text that must appear somewhere on the page.
   *
   * Catches the nastier case that `requireMin` cannot: the selector still
   * matches, but the page is now a cookie wall, a soft 404 returning 200, or a
   * "this programme is paused" notice.
   */
  sentinel?: string;
}

export interface SourceDef {
  id: string;
  name: string;
  /** Sources sharing a newsroom share a group, so corroboration counts rooms. */
  publisherGroup: string;
  homepage: string;
  role: SourceRole;
  kind: SourceKind;
  dialect: FeedDialect;
  endpoint: string;
  /** 0..1, hand-set. Never able to carry an item over the threshold alone. */
  authority: number;
  laneHints: Partial<Record<Lane, number>>;
  fullText: FullTextPolicy;
  paywalled: boolean;
  crawlDelayMs: number;
  conditionalGet: boolean;
  maxItems: number;
  enabled: boolean;
  /** An optional source can fail without making the run unusable. */
  optional: boolean;
  retries?: number;
  timeZone?: string;
  selectors?: HtmlSelectors;
  ats?: { vendor: AtsVendor; token: string; company: string; expectLocation?: RegExp };
  /** Registry programs this source is the authoritative page for. */
  programIds?: string[];
  exclude?: { urlPatterns?: RegExp[]; titlePatterns?: RegExp[] };
  /**
   * Keep an item only if title or body matches one of these.
   *
   * For a fellowship organisation's own feed, matching the lexicon is trivial
   * and meaningless: every post on gatescambridge.org contains "Gates
   * Cambridge". The first live run surfaced "Celebrating the Gates Cambridge
   * Weekend" and "Gates Cambridge Originals: Oksana Ruzak" above real news,
   * because a term that appears in EVERY item from a source carries no
   * information about any of them. This narrows those feeds to the handful of
   * posts that are actually about a cycle.
   */
  requireAny?: RegExp[];
  parser?: { title?: string; date?: string; link?: string };
  /** Hand-recorded with the date checked. Never fetched at runtime. */
  robots: "checked-allows" | "checked-disallows" | "unchecked";
  note?: string;
}

const DEFAULTS = {
  fullText: "feed-only" as FullTextPolicy,
  paywalled: false,
  crawlDelayMs: 1000,
  conditionalGet: true,
  maxItems: 40,
  enabled: true,
  optional: true,
  robots: "checked-allows" as const,
};

function news(def: Partial<SourceDef> & Pick<SourceDef, "id" | "name" | "publisherGroup" | "homepage" | "endpoint" | "authority" | "laneHints">): SourceDef {
  return { ...DEFAULTS, role: "news", kind: "news", dialect: "rss2", ...def } as SourceDef;
}

function substack(id: string, name: string, endpoint: string, authority: number, laneHints: Partial<Record<Lane, number>>, note?: string): SourceDef {
  return news({
    id, name, publisherGroup: `substack:${id}`, homepage: new URL(endpoint).origin,
    endpoint, authority, laneHints, maxItems: 20, note,
  });
}

/**
 * Greenhouse boards.
 *
 * `?content=true` is not optional: without it the API returns titles only, and
 * a bodyless job is unmatchable against "Mendelian randomization" or "target
 * discovery", which is the entire reason these are here.
 *
 * `expectLocation`/`company` exist because a WRONG TOKEN RETURNS HTTP 200 with
 * somebody else's jobs. Verified on 2026-08-22: greenhouse `verve` is an
 * ad-tech firm, `beam` is a mathematics nonprofit, `nucleus` is a UK agency and
 * `ora` is an ophthalmology CRO. Asserting identity rather than status is the
 * only defence.
 */
function greenhouse(id: string, company: string, token: string, laneHints: Partial<Record<Lane, number>> = { "venture-founder": 1 }): SourceDef {
  return {
    ...DEFAULTS,
    id: `gh-${id}`,
    name: `${company} — jobs`,
    publisherGroup: `ats:${id}`,
    homepage: `https://boards.greenhouse.io/${token}`,
    role: "opportunity",
    kind: "jobs",
    dialect: "ats",
    endpoint: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
    authority: 0.6,
    laneHints,
    conditionalGet: false,
    maxItems: 200,
    ats: { vendor: "greenhouse", token, company },
    robots: "checked-allows",
  } as SourceDef;
}

export const SOURCES: SourceDef[] = [
  /* ─────────────────────────── news: trade press ─────────────────────────── */
  news({
    id: "biopharma-dive", name: "BioPharma Dive", publisherGroup: "industry-dive",
    homepage: "https://www.biopharmadive.com", endpoint: "https://www.biopharmadive.com/feeds/news/",
    authority: 0.8, laneHints: { "tools-platforms": 0.6, "causal-genetics": 0.3 },
    note: "Cleanest feed in the trade press: RFC-822 dates, plain titles, no gate. Only ~10 items, so a missed day is a lost day.",
  }),
  news({
    id: "fierce-biotech", name: "Fierce Biotech", publisherGroup: "questex",
    homepage: "https://www.fiercebiotech.com", endpoint: "https://www.fiercebiotech.com/rss/xml",
    authority: 0.75, laneHints: { "tools-platforms": 0.6, "causal-genetics": 0.3 },
    parser: { date: "fierce" },
    note: "pubDate is NOT RFC-822 ('Aug 21, 2026 9:15am') so a naive parser leaves every item undated; items arrive out of date order; <title> and <dc:creator> contain <a href> HTML. Never fetch the article HTML — 403 Cloudflare.",
  }),
  news({
    id: "fierce-pharma", name: "Fierce Pharma", publisherGroup: "questex",
    homepage: "https://www.fiercepharma.com", endpoint: "https://www.fiercepharma.com/rss/xml",
    authority: 0.7, laneHints: { "tools-platforms": 0.5 }, parser: { date: "fierce" },
    note: "Same newsroom as Fierce Biotech, hence the shared publisherGroup — corroboration must not count one outlet twice.",
  }),
  news({
    id: "stat", name: "STAT", publisherGroup: "stat",
    homepage: "https://www.statnews.com", endpoint: "https://www.statnews.com/feed/",
    authority: 0.85, laneHints: { "causal-genetics": 0.4, "tools-platforms": 0.5 },
    note: "Paywall detection is exactly `title.startsWith('STAT+: ')`. robots disallows ClaudeBot/GPTBot by name while allowing /feed/ to generic clients, so the UA must stay honest and generic.",
  }),
  news({
    id: "endpoints", name: "Endpoints News", publisherGroup: "endpoints",
    homepage: "https://endpoints.news", endpoint: "https://endpoints.news/feed/",
    authority: 0.85, laneHints: { "tools-platforms": 0.5, "venture-founder": 0.4 },
    note: "Use the endpoints.news host: the endpts.com alias 403s from CloudFront. Headline + ~250-char dek only, no content:encoded.",
  }),

  /* ────────────────────── news: venture and commentary ───────────────────── */
  news({
    id: "lifescivc", name: "LifeSciVC (Bruce Booth)", publisherGroup: "atlas",
    homepage: "https://lifescivc.com", endpoint: "https://lifescivc.com/feed/",
    authority: 0.8, laneHints: { "venture-founder": 1 }, maxItems: 15,
    note: "330KB of full text — read `description`, not content:encoded, or every item blows the body budget.",
  }),
  substack("owlposting", "Owl Posting", "https://www.owlposting.com/feed", 0.6,
    { "causal-genetics": 0.7, "tools-platforms": 0.5 },
    "Works ONLY on the custom domain; the *.substack.com host 404s."),
  substack("decodingbio", "Decoding Bio", "https://decodingbio.substack.com/feed", 0.6,
    { "causal-genetics": 0.6, "tools-platforms": 0.6 },
    "Works ONLY on *.substack.com; the custom domain does not serve the feed. The inverse of Owl Posting — host choice is the whole problem, not the path."),
  substack("ruxandra", "Ruxandra Teslo", "https://www.writingruxandrabio.com/feed", 0.5,
    { "causal-genetics": 0.6 }, "Custom domain only."),
  substack("centuryofbio", "Century of Biology", "https://centuryofbio.com/feed", 0.7,
    { "causal-genetics": 0.7, "tools-platforms": 0.6 }, "Custom domain only."),

  /* ───────────────────────── news: journals ──────────────────────────────── */
  news({
    id: "nature-biotech", name: "Nature Biotechnology", publisherGroup: "springer-nature",
    homepage: "https://www.nature.com/nbt", endpoint: "https://www.nature.com/nbt.rss",
    authority: 0.9, kind: "journal", laneHints: { "tools-platforms": 0.8 }, maxItems: 15,
    note: "The ?error=cookies_not_supported redirect is cosmetic. 8 items.",
  }),
  news({
    id: "nature-aging", name: "Nature Aging", publisherGroup: "springer-nature",
    homepage: "https://www.nature.com/nataging", endpoint: "https://www.nature.com/nataging.rss",
    authority: 0.9, kind: "journal", laneHints: { "causal-genetics": 0.9 }, maxItems: 15,
  }),
  news({
    id: "nature-methods", name: "Nature Methods", publisherGroup: "springer-nature",
    homepage: "https://www.nature.com/nmeth", endpoint: "https://www.nature.com/nmeth.rss",
    authority: 0.9, kind: "journal", laneHints: { "causal-genetics": 0.8, "tools-platforms": 0.5 }, maxItems: 15,
    note: "The scMethyl manuscript's likely target journal — worth watching for competing methods.",
  }),

  /* ──────────────────── opportunity: cycle early-warning ─────────────────── */
  {
    ...DEFAULTS,
    id: "sdn-physician-scientists", name: "SDN — Physician Scientists", publisherGroup: "sdn",
    homepage: "https://forums.studentdoctor.net/forums/physician-scientists.32/",
    role: "opportunity", kind: "forum", dialect: "rss2",
    endpoint: "https://forums.studentdoctor.net/forums/physician-scientists.32/index.rss",
    authority: 0.3, laneHints: { "mstp-labs": 0.8 }, maxItems: 25,
    robots: "checked-allows",
    note: "The best early warning that a cycle went live — applicants post 'the app is open' before institutions announce it. RUMOUR GRADE: always link back, never republish bodies, and it must never write a date into the registry. robots allows *, though it disallows ClaudeBot by name, so the UA stays generic.",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "gates-cambridge-news", name: "Gates Cambridge — news", publisherGroup: "gates-cambridge",
    homepage: "https://www.gatescambridge.org",
    role: "opportunity", kind: "news", dialect: "rss2",
    endpoint: "https://www.gatescambridge.org/?feed=rss2&post_type=news",
    authority: 0.7, laneHints: { fellowships: 1 }, maxItems: 15,
    programIds: ["gates-cambridge-us"], robots: "checked-allows",
    requireAny: [
      /\b(applications?|nominations?)\b.{0,40}\b(open|close|deadline|due|invited|accepted|live)\b/i,
      /\b(deadline|now accepting|call for applications|apply (now|by)|closing date)\b/i,
      /\b(cycle|competition)\b.{0,30}\b(open|launch|announce)\b/i,
      /\bshortlist|\binterview (dates|schedule)\b/i,
    ],
    note: "The default /feed/ is valid RSS with ZERO items — news lives in a custom post type that is absent from the WP REST API, so this query string is the only route. A source returning a well-formed empty feed forever is the exact silent failure the volume check exists for.",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "pdsoros-news", name: "PD Soros — news", publisherGroup: "pdsoros",
    homepage: "https://www.pdsoros.org", role: "opportunity", kind: "news", dialect: "rss2",
    endpoint: "https://pdsoros.org/feed/", authority: 0.7, laneHints: { fellowships: 1 },
    maxItems: 15, programIds: ["pd-soros"], robots: "checked-allows",
    requireAny: [
      /\b(applications?|nominations?)\b.{0,40}\b(open|close|deadline|due|invited|accepted|live)\b/i,
      /\b(deadline|now accepting|call for applications|apply (now|by)|closing date)\b/i,
      /\b(cycle|competition)\b.{0,30}\b(open|launch|announce)\b/i,
      /\bshortlist|\binterview (dates|schedule)\b/i,
    ],
    note: "Hardcode the https apex: www.pdsoros.org/feed 301s to an http:// URL, and a redirect that downgrades the scheme is a redirect worth not following.",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "schmidt-news", name: "Schmidt Science Fellows — news", publisherGroup: "schmidt",
    homepage: "https://schmidtsciencefellows.org", role: "opportunity", kind: "news", dialect: "rss2",
    endpoint: "https://schmidtsciencefellows.org/feed/", authority: 0.6,
    laneHints: { fellowships: 1 }, maxItems: 15, programIds: ["schmidt-science-fellows"],
    requireAny: [
      /\b(applications?|nominations?)\b.{0,40}\b(open|close|deadline|due|invited|accepted|live)\b/i,
      /\b(deadline|now accepting|call for applications|apply (now|by)|closing date)\b/i,
      /\b(cycle|competition)\b.{0,30}\b(open|launch|announce)\b/i,
      /\bshortlist|\binterview (dates|schedule)\b/i,
    ],
    robots: "checked-allows",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "nih-guide-nofo", name: "NIH Guide — funding opportunities", publisherGroup: "nih",
    homepage: "https://grants.nih.gov", role: "opportunity", kind: "grants", dialect: "rss2",
    endpoint: "https://grants.nih.gov/grants/guide/newsfeed/fundingopps.xml",
    authority: 0.8, laneHints: { fellowships: 0.8, "mstp-labs": 0.4 }, maxItems: 25,
    optional: false, robots: "checked-allows",
    note: "A same-day tripwire and nothing more: 5 items on a ~48h rolling window, so a missed run loses NOFOs permanently — which is what the catch-up cron is for. ISO-8859-1, so the charset must be declared. No institute or activity-code filtering exists anywhere in the NIH feed estate; filter locally on F30 / Kirschstein / NOT-AG- / RFA-AG-.",
  } as SourceDef,

  /* ─────────────────── opportunity: ATS job boards (JSON) ────────────────── */
  {
    ...DEFAULTS,
    id: "lever-convergent", name: "Convergent Research (all FROs)", publisherGroup: "ats:convergent",
    homepage: "https://www.convergentresearch.org", role: "opportunity", kind: "jobs",
    dialect: "ats", endpoint: "https://api.lever.co/v0/postings/convergentresearch?mode=json",
    authority: 0.8, laneHints: { "venture-founder": 1 }, conditionalGet: false, maxItems: 100,
    ats: { vendor: "lever", token: "convergentresearch", company: "Convergent Research" },
    robots: "checked-allows",
    note: "The highest-value single endpoint found. One flat array covers EVERY FRO via categories.team (E11 Bio, PTI, Melody, Atlas) and carried a live Founder in Residence on 2026-08-22 — it replaces about six scrapers. createdAt is EPOCH MILLISECONDS, so a parser expecting a string silently yields 1970.",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "lever-retro", name: "Retro Biosciences", publisherGroup: "ats:retro",
    homepage: "https://www.retro.bio", role: "opportunity", kind: "jobs", dialect: "ats",
    endpoint: "https://api.lever.co/v0/postings/retro?mode=json",
    authority: 0.6, laneHints: { "venture-founder": 1 }, conditionalGet: false, maxItems: 60,
    ats: { vendor: "lever", token: "retro", company: "Retro Biosciences" },
    robots: "checked-allows",
    note: "The token is `retro`, not `retrobiosciences` — the obvious guess 404s.",
  } as SourceDef,
  {
    ...DEFAULTS,
    id: "ashby-insitro", name: "insitro", publisherGroup: "ats:insitro",
    homepage: "https://www.insitro.com", role: "opportunity", kind: "jobs", dialect: "ats",
    endpoint: "https://api.ashbyhq.com/posting-api/job-board/insitro",
    authority: 0.6, laneHints: { "venture-founder": 0.8, "causal-genetics": 0.5 },
    conditionalGet: false, maxItems: 80,
    ats: { vendor: "ashby", token: "insitro", company: "insitro" },
    robots: "checked-allows",
    note: "Skip isListed:false. An UNKNOWN Ashby token returns 200 with {\"jobs\":[]}, so a typo is invisible — which is why ATS sources must be wired into the trailing-median volume check.",
  } as SourceDef,
  greenhouse("recursion", "Recursion", "recursionpharmaceuticals", { "venture-founder": 0.7, "causal-genetics": 0.6 }),
  greenhouse("variantbio", "Variant Bio", "variantbio", { "causal-genetics": 1 }),
  greenhouse("newlimit", "NewLimit", "newlimit", { "causal-genetics": 0.9, "venture-founder": 0.6 }),
  greenhouse("altoslabs", "Altos Labs", "altoslabs", { "causal-genetics": 0.9 }),
  greenhouse("calicolabs", "Calico", "calicolabs", { "causal-genetics": 0.9 }),
  greenhouse("arcinstitute", "Arc Institute", "arcinstitute", { "causal-genetics": 0.8, "venture-founder": 0.5 }),
  greenhouse("arcadiascience", "Arcadia Science", "arcadiascience", { "causal-genetics": 0.6, "venture-founder": 0.5 }),
  greenhouse("beamtx", "Beam Therapeutics", "beamtherapeutics", { "causal-genetics": 0.7 }),
  // Disabled, not deleted. The token is VALID — boards-api answers 200 with
  // {"jobs":[],"meta":{"total":0}}, while alnylam / Alnylam /
  // alnylampharmaceuticalsinc all 404 — so this is a real board that currently
  // carries no public postings, not a typo. Left enabled it reports DEGRADED
  // every single day, and a health table with a permanent red line in it is a
  // health table nobody reads. Re-enable if Alnylam starts posting again.
  { ...greenhouse("alnylam", "Alnylam", "alnylampharmaceuticals", { "causal-genetics": 0.5 }), enabled: false },
];

/**
 * Pages watched for CHANGE only. No parsing, no dates, no selectors.
 *
 * This is THE ONE RULE in its most literal form. Every URL here belongs to a
 * program whose deadline lives in config/deadlines.yml, hand-verified. All we
 * ask of the network is "did this page change since yesterday?", and a change
 * produces one line in the email asking a human to look.
 *
 * It cannot lie about a date because it never reads one, it cannot silently
 * return zero because a fetch failure is a fetch failure, and it is roughly 120
 * lines for every program rather than a bespoke parser each. Deleting the whole
 * mechanism costs only the 90-day verification timer.
 */
export interface PageWatch {
  programId: string;
  url: string;
  /** Full Chrome-ish headers. Some hosts 403 a bare UA and 200 a browser one. */
  browserHeaders?: boolean;
  crawlDelayMs?: number;
  note?: string;
}

export const PAGE_WATCHES: PageWatch[] = [
  { programId: "rhodes-us", url: "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship",
    note: "States no date at all. We watch for the page changing, never for a date." },
  { programId: "gates-cambridge-us", url: "https://www.gatescambridge.org/apply/",
    note: "/apply/ 302s to http://www.gatescambridge.org/// and lands on the homepage, so the hash is of the homepage. Still useful as a change signal; do not read anything into its content." },
  { programId: "hertz-fellowship", url: "https://www.hertzfoundation.org/the-fellowship/", browserHeaders: true, crawlDelayMs: 10_000,
    note: "403s a bare UA, 200s with full browser headers. Declares Crawl-delay: 10." },
  { programId: "pd-soros", url: "https://www.pdsoros.org/apply", browserHeaders: true },
  { programId: "knight-hennessy", url: "https://knight-hennessy.stanford.edu/admission", crawlDelayMs: 30_000,
    note: "Declares Crawl-delay: 30. Honour it." },
  { programId: "nucleate-activator-us", url: "https://nucleate.org/", browserHeaders: true, crawlDelayMs: 10_000,
    note: "A bare UA gets a 5.5KB stub, browser headers get the real 153KB page. Says 'October 21st' with no year beside a 2024 COHORT block — the canonical reason we hash rather than parse." },
  { programId: "activate-fellowship", url: "https://www.activate.org/apply" },
  { programId: "hhmi-gilliam", url: "https://www.hhmi.org/developing-scientists/gilliam-fellowships-advanced-study",
    note: "The obvious /programs/gilliam-fellowships-advanced-study 404s, as do two other plausible guesses — and HHMI serves a 29KB body with its 404s, so a size check alone would call it healthy. This is the path that answers 200." },
  { programId: "ardd-2026", url: "https://agingpharma.org/registration",
    note: "Prints 'The deadline is August 31' with NO YEAR, while its tidier /deadline page is frozen on 2025. Hash the live one." },
  { programId: "abrcms-2026", url: "https://abrcms.org/present-at-abrcms/submit-an-abstract/" },
  { programId: "age-annual-2027", url: "https://www.americanagingassociation.org/annual-meeting" },
  { programId: "broad-bbps", url: "https://broadinstitute.avature.net/en_US/careers/SearchJobs/feed/",
    note: "broadinstitute.org 403s every path including robots.txt. The Avature careers feed is the documented back door — robots explicitly Allow: /careers." },
];

/** Sources that are enabled, in a stable order. */
export function enabledSources(): SourceDef[] {
  return SOURCES.filter((s) => s.enabled);
}

/**
 * Dead endpoints, kept as tombstones so they are not re-added from an old note.
 * Cheap, and it has already saved the sibling project twice.
 */
export const RETIRED_ENDPOINTS: { url: string; why: string }[] = [
  { url: "https://nucleate.org/feed/", why: "200 + valid RSS + ZERO items, forever. Nucleate publishes no posts." },
  { url: "https://www.rhodesscholar.org/feed/", why: "200 serving an HTML page, not a feed." },
  { url: "https://www.hertzfoundation.org/feed/", why: "Soft 200 serving the 593KB homepage." },
  { url: "https://www.nature.com/naturecareers/jobs/feed", why: "200 text/html — not a feed." },
  { url: "https://www.sciencemag.org/rss/careers.xml", why: "404. No working Science Careers jobs feed exists." },
  { url: "https://stooq.com/q/l/", why: "200 carrying a SHA-256 proof-of-work challenge; robots.txt Disallow: /." },
  { url: "https://api.sbir.gov/", why: "403 on every variant; the maintainers say it is under maintenance." },
  { url: "https://www.ashg.org/wp-json/wp/v2/", why: "401, Kadence-locked. The abstract date lives in a noindex SPA." },
];
