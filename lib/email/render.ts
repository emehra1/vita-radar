/**
 * The daily email.
 *
 * Rendered from the committed digest JSON and never by re-fetching anything, so
 * the email, the archive on disk and (from phase 2) the web page carry the same
 * bytes. If the email says something the JSON does not, that is a bug in here.
 *
 * Client constraints, carried over verbatim in spirit from the sibling project
 * because each one was paid for: ONE 600px presentational table, inline styles
 * only — no flex, no grid, no external CSS, no web fonts, no images — an explicit
 * color on every single text element because Gmail's dark-mode inverter mangles
 * unset colors, a hybrid dark mode (inline light values plus a
 * prefers-color-scheme block overriding a handful of classes with !important),
 * and a real text/plain alternative rather than a stripped-tags approximation.
 *
 * Order is not cosmetic. It is the project's priority list made physical:
 *
 *   1. VERIFY   — what a human has to go look at, because a hand-maintained YAML
 *                 fails by going quietly stale, and a stale date counts down
 *                 just as confidently as a real one.
 *   2. COUNTDOWN— every dated program inside the horizon, every day, no
 *                 exceptions and no degradation.
 *   3. LANES    — deadlines pinned first; a preprint never displaces a date.
 *   4. CATALYSTS— upcoming FDA decision dates. Decoration, and the first
 *                 substantive block the size ladder sheds.
 *   5. EDITORIAL— model-written, last, linking nothing.
 *   6. FOOTER   — the heartbeat. Load-bearing, see heartbeatLine.
 *
 * Node-side (it measures bytes with Buffer). lib/format.ts stays browser-safe;
 * this file does not.
 */

import type {
  Catalyst,
  CountdownRow,
  DailyDigest,
  DigestItem,
  Lane,
  MarketSection,
  NewsItem,
  OpportunityItem,
  VerifyRow,
} from "../types.ts";
import { LANE_LABELS, PINNED_LANE, isOpportunity } from "../types.ts";
import { formatWhen, parseDeadlineDate } from "../../pipeline/normalize/dates.ts";
import { formatDaysUntil, pluralize, truncate } from "../format.ts";
import { html, raw, safeUrl, type Raw } from "../html.ts";
import {
  COLORS,
  DARK_MODE_CSS,
  DEFAULT_HORIZON_DAYS,
  EmptyCountdownError,
  assertCountdownRenderable,
  chip,
  countdownPhrase,
  renderCountdownHtml,
  renderCountdownText,
  selectCountdownRows,
} from "./countdown.ts";

export { EmptyCountdownError };

/** Gmail clips around 102 KB and hides everything after the cut behind a link. */
const MAX_HTML_BYTES = 95_000;

/** Mirrors `subjectEscalationDays` in weights.json. Pass the loaded value from run.ts. */
const DEFAULT_SUBJECT_ESCALATION_DAYS = 14;

/** Mirrors `maxItemsPerLane` in weights.json. */
const DEFAULT_MAX_PER_LANE = 6;

export interface RenderOptions {
  siteUrl?: string;
  /** weights.json `countdownStripDays`. */
  countdownHorizonDays?: number;
  /** weights.json `subjectEscalationDays`. */
  subjectEscalationDays?: number;
  /** weights.json `maxItemsPerLane`. */
  maxPerLane?: number;
  /**
   * Overrides `digest.stats.deadlinesTracked` for the zero-is-an-error check.
   * A caller that knows the registry size should pass it: the check has to be
   * able to fire even on a digest whose own stats block is wrong.
   */
  deadlinesTracked?: number;
  /**
   * The program whose verification comes due soonest, for the heartbeat. The
   * digest carries no verifyBy dates, so run.ts supplies this from the registry;
   * without it the heartbeat falls back to the stalest row in `verify`.
   */
  nextUnverified?: { label: string; days: number };
  /** Hours left for a row due today, so the strip can say "in 6 hours". */
  hoursUntil?: (row: CountdownRow) => number;
  /**
   * The window the catalyst collector actually swept, in days.
   *
   * Only ever printed in the empty state — and the empty state is exactly the
   * case where it cannot be inferred from the data, because there is no data.
   * A caller that sweeps a different window must pass it, or the email names a
   * horizon nobody looked at.
   */
  catalystHorizonDays?: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface LaneEntry {
  id: Lane;
  label: string;
  blurb: string;
  items: DigestItem[];
}

/** How much detail one rung of the size ladder emits. See the ladder in renderDigestEmail. */
interface BuildStep {
  showBody: boolean;
  showBlurbs: boolean;
  perLane: number;
  showCatalysts: boolean;
  showEditorial: boolean;
  pinnedOnly: boolean;
}

/* ------------------------------- small parts ------------------------------- */

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * `not-modified` counts as healthy. A conditional request that earns an honest
 * 304 is a source that worked; counting it as a failure would put the footer
 * permanently at 8/14 and train the reader to ignore the one number in this
 * email that is supposed to mean something.
 */
function sourceCounts(digest: DailyDigest): { ok: number; total: number; degraded: string[] } {
  const health = digest.health ?? [];
  const ok = health.filter((h) => h.status === "ok" || h.status === "not-modified").length;
  const degraded = health
    .filter((h) => h.status === "failed" || h.status === "degraded")
    .map((h) => h.sourceName);
  return { ok, total: health.length, degraded };
}

function whyLine(item: DigestItem): string {
  // The digest on disk was written by whatever version of the pipeline ran that
  // day, so a field that types.ts calls required can still be absent from a file
  // from last month. Re-rendering an old digest must not throw.
  const factors = item.scoreBreakdown?.factors ?? [];
  return factors
    .slice(0, 2)
    .map((factor) => factor.label)
    .join(" · ");
}

/**
 * The deadline line on an opportunity card.
 *
 * Re-derives the instant from the stored fields rather than trusting a
 * pre-rendered string, because `formatWhen` prints BOTH zones when they differ
 * and that is the whole point: an Oxford 23:59 read in Boston is a five-hour
 * shift that can move the DAY. If the parse fails we print the raw YAML date
 * instead of guessing — a date we cannot parse is still a date a human wrote.
 */
function deadlineLine(item: OpportunityItem): string {
  const deadline = item.opportunity.deadline;
  const parts: string[] = [];
  if (item.daysUntil !== undefined) parts.push(countdownPhrase(item.daysUntil));

  if (deadline.kind === "rolling") {
    parts.push("rolling — reviewed as received");
  } else if (deadline.kind === "unknown" || !deadline.date) {
    parts.push("date not known — a human has to look");
  } else {
    const parsed = parseDeadlineDate(deadline.date, {
      timeZone: deadline.timeZone,
      timeOfDay: deadline.timeOfDay,
      precisionHint: deadline.precision,
    });
    parts.push(
      parsed.instant
        ? formatWhen(parsed.instant, deadline.timeZone, parsed.precision)
        : `${deadline.date} (unparsed — check the YAML)`,
    );
  }

  if (deadline.kind === "projected") parts.push("projected");
  if (deadline.precision === "month") parts.push("(day unknown — check)");
  if (!deadline.cycleYearConfident) parts.push(`cycle ${deadline.cycleYear}?`);
  return parts.join(" · ");
}

function nextStepLine(item: OpportunityItem): string {
  const facts = item.opportunity;
  const index = facts.nextStepIndex;
  if (index < 0) return "";
  const step = facts.steps?.[index];
  if (!step) return "";
  const bits = [step.label];
  if (step.due) bits.push(`due ${step.due}${step.timeOfDay ? ` ${step.timeOfDay}` : ""}`);
  if (step.system) bits.push(step.system);
  return `Next: ${bits.join(" · ")}`;
}

/* --------------------------------- blocks --------------------------------- */

/**
 * VERIFY, at the top.
 *
 * This block is above the countdown strip on purpose. The strip shows dates
 * counting down, and a date that went stale two cycles ago counts down exactly
 * as confidently as one a human confirmed last week — so the strip cannot show
 * you this class of failure, only this block can. It is the price of a
 * hand-maintained YAML, and the point of paying it here is that the price is
 * visible.
 */
function renderVerifyHtml(rows: VerifyRow[]): Raw {
  if (rows.length === 0) return html``;
  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;">
      <tr>
        <td
          class="vr-alert-bg"
          bgcolor="${COLORS.alertBg}"
          style="background:${COLORS.alertBg};border-left:3px solid ${COLORS.alertBorder};padding:12px 14px;"
        >
          <div
            class="vr-alert"
            style="color:${COLORS.alert};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;"
          >
            ${verifyHeadline(rows)}
          </div>
          ${rows.map(
            (row) => html`
              <div class="vr-ink" style="color:${COLORS.ink};padding-top:8px;font-size:13px;line-height:1.45;">
                ${row.url
                  ? html`<a
                      class="vr-ink"
                      href="${raw(safeUrl(row.url))}"
                      style="color:${COLORS.ink};font-weight:600;text-decoration:none;"
                      >${row.label}</a
                    >`
                  : html`<span class="vr-ink" style="color:${COLORS.ink};font-weight:600;">${row.label}</span>`}
                <span class="vr-muted" style="color:${COLORS.muted};">
                  — ${row.reason}${row.staleDays !== undefined ? ` (last checked ${row.staleDays}d ago)` : ""}
                </span>
              </div>
            `,
          )}
        </td>
      </tr>
    </table>
  `;
}

/**
 * "VERIFY: 3 deadlines unchecked for 91+ days".
 *
 * The "+" figure is the SMALLEST staleness in the set, not the largest or an
 * average, so the headline is a statement that is true of every row it counts.
 * Rows with no `staleDays` (a discrepancy a scraper raised, say) have no
 * staleness to quote, so a mixed set falls back to the plain count rather than
 * quoting a number that only covers some of them.
 */
function verifyHeadline(rows: VerifyRow[]): string {
  const n = rows.length;
  const noun = pluralize(n, "deadline");
  const staleDays = rows
    .map((row) => row.staleDays)
    .filter((days): days is number => typeof days === "number");
  if (staleDays.length === n && n > 0) {
    return `VERIFY: ${n} ${noun} unchecked for ${Math.min(...staleDays)}+ days`;
  }
  return `VERIFY: ${n} ${noun} ${n === 1 ? "needs" : "need"} a human`;
}

function renderItemHtml(item: DigestItem, step: BuildStep): Raw {
  return isOpportunity(item) ? renderOpportunityHtml(item, step) : renderNewsHtml(item, step);
}

function renderOpportunityHtml(item: OpportunityItem, step: BuildStep): Raw {
  const facts = item.opportunity;
  const gatingStep = facts.steps?.[facts.nextStepIndex];
  const next = nextStepLine(item);
  return html`
    <tr>
      <td class="vr-hr" style="padding:12px 0;border-bottom:1px solid ${COLORS.border};">
        <a
          class="vr-ink"
          href="${raw(safeUrl(item.url))}"
          style="color:${COLORS.ink};font-size:15px;font-weight:600;line-height:1.4;text-decoration:none;"
          >${facts.label || item.title}</a
        >
        ${facts.priority === "high" ? html` ${chip("priority", COLORS.gating, "vr-gating")}` : ""}
        ${facts.needsVerification ? html` ${chip("verify", COLORS.alert, "vr-alert")}` : ""}
        ${item.isNew ? html` ${chip("new", COLORS.accent, "vr-accent")}` : ""}
        <div class="vr-accent" style="color:${COLORS.accent};font-size:13px;font-weight:600;padding-top:4px;">
          ${deadlineLine(item)}
        </div>
        ${next
          ? html`<div class="vr-ink" style="color:${COLORS.ink};font-size:13px;padding-top:4px;">
              ${next}${gatingStep?.gating ? html` ${chip("gating", COLORS.gating, "vr-gating")}` : ""}
            </div>`
          : ""}
        ${facts.discrepancy
          ? html`<div class="vr-alert" style="color:${COLORS.alert};font-size:12px;padding-top:4px;line-height:1.45;">
              Page disagrees with the tracker on ${facts.discrepancy.field}: tracker
              "${facts.discrepancy.yaml}", page "${facts.discrepancy.page}". The tracker still wins —
              go read it.
            </div>`
          : ""}
        ${step.showBody && facts.eligibility?.notes
          ? html`<div class="vr-muted" style="color:${COLORS.muted};font-size:12px;padding-top:4px;line-height:1.45;">
              ${truncate(facts.eligibility.notes, 220)}
            </div>`
          : ""}
        <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;padding-top:4px;">
          ${[facts.org, item.sourceName, `score ${Math.round(item.score)}`, whyLine(item)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
    </tr>
  `;
}

function renderNewsHtml(item: NewsItem, step: BuildStep): Raw {
  const body = item.digest?.[0];
  return html`
    <tr>
      <td class="vr-hr" style="padding:12px 0;border-bottom:1px solid ${COLORS.border};">
        <a
          class="vr-ink"
          href="${raw(safeUrl(item.url))}"
          style="color:${COLORS.ink};font-size:15px;font-weight:600;line-height:1.4;text-decoration:none;"
          >${item.title}</a
        >
        ${item.paywalled ? html` ${chip("paywall", COLORS.muted, "vr-muted")}` : ""}
        <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;padding-top:4px;">
          ${[item.sourceName, `score ${Math.round(item.score)}`, whyLine(item)].filter(Boolean).join(" · ")}
        </div>
        ${step.showBody && body
          ? html`<div class="vr-ink" style="color:${COLORS.ink};font-size:13px;line-height:1.5;padding-top:6px;">
              ${body}
            </div>`
          : ""}
      </td>
    </tr>
  `;
}

/* -------------------------------- catalysts -------------------------------- */

/**
 * Watched rows are the point of this section; every other row is context.
 * Both halves are capped because the PDUFA calendar carries 1,553 events with
 * 64 of them still upcoming, and a section that can grow to sixty rows spends
 * the byte budget that the footer heartbeat needs to survive Gmail's clip.
 */
const MAX_WATCHED_CATALYSTS = 12;
const MAX_UNWATCHED_CATALYSTS = 8;

/** Only ever printed in the empty state. See RenderOptions.catalystHorizonDays. */
const DEFAULT_CATALYST_HORIZON_DAYS = 90;

const CATALYST_KIND_LABELS: Record<Catalyst["kind"], string> = {
  pdufa: "PDUFA",
  adcomm: "AdCom",
};

interface CatalystView {
  watched: Catalyst[];
  unwatched: Catalyst[];
  hiddenWatched: number;
  hiddenUnwatched: number;
  horizonDays: number;
}

/**
 * Watched first, then soonest.
 *
 * These calendars are overwhelmingly companies the reader has never heard of,
 * so ordering by date alone buries the two rows that were the reason to fetch
 * the feed under thirty rows that were not. Date order is the tiebreak, not the
 * sort.
 */
function compareCatalysts(a: Catalyst, b: Catalyst): number {
  if (a.watched !== b.watched) return a.watched ? -1 : 1;
  if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return (a.ticker ?? a.label).localeCompare(b.ticker ?? b.label);
}

/**
 * `undefined` means "render nothing at all", and it is a third state rather
 * than a flavour of empty.
 *
 * A half-read calendar and a genuinely quiet quarter produce the same short
 * list, so a degraded feed may not print one — the reader would take a subset
 * for the whole, which is the silent-failure shape this project spends most of
 * its design budget refusing. The section removing itself is distinguishable
 * from the section saying "nothing in range", and that distinction is the
 * entire point. Nothing load-bearing is lost either way: these dates are
 * decoration, they never make a run unusable, and every date that governs the
 * reader's own life is in the countdown strip above, which comes from the YAML
 * and not from anyone's calendar.
 */
function selectCatalysts(markets: MarketSection, options: RenderOptions): CatalystView | undefined {
  const broken = (markets.health ?? []).some(
    (entry) => entry.status === "failed" || entry.status === "degraded",
  );
  if (broken) return undefined;

  const sorted = [...(markets.catalysts ?? [])].sort(compareCatalysts);
  const watchedAll = sorted.filter((catalyst) => catalyst.watched);
  const unwatchedAll = sorted.filter((catalyst) => !catalyst.watched);
  const watched = watchedAll.slice(0, MAX_WATCHED_CATALYSTS);
  const unwatched = unwatchedAll.slice(0, MAX_UNWATCHED_CATALYSTS);

  return {
    watched,
    unwatched,
    hiddenWatched: watchedAll.length - watched.length,
    hiddenUnwatched: unwatchedAll.length - unwatched.length,
    horizonDays: options.catalystHorizonDays ?? DEFAULT_CATALYST_HORIZON_DAYS,
  };
}

/**
 * "+34 more on the calendars, not shown".
 *
 * Emitted whenever anything was cut. A truncated list with no count reads as a
 * complete one, which is the countdown strip's empty-section failure repeated
 * one floor down: the reader concludes "that was everything" from a section
 * that was silently shortened for space.
 */
function catalystsNotShown(view: CatalystView): string {
  const hidden = view.hiddenWatched + view.hiddenUnwatched;
  if (hidden === 0) return "";
  if (view.hiddenWatched > 0) {
    return `+${hidden} more not shown, ${view.hiddenWatched} of them on your watchlist`;
  }
  return `+${hidden} more on the calendars, not shown`;
}

/**
 * Where these dates came from, said in the email rather than only in the README.
 *
 * They are two public Google calendars maintained by an FDA tracker, not a
 * regulatory filing, and a reader deciding what to do with a row has to be able
 * to weigh that. The date itself prints exactly as published: reformatting a
 * bare YYYY-MM-DD means assuming a zone, and a PDUFA date moved a day by an
 * assumed zone is the precise flavour of confident wrongness this repo exists
 * to avoid shipping.
 */
function catalystProvenance(markets: MarketSection): string {
  const names = [
    ...new Set(
      [
        ...(markets.health ?? []).map((entry) => entry.sourceName),
        ...(markets.catalysts ?? []).map((catalyst) => catalyst.source),
      ].filter((name): name is string => Boolean(name && name.trim())),
    ),
  ];
  const who = names.length > 0 ? names.join(" + ") : "two FDA-tracker calendars";
  return `as of ${markets.asOf} · from ${who} — public tracker calendars read as ICS, dates printed exactly as published`;
}

function catalystTitle(catalyst: Catalyst): string {
  const parts = [catalyst.ticker, catalyst.company].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  return parts.length > 0 ? parts.join(" — ") : catalyst.label;
}

/**
 * The label, but only when it says something the row has not already said.
 *
 * The ICS SUMMARY is "<TICKER> <Company> PDUFA", so on most rows `label` is a
 * restatement of the ticker, the company and the kind that the row prints
 * anyway. A line that repeats the line above it in a 600px column is how a
 * reader learns to skip a whole block.
 */
function catalystExtra(catalyst: Catalyst): string {
  const label = (catalyst.label ?? "").trim();
  if (!label) return "";
  const known = [catalyst.ticker, catalyst.company].filter(Boolean).join(" ").trim().toLowerCase();
  if (!known) return label;
  const normalized = label.toLowerCase();
  if (normalized.includes(known) || known.includes(normalized)) return "";
  return label;
}

function catalystDetail(catalyst: Catalyst): string {
  return [catalyst.date, CATALYST_KIND_LABELS[catalyst.kind] ?? catalyst.kind, catalystExtra(catalyst)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One catalyst row, laid out like a countdown row on purpose.
 *
 * A PDUFA date is the same object as a fellowship deadline — a dated thing you
 * can prepare for — so it gets the same T-number in the same column rather than
 * a second visual language halfway down the email.
 *
 * Watched rows are ink, bold, accent-ruled and chipped; unwatched rows are
 * muted throughout. Both the weight and the rule are set because Gmail's
 * dark-mode inverter can flatten a colour difference, and a distinction that
 * survives only in light mode is not a distinction.
 */
function catalystRowHtml(catalyst: Catalyst): Raw {
  const watched = catalyst.watched;
  const color = watched ? COLORS.ink : COLORS.muted;
  const cls = watched ? "vr-ink" : "vr-muted";
  return html`
    <tr>
      <td
        class="${cls}"
        align="right"
        style="padding:7px 10px 7px 0;color:${color};font-size:13px;font-weight:${watched
          ? "700"
          : "400"};white-space:nowrap;vertical-align:top;width:104px;"
      >
        ${formatDaysUntil(catalyst.daysUntil)}
      </td>
      <td
        class="vr-hr"
        style="padding:7px 0;border-bottom:1px solid ${COLORS.border};vertical-align:top;${watched
          ? `border-left:3px solid ${COLORS.accent};padding-left:9px;`
          : ""}"
      >
        <div class="${cls}" style="color:${color};font-size:13px;line-height:1.45;font-weight:${watched
          ? "600"
          : "400"};">
          ${catalystTitle(catalyst)}${watched ? html` ${chip("watched", COLORS.accent, "vr-accent")}` : ""}
        </div>
        <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;line-height:1.45;padding-top:2px;">
          ${catalystDetail(catalyst)}
        </div>
      </td>
    </tr>
  `;
}

/**
 * Upcoming FDA decision dates. Explicitly not a portfolio.
 *
 * There are no prices in this email and there never will be: every keyless
 * quote source is unusable (Yahoo 429s, Stooq answers 200 with a proof-of-work
 * challenge, Alpha Vantage allows 25 requests a day, Tiingo's free tier forbids
 * redistributing the numbers), and the prices were the worthless half anyway —
 * a daily percentage move is the one figure here that is embarrassing when
 * wrong and useless when right. The dates are the signal, so the heading says
 * "decision dates" rather than "markets": a heading that names a portfolio
 * invites the reader to look for a number that is deliberately absent.
 */
function renderCatalystsHtml(markets: MarketSection, options: RenderOptions): Raw {
  const view = selectCatalysts(markets, options);
  if (!view) return html``;
  const rows = [...view.watched, ...view.unwatched];
  const notShown = catalystsNotShown(view);

  return html`
    <h2
      class="vr-ink"
      style="color:${COLORS.ink};font-size:15px;margin:24px 0 4px;padding-top:12px;border-top:2px solid ${COLORS.border};"
    >
      Upcoming FDA decision dates
    </h2>
    <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;line-height:1.5;">
      PDUFA and advisory-committee dates, watched tickers first. A calendar, not a portfolio — there
      are no prices in this email.
    </div>
    <div class="vr-muted" style="color:${COLORS.muted};font-size:11px;line-height:1.5;padding:2px 0 6px;">
      ${catalystProvenance(markets)}
    </div>
    ${rows.length === 0
      ? html`<div class="vr-ink" style="color:${COLORS.ink};font-size:13px;line-height:1.5;">
          No FDA decisions inside the next ${view.horizonDays} days. The calendars answered and had
          nothing in range — that is a reading, not a gap.
        </div>`
      : html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          ${rows.map((catalyst) => catalystRowHtml(catalyst))}
        </table>`}
    ${notShown
      ? html`<div class="vr-muted" style="color:${COLORS.muted};font-size:11px;padding-top:8px;">
          ${notShown}
        </div>`
      : ""}
  `;
}

/**
 * The same section in text/plain. Returns lines rather than a block so the
 * caller can decide about the blank line after it — and returns NONE at all in
 * the degraded case, matching renderCatalystsHtml exactly. Two renderers that
 * disagree about when a section exists is how the text part quietly becomes a
 * different email.
 */
function renderCatalystsText(markets: MarketSection, options: RenderOptions): string[] {
  const view = selectCatalysts(markets, options);
  if (!view) return [];
  const rows = [...view.watched, ...view.unwatched];

  const lines = [
    "UPCOMING FDA DECISION DATES (a calendar, not a portfolio — no prices here)",
    `  ${catalystProvenance(markets)}`,
  ];
  if (rows.length === 0) {
    lines.push(`  No FDA decisions inside the next ${view.horizonDays} days.`);
  }
  for (const catalyst of rows) {
    const tag = catalyst.watched ? " [WATCHED]" : "";
    lines.push(`  ${formatDaysUntil(catalyst.daysUntil).padEnd(6)} ${catalystTitle(catalyst)}${tag}`);
    lines.push(`         ${catalystDetail(catalyst)}`);
  }
  const notShown = catalystsNotShown(view);
  if (notShown) lines.push(`  ${notShown}`);
  return lines;
}

/**
 * The editorial, last, in a box that cannot be mistaken for an obligation.
 *
 * Grey left border, never the amber one — amber is reserved in this email for
 * things a human must act on, and a skim that mistakes model prose for a
 * deadline is a worse outcome than no opener at all.
 *
 * It links nothing, and it is rendered through the escaping template as text.
 * If the model emits a markdown link it appears as literal characters. That is
 * intended: the model may describe what the pipeline found, and it may not point
 * the reader anywhere the pipeline did not verify.
 */
function renderEditorialHtml(editorial: string): Raw {
  const paragraphs = editorial
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (paragraphs.length === 0) return html``;
  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;">
      <tr>
        <td class="vr-strip" bgcolor="${COLORS.strip}" style="background:${COLORS.strip};border-left:3px solid ${COLORS.border};padding:12px 14px;">
          <div
            class="vr-muted"
            style="color:${COLORS.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;"
          >
            The opener · model-written
          </div>
          ${paragraphs.map(
            (para) => html`<div class="vr-ink" style="color:${COLORS.ink};font-size:13px;line-height:1.6;padding-top:6px;">
              ${para}
            </div>`,
          )}
        </td>
      </tr>
    </table>
  `;
}

/**
 * The heartbeat. This is not decoration.
 *
 * The primary alarm in this system is the ABSENCE of the daily email, which only
 * works if every email that does arrive carries proof that the run behind it was
 * real. So the footer states the run instant, how many sources answered, how many
 * deadlines the registry holds, how many were verified this week, and which
 * program is next to need checking. A reader who sees "sources 3/14" or
 * "0 deadlines tracked" knows something broke even though the email looks fine,
 * and that is the only way a silent partial failure gets caught.
 *
 * "next unverified" always prints a value, "none" included. An omitted field
 * cannot be distinguished from a field that rendered empty.
 */
function heartbeatLine(digest: DailyDigest, options: RenderOptions): string {
  const { ok, total, degraded } = sourceCounts(digest);
  const tracked = options.deadlinesTracked ?? digest.stats?.deadlinesTracked ?? 0;
  const verified = digest.stats?.verifiedLast7d ?? 0;
  const parts = [
    `run ${digest.generatedAt}`,
    `sources ${ok}/${total}`,
    `${tracked} ${pluralize(tracked, "deadline")} tracked`,
    `${verified} verified in 7d`,
    `next unverified: ${nextUnverifiedLabel(digest, options)}`,
  ];
  // Named, not just counted. "sources 12/14" tells you two are down; it does not
  // tell you that the two are the ones that carry the Rhodes endorsement page,
  // which is the difference between a shrug and a manual check.
  if (degraded.length > 0) parts.push(`degraded: ${degraded.join(", ")}`);
  return parts.join(" · ");
}

function nextUnverifiedLabel(digest: DailyDigest, options: RenderOptions): string {
  if (options.nextUnverified) {
    const { label, days } = options.nextUnverified;
    return `${label} (${days}d)`;
  }
  // Without the registry's verifyBy dates the honest fallback is the row that has
  // gone longest without a human, labelled as staleness rather than as a due date
  // so the two can never be confused for one another.
  const stalest = [...(digest.verify ?? [])]
    .filter((row) => typeof row.staleDays === "number")
    .sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0))[0];
  if (stalest) return `${stalest.label} (stale ${stalest.staleDays}d)`;
  const flagged = [...(digest.countdown ?? [])]
    .filter((row) => row.needsVerification)
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (flagged) return `${flagged.label} (${formatDaysUntil(flagged.daysUntil)})`;
  return "none";
}

/* --------------------------------- lanes ---------------------------------- */

/**
 * PINNED_LANE first, then the pipeline's own order.
 *
 * Array#sort is stable, so a single rank comparison moves "deadlines" to the
 * front and leaves everything behind it exactly as the pipeline emitted it.
 * Empty lanes drop out — a lane with no cards today is normal, because cards are
 * episodic and only fire on rungs. The continuity that must never be empty is
 * the strip, and that is enforced in countdown.ts rather than here.
 */
function laneEntries(digest: DailyDigest): LaneEntry[] {
  return (digest.lanes ?? [])
    .map((lane) => ({
      id: lane.id,
      label: lane.label || LANE_LABELS[lane.id],
      blurb: lane.blurb,
      items: (lane.itemIds ?? [])
        .map((id) => digest.items?.[id])
        .filter((item): item is DigestItem => Boolean(item)),
    }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => (a.id === PINNED_LANE ? 0 : 1) - (b.id === PINNED_LANE ? 0 : 1));
}

/* -------------------------------- subject --------------------------------- */

/**
 * "Rhodes Scholarship (US)" → "Rhodes".
 *
 * The subject line's budget is a phone lock screen, roughly forty characters,
 * and the T-number has to survive. So the qualifier in parentheses goes, and so
 * does the generic noun: "Rhodes" identifies the program and "Scholarship" does
 * not. Only strip the noun when something is left after it, or "Blavatnik
 * Fellowship" becomes "Blavatnik" but "Fellowship" alone becomes nothing.
 */
const GENERIC_TAIL =
  /\s+(scholarships?|fellowships?|scholars|programmes?|programs?|awards?|application)$/i;

export function subjectLabel(label: string): string {
  let value = label;
  for (const separator of [" — ", " – ", " (", ": ", " / ", " - "]) {
    const index = value.indexOf(separator);
    if (index > 0) value = value.slice(0, index);
  }
  value = value.trim();
  const stripped = value.replace(GENERIC_TAIL, "").trim();
  if (stripped.length > 0) value = stripped;
  return truncate(value, 24);
}

/**
 * The subject line.
 *
 * A subject change is the only alarm that works on a locked phone, so the
 * escalation goes FIRST — before the product name, before the date — because
 * everything after roughly forty characters is invisible until the phone is
 * unlocked.
 *
 * This path reads `digest.countdown` and `digest.date` and nothing else. No
 * network, no model, no filesystem. The alarm cannot be allowed to depend on the
 * two things in this system that are permitted to fail: a fetch and an LLM call.
 *
 * `digest.markets` is deliberately not consulted, and that is a rule rather than
 * an omission: a catalyst may never take over the subject line. Those dates come
 * from a third-party public calendar, so wiring one in would hand an outside
 * publisher the only alarm in this system that works on a locked phone — a feed
 * glitch could then bury a Rhodes gating step behind someone else's PDUFA date.
 * The subject escalates on `provenance: "yaml"` deadlines or on nothing.
 *
 * Escalation candidates are GATING rows only, sorted ascending, so an already
 * closed gating step (negative days, rendered "T+3") outranks everything. If a
 * gating step slipped, that is the loudest thing this system can say, and it
 * needs to be said the same day rather than discovered in the archive.
 */
export function renderSubject(digest: DailyDigest, options: RenderOptions = {}): string {
  const rows = digest.countdown ?? [];
  assertCountdownRenderable(rows, options.deadlinesTracked ?? digest.stats?.deadlinesTracked ?? 0);
  const escalationDays = options.subjectEscalationDays ?? DEFAULT_SUBJECT_ESCALATION_DAYS;

  const gating = rows
    .filter((row) => row.gating && row.daysUntil <= escalationDays)
    .sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (gating) {
    return `[${formatDaysUntil(gating.daysUntil)} ${subjectLabel(gating.label)}] Vita Radar — ${digest.date}`;
  }

  const closingSoon = rows.filter((row) => row.daysUntil >= 0 && row.daysUntil <= escalationDays).length;
  if (closingSoon > 0) {
    return `Vita Radar — ${digest.date} · ${closingSoon} closing soon`;
  }

  // Nothing close, but the strip is never empty here — so say how far off the
  // nearest thing is rather than printing a bare date, which would read the same
  // on a day the pipeline produced nothing.
  const nearest = [...rows].sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (nearest) {
    return `Vita Radar — ${digest.date} · next ${formatDaysUntil(nearest.daysUntil)} ${subjectLabel(nearest.label)}`;
  }
  return `Vita Radar — ${digest.date} · no dated programs tracked`;
}

/* ------------------------------- the email -------------------------------- */

export function renderDigestEmail(digest: DailyDigest, options: RenderOptions = {}): RenderedEmail {
  const tracked = options.deadlinesTracked ?? digest.stats?.deadlinesTracked ?? 0;
  const countdown = digest.countdown ?? [];

  // Before anything is rendered. Zero rows against a non-empty registry is a
  // build failure wearing the costume of a quiet day; run.ts turns this into a
  // non-zero exit, which means no email and no commit, and the missing email is
  // the alarm.
  assertCountdownRenderable(countdown, tracked);

  const subject = renderSubject(digest, options);
  const horizonDays = options.countdownHorizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxPerLane = options.maxPerLane ?? DEFAULT_MAX_PER_LANE;
  const lanes = laneEntries(digest);
  const verify = digest.verify ?? [];

  // Both of these are rendered ONCE, here, and interpolated into the ladder as
  // finished markup. That is the enforcement, not the comment: no BuildStep field
  // reaches this code, so no future degradation rung can shrink the strip or the
  // verify block by accident. Everything else in the email is negotiable.
  const strip = renderCountdownHtml(countdown, {
    horizonDays,
    deadlinesTracked: tracked,
    hoursUntil: options.hoursUntil,
  });
  const verifyBlock = renderVerifyHtml(verify);

  const selection = selectCountdownRows(countdown, { horizonDays });
  const heroCount = selection.rows.length;

  const build = (step: BuildStep): string => {
    const visibleLanes = step.pinnedOnly ? lanes.filter((lane) => lane.id === PINNED_LANE) : lanes;
    return html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <title>${subject}</title>
          <style>${raw(DARK_MODE_CSS)}
          </style>
        </head>
        <body
          class="vr-page"
          style="margin:0;padding:0;background:${COLORS.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"
        >
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${COLORS.page}">
            <tr>
              <td align="center" style="padding:24px 12px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;">
                  <tr>
                    <td class="vr-card" bgcolor="${COLORS.card}" style="background:${COLORS.card};padding:24px;border-radius:12px;">
                      <div
                        class="vr-muted"
                        style="color:${COLORS.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;"
                      >
                        Vita Radar · ${digest.date}
                      </div>
                      <h1 class="vr-ink" style="color:${COLORS.ink};font-size:20px;margin:8px 0 2px;">
                        ${heroCount} ${pluralize(heroCount, "deadline")} inside ${horizonDays} days
                      </h1>
                      <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;">
                        ${digest.stats?.kept ?? 0} of ${digest.stats?.fetched ?? 0} items kept
                      </div>
                      ${options.siteUrl
                        ? html`<a
                            class="vr-accent"
                            href="${raw(safeUrl(options.siteUrl))}"
                            style="color:${COLORS.accent};font-size:13px;text-decoration:none;"
                            >View the archive →</a
                          >`
                        : ""}

                      ${verifyBlock} ${strip}

                      ${visibleLanes.map(
                        (lane) => html`
                          <h2
                            class="vr-ink"
                            style="color:${COLORS.ink};font-size:15px;margin:24px 0 0;padding-top:12px;border-top:2px solid ${COLORS.border};"
                          >
                            ${lane.label}
                          </h2>
                          ${step.showBlurbs && lane.blurb
                            ? html`<div class="vr-muted" style="color:${COLORS.muted};font-size:11px;padding-top:4px;line-height:1.45;">
                                ${lane.blurb}
                              </div>`
                            : ""}
                          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                            ${lane.items.slice(0, step.perLane).map((item) => renderItemHtml(item, step))}
                          </table>
                        `,
                      )}

                      ${step.showCatalysts && digest.markets ? renderCatalystsHtml(digest.markets, options) : ""}
                      ${step.showEditorial && digest.editorial ? renderEditorialHtml(digest.editorial) : ""}

                      <div
                        class="vr-muted"
                        style="color:${COLORS.muted};font-size:11px;padding-top:20px;line-height:1.7;border-top:1px solid ${COLORS.border};margin-top:20px;"
                      >
                        ${heartbeatLine(digest, options)}<br />
                        ${digest.editorial
                          ? "Ranked by deterministic weighted scoring; the opener is model-written."
                          : "Ranked by deterministic weighted scoring."}
                        ${step.showBody ? "" : " · trimmed to fit Gmail's clip"}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>`.value;
  };

  /**
   * The size ladder.
   *
   * Gmail clips around 102 KB and puts everything past the cut behind a "View
   * entire message" link — including the footer, which is the heartbeat. So
   * overflowing does not merely look untidy, it hides the proof that the run
   * happened. Detail goes first, then per-lane counts, then the opener, then the
   * FDA catalysts, and only at the very floor do the non-pinned lanes go.
   *
   * The verify block and the countdown strip appear at every rung, and not
   * because this comment says so: they were rendered into local variables above,
   * before this array existed, so no BuildStep field can reach them. The
   * catalyst section is the opposite — it is decoration read off a third-party
   * calendar, so it sits inside the ladder and is shed while the reader's own
   * dates are untouched.
   */
  const ladder: BuildStep[] = [];
  const push = (over: Partial<BuildStep>) =>
    ladder.push({
      showBody: true,
      showBlurbs: true,
      perLane: maxPerLane,
      showCatalysts: true,
      showEditorial: true,
      pinnedOnly: false,
      ...over,
    });

  push({});
  push({ showBody: false });
  push({ showBody: false, showBlurbs: false });
  for (let perLane = maxPerLane - 1; perLane >= 1; perLane--) {
    push({ showBody: false, showBlurbs: false, perLane });
  }
  push({ showBody: false, showBlurbs: false, perLane: 1, showEditorial: false });
  push({ showBody: false, showBlurbs: false, perLane: 1, showEditorial: false, showCatalysts: false });
  push({
    showBody: false,
    showBlurbs: false,
    perLane: 1,
    showEditorial: false,
    showCatalysts: false,
    pinnedOnly: true,
  });

  let output = "";
  for (const step of ladder) {
    output = build(step);
    if (bytes(output) <= MAX_HTML_BYTES) break;
  }
  // If even the floor is over budget we send the floor. The strip is at the top,
  // so what Gmail hides is the tail, and a clipped email that still opens on the
  // countdown beats no email at all — no email means the alarm fires for a
  // formatting problem.

  return { subject, html: output, text: renderText(digest, options) };
}

/**
 * The HTML part on its own, for callers that already have the subject and the
 * text part (scripts/send-email.ts builds all three separately so its preview
 * mode can write the HTML to a file and print the text to the terminal).
 *
 * It goes through the same ladder and the same asserts as renderDigestEmail —
 * there is deliberately no second rendering path, because a second path is where
 * the strip would eventually go missing from one of them.
 */
export function renderEmail(digest: DailyDigest, options: RenderOptions = {}): string {
  return renderDigestEmail(digest, options).html;
}

/* ------------------------------- text/plain ------------------------------- */

/**
 * A real text/plain alternative, in the same order as the HTML.
 *
 * Not a tag-stripped copy: the strip uses fixed-width T-numbers here because
 * nothing aligns a proportional column in plain text, and every item prints its
 * URL because a text reader has no anchors to click.
 */
export function renderText(digest: DailyDigest, options: RenderOptions = {}): string {
  const tracked = options.deadlinesTracked ?? digest.stats?.deadlinesTracked ?? 0;
  const countdown = digest.countdown ?? [];
  assertCountdownRenderable(countdown, tracked);

  const horizonDays = options.countdownHorizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxPerLane = options.maxPerLane ?? DEFAULT_MAX_PER_LANE;
  const lines: string[] = [`VITA RADAR — ${digest.date}`];
  if (options.siteUrl) lines.push(options.siteUrl);
  lines.push("");

  const verify = digest.verify ?? [];
  if (verify.length > 0) {
    lines.push(verifyHeadline(verify));
    for (const row of verify) {
      lines.push(
        `  - ${row.label} — ${row.reason}${row.staleDays !== undefined ? ` (last checked ${row.staleDays}d ago)` : ""}`,
      );
      if (row.url) lines.push(`    ${row.url}`);
    }
    lines.push("");
  }

  lines.push(
    renderCountdownText(countdown, {
      horizonDays,
      deadlinesTracked: tracked,
      hoursUntil: options.hoursUntil,
    }),
  );
  lines.push("");

  for (const lane of laneEntries(digest)) {
    lines.push(lane.label.toUpperCase());
    for (const item of lane.items.slice(0, maxPerLane)) {
      lines.push(`  - ${isOpportunity(item) ? item.opportunity.label || item.title : item.title}`);
      if (isOpportunity(item)) {
        lines.push(`    ${deadlineLine(item)}`);
        const next = nextStepLine(item);
        if (next) lines.push(`    ${next}`);
      } else if (item.digest?.[0]) {
        lines.push(`    ${item.digest[0]}`);
      }
      lines.push(`    ${[item.sourceName, `score ${Math.round(item.score)}`, whyLine(item)].filter(Boolean).join(" · ")}`);
      lines.push(`    ${item.url}`);
    }
    lines.push("");
  }

  if (digest.markets) {
    const catalystLines = renderCatalystsText(digest.markets, options);
    // Empty means the feed was degraded and the section suppressed itself. A
    // heading with nothing under it would say "no FDA dates", which is a claim
    // this renderer has no evidence for.
    if (catalystLines.length > 0) {
      lines.push(...catalystLines);
      lines.push("");
    }
  }

  if (digest.editorial) {
    lines.push("THE OPENER (model-written, links nothing)");
    for (const para of digest.editorial.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 6)) {
      lines.push(`  ${para}`);
    }
    lines.push("");
  }

  lines.push(heartbeatLine(digest, options));
  lines.push(
    digest.editorial
      ? "Ranked by deterministic weighted scoring; the opener is model-written."
      : "Ranked by deterministic weighted scoring.",
  );
  return lines.join("\n");
}
