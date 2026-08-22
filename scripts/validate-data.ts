/**
 * Schema-checks everything under data/. Runs in CI so a malformed digest fails
 * the pull request rather than the next morning's email.
 *
 * Hand-rolled, no zod, for the same reason the deadline config compiler is:
 * every problem is collected and reported together, because a bad run writes a
 * whole digest at once and fixing them one exit code at a time is slow.
 *
 * Two of the nine checks below are not schema checks at all and are the reason
 * this file matters more than a validator usually does:
 *
 *   · `noModelScoring` is the machine-checkable statement of the entire design.
 *     Everything else in the README about where Claude is allowed to be is
 *     prose; this is the assertion. It runs on every pull request.
 *   · `countdownPresent` is the anti-silence check. A scraper returning zero
 *     items reads exactly like "no new opportunities today", so an empty
 *     countdown strip beside a non-zero deadline count is the shape a silent
 *     failure has, and it must be impossible to commit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadRegistry } from "../pipeline/config/deadlines.ts";
import { parseDeadlineDate } from "../pipeline/normalize/dates.ts";
import { DATA_DIR } from "../pipeline/state/store.ts";
import { LANES, type DailyDigest, type DigestItem, type ScoreFactor } from "../lib/types.ts";

const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every .json file under a directory, recursively, sorted for stable output. */
function jsonFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
  }
  return found;
}

/* --------------------------- the ruled-out fence -------------------------- */

/**
 * A program marked `ruled-out` in config/deadlines.yml has a recorded reason —
 * NSF GRFP does not fund MD/PhD candidates, Blavatnik is postdoc-only — and it
 * stays in the file so nobody re-adds it in two years. If one ever reaches a
 * digest, the reader spends an evening on an application they cannot submit,
 * and the digest looks entirely normal while they do it. So the fence is here
 * and not only in the builder that is supposed to honour it.
 */
function ruledOutProgramIds(): Set<string> {
  try {
    const registry = loadRegistry();
    return new Set(registry.programs.filter((p) => p.status === "ruled-out").map((p) => p.id));
  } catch (error) {
    problems.push(`config/deadlines.yml did not load, so the ruled-out fence could not run: ${String(error)}`);
    return new Set();
  }
}

/* ------------------------------ digest checks ----------------------------- */

function validateScoreFactors(where: string, factors: unknown, bucket: string): void {
  if (!Array.isArray(factors)) {
    problems.push(`${where}: scoreBreakdown.${bucket} is not an array`);
    return;
  }
  for (const raw of factors as ScoreFactor[]) {
    if (!isRecord(raw) || typeof raw.key !== "string") {
      problems.push(`${where}: scoreBreakdown.${bucket} contains a factor with no key`);
      continue;
    }
    const key = raw.key.toLowerCase();
    // THE AUDIT-TRAIL FIREWALL. Not a naming convention.
    check(
      !key.startsWith("llm") && !key.startsWith("claude"),
      `${where}: score factor "${raw.key}" starts with llm/claude. THE MODEL NEVER CONTRIBUTES A POINT. ` +
        `Ranking is a deterministic weighted sum whose every term a human can audit; a model-derived ` +
        `factor makes the score unexplainable and puts Claude in the alert path, which is the one thing ` +
        `this project's design forbids. Move the signal into a deterministic factor or drop it.`,
    );
  }
}

function validateItem(where: string, id: string, item: DigestItem, ruledOut: Set<string>): void {
  check(item.id === id, `${where}: items["${id}"] carries item.id "${item.id}"`);
  check(typeof item.title === "string" && item.title.length > 0, `${where}: item ${id} has no title`);
  check(item.kind === "news" || item.kind === "opportunity", `${where}: item ${id} has kind "${item.kind}"`);

  // Scored items carry the hash of weights.json they were scored under. Without
  // it, a digest cannot be re-explained after a weight edit: the breakdown still
  // renders, it just no longer adds up to the number beside it.
  check(
    Boolean(item.scoreBreakdown?.weightsVersion),
    `${where}: item ${id} is missing scoreBreakdown.weightsVersion`,
  );
  if (isRecord(item.scoreBreakdown)) {
    validateScoreFactors(`${where} item ${id}`, item.scoreBreakdown.factors, "factors");
    validateScoreFactors(`${where} item ${id}`, item.scoreBreakdown.penalties, "penalties");
  }

  if (item.kind !== "opportunity") return;

  const facts = item.opportunity;
  if (!isRecord(facts)) {
    problems.push(`${where}: opportunity item ${id} has no opportunity facts`);
    return;
  }

  check(
    !ruledOut.has(facts.programId),
    `${where}: item ${id} is program "${facts.programId}", which config/deadlines.yml rules out. ` +
      `A ruled-out program must never be scored or delivered.`,
  );
  check(
    facts.status !== "ruled-out",
    `${where}: item ${id} carries status "ruled-out" and was delivered anyway`,
  );

  const deadline = facts.deadline;
  if (!isRecord(deadline)) {
    problems.push(`${where}: opportunity item ${id} has no deadline object`);
    return;
  }

  // Provenance is what the renderer branches on to decide whether a date may
  // drive an alert ("yaml") or must render behind a verify affordance
  // (everything else). A missing value defaults to nothing in particular, so a
  // hash-change or model-proposed date would render indistinguishably from one
  // a human read off the page and wrote down.
  check(
    typeof deadline.provenance === "string" && deadline.provenance.length > 0,
    `${where}: item ${id} deadline has no provenance — an unattributed date cannot be told apart ` +
      `from one a human verified`,
  );

  if (deadline.date !== undefined) {
    const parsed = parseDeadlineDate(deadline.date, {
      timeZone: deadline.timeZone ?? "America/New_York",
      timeOfDay: deadline.timeOfDay,
      precisionHint: deadline.precision,
    });
    check(
      parsed.instant !== null,
      `${where}: item ${id} deadline.date "${deadline.date}" does not parse` +
        (parsed.warning ? ` (${parsed.warning})` : ""),
    );
  } else {
    // The union is deliberate: `rolling` needs no action, `unknown` needs you to
    // go look. Anything else without a date is a builder bug.
    check(
      deadline.kind === "rolling" || deadline.kind === "unknown",
      `${where}: item ${id} has kind "${deadline.kind}" and no date`,
    );
  }
}

function validateDigest(where: string, value: unknown, ruledOut: Set<string>): void {
  if (!isRecord(value)) {
    problems.push(`${where}: not a JSON object`);
    return;
  }
  // The cast is deliberate. Everything below is what makes it true; a validator
  // that has to narrow every field before checking it checks nothing.
  const digest = value as unknown as DailyDigest;

  check(digest.schemaVersion === 1, `${where}: expected schemaVersion 1, got ${String(digest.schemaVersion)}`);
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(digest.date)), `${where}: date field is "${String(digest.date)}"`);
  check(typeof digest.generatedAt === "string", `${where}: no generatedAt`);

  const basename = path.basename(where, ".json");
  check(digest.date === basename, `${where}: digest.date "${digest.date}" does not match its filename`);

  if (!isRecord(digest.items)) {
    problems.push(`${where}: items must be an object keyed by id`);
    return;
  }

  // Two different keys carrying the same item.id, or one lane listing an id
  // twice, both render the same card twice — which reads to the reader as two
  // separate opportunities with the same deadline.
  const seenIds = new Set<string>();
  for (const [id, item] of Object.entries(digest.items)) {
    if (!isRecord(item)) {
      problems.push(`${where}: items["${id}"] is not an object`);
      continue;
    }
    const declared = String((item as unknown as DigestItem).id);
    check(!seenIds.has(declared), `${where}: two items share the id "${declared}"`);
    seenIds.add(declared);
    validateItem(where, id, item as unknown as DigestItem, ruledOut);
  }

  if (!Array.isArray(digest.lanes)) {
    problems.push(`${where}: lanes must be an array`);
  } else {
    for (const lane of digest.lanes) {
      check((LANES as readonly string[]).includes(lane.id), `${where}: unknown lane "${lane.id}"`);
      if (!Array.isArray(lane.itemIds)) {
        problems.push(`${where}: lane ${lane.id} has no itemIds array`);
        continue;
      }
      const inLane = new Set<string>();
      for (const id of lane.itemIds) {
        // The store keeps one copy of an item and lanes hold references, so a
        // dangling reference renders as a gap in a numbered lane rather than as
        // an error anybody sees.
        check(Boolean(digest.items[id]), `${where}: lane ${lane.id} references missing item "${id}"`);
        check(!inLane.has(id), `${where}: lane ${lane.id} lists item "${id}" twice`);
        inLane.add(id);
      }
    }
  }

  /* -------------------------- the anti-silence check ------------------------ */

  if (!Array.isArray(digest.countdown)) {
    problems.push(`${where}: countdown must be an array`);
  } else {
    const tracked = Number(digest.stats?.deadlinesTracked ?? 0);
    check(
      !(tracked > 0 && digest.countdown.length === 0),
      `${where}: stats.deadlinesTracked is ${tracked} but the countdown strip is empty. The strip is the ` +
        `continuity signal — it renders every day for everything inside the horizon and is the last thing ` +
        `shed when the email is trimmed. An empty strip on a day with tracked deadlines is what a silent ` +
        `failure looks like, and it must never reach the reader.`,
    );
    for (const row of digest.countdown) {
      check(
        /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)),
        `${where}: countdown row ${row.programId} has date "${String(row.date)}"`,
      );
      check(
        Number.isFinite(row.daysUntil),
        `${where}: countdown row ${row.programId} has a non-finite daysUntil`,
      );
      check(
        !ruledOut.has(row.programId),
        `${where}: countdown row "${row.programId}" is a ruled-out program`,
      );
    }
  }

  if (Array.isArray(digest.verify)) {
    for (const row of digest.verify) {
      check(
        !ruledOut.has(row.programId),
        `${where}: verify row "${row.programId}" is a ruled-out program`,
      );
    }
  }

  /* ------------------------------ markets ---------------------------------- */

  if (digest.markets !== undefined) {
    const markets = digest.markets;
    if (!isRecord(markets)) {
      problems.push(`${where}: markets is not an object`);
    } else {
      // A 60% single-day move on a large cap is a data bug — a split the quote
      // source did not adjust for, a stale previous close, a ticker collision —
      // and it renders as the loudest line in the market section. A real 60%
      // biotech move exists (a phase 3 readout can do it), which is why the bar
      // is high enough to let one through and low enough to catch the garbage.
      for (const bucket of ["quotes", "movers"] as const) {
        const rows = markets[bucket];
        if (!Array.isArray(rows)) continue;
        for (const quote of rows) {
          if (!isRecord(quote) || quote.changePct === undefined || quote.changePct === null) continue;
          const pct = Number(quote.changePct);
          check(
            Number.isFinite(pct),
            `${where}: markets.${bucket} ${String(quote.ticker)} has a non-finite changePct`,
          );
          check(
            !Number.isFinite(pct) || Math.abs(pct) < 60,
            `${where}: markets.${bucket} ${String(quote.ticker)} moved ${pct}% in a day — that is a data bug, not news`,
          );
        }
      }
    }
  }
}

/* --------------------------------- driver -------------------------------- */

// Not existing is the normal state of a fresh clone, and a validator that fails
// there is a validator people delete from CI on day one.
if (!existsSync(DATA_DIR) || !statSync(DATA_DIR).isDirectory()) {
  console.log(`validate-data: OK — ${DATA_DIR} does not exist yet, nothing to check.`);
  process.exit(0);
}

const ruledOut = ruledOutProgramIds();
const files = jsonFiles(DATA_DIR);
const digestDir = path.join(DATA_DIR, "digests");
let digestCount = 0;

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // Every file under data/ is committed generated output, so unparseable JSON
    // is a truncated write, not somebody's scratch file.
    problems.push(`${rel}: unreadable JSON (${String(error)})`);
    continue;
  }
  if (file.startsWith(digestDir + path.sep)) {
    digestCount++;
    validateDigest(rel, parsed, ruledOut);
  }
}

if (problems.length > 0) {
  console.error(`validate-data: ${problems.length} problem(s) across ${digestCount} digest(s)`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(
  `validate-data: OK — ${digestCount} digest(s), ${files.length} JSON file(s), ` +
    `${ruledOut.size} ruled-out program(s) fenced out.`,
);
