/**
 * The countdown strip: the one block of this email that is never episodic.
 *
 * Cards fire on rungs — T-90, T-30, T-7 — so on most days most programs emit
 * nothing. That is correct for cards and fatal as a whole email: a day with no
 * card is indistinguishable from a day when the pipeline returned nothing, and
 * the second one is how you miss a deadline. The strip closes that gap. Every
 * dated program inside the horizon prints one line EVERY day, whether or not it
 * has news, whether or not a rung fired.
 *
 * This lives in its own module because of the size ladder in render.ts. When the
 * HTML overflows Gmail's clip, render.ts sheds detail step by step, and the
 * cheapest thing to shed is always whatever is longest — which is the strip. So
 * the strip is built HERE, once, before the ladder starts, and handed to the
 * ladder as finished markup. No degradation step has a value it can pass that
 * would reach this code. The rule is enforced by the direction of the import,
 * not by a comment in a build function that someone will edit later.
 *
 * The palette lives here for the same reason: render.ts imports this module and
 * never the reverse, so there is exactly one direction of dependency and no
 * third theme module to drift out of sync.
 */

import type { CountdownRow } from "../types.ts";
import { formatCountdown } from "../../pipeline/normalize/dates.ts";
import { formatDaysUntil } from "../format.ts";
import { html, raw, safeUrl, type Raw } from "../html.ts";

/** Mirrors `countdownStripDays` in pipeline/config/weights.json. Pass the loaded value. */
export const DEFAULT_HORIZON_DAYS = 60;

/**
 * A bound on rows so one pathological registry cannot push the email past the
 * clip on its own. It is a cap on LINES, never on existence: whatever is cut
 * gets counted in a footer line under the strip, so the reader is told the
 * number they are not seeing.
 */
const MAX_STRIP_ROWS = 30;

/**
 * When nothing at all is inside the horizon we still print the nearest few.
 * An empty strip is the failure this whole module exists to prevent, and
 * "everything is more than 60 days out" is a legitimate state that must still
 * produce ink on the page.
 */
const MIN_STRIP_ROWS = 3;

/** Inline light values. Every text element gets one of these explicitly. */
export const COLORS = {
  ink: "#161b22",
  muted: "#5a6472",
  accent: "#0b5fa4",
  alert: "#8a5a00",
  alertBg: "#fff8e6",
  alertBorder: "#c98a00",
  gating: "#a2360f",
  up: "#0a7a44",
  down: "#b3261e",
  border: "#e2e6ec",
  page: "#f4f6f9",
  card: "#ffffff",
  strip: "#f2f5f9",
};

/**
 * The dark half of the hybrid. Inline styles cannot answer a media query, so the
 * light values above ship inline (for the clients that strip <style>) and these
 * classes override them where <style> survives.
 *
 * `!important` is not sloppiness: Gmail rewrites inline styles onto the element
 * and a class rule without it loses the specificity fight. And every text
 * element carries one of these classes even where the light and dark values look
 * close, because Gmail's dark-mode inverter only leaves colors alone when they
 * were set — an unset color gets inverted to something the author never chose,
 * which in practice means dark grey text on a dark grey card.
 *
 * Exported as the CSS text rather than as a list of class names so the strip's
 * markup and the rules that recolor it cannot drift apart across two files.
 */
export const DARK_MODE_CSS = `
      @media (prefers-color-scheme: dark) {
        .vr-page { background: #0e1116 !important; }
        .vr-card { background: #161b22 !important; }
        .vr-strip { background: #11161d !important; }
        .vr-ink { color: #e6edf3 !important; }
        .vr-muted { color: #9aa5b4 !important; }
        .vr-accent { color: #6cb6ff !important; }
        .vr-alert { color: #e3b341 !important; }
        .vr-alert-bg { background: #241b06 !important; }
        .vr-gating { color: #ff9f7a !important; }
        .vr-up { color: #56d364 !important; }
        .vr-down { color: #ff7b72 !important; }
        .vr-hr { border-color: #2a323d !important; }
      }`;

/**
 * Thrown when the strip would render empty while the registry holds dated
 * programs. See `assertCountdownRenderable`.
 */
export class EmptyCountdownError extends Error {
  constructor(readonly deadlinesTracked: number) {
    super(
      `countdown strip is empty but ${deadlinesTracked} deadlines are tracked — ` +
        `refusing to render an email whose deadline section reads as "nothing due"`,
    );
    this.name = "EmptyCountdownError";
  }
}

/**
 * Zero rows is an error, not a result.
 *
 * A strip with no rows and a registry with 37 dated programs renders exactly like
 * a quiet day. There is no way for a reader to tell the two apart, so the only
 * safe behaviour is to refuse: run.ts turns this into a non-zero exit, which
 * means no email and no commit, and the missing daily email is itself the alarm.
 * A plausible email with the deadline section silently absent is the one failure
 * this project cannot recover from.
 *
 * If the nearest deadline is genuinely beyond the horizon, the fix is in
 * buildOpportunities — emit it anyway. The horizon governs emphasis, never
 * existence.
 */
export function assertCountdownRenderable(rows: CountdownRow[], deadlinesTracked: number): void {
  if (rows.length > 0) return;
  if (deadlinesTracked > 0) throw new EmptyCountdownError(deadlinesTracked);
}

export interface CountdownOptions {
  /** Rows further out than this are summarised rather than listed. */
  horizonDays?: number;
  /** From the caller: `digest.stats.deadlinesTracked`. Drives the zero-is-an-error check. */
  deadlinesTracked?: number;
  /**
   * Hours remaining for a row that is due TODAY, when the caller can compute it.
   * Without it a same-day row prints "today" rather than a fabricated hour count
   * — see `countdownPhrase`.
   */
  hoursUntil?: (row: CountdownRow) => number;
  maxRows?: number;
}

export interface CountdownSelection {
  rows: CountdownRow[];
  horizonDays: number;
  /** Rows past the horizon or past the row cap. Reported, never silently dropped. */
  notShown: number;
  /** True when nothing was inside the horizon and the nearest rows were printed anyway. */
  borrowedBeyondHorizon: boolean;
}

/**
 * Sorted by `daysUntil`, ascending, gating first on a tie.
 *
 * Ascending means an already-closed row sorts to the very top, which is
 * deliberate. buildOpportunities drops passed deadlines, so a negative row
 * arriving here is either something that closed today or a bug in the ladder;
 * both are things you want in the first line you read, not buried under a
 * fortnight of upcoming dates.
 */
function compareRows(a: CountdownRow, b: CountdownRow): number {
  if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
  if (a.gating !== b.gating) return a.gating ? -1 : 1;
  return a.label.localeCompare(b.label);
}

export function selectCountdownRows(
  rows: CountdownRow[],
  opts: CountdownOptions = {},
): CountdownSelection {
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxRows = opts.maxRows ?? MAX_STRIP_ROWS;
  const sorted = [...rows].sort(compareRows);
  const inside = sorted.filter((row) => row.daysUntil <= horizonDays);

  // The horizon is a display choice made here, so it is not allowed to turn a
  // non-empty input into an empty section — that would manufacture the exact
  // silence assertCountdownRenderable exists to forbid, and it would do it
  // without throwing, since the input was fine.
  const chosen = inside.length > 0 ? inside : sorted.slice(0, MIN_STRIP_ROWS);
  const capped = chosen.slice(0, maxRows);

  return {
    rows: capped,
    horizonDays,
    notShown: sorted.length - capped.length,
    borrowedBeyondHorizon: inside.length === 0 && capped.length > 0,
  };
}

/**
 * Prose for one row: "in 9 days", "tomorrow", "closed yesterday".
 *
 * dates.ts's `formatCountdown` only consults `hours` when `days` is 0, so for
 * every other row the hour argument is unused and passing `days * 24` is honest.
 *
 * At days === 0 it matters enormously. A CountdownRow carries a calendar date and
 * a rendered `displayWhen` string, not an instant, so this module cannot know
 * whether a deadline closing today has six hours left or closed at noon. Handing
 * `formatCountdown` a made-up 0 would print "closed today" over a deadline the
 * reader still has an afternoon to make. So an un-supplied same-day row prints a
 * flat "today" and the reader goes and looks. Fabricating the hour is the one
 * thing this file must never do.
 */
export function countdownPhrase(days: number, hours?: number): string {
  if (days === 0 && hours === undefined) return "today";
  return formatCountdown(days, hours ?? days * 24);
}

/**
 * The small uppercase tag used for "gating", "verify", "new", "priority".
 *
 * Exported because render.ts needs the identical one on its cards, and two
 * copies of a six-line span drift: the first divergence is a font-size, the
 * second is a gating tag that reads as decoration in one block and as an alarm
 * in the other.
 */
export function chip(text: string, color: string, cls: string): Raw {
  return html`<span
    class="${cls}"
    style="color:${color};font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;"
    >${text}</span
  >`;
}

/**
 * The qualifiers a row must carry to be read correctly.
 *
 * "projected" is the difference between a date a human confirmed and a date
 * rolled forward from last year's cycle, and the reader has to be able to tell
 * without opening the YAML. A month-precision row says the day is unknown
 * outright rather than implying the 1st, which is what the parser resolved it to
 * internally so that ambiguity would round toward being early.
 */
function qualifiers(row: CountdownRow): string[] {
  const out: string[] = [];
  if (row.kind === "projected") out.push("projected");
  if (row.kind === "rolling") out.push("rolling");
  // A `kind: unknown` row already says the date is not known, so the
  // precision qualifier would repeat it back — "date not known · (date unknown
  // — check)" reads as a bug rather than as emphasis.
  if (row.kind === "unknown") out.push("date not known — go look");
  else if (row.precision === "month") out.push("(day unknown — check)");
  else if (row.precision === "unknown") out.push("(date unknown — check)");
  return out;
}

/**
 * `displayWhen`, minus whatever the qualifier is about to say again.
 *
 * dates.ts's formatWhen already appends "(day unknown)" to a month-precision
 * date and returns a bare "date unknown" when there is no precision at all. The
 * qualifier above says the same thing and adds what to do about it, so printing
 * both gives you "September 2026 (day unknown) · (day unknown — check)", which
 * reads like a template bug and costs a reader's trust in the whole strip.
 */
function whenText(row: CountdownRow): string {
  const when = (row.displayWhen ?? "").trim();
  if (row.precision === "month") return when.replace(/\s*\(day unknown\)\s*$/i, "").trim();
  if (row.precision === "unknown" && /^date unknown$/i.test(when)) return "";
  return when;
}

/** "Harvard endorsement · 14 Sep 2026 · projected" — the detail half of a row. */
function detailText(row: CountdownRow): string {
  return [row.target, whenText(row), ...qualifiers(row)].filter(Boolean).join(" · ");
}

function rowHtml(row: CountdownRow, opts: CountdownOptions): Raw {
  const phrase = countdownPhrase(row.daysUntil, opts.hoursUntil?.(row));
  const label = row.url
    ? html`<a
        class="vr-ink"
        href="${raw(safeUrl(row.url))}"
        style="color:${COLORS.ink};text-decoration:none;font-weight:600;"
        >${row.label}</a
      >`
    : html`<span class="vr-ink" style="color:${COLORS.ink};font-weight:600;">${row.label}</span>`;

  return html`
    <tr>
      <td
        class="vr-ink"
        align="right"
        style="padding:7px 10px 7px 0;color:${COLORS.ink};font-size:13px;font-weight:700;white-space:nowrap;vertical-align:top;width:104px;"
      >
        ${phrase}
      </td>
      <td
        class="vr-hr"
        style="padding:7px 0;border-bottom:1px solid ${COLORS.border};vertical-align:top;${row.gating
          ? `border-left:3px solid ${COLORS.gating};padding-left:9px;`
          : ""}"
      >
        <div class="vr-ink" style="color:${COLORS.ink};font-size:13px;line-height:1.45;">
          ${label}${row.gating ? html` ${chip("gating", COLORS.gating, "vr-gating")}` : ""}${row
            .needsVerification
            ? html` ${chip("verify", COLORS.alert, "vr-alert")}`
            : ""}
        </div>
        <div class="vr-muted" style="color:${COLORS.muted};font-size:12px;line-height:1.45;padding-top:2px;">
          ${detailText(row)}
        </div>
      </td>
    </tr>
  `;
}

function headerText(selection: CountdownSelection, rowCount: number): string {
  if (selection.borrowedBeyondHorizon) {
    return `Countdown · nothing inside ${selection.horizonDays} days · showing the next ${rowCount}`;
  }
  return `Countdown · ${rowCount} inside ${selection.horizonDays} days`;
}

/**
 * The strip, as markup. Renders something for every input, including none.
 *
 * The empty case only survives the assert when the registry tracks no dated
 * programs at all, and even then it prints a sentence saying so. A blank space
 * where the deadlines go is never an acceptable output of this function.
 */
export function renderCountdownHtml(rows: CountdownRow[], opts: CountdownOptions = {}): Raw {
  assertCountdownRenderable(rows, opts.deadlinesTracked ?? 0);
  const selection = selectCountdownRows(rows, opts);

  const header = html`<div
    class="vr-muted"
    style="color:${COLORS.muted};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding-bottom:4px;"
  >
    ${headerText(selection, selection.rows.length)}
  </div>`;

  if (selection.rows.length === 0) {
    return html`
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;">
        <tr>
          <td class="vr-strip" bgcolor="${COLORS.strip}" style="background:${COLORS.strip};padding:12px 14px;">
            ${header}
            <div class="vr-alert" style="color:${COLORS.alert};font-size:13px;line-height:1.5;">
              No dated programs in the registry. This is a configuration state, not a quiet day —
              config/deadlines.yml has nothing with a date in it.
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  return html`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;">
      <tr>
        <td class="vr-strip" bgcolor="${COLORS.strip}" style="background:${COLORS.strip};padding:12px 14px;">
          ${header}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${selection.rows.map((row) => rowHtml(row, opts))}
          </table>
          ${selection.notShown > 0
            ? html`<div
                class="vr-muted"
                style="color:${COLORS.muted};font-size:11px;padding-top:8px;"
              >
                +${selection.notShown} further out or beyond the ${MAX_STRIP_ROWS}-row cap
              </div>`
            : ""}
        </td>
      </tr>
    </table>
  `;
}

/**
 * The text/plain strip.
 *
 * Uses the fixed-width "T-7" token rather than the prose the HTML uses. In a
 * proportional-font HTML table the column is aligned by the table; in text/plain
 * nothing aligns it, and a column of "in 9 days" / "tomorrow" / "closed
 * yesterday" is unscannable where a column of T-numbers reads down the page.
 */
export function renderCountdownText(rows: CountdownRow[], opts: CountdownOptions = {}): string {
  assertCountdownRenderable(rows, opts.deadlinesTracked ?? 0);
  const selection = selectCountdownRows(rows, opts);
  const lines: string[] = [headerText(selection, selection.rows.length).toUpperCase()];

  if (selection.rows.length === 0) {
    lines.push(
      "  No dated programs in the registry. A configuration state, not a quiet day.",
    );
    return lines.join("\n");
  }

  for (const row of selection.rows) {
    const tags = [row.gating ? "[GATING]" : "", row.needsVerification ? "[VERIFY]" : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  ${formatDaysUntil(row.daysUntil).padEnd(6)} ${row.label}${tags ? ` ${tags}` : ""}`,
    );
    lines.push(`         ${detailText(row)}`);
    // The prose only earns a line inside two days. Further out "T-41" and "in 41
    // days" say the same thing and the token already said it; inside two days the
    // prose carries what the token flattens — the hour ("in 6 hours") and the
    // word a reader reacts to ("closed yesterday").
    if (row.daysUntil <= 1) {
      lines.push(`         ${countdownPhrase(row.daysUntil, opts.hoursUntil?.(row))}`);
    }
    if (row.url) lines.push(`         ${row.url}`);
  }
  if (selection.notShown > 0) {
    lines.push(`  +${selection.notShown} further out or beyond the ${MAX_STRIP_ROWS}-row cap`);
  }
  return lines.join("\n");
}
