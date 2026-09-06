/**
 * The one place Claude writes prose the reader sees.
 *
 * It renders LAST in the email — after the countdown strip and the verify block
 * — so it can never displace a date, and it is entirely optional. When any
 * guard below trips, the paragraph is discarded whole and the email simply has
 * no opener. Nothing degrades. That property is what makes the guards safe to
 * make strict: a false rejection costs one sentence nobody was promised, and a
 * false acceptance puts a fabricated number in front of somebody who is using
 * this to decide what to do today.
 *
 * The model is given ONLY already-structured digest fields — lane, score,
 * title, one fact, days remaining — plus the previous three openers so it does
 * not write the same sentence four mornings running. It never sees a raw page,
 * never sees a URL, and never sees a date it could reformat.
 *
 * Four guards, each of which discards the whole paragraph:
 *
 *   1. It contains a URL.
 *   2. It contains a number that was not in the input block. THIS IS THE ONE
 *      THAT MATTERS. "applications close in nine days" had better be a number
 *      we handed it, because a reader who acts on that sentence and finds it
 *      was invented stops trusting the countdown, which is the load-bearing
 *      part of the whole product.
 *   3. It is over 700 characters.
 *   4. It names a programme that was not in the input.
 */

import type { Lane } from "../../lib/types.ts";
import type { LlmRunner } from "./client.ts";
import { EDITORIAL_MODEL } from "./models.ts";

export const EDITORIAL_PROMPT_VERSION = "editorial-1";

/** ~120 words. Past this it is not an opener, it is a second digest. */
export const EDITORIAL_MAX_CHARS = 700;

/**
 * Deliberately NOT pipeline/llm/profile.ts.
 *
 * The editorial runs once a day, twenty-four hours after the last one, so a
 * 6,000-token cached prefix would never see a cache hit — the 5-minute TTL is
 * long dead — and would just pay the 1.25x write premium on Opus 5 input every
 * single morning for nothing. A short, purpose-built brief is both cheaper and
 * a better prompt.
 */
const EDITORIAL_SYSTEM = [
  "You write the one-paragraph opener for a daily deadline digest that has",
  "exactly one reader: a Harvard senior heading for an MD/PhD after two research",
  "gap years, building toward founding a company doing causal human target",
  "discovery from human genetics.",
  "",
  "Write at most 120 words, in one paragraph, in plain declarative English.",
  "Say what today's list adds up to and what deserves attention first. Be useful,",
  "not encouraging; he can see the list, so do not recite it back to him.",
  "",
  "Hard rules, all of them absolute:",
  "- Use ONLY the facts in the input block. You have no other knowledge of his week.",
  "- Every number you write must appear in the input block. If you want to say how",
  "  many days remain, use the number given. Never estimate, never round, never",
  "  infer a date, and never write a date the input did not contain.",
  "- Name only programmes that appear in the input block.",
  "- No URLs, no links, no markdown, no headings, no bullet points, no sign-off.",
  "- Do not repeat the phrasing or the angle of the previous openers you are shown.",
  "- If the list is thin, say so briefly. A short honest opener beats a padded one.",
  "",
  "Return the paragraph and nothing else.",
].join("\n");

export interface EditorialItem {
  lane: Lane;
  /** 0-100, already rounded. Raw decimals put stray digits in the permitted set. */
  score: number;
  title: string;
  /** ONE already-structured fact. Never free text scraped from a page. */
  fact: string;
  daysUntil?: number;
}

export interface EditorialInput {
  /** YYYY-MM-DD. */
  date: string;
  items: EditorialItem[];
  /** The last three openers, newest first. Excluded from the guard corpus — see below. */
  previousOpeners: string[];
}

/**
 * The corpus the guards check against.
 *
 * Note what is NOT in it: the previous openers. They are shown to the model so
 * it varies its angle, but a number that only ever appeared in Tuesday's
 * paragraph is not a number we handed it today, and letting yesterday's "eleven
 * days" back through would defeat the guard exactly when it matters most.
 */
export function buildInputBlock(input: EditorialInput): string {
  const lines: string[] = [];
  lines.push(`Digest date: ${input.date}`);
  lines.push(`Items: ${input.items.length}`);
  lines.push("");
  for (const item of input.items) {
    const days =
      item.daysUntil === undefined ? "no date" : `${item.daysUntil} days remaining`;
    lines.push(`- [${item.lane}] (score ${item.score}) ${item.title}`);
    lines.push(`  ${days}. ${item.fact}`);
  }
  return lines.join("\n");
}

export interface GuardResult {
  ok: boolean;
  /** Populated whenever ok is false. Logged so a discarded opener is explainable. */
  reason?: string;
}

const URL_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|org|net|edu|gov|io|ai|co)\b)/i;

/**
 * Number words that are only checked when a time unit follows.
 *
 * "one of the two things due" must not trip the guard, but "closes in nine
 * days" must. Requiring an adjacent unit is what separates prose from a claim
 * about the calendar, which is the only kind of number that can hurt anybody
 * here.
 */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

const TIME_UNIT = /^(day|days|week|weeks|month|months|hour|hours|year|years)$/i;

/**
 * Words that may be capitalised in ordinary English prose without being a name.
 *
 * Month and weekday names are deliberately ABSENT: a month the input never
 * mentioned is a claim about a date, which is precisely what this layer is not
 * allowed to make. "May" as a modal verb will occasionally be flagged, and that
 * costs one discarded opener.
 */
const CAPITALISED_STOPWORDS = new Set(
  (
    "the this that these those and but or so yet if when while where what which " +
    "who whose with without after before between beyond by for from in into on " +
    "of off out over to under up upon at as it its he his she her they their " +
    "you your we our my one two three four five six seven eight nine ten today " +
    "tomorrow yesterday now then there here everything nothing something " +
    "anything both either neither each every all most more less least only just " +
    "still also even once twice next last first second third final meanwhile " +
    "however otherwise instead because since until though although unless note " +
    "watch keep read start begin expect remember consider treat plan write " +
    "applications application deadlines deadline no yes not do does did is are " +
    "was were be been being have has had will would can could should must may " +
    "might none new nothing another other same such about against along among " +
    "around behind below beside despite during except inside near outside past " +
    "than through toward within your everything"
  ).split(/\s+/),
);

/**
 * A capitalised token that never appears in the input, and is not ordinary
 * English, is a name the model brought with it. Discard.
 *
 * Deliberately blunt. The failure mode this exists for is an opener that says
 * "the Marshall deadline" on a morning when Marshall is not in the file at all,
 * and a blunt check catches that; the cost of the occasional false positive is
 * one missing sentence.
 */
function unknownProperNoun(text: string, haystack: string): string | undefined {
  const lower = haystack.toLowerCase();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9'’&.-]{1,}\b/g)) {
    const token = match[0];
    const bare = token.replace(/[.'’&-]+$/, "");
    if (bare.length < 2) continue;
    if (CAPITALISED_STOPWORDS.has(bare.toLowerCase())) continue;
    if (lower.includes(bare.toLowerCase())) continue;
    return bare;
  }
  return undefined;
}

/** Every run of digits in `text`, as numbers, with leading zeros dropped. */
function digitValues(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/**
 * Run all four guards. Exported so the contract test can hit each one directly
 * without a model in the loop.
 */
export function checkEditorial(candidate: string, inputBlock: string): GuardResult {
  const text = candidate.trim();
  if (!text) return { ok: false, reason: "empty" };

  if (text.length > EDITORIAL_MAX_CHARS) {
    return { ok: false, reason: `over ${EDITORIAL_MAX_CHARS} characters (${text.length})` };
  }

  const url = URL_PATTERN.exec(text);
  if (url) return { ok: false, reason: `contains a URL (${url[0]})` };

  const allowed = new Set(digitValues(inputBlock));
  for (const value of digitValues(text)) {
    if (!allowed.has(value)) {
      return { ok: false, reason: `contains the number ${value}, which is not in the input` };
    }
  }

  const words = text.split(/[^A-Za-z0-9]+/);
  for (let i = 0; i < words.length - 1; i++) {
    const value = NUMBER_WORDS[(words[i] ?? "").toLowerCase()];
    if (value === undefined) continue;
    if (!TIME_UNIT.test(words[i + 1] ?? "")) continue;
    if (!allowed.has(value)) {
      return {
        ok: false,
        reason: `says "${words[i]} ${words[i + 1]}" but ${value} is not in the input`,
      };
    }
  }

  const stranger = unknownProperNoun(text, inputBlock);
  if (stranger) return { ok: false, reason: `names "${stranger}", which is not in the input` };

  return { ok: true };
}

/**
 * Write the opener, or return undefined.
 *
 * Never throws. A discarded paragraph and a failed call are the same outcome to
 * the caller, because they are the same outcome to the reader.
 */
export async function writeEditorial(
  runner: LlmRunner | undefined,
  input: EditorialInput,
): Promise<string | undefined> {
  try {
    if (!runner) return undefined;
    if (input.items.length === 0) return undefined;

    const inputBlock = buildInputBlock(input);
    const previous = input.previousOpeners.slice(0, 3);
    const user = [
      "INPUT BLOCK — every fact and every number you may use is here.",
      "",
      inputBlock,
      "",
      previous.length > 0
        ? [
            "PREVIOUS OPENERS — do not reuse their phrasing or their angle. Their",
            "numbers and names are NOT available to you; only the input block above is.",
            "",
            ...previous.map((p, i) => `${i + 1}. ${p}`),
          ].join("\n")
        : "There are no previous openers.",
    ].join("\n");

    const raw = await runner.text({
      model: EDITORIAL_MODEL,
      purpose: "editorial",
      system: EDITORIAL_SYSTEM,
      user,
      maxTokens: 1500,
      effort: "low",
    });
    if (!raw) return undefined;

    // Strip any wrapper quoting before measuring, so a model that politely
    // quotes its own paragraph is not failed for two characters.
    const candidate = raw.trim().replace(/^["']|["']$/g, "").trim();

    const verdict = checkEditorial(candidate, inputBlock);
    if (!verdict.ok) {
      console.log(`[llm] editorial DISCARDED: ${verdict.reason ?? "unknown"}`);
      return undefined;
    }
    return candidate;
  } catch (err) {
    console.log(`[llm] editorial: unexpected failure: ${String(err)}`);
    return undefined;
  }
}
