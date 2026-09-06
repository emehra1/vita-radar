/**
 * The load-bearing assertions for the Claude layer.
 *
 * There is no network here and there never will be. Every test drives a stub
 * runner, because the thing being tested is not whether Claude is good at
 * finding deadlines — it is whether a Claude that is WRONG can do any damage.
 * The interesting cases are all adversarial: the model fabricates a sentence,
 * the model returns a bare date, the model invents a number, the model throws.
 *
 * If someone later relaxes any of this, the failure it re-enables is a phantom
 * countdown to a day on which nothing happens — invisible until the morning the
 * reader misses something, and unrecoverable after that because the trust is
 * what was lost.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { quoteAppearsIn, readDeadlineFromQuote } from "../pipeline/deadlines/extract.ts";
import type { LlmJsonRequest, LlmRequestBase, LlmRunner, LlmStats } from "../pipeline/llm/client.ts";
import { LLM_MAX_CALLS_PER_RUN, LLM_MAX_USD_PER_RUN } from "../pipeline/llm/client.ts";
import {
  buildInputBlock,
  checkEditorial,
  EDITORIAL_MAX_CHARS,
  writeEditorial,
  type EditorialInput,
} from "../pipeline/llm/editorial.ts";
import {
  locateDeadline,
  LOCATE_SCHEMA,
  renderProposalMarkdown,
  type LocateInput,
} from "../pipeline/llm/locate.ts";
import { estimateUsd, LOCATOR_MODEL, MODELS, willCache } from "../pipeline/llm/models.ts";
import { PROFILE, PROFILE_VERSION } from "../pipeline/llm/profile.ts";

const TZ = "America/New_York";
const NOW = new Date("2026-09-06T12:00:00Z");

/**
 * A real page: one genuine deadline sentence, plus the noise that surrounds it
 * on every site this project actually watches.
 */
const PAGE = [
  "Applying for the Scholarship",
  "The Rhodes Scholarship is the oldest international graduate scholarship in the world.",
  "Applications for the class entering in 2027 close on 3 October 2026 at 23:59 BST.",
  "The 2026 Scholars were announced on 22 November 2025.",
  "Scholars begin their studies in October 2027.",
  "Last updated: 2026-08-22.",
  "Applicants must be endorsed by their university before applying.",
].join("\n");

function stub(overrides: Partial<LlmRunner> = {}): LlmRunner {
  const base: LlmRunner = {
    async json() {
      return undefined;
    },
    async text() {
      return undefined;
    },
    stats(): LlmStats {
      return {
        calls: 0,
        estimatedUsd: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        disabled: false,
      };
    },
    report() {},
  };
  return { ...base, ...overrides };
}

function jsonStub(payload: Record<string, unknown>): LlmRunner {
  return stub({
    async json(_req: LlmJsonRequest) {
      return payload;
    },
  });
}

function locateInput(over: Partial<LocateInput> = {}): LocateInput {
  return {
    programId: "rhodes-us",
    label: "Rhodes Scholarship (US)",
    sourceUrl: "https://www.rhodeshouse.ox.ac.uk/scholarships/the-rhodes-scholarship",
    pageText: PAGE,
    pageHash: "abcdef0123456789",
    timeZone: TZ,
    cycleYear: 2027,
    today: "2026-09-06",
    now: NOW,
    current: { kind: "projected", date: "2026-10-01", precision: "day" },
    ...over,
  };
}

/* ------------------------- the schema has no date ------------------------- */

describe("LOCATE_SCHEMA", () => {
  /**
   * The structural half of the safety argument: a hallucinated date has nowhere
   * to go. Adding "just a hint" date field is the natural instinct of the next
   * person to touch locate.ts, and this is what stops it.
   */
  it("contains no field a date could be written into", () => {
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        keys.push(key);
        walk(value);
      }
    };
    walk(LOCATE_SCHEMA);

    const propertyNames = Object.keys(
      (LOCATE_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    expect(propertyNames.sort()).toEqual(["found", "location", "note", "quote"]);

    for (const key of keys) {
      expect(/date|deadline|year|iso|when|day|month/i.test(key)).toBe(false);
    }
  });

  it("forbids extra properties, so a model cannot smuggle one in", () => {
    expect((LOCATE_SCHEMA as { additionalProperties: unknown }).additionalProperties).toBe(false);
  });
});

/* --------------------------- gate 2: the quote ---------------------------- */

describe("the verbatim check", () => {
  it("rejects a fabricated quote that is not on the page", () => {
    const fabricated = "Applications close on 15 September 2026 at 5:00 PM.";
    expect(quoteAppearsIn(fabricated, PAGE)).toBe(false);
  });

  it("accepts a genuine quote even when whitespace and punctuation are mangled", () => {
    const genuine =
      "applications  for the class entering in 2027   close on 3 October 2026 at 23:59 BST.";
    expect(quoteAppearsIn(genuine, PAGE)).toBe(true);
  });

  it("stops a fabricated quote before it ever reaches the reader", async () => {
    const runner = jsonStub({
      found: true,
      // Plausible, well-formed, parseable — and nowhere on the page.
      quote: "Applications close on 15 September 2026 at 17:00 BST.",
      location: "Apply",
      note: "invented",
    });
    await expect(locateDeadline(runner, locateInput())).resolves.toBeUndefined();
  });
});

/* --------------------------- gate 3: the reader --------------------------- */

describe("the deterministic reader is the only thing that makes a date", () => {
  it("refuses a real quote that carries no four-digit year", () => {
    const page = "Nucleate Activator. Deadline for US chapters is October 21st. 2024 COHORT.";
    const quote = "Deadline for US chapters is October 21st.";
    expect(quoteAppearsIn(quote, page)).toBe(true);
    const read = readDeadlineFromQuote(quote, { timeZone: TZ, now: NOW, cycleYear: 2027 });
    expect(read.ok).toBe(false);
    expect(read.date).toBeUndefined();
    expect(read.reason).toMatch(/year/i);
  });

  it("produces no proposal from a yearless quote, however confident the model is", async () => {
    const page = "Nucleate Activator. Deadline for US chapters is October 21st. 2024 COHORT.";
    const runner = jsonStub({
      found: true,
      quote: "Deadline for US chapters is October 21st.",
      location: "Apply",
      note: "This is clearly this year's deadline.",
    });
    await expect(
      locateDeadline(
        runner,
        locateInput({ programId: "nucleate-activator-us", pageText: page, current: { kind: "unknown", precision: "unknown" } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("cannot produce a date from a date-shaped quote the reader will not accept", async () => {
    /**
     * The model returns a string that IS a date and IS on the page. It still
     * fails, because a bare date is not a deadline — a page is full of dates,
     * and this one is the page's own last-updated stamp.
     */
    const quote = "Last updated: 2026-08-22.";
    expect(quoteAppearsIn(quote, PAGE)).toBe(true);
    const read = readDeadlineFromQuote(quote, { timeZone: TZ, now: NOW, cycleYear: 2027 });
    expect(read.ok).toBe(false);

    const runner = jsonStub({ found: true, quote, location: "Footer", note: "the date" });
    await expect(locateDeadline(runner, locateInput())).resolves.toBeUndefined();
  });

  it("refuses an announcement sentence even though it is verbatim and dated", async () => {
    const quote = "The 2026 Scholars were announced on 22 November 2025.";
    expect(quoteAppearsIn(quote, PAGE)).toBe(true);
    const runner = jsonStub({ found: true, quote, location: "News", note: "" });
    await expect(locateDeadline(runner, locateInput())).resolves.toBeUndefined();
  });

  it("accepts the one genuine deadline sentence and emits proposed* fields only", async () => {
    const quote = "Applications for the class entering in 2027 close on 3 October 2026 at 23:59 BST.";
    const runner = jsonStub({
      found: true,
      quote,
      location: "Applying for the Scholarship",
      note: "National deadline for the entering class of 2027.",
    });
    const proposal = await locateDeadline(runner, locateInput());
    expect(proposal).toBeDefined();
    expect(proposal?.proposedDate).toBe("2026-10-03");
    expect(proposal?.proposedPrecision).toBe("day");
    // THE ONE RULE, expressed as a type: this can never satisfy canAlert().
    expect(proposal?.proposedProvenance).toBe("claude-proposed");
    expect(proposal?.agreesWithYaml).toBe(false);
    expect(proposal?.currentDate).toBe("2026-10-01");
    expect(proposal?.provenance.quote).toBe(quote);
    expect(proposal?.provenance.model).toBe(LOCATOR_MODEL);
    expect(proposal?.provenance.profileVersion).toBe(PROFILE_VERSION);
    expect(proposal?.provenance.pageHash).toBe("abcdef0123456789");
    expect(proposal?.provenance.sourceUrl).toContain("rhodeshouse");
    expect(proposal?.provenance.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Nothing on the proposal is named like a date of record.
    expect(Object.keys(proposal ?? {})).not.toContain("date");
    expect(Object.keys(proposal ?? {})).not.toContain("deadline");
  });

  it("marks a page that agrees with the YAML as a confirmation, not a change", async () => {
    const quote = "Applications for the class entering in 2027 close on 3 October 2026 at 23:59 BST.";
    const runner = jsonStub({ found: true, quote, location: "Apply", note: "" });
    const proposal = await locateDeadline(
      runner,
      locateInput({ current: { kind: "confirmed", date: "2026-10-03", precision: "day" } }),
    );
    expect(proposal?.agreesWithYaml).toBe(true);
  });
});

/* ---------------------------- never throw, ever --------------------------- */

describe("failure is always undefined, never an exception", () => {
  const thrower = stub({
    async json() {
      throw new Error("the model layer exploded");
    },
    async text() {
      throw new Error("the model layer exploded");
    },
  });

  it("locateDeadline swallows a throwing client", async () => {
    await expect(locateDeadline(thrower, locateInput())).resolves.toBeUndefined();
  });

  it("writeEditorial swallows a throwing client", async () => {
    await expect(
      writeEditorial(thrower, {
        date: "2026-09-06",
        items: [{ lane: "fellowships", score: 80, title: "Rhodes", fact: "Endorsement first.", daysUntil: 9 }],
        previousOpeners: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("both callers no-op when there is no client at all (no ANTHROPIC_API_KEY)", async () => {
    await expect(locateDeadline(undefined, locateInput())).resolves.toBeUndefined();
    await expect(
      writeEditorial(undefined, { date: "2026-09-06", items: [], previousOpeners: [] }),
    ).resolves.toBeUndefined();
  });

  it("survives a model that answers with the wrong shape", async () => {
    await expect(
      locateDeadline(jsonStub({ found: "yes", quote: 42 }), locateInput()),
    ).resolves.toBeUndefined();
    await expect(locateDeadline(jsonStub({}), locateInput())).resolves.toBeUndefined();
  });

  it("does not spend a call on a challenge page", async () => {
    let called = false;
    const runner = stub({
      async json() {
        called = true;
        return { found: true, quote: "x", location: "", note: "" };
      },
    });
    await expect(
      locateDeadline(runner, locateInput({ pageText: "Client Challenge. Enable JavaScript." })),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});

/* --------------------------------- profile -------------------------------- */

describe("PROFILE", () => {
  const source = readFileSync(resolve(process.cwd(), "pipeline/llm/profile.ts"), "utf8");

  /**
   * Checked against the SOURCE, not the value: an interpolation would already
   * have been substituted by the time the value exists, so the runtime string
   * cannot reveal it. This is the only place the bug is visible.
   */
  it("contains no interpolation, so nothing can leak into the cached prefix", () => {
    expect(source.includes("${")).toBe(false);
    expect(PROFILE.includes("${")).toBe(false);
  });

  /**
   * A date in a cached prefix is the number-one silent cache invalidator: the
   * prefix changes at midnight, every entry dies, and the only symptom is the
   * bill. The current date belongs in the user turn.
   */
  it("contains no current-year literal and no future year", () => {
    const thisYear = new Date().getFullYear();
    expect(PROFILE).not.toContain(String(thisYear));
    const years = [...PROFILE.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    for (const year of years) expect(year).toBeLessThan(thisYear);
  });

  it("never says today", () => {
    expect(/\btoday\b/i.test(PROFILE)).toBe(false);
  });

  /**
   * Haiku 4.5's minimum cacheable prefix is 4096 tokens, not the 1024 everyone
   * remembers. A near-miss caches NOTHING and reports nothing — this assertion
   * is the only warning anyone would ever get.
   */
  it("clears the locator model's minimum cacheable prefix with margin", () => {
    expect(MODELS[LOCATOR_MODEL].minCacheablePrefixTokens).toBe(4096);
    expect(willCache(LOCATOR_MODEL, PROFILE)).toBe(true);
    expect(Math.floor(PROFILE.length / 4)).toBeGreaterThanOrEqual(6000);
  });

  it("names the target stack and the conference set it is supposed to know", () => {
    // Case-insensitive: the section headings are upper-case by design.
    const haystack = PROFILE.toLowerCase();
    for (const name of [
      "Rhodes", "Gates Cambridge", "BBPS", "AMCAS", "MSTP", "Hertz", "Soros",
      "Knight-Hennessy", "F30", "NIA", "HHMI", "Gilliam", "Schmidt",
      "ARDD", "CSHL", "Keystone", "GRC", "ASHG", "ABRCMS", "AGE",
      "Buenrostro", "Mendelian randomization", "scMethyl", "TAPS",
    ]) {
      expect({ name, present: haystack.includes(name.toLowerCase()) }).toEqual({
        name,
        present: true,
      });
    }
  });
});

/* ------------------------------- editorial -------------------------------- */

describe("the editorial guards", () => {
  const input: EditorialInput = {
    date: "2026-09-06",
    items: [
      { lane: "fellowships", score: 91, title: "Rhodes Scholarship (US)", fact: "Harvard endorsement precedes the national deadline.", daysUntil: 9 },
      { lane: "conferences", score: 64, title: "ASHG Annual Meeting", fact: "Abstract submission is open.", daysUntil: 25 },
    ],
    previousOpeners: [],
  };
  const block = buildInputBlock(input);

  it("passes an opener built only from the input", () => {
    const ok =
      "Two things matter this morning. Rhodes is 9 days out and the Harvard " +
      "endorsement comes first, so treat that as the real deadline rather than " +
      "the national one. ASHG abstract submission is open with 25 days left.";
    expect(checkEditorial(ok, block)).toEqual({ ok: true });
  });

  it("rejects a URL", () => {
    const bad =
      "Rhodes is 9 days out. Full details at https://rhodeshouse.ox.ac.uk before you start.";
    const verdict = checkEditorial(bad, block);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/URL/i);
  });

  it("rejects a number that was not in the input", () => {
    const bad = "Rhodes is 9 days out, and there are 14 days left for the ASHG abstract.";
    const verdict = checkEditorial(bad, block);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("14");
  });

  it("rejects a spelled-out number that was not in the input", () => {
    const bad = "Rhodes closes in eleven days, so start on the endorsement.";
    const verdict = checkEditorial(bad, block);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/eleven/);
  });

  it("allows a spelled-out number that WAS in the input", () => {
    const ok = "Rhodes closes in nine days, so start on the endorsement today.";
    expect(checkEditorial(ok, block).ok).toBe(true);
  });

  it("rejects anything over the character ceiling", () => {
    const bad = `Rhodes is 9 days out. ${"The endorsement comes first. ".repeat(40)}`;
    expect(bad.length).toBeGreaterThan(EDITORIAL_MAX_CHARS);
    const verdict = checkEditorial(bad, block);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/characters/);
  });

  it("rejects a programme that is not in the input", () => {
    const bad = "Rhodes is 9 days out, and the Marshall deadline is close behind it.";
    const verdict = checkEditorial(bad, block);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("Marshall");
  });

  it("does not let yesterday's numbers back in through the previous openers", () => {
    const withPrevious = buildInputBlock({ ...input, previousOpeners: ["Rhodes is 11 days out."] });
    expect(checkEditorial("Rhodes is 11 days out.", withPrevious).ok).toBe(false);
  });

  it("discards a guard-failing paragraph rather than returning it", async () => {
    const runner = stub({
      async text(_req: LlmRequestBase) {
        return "Rhodes closes in 14 days — see https://example.org for details.";
      },
    });
    await expect(writeEditorial(runner, input)).resolves.toBeUndefined();
  });

  it("returns a paragraph that passes every guard", async () => {
    const good = "Rhodes is 9 days out and the endorsement comes first. ASHG has 25 days.";
    const runner = stub({
      async text() {
        return good;
      },
    });
    await expect(writeEditorial(runner, input)).resolves.toBe(good);
  });
});

/* ------------------------------ the PR body ------------------------------- */

describe("renderProposalMarkdown", () => {
  it("shows the current value, the proposed value, the quote and the URL", async () => {
    const quote = "Applications for the class entering in 2027 close on 3 October 2026 at 23:59 BST.";
    const proposal = await locateDeadline(
      jsonStub({ found: true, quote, location: "Apply", note: "class of 2027" }),
      locateInput(),
    );
    const md = renderProposalMarkdown(proposal ? [proposal] : []);
    expect(md).toContain("Rhodes Scholarship (US)");
    expect(md).toContain("2026-10-01");
    expect(md).toContain("2026-10-03");
    expect(md).toContain(quote);
    expect(md).toContain("rhodeshouse.ox.ac.uk");
    expect(md).toContain("Changes proposed (1)");
    // It must say, in the body a human reads, that nothing was applied.
    expect(md).toMatch(/has been applied/i);
  });

  it("says so plainly when nothing was found", () => {
    expect(renderProposalMarkdown([])).toMatch(/No page produced/);
  });
});

/* --------------------------- ceilings and costs --------------------------- */

describe("cost ceilings", () => {
  it("are low enough that a loop bug cannot produce a surprising bill", () => {
    expect(LLM_MAX_CALLS_PER_RUN).toBeLessThanOrEqual(60);
    expect(LLM_MAX_USD_PER_RUN).toBeLessThanOrEqual(0.5);
    // Worst case: every allowed call runs at the ceiling, every day of a month.
    const worstMonth = LLM_MAX_USD_PER_RUN * 31;
    expect(worstMonth).toBeLessThan(20);
  });

  it("counts cached reads at a tenth of input price and cache writes at 1.25x", () => {
    const cold = estimateUsd(LOCATOR_MODEL, { input_tokens: 1_000_000, output_tokens: 0 });
    const warm = estimateUsd(LOCATOR_MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    const written = estimateUsd(LOCATOR_MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cold).toBeCloseTo(1, 6);
    expect(warm).toBeCloseTo(0.1, 6);
    expect(written).toBeCloseTo(1.25, 6);
  });

  it("never sends effort to a model that 400s on it", () => {
    // Haiku 4.5 rejects output_config.effort outright rather than ignoring it.
    expect(MODELS["claude-haiku-4-5"].supportsEffort).toBe(false);
    expect(MODELS["claude-opus-5"].supportsEffort).toBe(true);
  });
});

/**
 * The strongest statement of the model being additive rather than load-bearing:
 * the pipeline must survive `pipeline/llm/` not existing.
 *
 * This is not hypothetical tidiness. run.ts originally imported the layer
 * statically, which made the README's claim false in the most complete way
 * possible — removing the directory broke module resolution before main() ran a
 * single line, so the digest was never written at all. The import is dynamic
 * now specifically so a missing layer is a caught miss instead of a crash.
 */
describe("the LLM layer is deletable", () => {
  it("is reached only through a dynamic import in run.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "pipeline/run.ts"), "utf8");

    // A static `import ... from "./llm/..."` at module scope would crash the run.
    const staticImport = /^\s*import\s[^;]*from\s+["']\.\/llm\//m.test(source);
    expect(staticImport).toBe(false);

    // And it must actually be imported somewhere, or this test passes vacuously
    // while the editorial silently never runs.
    expect(source).toMatch(/await import\(["']\.\/llm\/client\.ts["']\)/);
    expect(source).toMatch(/await import\(["']\.\/llm\/editorial\.ts["']\)/);
  });

  it("keeps the editorial inside a try/catch so a throw cannot reach the digest", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "pipeline/run.ts"), "utf8");
    const block = source.slice(source.indexOf("let editorial"), source.indexOf("const digest: DailyDigest"));
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/catch\s*\(/);
  });
});
