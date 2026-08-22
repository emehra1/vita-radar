/**
 * The repo IS the database.
 *
 * Same choice the sibling project made, for the same reasons: a GitHub Actions
 * runner is ephemeral, so state has to live somewhere durable, and committing
 * JSON gives durability, history, diffability, and a free 60-day activity
 * heartbeat in one move — with no external service that can pause a free tier or
 * expire a token.
 *
 * Digests are year-sharded because github.com truncates directory listings at
 * 1,000 entries, so a flat directory becomes unbrowsable in under three years.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DailyDigest, RunStatus } from "../../lib/types.ts";

export const DATA_DIR = resolve(process.cwd(), "data");
const DIGEST_DIR = join(DATA_DIR, "digests");
const STATE_DIR = join(DATA_DIR, "state");

const RUNGS_PATH = join(STATE_DIR, "deadline-rungs.json");
const ROLLING_PATH = join(STATE_DIR, "rolling-delivered.json");
const SEEN_PATH = join(STATE_DIR, "seen.json");
const RUN_STATUS_PATH = join(STATE_DIR, "last-run.json");

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    // A corrupt state file must not take the run down. Losing a rung means one
    // duplicate card; failing the run means no email, which is strictly worse.
    console.warn(`state: could not parse ${path} (${(err as Error).message}) — treating as empty`);
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function digestPath(date: string): string {
  return join(DIGEST_DIR, date.slice(0, 4), `${date}.json`);
}

export function readDigest(date: string): DailyDigest | null {
  return readJson<DailyDigest>(digestPath(date));
}

export function writeDigest(digest: DailyDigest): void {
  writeJson(digestPath(digest.date), digest);
}

/** Every digest date on disk, ascending. */
export function listDigestDates(): string[] {
  if (!existsSync(DIGEST_DIR)) return [];
  const out: string[] = [];
  for (const year of readdirSync(DIGEST_DIR)) {
    const dir = join(DIGEST_DIR, year);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) out.push(file.replace(/\.json$/, ""));
    }
  }
  return out.sort();
}

/** The most recent digest strictly before `date`, scanning back a bounded window. */
export function findPreviousDigest(date: string, maxBackDays = 10): DailyDigest | null {
  const dates = listDigestDates().filter((d) => d < date);
  for (const d of dates.slice(-maxBackDays).reverse()) {
    const digest = readDigest(d);
    if (digest) return digest;
  }
  return null;
}

/* ------------------------------- rung ledger ------------------------------ */

/**
 * programId -> the last ladder rung delivered.
 *
 * Without this the rung gate cannot work across runs: the runner is ephemeral, so
 * "have I already sent the 90-day card?" is only answerable from committed state.
 */
export function readRungs(): Record<string, number> {
  return readJson<Record<string, number>>(RUNGS_PATH) ?? {};
}

export function writeRungs(rungs: Record<string, number>): void {
  writeJson(RUNGS_PATH, rungs);
}

/** programId -> ISO date a rolling program was last delivered. */
export function readRollingDelivered(): Record<string, string> {
  return readJson<Record<string, string>>(ROLLING_PATH) ?? {};
}

export function writeRollingDelivered(map: Record<string, string>): void {
  writeJson(ROLLING_PATH, map);
}

/* -------------------------------- seen store ------------------------------ */

/**
 * itemId -> the date the pipeline FIRST laid eyes on it.
 *
 * Carried over from the sibling with its distinction intact, because it is
 * load-bearing and easy to get wrong: `seen` records everything ever fetched,
 * including items that were immediately dropped. It exists to answer "is this
 * new?" — it is NOT a record of what was delivered. Conflating the two would
 * penalise as a repeat everything a productive source could not fit into its
 * slots, permanently burying it.
 */
export class SeenStore {
  private readonly map: Record<string, string>;
  private dirty = false;

  constructor(private readonly today: string) {
    this.map = readJson<Record<string, string>>(SEEN_PATH) ?? {};
  }

  /** The date this id was first seen, recording today if it is new. */
  firstSeen(id: string): string {
    const existing = this.map[id];
    if (existing) return existing;
    this.map[id] = this.today;
    this.dirty = true;
    return this.today;
  }

  flush(): void {
    if (!this.dirty) return;
    writeJson(SEEN_PATH, this.map);
  }

  get size(): number {
    return Object.keys(this.map).length;
  }
}

/* ------------------------------- run status ------------------------------- */

export function writeRunStatus(status: RunStatus): void {
  writeJson(RUN_STATUS_PATH, status);
}

export function readRunStatus(): RunStatus | null {
  return readJson<RunStatus>(RUN_STATUS_PATH);
}
