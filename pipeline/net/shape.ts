/**
 * "Is this body the kind of thing we asked for?"
 *
 * One definition, used in two places that must agree:
 *
 *  - `http.ts` calls it BEFORE writing to the cache, so a bot challenge or an
 *    IdP interstitial can never be stored as if it were a feed. That is not
 *    hypothetical: a 200-with-HTML for nature-rev-drug-discovery was cached
 *    along with its ETag, and the next run's conditional request earned an
 *    honest 304 and replayed the HTML back out of the cache. The source failed
 *    with "HTTP 304 · expected XML, got HTML" — a fetch that never happened.
 *
 *  - `collect.ts` calls it to explain the failure, because the alternative
 *    message is the XML parser's "Attribute without value, Line: 13" (HTML
 *    boolean attributes like `<script async>` are illegal in XML), which tells
 *    you nothing about what to do next.
 */

export type BodyShape = "xml" | "json" | "html" | "csv" | "ics";

/**
 * Bodies that are the RIGHT shape and still not a real response.
 *
 * This matters most for `expect: "html"`, where the naive check is vacuous — a
 * Cloudflare interstitial and a fellowship page are both perfectly good HTML, so
 * shape alone cannot tell them apart. Confirmed live on 2026-08-22: AAMC returns
 * HTTP 200 with a 3,038-byte F5/Shape "Client Challenge" body, which a monitor
 * checking only the status code calls healthy forever.
 *
 * Matched against the title and the first 400 characters, so a page that merely
 * mentions one of these phrases in its prose is not caught by accident.
 */
const CHALLENGE_MARKERS: { pattern: RegExp; vendor: string }[] = [
  { pattern: /just a moment/i, vendor: "Cloudflare" },
  { pattern: /attention required/i, vendor: "Cloudflare" },
  { pattern: /checking your browser/i, vendor: "Cloudflare" },
  { pattern: /cf-browser-verification|__cf_chl|cf_chl_opt/i, vendor: "Cloudflare" },
  { pattern: /client challenge/i, vendor: "F5/Shape" },
  { pattern: /_incapsula_|incapsula incident/i, vendor: "Imperva" },
  { pattern: /access denied|request blocked/i, vendor: "WAF" },
  { pattern: /enable javascript and cookies to continue/i, vendor: "bot wall" },
  { pattern: /<title[^>]*>\s*(403|forbidden|error)\s*</i, vendor: "error page" },
];

/** A challenge vendor name when the body looks like an interstitial. */
export function describeChallenge(body: string): string | undefined {
  const head = body.slice(0, 2000);
  for (const { pattern, vendor } of CHALLENGE_MARKERS) {
    if (pattern.test(head)) return `${vendor} challenge page`;
  }
  return undefined;
}

/**
 * Returns a human description when the body is NOT what `expect` asked for, or
 * undefined when it looks right. Kept to a single line so it survives a
 * markdown table in the job summary.
 */
export function describeWrongShape(body: string, expect: BodyShape): string | undefined {
  const head = body.slice(0, 400).trim();
  if (!head) return "got an empty response";

  const lower = head.toLowerCase();

  // Checked before the per-shape branches, because an interstitial is served
  // with a 200 in whatever content type the WAF feels like and is never a valid
  // response for any of them.
  const challenge = describeChallenge(body);
  if (challenge) return `got a ${challenge}${titleOf(head)}`;

  if (expect === "html") {
    // The shape check is nearly vacuous here — the challenge check above is
    // doing the real work. All this can catch is a source that has stopped
    // serving markup at all, which does happen: nature's careers "feed" returns
    // 200 text/html, and Substack 404s come back as ~55KB of HTML.
    if (lower.startsWith("{") || lower.startsWith("[")) return "got JSON, not HTML";
    if (!head.includes("<")) return `got non-markup starting ${JSON.stringify(head.slice(0, 40))}`;
    return undefined;
  }

  if (expect === "csv") {
    if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
      return `got HTML${titleOf(head)} — likely a bot challenge or consent page`;
    }
    // Stooq is the reason this branch exists: it answers 200 with an ~800-byte
    // SHA-256 proof-of-work challenge that naive code happily parses as CSV,
    // yielding a row of garbage rather than an error.
    if (!head.includes(",") && !head.includes("\t")) {
      return `got no delimiter in the first line — ${JSON.stringify(head.slice(0, 40))}`;
    }
    return undefined;
  }

  if (expect === "ics") {
    if (!lower.startsWith("begin:vcalendar")) {
      if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
        return `got HTML${titleOf(head)} — likely a bot challenge or consent page`;
      }
      return `got no BEGIN:VCALENDAR — ${JSON.stringify(head.slice(0, 40))}`;
    }
    return undefined;
  }

  if (expect === "json") {
    if (lower.startsWith("{") || lower.startsWith("[")) return undefined;
    if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
      return `got HTML${titleOf(head)} — likely a bot challenge or consent page`;
    }
    if (head.startsWith("<")) return "got markup, not JSON";
    return `got non-JSON starting ${JSON.stringify(head.slice(0, 40))}`;
  }

  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || lower.includes("<head>")) {
    return `got HTML${titleOf(head)} — likely a bot challenge or consent page`;
  }
  if (lower.startsWith("{") || lower.startsWith("[")) return "got JSON";
  if (!head.startsWith("<")) {
    return `got non-markup starting ${JSON.stringify(head.slice(0, 40))}`;
  }
  return undefined;
}

function titleOf(head: string): string {
  // Collapse whitespace, don't just trim it. A `<title>` wrapped across two
  // lines would otherwise put a newline into the health table's detail column,
  // and a newline inside a markdown table cell shatters the row into fake ones.
  const title = /<title[^>]*>([^<]{0,80})/i.exec(head)?.[1]?.replace(/\s+/g, " ").trim();
  return title ? ` titled "${title}"` : "";
}
