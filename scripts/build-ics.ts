/**
 * Writes the subscribable deadline calendar.
 *
 *   npx tsx scripts/build-ics.ts
 *   npx tsx scripts/build-ics.ts --out public/calendar.ics
 *   npx tsx scripts/build-ics.ts --date 2026-08-22          # freeze the clock
 *
 * Standalone on purpose. It touches config/deadlines.yml and nothing else: no
 * digest, no cache, no state, no network. If the pipeline is broken — and the
 * whole point of this artifact is the month when it is — this still runs, and
 * the reader's phone still rings for the Rhodes endorsement.
 *
 * NOTE ON PUBLISHING: out/ is gitignored, so writing there produces a calendar
 * nobody can subscribe to. The default is out/ because that is where the site
 * build collects things; whatever job publishes the site has to copy or point
 * --out at the served directory. A calendar at a URL nobody can reach is the
 * one failure mode indistinguishable from success.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildIcs, registryToIcsEvents } from "../lib/calendar/ics.ts";
import { DeadlineConfigError, loadRegistry } from "../pipeline/config/deadlines.ts";
import { wallClockToUtc } from "../pipeline/normalize/dates.ts";

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(): number {
  const outPath = resolve(process.cwd(), flag("out") ?? "out/calendar.ics");
  const dateArg = flag("date");

  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof DeadlineConfigError) {
      console.log(err.message);
      return 1;
    }
    throw err;
  }

  // Noon, not midnight. "2026-08-22" read as a UTC instant is the evening of the
  // 21st in America/New_York, which would shift which `watch` rows are still
  // suppressed by their watchFrom — the same off-by-one-day class of bug the
  // YAML loader avoids by refusing js-yaml's timestamp type. Noon local is far
  // from any zone boundary or DST transition.
  let now = new Date();
  if (dateArg) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateArg);
    if (!m) {
      console.log(`build-ics: --date must be YYYY-MM-DD, got "${dateArg}"`);
      return 1;
    }
    now = wallClockToUtc(
      registry.defaults.timeZone,
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      12,
      0,
    );
  }

  const events = registryToIcsEvents(registry, now);

  // Zero events reads exactly like "no deadlines exist", which is the failure
  // this repo is built to make impossible. 37 programs cannot legitimately
  // produce an empty calendar, so an empty one means a load or filter bug, and
  // it must not overwrite the good file already sitting at outPath.
  if (events.length === 0) {
    console.log(
      `build-ics: ${registry.programs.length} programs produced ZERO events — refusing to write ${outPath}`,
    );
    return 1;
  }

  const ics = buildIcs(events, {
    calendarName: "vita-radar — deadlines",
    timeZone: registry.defaults.timeZone,
    // One clock read, here, passed down. The builder never reads a clock, so the
    // same registry and the same --date always produce the same bytes.
    dtstamp: now,
    description:
      "Fellowship, conference and application deadlines from config/deadlines.yml. " +
      "Entries marked [projected] are rolled forward from a previous cycle and NOT confirmed. " +
      "Entries marked (day unknown — verify) are pinned to the first of the month and are not due then.",
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ics, "utf8");

  const allDay = events.filter((e) => e.precision !== "minute").length;
  const projected = events.filter((e) => e.status === "TENTATIVE").length;
  const alarms = events.filter((e) => e.alarm).length;
  console.log(
    `build-ics: ${events.length} events (${allDay} all-day, ${events.length - allDay} timed, ` +
      `${projected} tentative, ${alarms} with a 7-day alarm) from ${registry.programs.length} programs`,
  );
  console.log(`build-ics: wrote ${outPath} (${Buffer.byteLength(ics, "utf8")} bytes)`);
  return 0;
}

process.exit(main());
