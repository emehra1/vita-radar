/**
 * Pipeline entry point.
 *
 * EXIT CODES ARE A CONTRACT WITH .github/workflows/pipeline.yml:
 *
 *   0  fine — commit the digest, send the email
 *   2  unusable — do NOT commit, do NOT email. Yesterday's digest stays the
 *      latest and the run status records why.
 *   1  crashed
 *
 * Phase 1 makes no network calls and no LLM calls. The whole deadline tracker is
 * a pure function of a committed YAML file and the clock, which is why it shipped
 * first: nothing here can break because a website was redesigned, and every
 * alarm in the system works with `pipeline/llm/` deleted from disk.
 */

import { writeFileSync } from "node:fs";

import type { DailyDigest, DigestItem, Lane, RunStatus } from "../lib/types.ts";
import { LANES, LANE_BLURBS, LANE_LABELS, PINNED_LANE } from "../lib/types.ts";
import { DeadlineConfigError, loadRegistry } from "./config/deadlines.ts";
import { buildOpportunities } from "./deadlines/build.ts";
import { buildNews } from "./digest/build.ts";
import { collectSources } from "./ingest/collect.ts";
import { WEIGHTS } from "./score/index.ts";
import { localDateString } from "./normalize/dates.ts";
import {
  SeenStore,
  findPreviousDigest,
  readDigest,
  readRollingDelivered,
  readRungs,
  writeDigest,
  writeRollingDelivered,
  writeRungs,
  writeRunStatus,
  readPageHashes,
  writePageHashes,
  readSourceHistory,
  writeSourceHistory,
} from "./state/store.ts";

const READER_ZONE = process.env.TZ ?? "America/New_York";

interface Args {
  date?: string;
  dryRun: boolean;
  force: boolean;
  summary?: string;
  noLlm: boolean;
  noMarket: boolean;
  /** Skip the network entirely. The deadline tracker is unaffected by design. */
  noSources: boolean;
  fromCache: boolean;
  only?: string[];
}

/**
 * Hand-rolled argv loop rather than a dependency, matching the sibling. Accepts
 * both `--date X` and `--date=X` because CI writes one form and humans the other.
 */
function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false, noLlm: false, noMarket: false, noSources: false, fromCache: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    const [flag, inline] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case "--date": args.date = next(); break;
      case "--summary": args.summary = next(); break;
      case "--dry-run": args.dryRun = true; break;
      case "--force": args.force = true; break;
      case "--no-llm": args.noLlm = true; break;
      case "--no-market": args.noMarket = true; break;
      case "--no-sources": args.noSources = true; break;
      case "--from-cache": args.fromCache = true; break;
      case "--only": args.only = (next() ?? "").split(",").filter(Boolean); break;
      default:
        if (flag?.startsWith("--")) console.warn(`unknown flag ${flag} — ignored`);
    }
  }
  return args;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? (lo + hi) / 2 : hi;
}

/**
 * Lane assembly with the pinned lane first.
 *
 * `deadlines` is exempt from the per-lane cap and from the round-robin. The
 * sibling learned the general form of this the hard way — Europe PMC returns 50
 * dense abstracts a day and a straight sort buried the day's biggest M&A story
 * under review articles. Here the stakes are higher than ordering: a preprint
 * must never be able to push a closing deadline off the email.
 */
function assembleLanes(items: DigestItem[], maxPerLane: number) {
  const byLane = new Map<Lane, DigestItem[]>();
  for (const item of items) {
    const list = byLane.get(item.primaryLane) ?? [];
    list.push(item);
    byLane.set(item.primaryLane, list);
  }
  const ordered: Lane[] = [PINNED_LANE, ...LANES.filter((l) => l !== PINNED_LANE)];
  return ordered
    .map((id) => {
      const list = (byLane.get(id) ?? []).sort((a, b) => b.score - a.score);
      const capped = id === PINNED_LANE ? list : list.slice(0, maxPerLane);
      return { id, label: LANE_LABELS[id], blurb: LANE_BLURBS[id], itemIds: capped.map((i) => i.id) };
    })
    .filter((lane) => lane.itemIds.length > 0);
}

function emitSummary(path: string | undefined, lines: string[]): void {
  if (!path) return;
  try {
    writeFileSync(path, `${lines.join("\n")}\n`, { flag: "a" });
  } catch {
    // A missing $GITHUB_STEP_SUMMARY must never fail a run that produced a digest.
  }
}

/**
 * The registry counts as a source, and reporting it honestly matters: the email
 * footer is the primary alarm, so "sources 0/0" on a perfectly good run trains
 * the reader to distrust the one line that has to stay trustworthy.
 */
function digestHealthForRegistry(programs: number, kept: number): import("../lib/types.ts").SourceHealth[] {
  return [{
    sourceId: "deadlines-yml",
    sourceName: "config/deadlines.yml",
    status: "ok",
    itemsParsed: programs,
    itemsKept: kept,
    parseWarnings: [],
    latencyMs: 0,
    lastSuccessAt: new Date().toISOString(),
    consecutiveFailures: 0,
    // If the registry cannot be read there is no digest; loadRegistry has
    // already exited 1 by the time this is called.
    optional: false,
  }];
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const now = startedAt;

  // "Today" means the READER's day, not UTC's. A digest dated a day ahead of the
  // person reading it makes every countdown off by one.
  const date = args.date ?? localDateString(READER_ZONE, now);
  const summary: string[] = [`## Vita Radar — ${date}`, ""];

  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof DeadlineConfigError) {
      // The config validator is the loud path: it reports EVERY problem at once
      // so a batch of hand-edit typos is one fix, not one per run.
      console.error(err.message);
      summary.push("### Config invalid", "", ...err.problems.map((p) => `- ${p}`));
      emitSummary(args.summary, summary);
      writeRunStatus({
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: "error",
        message: `config invalid: ${err.problems.length} problem(s)`,
        date,
        sourcesOk: 0,
        sourcesTotal: 0,
        itemsKept: 0,
        deadlinesTracked: 0,
      });
      return 1;
    }
    throw err;
  }

  // Idempotence, and it is shouted rather than whispered. A run that produced
  // nothing must never read as a healthy run that happened to find nothing —
  // which is also what makes the catch-up cron safe to add.
  const existing = readDigest(date);
  if (existing && !args.force && !args.dryRun) {
    const msg = `digest for ${date} already exists (generated ${existing.generatedAt}); use --force to regenerate`;
    console.log(msg);
    emitSummary(args.summary, [...summary, `**Skipped:** ${msg}`]);
    return 0;
  }

  const previous = findPreviousDigest(date);
  const windowStart = previous?.date ?? date;

  const seen = new SeenStore(date);
  const rungs = readRungs();
  const rollingDelivered = readRollingDelivered();

  const built = buildOpportunities(registry, now, {
    weights: WEIGHTS,
    rungs,
    rollingLastDelivered: rollingDelivered,
    firstSeen: (id) => seen.firstSeen(id),
    readerZone: READER_ZONE,
  });

  /**
   * Sources run AFTER the deadline tracker, and nothing below can affect it.
   *
   * That ordering is the whole reliability argument: the countdown, the Verify
   * block, the subject-line escalation and the .ics are already computed from
   * committed YAML and the clock. Every feed on earth can 403 and the part of
   * this email that costs a year if missed is unchanged.
   */
  let newsItems: DigestItem[] = [];
  let health = digestHealthForRegistry(registry.programs.length, built.items.length);
  const pageHashesBefore = readPageHashes();
  let pageHashes = pageHashesBefore;
  const pageChanges: { programId: string; url: string; kind: string; detail: string }[] = [];

  if (!args.noSources) {
    try {
      const sourceHistory = readSourceHistory();
      const collected = await collectSources({
        now,
        today: date,
        previousHealth: sourceHistory.health,
        trailingMedian: sourceHistory.medians,
        pageHashes: pageHashesBefore,
        fromCache: args.fromCache,
        only: args.only,
      });
      const news = buildNews(collected.items, now, date, (id) => seen.firstSeen(id));
      newsItems = news.items.slice(0, WEIGHTS.maxItemsPerDay);
      for (const [reason, count] of Object.entries(news.dropped)) {
        built.dropped[reason as keyof typeof built.dropped] =
          (built.dropped[reason as keyof typeof built.dropped] ?? 0) + count;
      }
      health = [...health, ...collected.health];
      pageHashes = collected.pageHashes;
      pageChanges.push(...collected.pageChanges);
      if (!args.dryRun) {
        writeSourceHistory(collected.health, sourceHistory);
      }
    } catch (err) {
      // A collapse of the entire source layer must not take the digest down.
      // The deadline half is already computed and is the part that matters.
      console.error(`sources failed wholesale: ${(err as Error).message}`);
      health = [
        ...health,
        {
          sourceId: "collect", sourceName: "source collection", status: "failed",
          error: String((err as Error).message).slice(0, 200), itemsParsed: 0, itemsKept: 0,
          parseWarnings: [], latencyMs: 0, consecutiveFailures: 1, optional: true,
        },
      ];
    }
  }

  /**
   * A changed program page becomes a Verify row, never a date.
   *
   * This is the join between the two halves and the place THE ONE RULE is
   * cashed out: the network is allowed to say "this page moved, go look" and
   * nothing more. It cannot edit config/deadlines.yml, and no countdown in the
   * email can move because of anything a fetch returned.
   */
  for (const change of pageChanges) {
    if (change.kind === "new") continue;
    const program = registry.programs.find((p) => p.id === change.programId);
    built.verify.push({
      programId: change.programId,
      label: program?.label ?? change.programId,
      reason:
        change.kind === "changed"
          ? `page changed — verify the date (${change.detail})`
          : change.kind === "suspicious"
            ? `page looks broken — ${change.detail}`
            : `page unreachable — ${change.detail}`,
      url: change.url,
    });
  }
  built.verify.sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0) || a.label.localeCompare(b.label));

  const allItems: DigestItem[] = [...built.items, ...newsItems];
  const items: Record<string, DigestItem> = {};
  for (const item of allItems) items[item.id] = item;

  const lanes = assembleLanes(allItems, WEIGHTS.maxItemsPerLane);

  /**
   * The usability gate.
   *
   * Phase 1 has no sources, so "most feeds are down" cannot happen. What CAN
   * happen — and is far worse — is that the registry holds active dated programs
   * and the countdown comes out empty, which means a bug ate the dates. That
   * reads to a human exactly like "nothing is due", so it must be a hard failure
   * rather than a quiet email.
   */
  const unusable = built.deadlinesTracked > 0 && built.countdown.length === 0 && built.items.length === 0;

  const digest: DailyDigest = {
    schemaVersion: 1,
    date,
    runId: process.env.GITHUB_RUN_ID,
    generatedAt: new Date().toISOString(),
    windowStart,
    windowEnd: date,
    health,
    items,
    lanes,
    countdown: built.countdown,
    verify: built.verify,
    stats: {
      fetched: registry.programs.length + newsItems.length,
      kept: allItems.length,
      deadlinesTracked: built.deadlinesTracked,
      verifiedLast7d: built.verifiedLast7d,
      medianScore: median(built.items.map((i) => i.score)),
      dropped: built.dropped,
    },
  };

  // ── reporting ────────────────────────────────────────────────────────────
  console.log(`\n${date} — ${allItems.length} items (${built.items.length} opportunities, ${newsItems.length} news), ${built.countdown.length} on the strip, ${built.verify.length} to verify`);
  console.log(`tracked ${built.deadlinesTracked} dated deadlines across ${registry.programs.length} programs`);
  console.log(`dropped: ${JSON.stringify(built.dropped)}`);

  if (built.countdown.length > 0) {
    console.log("\nCOUNTDOWN");
    for (const row of built.countdown) {
      const flags = [
        row.gating ? "GATING" : "",
        row.kind === "projected" ? "projected" : "",
        row.precision === "month" ? "month-only" : "",
        row.needsVerification ? "verify" : "",
      ].filter(Boolean).join(",");
      console.log(
        `  ${String(row.daysUntil).padStart(4)}d  ${row.label.padEnd(46).slice(0, 46)}  ${row.target.padEnd(40).slice(0, 40)}  ${flags}`,
      );
    }
  }

  if (built.verify.length > 0) {
    console.log("\nVERIFY");
    for (const row of built.verify) console.log(`  ${row.label.padEnd(46).slice(0, 46)}  ${row.reason}`);
  }

  if (args.dryRun) {
    console.log("\nTOP ITEMS BY SCORE");
    for (const item of [...allItems].sort((a, b) => b.score - a.score).slice(0, 15)) {
      console.log(`\n  ${item.score.toFixed(1).padStart(6)}  ${item.title}`);
      for (const f of item.scoreBreakdown.factors) {
        console.log(`          + ${f.key.padEnd(22)} raw=${f.raw.toFixed(3)} x${f.weight} = ${f.contribution.toFixed(2)}`);
      }
      for (const p of item.scoreBreakdown.penalties) {
        console.log(`          - ${p.key.padEnd(22)} ${p.contribution.toFixed(2)}`);
      }
    }
    console.log("\n--dry-run: nothing written");
    return unusable ? 2 : 0;
  }

  const finishedAt = new Date();
  const okSources = health.filter((h) => h.status === "ok" || h.status === "not-modified").length;
  const status: RunStatus = {
    runId: process.env.GITHUB_RUN_ID,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    outcome: unusable ? "unusable" : "ok",
    date,
    sourcesOk: okSources,
    sourcesTotal: health.length,
    itemsKept: allItems.length,
    deadlinesTracked: built.deadlinesTracked,
  };
  writeRunStatus(status);

  if (unusable) {
    console.error("\nUNUSABLE: the registry has dated programs but nothing resolved. Not writing a digest.");
    emitSummary(args.summary, [...summary, "**UNUSABLE** — registry has dated programs but nothing resolved."]);
    return 2;
  }

  // Persist the ledgers only on a real run, and only merged — a partial write
  // would silently re-fire cards that already went out.
  writeRungs({ ...rungs, ...built.rungsDelivered });
  writePageHashes(pageHashes);
  const rollingNow = { ...rollingDelivered };
  for (const item of built.items) {
    if (item.kind === "opportunity" && item.opportunity.deadline.kind === "rolling") {
      rollingNow[item.opportunity.programId] = date;
    }
  }
  writeRollingDelivered(rollingNow);
  seen.flush();
  writeDigest(digest);

  summary.push(
    `**${built.items.length}** items · **${built.countdown.length}** on the countdown · **${built.verify.length}** to verify`,
    "",
    "| days | program | target | flags |",
    "| ---: | --- | --- | --- |",
    ...built.countdown.slice(0, 20).map((r) => {
      const flags = [r.gating ? "gating" : "", r.kind === "projected" ? "projected" : "", r.needsVerification ? "verify" : ""]
        .filter(Boolean)
        .join(", ");
      // Escape pipes: a label containing one shatters the markdown table into
      // fake rows, which is exactly the bug the sibling hit with parser errors.
      const esc = (s: string) => s.replace(/\|/g, "\\|");
      return `| ${r.daysUntil} | ${esc(r.label)} | ${esc(r.target)} | ${flags} |`;
    }),
  );
  emitSummary(args.summary, summary);

  console.log(`\nwrote ${date} · seen store holds ${seen.size} ids`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
