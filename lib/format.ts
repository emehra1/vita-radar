/**
 * Small pure formatting helpers: numbers, counts and strings.
 *
 * Browser-safe on purpose — no `node:` imports, no Buffer, no Intl-dependent
 * date work. The email renderer runs in Node and the phase-2 site renders the
 * same digest JSON in a browser; the moment one of these helpers reaches for
 * `Buffer.byteLength` the site build breaks on an import that has nothing to do
 * with the bug being fixed.
 *
 * Nothing here parses, shifts or compares a DATE. pipeline/normalize/dates.ts
 * owns every instant in this repo, including the calendar-day arithmetic that
 * makes "in 1 day" mean tomorrow. `formatDaysUntil` below takes a number of
 * days that dates.ts already computed and only chooses characters for it.
 */

/**
 * "T-7" / "T-0" / "T+3" — the compact ladder token.
 *
 * dates.ts already has `formatCountdown`, which returns prose ("in 9 days",
 * "tomorrow"). Both exist because they serve different surfaces. Prose is what a
 * human reads in the body of the email. This token is what survives a phone lock
 * screen truncating the subject at roughly forty characters, and it is the only
 * form that lines up into a scannable column in text/plain, where the reader has
 * no table to align things for them.
 *
 * A passed date renders "T+3" rather than "T-0" or nothing at all. A gating step
 * that has already closed is the single most important thing this system can say,
 * and rounding it to "today" or dropping it is how it goes unnoticed.
 */
export function formatDaysUntil(days: number): string {
  if (!Number.isFinite(days)) return "T-?";
  const whole = Math.round(days);
  return whole < 0 ? `T+${Math.abs(whole)}` : `T-${whole}`;
}

/**
 * Returns the NOUN, not "3 deadlines".
 *
 * The countdown strip puts the number and the noun in different table cells, so
 * a helper that returned the joined phrase would be unusable at exactly the call
 * site that needs it most. Callers that want the phrase write
 * `${n} ${pluralize(n, "deadline")}`.
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return Math.abs(count) === 1 ? singular : plural;
}

/**
 * Truncate to `max` characters INCLUDING the ellipsis.
 *
 * Counting the ellipsis matters because the output is spent against a hard
 * budget — a subject line that comes back one character over the client's cutoff
 * loses a whole word, not a character. `trimEnd` keeps "Rhodes …" from happening.
 */
export function truncate(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(0, max));
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function oneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * "$18.42" / "$1,240" / "$12.5M" / "$1.2B", or undefined when there is no number.
 *
 * Returning undefined rather than "" or "n/a" is the point: the `html` template
 * renders undefined as nothing, so a missing quote drops out of the line instead
 * of rendering a bare "$" with nothing after it, which reads as a price of zero.
 *
 * Cents are kept below $1,000 and dropped above it. A $2.31 microcap moving to
 * $2.09 is the story; the cents on a $1,240 share price are noise that costs
 * characters in a 600px column.
 */
export function formatUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${oneDecimal(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${oneDecimal(abs / 1e6)}M`;
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * "+1.2%" / "-3.4%" / "0.0%".
 *
 * The input is ALREADY a percentage: `Quote.changePct` of -3.4 means -3.4%. A
 * helper that multiplied by 100 here would be a hundred-fold error printed in a
 * plausible-looking market line, which is worse than no market line.
 *
 * The explicit "+" is not decoration. Beside a "-3.4%" a bare "1.2%" reads as a
 * magnitude rather than a direction, and the whole value of the movers line is
 * direction at a glance. `signed: false` suppresses only the plus; a negative
 * number always keeps its minus.
 */
export function formatPct(
  value: number | undefined,
  opts: { signed?: boolean; digits?: number } = {},
): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const digits = opts.digits ?? 1;
  const signed = opts.signed ?? true;
  const sign = value < 0 ? "-" : signed && value > 0 ? "+" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}
