/**
 * Renders and (optionally) sends the daily digest email.
 *
 *   npm run email                                  # preview, sends nothing
 *   npm run email -- --date 2026-09-28 --out /tmp/x.html
 *   npm run email -- --send                        # actually send
 *
 * PREVIEW IS THE DEFAULT and --send is required. Carried over from the sibling,
 * where an earlier version hard-failed at import when any SMTP variable was
 * missing: `npm run email` was then unusable for the thing people actually want
 * it for, which is looking at the output. The flag also means a stray CI
 * invocation cannot mail anybody.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import nodemailer from "nodemailer";

import { renderEmail, renderSubject, renderText, type RenderOptions } from "../lib/email/render.ts";
import { localDateString } from "../pipeline/normalize/dates.ts";
import { WEIGHTS } from "../pipeline/score/index.ts";
import { readDigest, writeDigest } from "../pipeline/state/store.ts";

interface Args {
  date?: string;
  send: boolean;
  force: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { send: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--send") args.send = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--date") args.date = argv[++i] || undefined;
    else if (arg.startsWith("--date=")) args.date = arg.slice(7);
    else if (arg === "--out") args.out = argv[++i] || undefined;
    else if (arg.startsWith("--out=")) args.out = arg.slice(6);
  }
  return args;
}

const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "MAIL_TO"];

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // "Today" is the reader's today, not UTC's. A digest generated at 06:47 ET is
  // dated the 22nd; asking UTC for the date at 23:10 ET would look for the 23rd
  // and report a missing digest that is sitting right there.
  const date = args.date ?? localDateString(process.env.TZ || "America/New_York");

  const digest = readDigest(date);
  if (!digest) {
    console.error(`No digest for ${date}. Run \`npm run pipeline\` first.`);
    return 1;
  }

  // Idempotence. The digest carries its own emailedAt, so a second invocation —
  // a catch-up cron, "Re-run failed jobs" after a flaky send, a human running
  // the command twice — does not mail the reader a duplicate. --force is the
  // deliberate override.
  if (digest.emailedAt && args.send && !args.force) {
    console.log(`Digest ${date} was already emailed at ${digest.emailedAt}. Use --force to resend.`);
    return 0;
  }

  // The horizon, the escalation threshold and the lane cap come from
  // weights.json rather than the renderer's mirrored defaults. The defaults are
  // correct today and drift the moment somebody tunes the file: the email in CI
  // is rendered HERE, not by run.ts, so a countdownStripDays raised to 90 would
  // apply everywhere except the message the reader actually receives.
  //
  // `hoursUntil` is deliberately not supplied. Only run.ts holds the registry
  // that can say what time of day a row's target closes, and the renderer's
  // documented fallback for a same-day row is to print "today" rather than a
  // fabricated hour count. A wrong hour is worse than a missing one.
  const options: RenderOptions = {
    siteUrl: process.env.SITE_URL,
    countdownHorizonDays: WEIGHTS.countdownStripDays,
    subjectEscalationDays: WEIGHTS.subjectEscalationDays,
    maxPerLane: WEIGHTS.maxItemsPerLane,
  };

  // Not wrapped in a try. renderEmail throws EmptyCountdownError when the strip
  // is empty on a day with tracked deadlines, and that is the zero-is-an-error
  // alarm doing its job: a digest whose continuity signal has vanished must not
  // be sent, because an email that arrived and said nothing is due is the one
  // failure the reader cannot detect. The top-level catch below turns it into a
  // non-zero exit, which the workflow turns into a filed issue.
  const subject = renderSubject(digest, options);
  const html = renderEmail(digest, options);
  const text = renderText(digest, options);
  const sizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);

  if (!args.send) {
    const file = args.out ?? path.join(".preview", `${date}.html`);
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writeFileSync(file, html, "utf8");
    console.log(`Preview written to ${file} (${sizeKb} KB)`);
    console.log(`Subject: ${subject}`);
    console.log("\n--- text part ---\n");
    console.log(text);
    console.log("\nAdd --send (with SMTP env set) to actually send.");
    return 0;
  }

  const missing = SMTP_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Cannot send: missing ${missing.join(", ")}`);
    return 1;
  }

  const port = Number(process.env.SMTP_PORT);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Port 25 is blocked on GitHub's runners; use 465 (implicit TLS) or 587.
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    // Bounded, because the alternative is a job that hangs until the 6-hour
    // runner ceiling holding the concurrency slot, which then delays the next
    // day's run rather than failing today's.
    connectionTimeout: 20_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  const send = () =>
    transport.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text,
      html,
    });

  // One retry, no more. Gmail's submission endpoint fails transiently often
  // enough to be worth a second attempt and rarely enough that a third is just
  // a longer wait before the same error.
  try {
    await send();
  } catch (error) {
    console.warn(`First send attempt failed (${String(error)}); retrying once…`);
    await send();
  }

  // Stamped only after the send resolved. Stamping before would turn a failed
  // send into a permanently suppressed one: the guard above would then decline
  // to retry an email that never arrived, and the reader's evidence of the
  // failure is the absence of a message they were not expecting to be absent.
  writeDigest({ ...digest, emailedAt: new Date().toISOString() });
  console.log(`Sent "${subject}" to ${process.env.MAIL_TO} (${sizeKb} KB)`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
