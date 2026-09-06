/**
 * Fetch every source from wherever you are running, and report honestly.
 *
 * The reason this exists as a script rather than a test: EVERY source status in
 * this repo was verified from a residential IP, and GitHub's runners sit on
 * shared Azure ranges that are throttled and challenged far harder. Treat the
 * registry's notes as hypotheses until this has passed inside CI.
 *
 * Run locally:  npm run check-sources
 * Run in CI:    the smoke-test workflow calls it and writes to the job summary.
 */

import { writeFileSync } from "node:fs";

import { collectSources } from "../pipeline/ingest/collect.ts";
import { localDateString } from "../pipeline/normalize/dates.ts";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith("--"));
  const summaryPath = args.find((a) => a.startsWith("--summary="))?.split("=")[1];

  const now = new Date();
  const today = localDateString("America/New_York", now);

  const result = await collectSources({
    now,
    today,
    previousHealth: {},
    trailingMedian: {},
    pageHashes: {},
    only: only.length ? only : undefined,
  });

  const bad = result.health.filter((h) => h.status === "failed" || h.status === "degraded");
  const okCount = result.health.length - bad.length;

  console.log(`\n${okCount}/${result.health.length} sources healthy`);

  if (bad.length > 0) {
    console.log("\nNEEDS ATTENTION");
    for (const h of bad) {
      console.log(`  ${h.status.toUpperCase().padEnd(9)} ${h.sourceId.padEnd(26)} ${h.error ?? ""}`);
    }
  }

  // A sample from each healthy source, because "kept 40 items" says nothing about
  // whether those items are sponsored whitepapers.
  console.log("\nSAMPLES");
  const bySource = new Map<string, string[]>();
  for (const item of result.items) {
    const list = bySource.get(item.sourceId) ?? [];
    if (list.length < 2) list.push(item.title.slice(0, 88));
    bySource.set(item.sourceId, list);
  }
  for (const [id, titles] of [...bySource].sort()) {
    console.log(`  ${id}`);
    for (const t of titles) console.log(`      ${t}`);
  }

  if (summaryPath) {
    const lines = [
      "## Source smoke test",
      "",
      `**${okCount}/${result.health.length}** healthy · **${result.items.length}** items · **${result.pageChanges.length}** page-watch results`,
      "",
      "| status | source | kept/parsed | ms | detail |",
      "| --- | --- | ---: | ---: | --- |",
      ...result.health
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
        .map((h) => {
          // Escape pipes: a parser error containing one shatters the table.
          const detail = (h.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 90);
          return `| ${h.status} | ${h.sourceId} | ${h.itemsKept}/${h.itemsParsed} | ${h.latencyMs} | ${detail} |`;
        }),
      "",
      "### Page watches",
      "",
      "| result | program | detail |",
      "| --- | --- | --- |",
      ...result.pageChanges.map(
        (c) => `| ${c.kind} | ${c.programId} | ${c.detail.replace(/\|/g, "\\|").slice(0, 90)} |`,
      ),
    ];
    writeFileSync(summaryPath, `${lines.join("\n")}\n`, { flag: "a" });
  }

  // Exit non-zero only when a NON-optional source is unhealthy. An optional source
  // failing is information, not a build break — the whole point of marking a
  // source optional is that the digest survives without it.
  const required = bad.filter((h) => !h.optional);
  if (required.length > 0) {
    console.error(`\n${required.length} REQUIRED source(s) unhealthy`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
