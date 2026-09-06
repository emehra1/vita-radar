/**
 * Text coercion for feed fields that are not reliably strings.
 *
 * FierceBiotech/FiercePharma embed anchor markup *inside* <title> and
 * <dc:creator>, so xml2js (under rss-parser) hands back an object:
 *   {"a":[{"_":"Novo Nordisk left praying…","$":{"href":"/biotech/…"}}]}
 * Calling .replace()/.slice() on that throws, which rejects the whole feed's
 * Promise.all and silently yields zero items. coerceText() is the fix.
 */

/** Recursively pull the text out of whatever xml2js produced. */
export function coerceText(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 6) return "";

  if (Array.isArray(value)) {
    return value
      .map((v) => coerceText(v, depth + 1))
      .filter(Boolean)
      .join(" ");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // xml2js puts element text in `_` and attributes in `$`.
    if (typeof obj["_"] === "string") return obj["_"];
    const parts: string[] = [];
    for (const [key, child] of Object.entries(obj)) {
      if (key === "$") continue; // attributes are never display text
      const text = coerceText(child, depth + 1);
      if (text) parts.push(text);
    }
    return parts.join(" ");
  }

  return "";
}

/** Collapse whitespace and strip the literal newlines bioRxiv wraps fields in. */
export function squish(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** coerceText + squish, the form nearly every caller wants. */
export function cleanText(value: unknown): string {
  return squish(coerceText(value));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
  szlig: "ß",
};

/** Decode the HTML entities that actually show up in feeds, including doubles. */
export function decodeEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    });
    if (!out.includes("&")) break;
  }
  return out;
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Truncate on a word boundary, appending an ellipsis only if we actually cut. */
export function truncateWords(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const slice = input.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${base.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

const TOKEN_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "their", "this", "to", "was", "were", "will", "with", "after", "over", "new",
  "says", "say", "said", "amid", "up", "down", "out", "not", "no",
]);

/** Lowercased content tokens, used by clustering and search. */
export function tokenize(input: string, keepStopwords = false): string[] {
  const tokens = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1);
  return keepStopwords ? tokens : tokens.filter((t) => !TOKEN_STOPWORDS.has(t));
}

/**
 * Normalize a headline for near-duplicate comparison: drop the "STAT+: " prefix
 * and any trailing " - Outlet" / " | Outlet" attribution.
 */
export function normalizeTitle(title: string): string {
  return squish(
    title
      .replace(/^\s*STAT\+:\s*/i, "")
      .replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "")
      .replace(/&/g, " and "),
  );
}

/** Character n-gram shingles over normalized text. */
export function shingles(input: string, n = 3): Set<string> {
  const text = tokenize(input).join(" ");
  const out = new Set<string>();
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / (a.size + b.size - shared);
}

export function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return (2 * shared) / (a.size + b.size);
}
