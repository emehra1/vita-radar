/**
 * URL canonicalization. Every pattern here was observed in our feeds:
 *   ?utm_campaign=rss   STAT
 *   ?rss=1              bioRxiv / medRxiv
 *   ?rss=yes            Cell
 *   http://             FDA press releases
 *   endpts.com          301 → endpoints.news
 * Canonical URLs are the item identity, so getting this wrong means duplicates
 * across runs and broken "first seen" dating.
 */

const TRACKING_PARAM =
  /^(utm_\w+|mc_\w+|mkt_\w+|_hs\w*|hsa_\w+|ref|ref_src|referrer|fbclid|gclid|gbraid|wbraid|igshid|mibextid|cmpid|campaign|source|spm|rss|feed|at_\w+|ito|smid|partner)$/i;

/** Hosts we always upgrade to https (they serve http links in their feeds). */
const HTTPS_ONLY = new Set(["www.fda.gov", "fda.gov"]);

/** Permanent host renames. Cheaper and more reliable than following 301s. */
const HOST_ALIASES: Record<string, string> = {
  "endpts.com": "endpoints.news",
  "www.endpts.com": "endpoints.news",
  "www.endpoints.news": "endpoints.news",
};

export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.replace(/\s+/g, "").trim();
  if (!trimmed) return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  url.hostname = url.hostname.toLowerCase();
  const aliased = HOST_ALIASES[url.hostname];
  if (aliased) url.hostname = aliased;

  if (url.protocol === "http:" && HTTPS_ONLY.has(url.hostname)) url.protocol = "https:";

  url.hash = "";
  url.username = "";
  url.password = "";

  const kept: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAM.test(key)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  // Drop a trailing slash on non-root paths so /a/b and /a/b/ are one item.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  if (url.port === "80" || url.port === "443") url.port = "";

  return url.toString();
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** DOI extracted from a URL or free text, lowercased. */
export function extractDoi(input: string): string | undefined {
  const m = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/.exec(input);
  return m ? m[0].toLowerCase().replace(/[.,;)]+$/, "") : undefined;
}
