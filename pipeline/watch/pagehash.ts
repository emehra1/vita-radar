/**
 * "Did this page change since yesterday?" — and nothing else.
 *
 * This is THE ONE RULE made literal. Every URL here belongs to a program whose
 * deadline is hand-verified in config/deadlines.yml. All we ask of the network
 * is whether the page moved; a change produces one line in the email asking a
 * human to look, and the human is the only thing that ever writes a date.
 *
 * Why not just parse the date, which is what everyone tries first: because the
 * pages do not contain what you would be parsing. Probed live 2026-08-22 —
 *
 *   rhodeshouse.ox.ac.uk        renders fine and states NO DATE at all
 *   gatescambridge.org/apply/   302s to http://www.gatescambridge.org/// (homepage)
 *   nucleate.org                "Deadline for US chapters is October 21st" —
 *                               no year, beside a "2024 COHORT" block
 *   agingpharma.org             "The deadline is August 31" — no year, while its
 *                               tidier /deadline page is frozen on 2025
 *   uraf.harvard.edu            hard 403 on every path including robots.txt
 *
 * A parser pointed at those produces a confident, wrong, unfalsifiable date. A
 * hash produces "go look", which is correct every single time.
 *
 * Properties worth keeping:
 *   · It cannot lie about a date, because it never reads one.
 *   · It cannot silently return zero, because a fetch failure is a fetch failure
 *     rather than an empty list.
 *   · It is one implementation for all twelve pages, not twelve parsers.
 *   · Deleting it costs only the 90-day verification timer.
 */

import { createHash } from "node:crypto";

import type { PageWatch } from "../config/sources.ts";
import { describeChallenge } from "../net/shape.ts";

export interface PageHashRecord {
  hash: string;
  /** ISO date this hash was first seen. */
  firstSeen: string;
  /** ISO date the hash last changed. */
  lastChanged: string;
  /** Bytes of the normalised text, to catch a page collapsing to a stub. */
  length: number;
  lastStatus?: number;
  lastError?: string;
}

export type PageHashState = Record<string, PageHashRecord>;

export interface PageChange {
  programId: string;
  url: string;
  kind: "changed" | "new" | "failed" | "suspicious";
  detail: string;
  previousLength?: number;
  length?: number;
}

/**
 * Reduce a page to the text a human would read.
 *
 * The normalisation has to be aggressive or the detector is useless: pages carry
 * CSRF tokens, cache-busting query strings on assets, rotating ad slots, "as of
 * <timestamp>" footers and randomised element ids, any one of which changes on
 * every single fetch and would report a change every day until it is ignored.
 *
 * An alarm that fires daily is an alarm that has been turned off.
 */
export function normalizePage(html: string): string {
  return html
    // Whole elements whose content is never prose.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // All markup, including the attributes where the rotating values live.
    .replace(/<[^>]+>/g, " ")
    // Entities that would otherwise make identical text hash differently.
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    // Bare timestamps and years-in-parens that some CMSes stamp per-request.
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function hashPage(html: string): { hash: string; length: number } {
  const text = normalizePage(html);
  return { hash: createHash("sha256").update(text).digest("hex").slice(0, 16), length: text.length };
}

/**
 * Compare a freshly fetched page against the stored hash.
 *
 * `body` is undefined when the fetch failed, and that is reported as a change of
 * its own kind — a page we can no longer reach is exactly as actionable as a
 * page that moved, and far more likely to be ignored if it is silent.
 */
export function comparePage(
  watch: PageWatch,
  today: string,
  previous: PageHashRecord | undefined,
  body: string | undefined,
  status?: number,
  error?: string,
): { record: PageHashRecord | undefined; change: PageChange | undefined } {
  if (body === undefined) {
    return {
      record: previous ? { ...previous, lastStatus: status, lastError: error } : undefined,
      change: {
        programId: watch.programId,
        url: watch.url,
        kind: "failed",
        detail: error ?? `fetch failed${status ? ` (HTTP ${status})` : ""}`,
      },
    };
  }

  // A challenge page hashes perfectly well and would otherwise be recorded as
  // "the page changed", then as "unchanged" every day after — quietly replacing
  // the real page with a bot wall in our state file.
  const challenge = describeChallenge(body);
  if (challenge) {
    return {
      record: previous ? { ...previous, lastStatus: status, lastError: challenge } : undefined,
      change: { programId: watch.programId, url: watch.url, kind: "failed", detail: `got a ${challenge}` },
    };
  }

  const { hash, length } = hashPage(body);

  if (!previous) {
    return {
      record: { hash, firstSeen: today, lastChanged: today, length, lastStatus: status },
      change: { programId: watch.programId, url: watch.url, kind: "new", detail: "first time seen — baseline recorded", length },
    };
  }

  if (previous.hash === hash) {
    return { record: { ...previous, length, lastStatus: status, lastError: undefined }, change: undefined };
  }

  /**
   * A page that lost most of its text is more likely a soft failure than an
   * edit — a login wall, a partial render, a CDN error page that our challenge
   * patterns do not know about yet. Flag it differently so a human reads it as
   * "this looks broken" rather than "the deadline may have moved".
   */
  const ratio = previous.length > 0 ? length / previous.length : 1;
  const suspicious = previous.length > 2000 && ratio < 0.4;

  return {
    record: { hash, firstSeen: previous.firstSeen, lastChanged: today, length, lastStatus: status },
    change: {
      programId: watch.programId,
      url: watch.url,
      kind: suspicious ? "suspicious" : "changed",
      detail: suspicious
        ? `page shrank from ${previous.length} to ${length} chars — likely a wall, not an edit`
        : `content changed (last changed ${previous.lastChanged})`,
      previousLength: previous.length,
      length,
    },
  };
}
