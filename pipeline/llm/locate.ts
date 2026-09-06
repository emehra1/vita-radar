/**
 * Claude as a LOCATOR.
 *
 * This file is the whole point of phase 3, and every line of it is arranged
 * around one asymmetry:
 *
 *   A hallucinated DATE is byte-identical to a correct one. Nothing downstream
 *   can contradict it. It becomes a countdown to a day on which nothing
 *   happens, and the reader finds out by missing something.
 *
 *   A hallucinated QUOTE fails a literal substring check against the page, in
 *   one line, before anything else runs.
 *
 * So the model is only ever asked for the checkable thing. There is no date
 * field anywhere in LOCATE_SCHEMA — not an optional one, not a nullable one —
 * because a field that does not exist cannot be filled in with a guess. The
 * model returns a sentence it believes contains the deadline; a deterministic
 * parser that was written and tested before any model existed decides whether
 * that sentence contains a date.
 *
 * Four gates, in this order, and the order matters:
 *
 *   1. The model answered at all, with found = true and a non-empty quote.
 *   2. quoteAppearsIn(quote, pageText) — the hallucination killer. Runs FIRST,
 *      before any parsing, so a fabricated sentence never even reaches the
 *      reader. Cheap, total, and the reason this design is safe at all.
 *   3. readDeadlineFromQuote(...) — the ONLY thing in this repo allowed to turn
 *      text into a date. If it refuses, the answer is no answer; the model does
 *      not get a second opinion and there is no override.
 *   4. Everything that survives is emitted as `proposed*` fields carrying
 *      provenance "claude-proposed", which canAlert() in score/temporal.ts
 *      rejects by construction. Nothing here is ever written to
 *      config/deadlines.yml by code. The output is a pull request body.
 *
 * And the whole file returns `undefined` on any failure and never throws. A
 * phase-3 experiment does not get to take down a pipeline whose contract is
 * that an email arrives every morning.
 */

import type {
  DateProvenance,
  DeadlineKind,
  DeadlinePrecision,
} from "../../lib/types.ts";
import { quoteAppearsIn, readDeadlineFromQuote } from "../deadlines/extract.ts";
import type { LlmRunner } from "./client.ts";
import { LOCATOR_MODEL } from "./models.ts";
import { PROFILE, PROFILE_VERSION } from "./profile.ts";

/** Bump when the USER-turn wording changes. The system prefix is versioned separately. */
export const LOCATE_PROMPT_VERSION = "locate-1";

/**
 * The output contract handed to the model.
 *
 * READ THE PROPERTIES AND NOTICE WHAT IS MISSING. There is no `date`, no `year`,
 * no `deadline`, no `iso`. Not optional — absent. A model that has decided the
 * deadline is the fourth of October has nowhere to put that belief except into
 * `quote`, where it has to survive a substring check against the page.
 *
 * tests/llm.contract.test.ts asserts this schema stays date-free, because the
 * natural instinct of anyone extending this file is to add "just a hint" field.
 */
export const LOCATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description:
        "True only when a sentence on this page states the deadline explicitly and includes a four-digit year.",
    },
    quote: {
      type: "string",
      description:
        "The sentence, copied verbatim from the page. Empty string when found is false. Never a paraphrase, never a reconstruction, never a date you assembled yourself.",
    },
    location: {
      type: "string",
      description:
        "Short pointer to where on the page the sentence sits, for the human reviewing this. Empty string when nothing was found.",
    },
    note: {
      type: "string",
      description:
        "One sentence of plain English: which cycle this is about, or specifically why nothing was found.",
    },
  },
  required: ["found", "quote", "location", "note"],
  additionalProperties: false,
};

/**
 * Pages larger than this are truncated for the prompt.
 *
 * This number is the whole cost model. Page text is uncached input — the PROFILE
 * prefix caches, the page never can — so it dominates every call: 40,000 chars
 * is roughly 10,000 tokens, about a cent per page on the locator model, against
 * a tenth of a cent for the 6,000-token cached prefix. Raising it to 60,000
 * would put a full sweep of all thirteen page watches within sight of the
 * per-run dollar ceiling for no gain, because on these pages the deadline is in
 * the first screen or in an "Important Dates" block near it, never at 50KB.
 */
const MAX_PAGE_CHARS = 40_000;

/** Below this a "page" is a challenge interstitial or an error body, not content. */
const MIN_PAGE_CHARS = 200;

export interface LocateInput {
  programId: string;
  label: string;
  sourceUrl: string;
  /** Text-extracted page content. The verbatim check runs against this. */
  pageText: string;
  /** From watch/pagehash.ts. Pins the proposal to the exact bytes it came from. */
  pageHash: string;
  timeZone: string;
  /** The cycle being tracked, by AWARD start year. The reader enforces consistency. */
  cycleYear: number;
  /** YYYY-MM-DD. Goes in the USER turn — never in PROFILE. See profile.ts. */
  today: string;
  now?: Date;
  /** What config/deadlines.yml says right now, so the PR body can show a diff. */
  current: {
    kind: DeadlineKind;
    date?: string;
    precision: DeadlinePrecision;
  };
}

/** Everything needed to audit a proposal a year after it was merged. */
export interface ProposalProvenance {
  model: string;
  promptVersion: string;
  profileVersion: string;
  pageHash: string;
  /** ISO instant. */
  extractedAt: string;
  /** The verbatim span. This IS the justification; without it there is no proposal. */
  quote: string;
  sourceUrl: string;
}

/**
 * A suggestion for a human, and nothing else.
 *
 * Every date-bearing field is prefixed `proposed`, which is not cosmetic: it
 * means no code path can assign one of these to a `Deadline.date` without the
 * mismatch being visible at the assignment. `proposedProvenance` is pinned to
 * "claude-proposed", which canAlert() refuses, so even a mistaken merge into a
 * Deadline object cannot ring the subject line or the calendar alarm.
 */
export interface DeadlineProposal {
  programId: string;
  label: string;
  proposedDate: string;
  proposedPrecision: DeadlinePrecision;
  proposedCycleYear: number;
  proposedProvenance: DateProvenance;
  currentDate?: string;
  currentKind: DeadlineKind;
  currentPrecision: DeadlinePrecision;
  /** True when the page agrees with the YAML — a cue to bump verifiedOn, not to edit. */
  agreesWithYaml: boolean;
  location?: string;
  note?: string;
  provenance: ProposalProvenance;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The volatile turn.
 *
 * Everything that changes between calls lives here and NOTHING that changes
 * lives in PROFILE. That split is the entire prompt-cache strategy: one 6,000-
 * token prefix, written once per five minutes, read at a tenth of the price by
 * every page after it. Putting the date up in the system prompt — the obvious,
 * tidy-looking thing to do — silently invalidates the cache at midnight and the
 * only symptom is the bill.
 */
function buildUserTurn(input: LocateInput, pageText: string): string {
  return [
    `Today is ${input.today}.`,
    `Programme: ${input.label}  (tracker id: ${input.programId})`,
    `Cycle being tracked: the cycle whose award starts in ${input.cycleYear}.`,
    `Source URL: ${input.sourceUrl}`,
    "",
    "Find the sentence on the page below that states this programme's deadline",
    "for that cycle, with a four-digit year, and return it verbatim. If there is",
    "no such sentence, return found: false and say why.",
    "",
    "--- BEGIN PAGE TEXT ---",
    pageText,
    "--- END PAGE TEXT ---",
  ].join("\n");
}

/**
 * Ask Claude where the deadline is. Return a proposal, or nothing.
 *
 * Never throws. Never returns a date the deterministic reader did not produce.
 *
 * INTENDED TRIGGER: a page whose hash CHANGED, per pipeline/watch/pagehash.ts.
 * Claude is a change-detector layered on the YAML, exactly like the scrapers,
 * and a page that is byte-identical to yesterday cannot contain news. Calling
 * this for every watch every morning still fits inside the ceilings in
 * client.ts, but it pays roughly thirty times over for the same answer, and it
 * generates a pull request full of confirmations nobody asked for.
 */
export async function locateDeadline(
  runner: LlmRunner | undefined,
  input: LocateInput,
): Promise<DeadlineProposal | undefined> {
  try {
    // No API key means no runner means the layer is a no-op. Documented contract.
    if (!runner) return undefined;

    const pageText = input.pageText ?? "";
    if (pageText.length < MIN_PAGE_CHARS) {
      // A 3KB challenge body answers HTTP 200 and looks healthy forever. Spending
      // a model call on one is how the ceiling gets burned on nothing.
      console.log(
        `[llm] locate ${input.programId}: page is ${pageText.length} chars, too short to be content`,
      );
      return undefined;
    }

    const raw = await runner.json({
      model: LOCATOR_MODEL,
      purpose: `locate:${input.programId}`,
      system: PROFILE,
      user: buildUserTurn(input, pageText.slice(0, MAX_PAGE_CHARS)),
      schema: LOCATE_SCHEMA,
      maxTokens: 700,
      expectCache: true,
    });
    if (!raw) return undefined;

    if (raw.found !== true) return undefined;
    const quote = asString(raw.quote).trim();
    if (!quote) return undefined;

    /**
     * GATE 2. First check after the response, deliberately: a fabricated
     * sentence must never reach the parser, because the parser's job is to
     * believe the text it is given.
     */
    if (!quoteAppearsIn(quote, pageText)) {
      console.log(
        `[llm] locate ${input.programId}: REJECTED — quote does not appear on the page: ${JSON.stringify(quote.slice(0, 120))}`,
      );
      return undefined;
    }

    /**
     * GATE 3. The deterministic reader. It refuses a quote with no four-digit
     * year, refuses announcement / past-cycle / award-start / metadata
     * phrasing, refuses month precision, and refuses a year inconsistent with
     * the cycle. If it refuses, that is the answer — the model does not get to
     * argue, and there is deliberately no confidence score that could override
     * it.
     */
    const read = readDeadlineFromQuote(quote, {
      timeZone: input.timeZone,
      now: input.now,
      cycleYear: input.cycleYear,
    });
    if (!read.ok || !read.date) {
      console.log(
        `[llm] locate ${input.programId}: quote verified on page but REFUSED by the reader — ${read.reason ?? "unknown"}`,
      );
      return undefined;
    }

    return {
      programId: input.programId,
      label: input.label,
      proposedDate: read.date,
      // The reader will not return a date at coarser than day precision, so
      // this is a statement of what it guarantees rather than an assumption.
      proposedPrecision: "day",
      proposedCycleYear: input.cycleYear,
      proposedProvenance: "claude-proposed",
      currentDate: input.current.date,
      currentKind: input.current.kind,
      currentPrecision: input.current.precision,
      agreesWithYaml: input.current.date === read.date,
      location: asString(raw.location).trim() || undefined,
      note: asString(raw.note).trim() || undefined,
      provenance: {
        model: LOCATOR_MODEL,
        promptVersion: LOCATE_PROMPT_VERSION,
        profileVersion: PROFILE_VERSION,
        pageHash: input.pageHash,
        extractedAt: new Date().toISOString(),
        quote,
        sourceUrl: input.sourceUrl,
      },
    };
  } catch (err) {
    // Including a throwing stub, a malformed input, or an SDK surprise. The
    // pipeline continues without this proposal; it never continues without an
    // email.
    console.log(`[llm] locate ${input.programId}: unexpected failure: ${String(err)}`);
    return undefined;
  }
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function describeCurrent(p: DeadlineProposal): string {
  if (!p.currentDate) return `none (${p.currentKind})`;
  return `${p.currentDate} (${p.currentKind}, ${p.currentPrecision})`;
}

function renderOne(p: DeadlineProposal): string[] {
  const out: string[] = [];
  // One level below the section heading, so the two groups stay visually distinct
  // in a collapsed GitHub PR body on a phone.
  out.push(`#### ${p.label}`);
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push(`| Program id | \`${p.programId}\` |`);
  out.push(`| YAML today | ${escapePipes(describeCurrent(p))} |`);
  out.push(`| Page says | **${p.proposedDate}** (cycle ${p.proposedCycleYear}) |`);
  out.push(`| Source | ${escapePipes(p.provenance.sourceUrl)} |`);
  out.push("");
  out.push(`> ${escapePipes(p.provenance.quote)}`);
  out.push("");
  if (p.location) out.push(`Found under: ${p.location}`);
  if (p.note) out.push(`Model note: ${p.note}`);
  if (p.location || p.note) out.push("");
  out.push(
    `<sub>${p.provenance.model} · prompt ${p.provenance.promptVersion} · profile ${p.provenance.profileVersion} · page ${p.provenance.pageHash.slice(0, 12)} · read ${p.provenance.extractedAt}</sub>`,
  );
  out.push("");
  return out;
}

/**
 * The pull-request body.
 *
 * Written to be actioned in twenty seconds on a phone, because that is the only
 * review that will actually happen. Three things per row and no more: what the
 * YAML says now, what the page says, and the verbatim sentence that justifies
 * the change. The URL is last so the reader can open it if the quote is not
 * enough, and the provenance line is small because it is for the archaeologist,
 * not the reviewer.
 *
 * Confirmations are separated from changes. A page that agrees with the YAML is
 * not a diff to merge — it is permission to bump `verifiedOn`, which is the one
 * recurring maintenance task this whole project runs on.
 */
export function renderProposalMarkdown(proposals: DeadlineProposal[]): string {
  const changes = proposals.filter((p) => !p.agreesWithYaml);
  const confirmations = proposals.filter((p) => p.agreesWithYaml);

  const lines: string[] = [];
  lines.push("## Deadline proposals");
  lines.push("");
  lines.push(
    "Nothing in this pull request has been applied. Every date below is a " +
      "**proposal** derived from a verbatim quote on a live page; the quote is " +
      "the evidence and the page is the authority. Read the quote, open the URL " +
      "if it does not settle it, and edit `config/deadlines.yml` yourself.",
  );
  lines.push("");

  if (proposals.length === 0) {
    lines.push("_No page produced a quotable, parseable deadline this run._");
    lines.push("");
    return lines.join("\n");
  }

  if (changes.length > 0) {
    lines.push(`### Changes proposed (${changes.length})`);
    lines.push("");
    for (const p of changes) lines.push(...renderOne(p));
  }

  if (confirmations.length > 0) {
    lines.push(`### Pages that agree with the YAML (${confirmations.length})`);
    lines.push("");
    lines.push(
      "No edit needed. Update `verifiedOn` on these rows if you are happy to " +
        "count this as having read the page.",
    );
    lines.push("");
    for (const p of confirmations) lines.push(...renderOne(p));
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "A model located these sentences; it did not read the dates. " +
      "`pipeline/deadlines/extract.ts` parsed every date above from the quoted " +
      "text, and refused everything it could not parse. A model may move a date " +
      "toward a human, never toward an alert.",
  );
  lines.push("");
  return lines.join("\n");
}
