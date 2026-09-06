/**
 * The only place in this repo that talks to Anthropic.
 *
 * Three jobs, in order of how much damage they prevent:
 *
 * 1. NEVER THROW, and no-op without a key. Phase 3 is an optional layer bolted
 *    onto a pipeline whose whole point is that an email arrives every morning.
 *    A model outage, a schema bug, a 429 — none of them may take the digest
 *    with them. Every public method returns `undefined` on failure.
 * 2. Hard per-run ceilings. `LLM_MAX_CALLS_PER_RUN` and `LLM_MAX_USD_PER_RUN`
 *    are what stops a loop bug from producing a $200 month on a project whose
 *    entire infrastructure budget is zero. Exceeding either disables the layer
 *    for the rest of the run — the run continues, just without Claude in it.
 * 3. Make the prompt cache observable. A cached prefix that silently stops
 *    caching costs 10x and reports nothing, so this logs it loudly.
 *
 * Note on the SDK: `timeout` is in MILLISECONDS in the TypeScript SDK (it is
 * seconds in the Python one). A `timeout: 45` here would be 45 milliseconds and
 * every call would fail as a connection timeout.
 */

import Anthropic from "@anthropic-ai/sdk";

import {
  estimateUsd,
  MODELS,
  willCache,
  type ModelId,
  type UsageLike,
} from "./models.ts";

/**
 * Ceilings, deliberately low.
 *
 * 60 calls covers every page watch in config/sources.ts twice over, and $0.50
 * is roughly 25x what a normal run actually costs. Both exist to bound a BUG,
 * not to ration normal use — if a run ever gets close to either, something is
 * looping, and the right answer is to stop rather than to spend.
 */
export const LLM_MAX_CALLS_PER_RUN = 60;
export const LLM_MAX_USD_PER_RUN = 0.5;

/** SDK default is 10 minutes. A daily cron does not get to hang for ten minutes. */
const REQUEST_TIMEOUT_MS = 60_000;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmRequestBase {
  model: ModelId;
  /** Shows up in every log line. Makes a ceiling breach attributable. */
  purpose: string;
  /**
   * The CACHED prefix. Must be byte-identical across calls or nothing caches.
   * Never put a date, a URL, a page or a run id in here.
   */
  system: string;
  /** The volatile turn. Today's date, the page, the program: all of it goes here. */
  user: string;
  maxTokens?: number;
  effort?: Effort;
  /**
   * Set when the caller is relying on the prefix caching. Only then is a
   * too-short prefix worth a warning — the editorial call deliberately uses a
   * small system prompt it never expects to cache, and a daily "this will not
   * cache" line about that is noise that trains you to ignore the real one.
   */
  expectCache?: boolean;
}

export interface LlmJsonRequest extends LlmRequestBase {
  /** Raw JSON Schema. No zod in this project. */
  schema: Record<string, unknown>;
}

export interface LlmStats {
  calls: number;
  estimatedUsd: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  disabled: boolean;
  disabledReason?: string;
}

/**
 * The seam every caller depends on, so tests can pass a stub and no test ever
 * touches the network. `locate.ts` and `editorial.ts` know only this interface.
 */
export interface LlmRunner {
  json(req: LlmJsonRequest): Promise<Record<string, unknown> | undefined>;
  text(req: LlmRequestBase): Promise<string | undefined>;
  stats(): LlmStats;
  /** Logs the one-line spend summary. Safe to call more than once. */
  report(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `retry-after` is seconds, and may be absent. Clamp hard: a server asking us
 * to wait five minutes is a server we should skip, not wait for, because the
 * whole pipeline has a cron slot to keep.
 */
function retryAfterMs(headers: Headers | undefined): number {
  const raw = headers?.get?.("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return 2_000;
  return Math.min(seconds * 1000, 20_000);
}

class AnthropicRunner implements LlmRunner {
  private calls = 0;
  private usd = 0;
  private cacheRead = 0;
  private cacheCreation = 0;
  /** Calls that requested a cached prefix. Only these can legitimately read one. */
  private cacheableCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private off = false;
  private offReason: string | undefined;
  private warnedNoCache = false;
  private reported = false;

  constructor(private readonly client: Anthropic) {}

  stats(): LlmStats {
    return {
      calls: this.calls,
      estimatedUsd: this.usd,
      cacheReadTokens: this.cacheRead,
      cacheCreationTokens: this.cacheCreation,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      disabled: this.off,
      disabledReason: this.offReason,
    };
  }

  report(): void {
    if (this.reported) return;
    this.reported = true;
    if (this.calls === 0) return;
    console.log(
      `[llm] ${this.calls} call(s), ~$${this.usd.toFixed(4)}, ` +
        `cache read ${this.cacheRead} / written ${this.cacheCreation} tokens` +
        (this.off ? ` — DISABLED: ${this.offReason ?? "unknown"}` : ""),
    );
  }

  private disable(reason: string): void {
    if (this.off) return;
    this.off = true;
    this.offReason = reason;
    console.log(`[llm] LAYER DISABLED FOR THIS RUN: ${reason}`);
  }

  /** Returns false when the call must not be made. */
  private admit(purpose: string): boolean {
    if (this.off) return false;
    if (this.calls >= LLM_MAX_CALLS_PER_RUN) {
      this.disable(`call ceiling ${LLM_MAX_CALLS_PER_RUN} reached at ${purpose}`);
      return false;
    }
    if (this.usd >= LLM_MAX_USD_PER_RUN) {
      this.disable(
        `spend ceiling $${LLM_MAX_USD_PER_RUN.toFixed(2)} reached at ${purpose} ` +
          `(~$${this.usd.toFixed(4)})`,
      );
      return false;
    }
    return true;
  }

  private account(model: ModelId, usage: UsageLike | undefined): void {
    if (!usage) return;
    this.usd += estimateUsd(model, usage);
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheCreation += usage.cache_creation_input_tokens ?? 0;
    this.inputTokens += usage.input_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;

    /**
     * The cache failure is silent by construction: a prefix under the model's
     * minimum, or a single changed byte in it, returns zeroes rather than an
     * error. Two calls with a shared prefix and nothing read back is the exact
     * signature, so say so once, loudly, rather than paying 10x in silence.
     */
    /**
     * Gated on a prefix having actually been WRITTEN, not merely on call count.
     *
     * The editorial call deliberately uses a short, uncacheable system prompt,
     * and it still increments `calls`. So one locate call (which writes a prefix
     * and reads nothing, correctly, because it is the only locate call that run)
     * plus one editorial call reached `calls === 2` with `cacheRead === 0` and
     * fired this alarm on a run where every byte of behaviour was right.
     *
     * An alarm that fires on correct behaviour is one the reader learns to
     * scroll past, which is the whole argument this project keeps making about
     * its own health table.
     */
    if (!this.warnedNoCache && this.cacheCreation > 0 && this.cacheRead === 0 && this.cacheableCalls > 1) {
      this.warnedNoCache = true;
      console.log(
        "[llm] PROMPT CACHE NOT HIT — cache_read_input_tokens is 0 after " +
          `${this.calls} calls. The cached prefix is either below the model's ` +
          "minimum or is changing between calls (a date in the system prompt " +
          "is the usual cause). Paying full input price.",
      );
    }

    if (this.usd >= LLM_MAX_USD_PER_RUN) {
      this.disable(
        `spend ceiling $${LLM_MAX_USD_PER_RUN.toFixed(2)} exceeded (~$${this.usd.toFixed(4)})`,
      );
    }
  }

  private async send(
    req: LlmRequestBase,
    schema: Record<string, unknown> | undefined,
  ): Promise<string | undefined> {
    if (!this.admit(req.purpose)) return undefined;

    const spec = MODELS[req.model];

    /**
     * `effort` is a 400 on Haiku 4.5 rather than an ignored field, so it is
     * dropped rather than passed through. A 400 here would look identical to a
     * schema bug and would disable the layer for a reason that is not real.
     */
    const outputConfig: Anthropic.OutputConfig = {};
    if (schema) outputConfig.format = { type: "json_schema", schema };
    if (req.effort && spec.supportsEffort) outputConfig.effort = req.effort;

    if (req.expectCache) this.cacheableCalls++;

    if (req.expectCache && !willCache(req.model, req.system)) {
      console.log(
        `[llm] ${req.purpose}: system prompt is ~${Math.floor(req.system.length / 4)} tokens, ` +
          `below the ${spec.minCacheablePrefixTokens}-token cache minimum for ${req.model}. ` +
          "It will not cache.",
      );
    }

    /**
     * Typed explicitly rather than inferred. An object literal handed straight
     * to messages.create() gets excess-property checking, but a `const` does
     * not — so without this annotation a misspelled or removed SDK field
     * (output_config vs the deprecated output_format, say) compiles cleanly and
     * fails at runtime as a 400 that looks like a prompt bug.
     */
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      system: [
        {
          type: "text" as const,
          text: req.system,
          // The one breakpoint. Everything volatile lives after it, in `user`.
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [{ role: "user" as const, content: req.user }],
      // Omitted entirely when empty: an empty output_config is a needless byte
      // of request surface, and `effort` must be absent (not null) on Haiku.
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : undefined),
    };

    // One retry, at most, and only for the two classes where a retry can help.
    // A retry is a call: it is re-admitted so a retry storm cannot walk past
    // the ceilings that the first attempt was checked against.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && !this.admit(req.purpose)) return undefined;
      this.calls++;
      try {
        const response = await this.client.messages.create(params, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        this.account(req.model, response.usage as UsageLike | undefined);

        // A refusal is a legitimate outcome, not an error. Treat it as "no answer".
        if (response.stop_reason === "refusal") {
          console.log(`[llm] ${req.purpose}: model refused; treating as no result`);
          return undefined;
        }

        /**
         * A truncated answer is worse than no answer, and it is the failure the
         * editorial guards cannot see.
         *
         * Thinking is ON BY DEFAULT on Opus 5 — a change from Opus 4.8/4.7,
         * where omitting the parameter meant no thinking — and those tokens
         * bill as output inside the same `max_tokens`. So an opener can lose
         * most of its budget to reasoning and come back cut mid-sentence. Under
         * 700 characters, no invented numbers, no URL, no unknown program: it
         * passes all four editorial guards and ships a half-finished paragraph
         * as the reader's first impression of the digest.
         *
         * Cheaper to discard here than to teach four downstream guards what a
         * severed sentence looks like.
         */
        if (response.stop_reason === "max_tokens") {
          console.log(
            `[llm] ${req.purpose}: hit max_tokens (${req.maxTokens ?? 1024}); discarding a truncated response`,
          );
          return undefined;
        }

        let text = "";
        for (const block of response.content) {
          if (block.type === "text") text += block.text;
        }
        return text.trim() || undefined;
      } catch (err) {
        /**
         * Most specific first. Collapsing these into one `catch (APIError)`
         * would retry a 400 — which can never succeed — and give up on a 429,
         * which always can.
         */
        if (err instanceof Anthropic.RateLimitError) {
          if (attempt === 1) {
            console.log(`[llm] ${req.purpose}: rate limited twice, giving up`);
            return undefined;
          }
          const waitMs = retryAfterMs(err.headers);
          console.log(`[llm] ${req.purpose}: rate limited, retrying in ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        if (err instanceof Anthropic.BadRequestError) {
          /**
           * A 400 is OUR bug — a malformed schema, an unsupported param, a
           * prompt over the window. Retrying it burns the ceiling to reproduce
           * the same failure, so this never retries and says what it was.
           */
          console.log(
            `[llm] ${req.purpose}: BAD REQUEST (this is a bug in our request, not a transient failure): ${err.message}`,
          );
          return undefined;
        }
        if (err instanceof Anthropic.APIConnectionError) {
          if (attempt === 1) {
            console.log(`[llm] ${req.purpose}: connection failed twice, giving up`);
            return undefined;
          }
          console.log(`[llm] ${req.purpose}: connection error, retrying once`);
          await sleep(1_000);
          continue;
        }
        if (err instanceof Anthropic.APIError) {
          console.log(`[llm] ${req.purpose}: API error ${String(err.status)}: ${err.message}`);
          return undefined;
        }
        // Anything else — a JSON parse blowing up inside the SDK, an abort —
        // is still not allowed to reach the pipeline.
        console.log(`[llm] ${req.purpose}: unexpected failure: ${String(err)}`);
        return undefined;
      }
    }
    return undefined;
  }

  async text(req: LlmRequestBase): Promise<string | undefined> {
    return this.send(req, undefined);
  }

  async json(req: LlmJsonRequest): Promise<Record<string, unknown> | undefined> {
    const raw = await this.send(req, req.schema);
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.log(`[llm] ${req.purpose}: structured output was not an object`);
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      // Structured outputs make this near-impossible, which is exactly why it
      // must not be an exception when it happens.
      console.log(`[llm] ${req.purpose}: structured output did not parse as JSON`);
      return undefined;
    }
  }
}

/**
 * The whole layer's on/off switch.
 *
 * No `ANTHROPIC_API_KEY` means `undefined`, which means every caller's optional
 * chain short-circuits and the pipeline runs exactly as it did in phase 2. That
 * is the documented contract in the README, and it is why local runs and forks
 * need no configuration at all.
 */
export function createLlmClient(opts: { apiKey?: string } = {}): LlmRunner | undefined {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  try {
    return new AnthropicRunner(
      new Anthropic({
        apiKey,
        /**
         * The SDK retries 429/5xx twice by default, invisibly. That would make
         * the ceilings in this file wrong by up to 3x — every hidden attempt is
         * a billable request that `usage` from the successful one does not
         * account for. Retries are done HERE instead, one per failure class,
         * counted.
         */
        maxRetries: 0,
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
  } catch (err) {
    console.log(`[llm] client construction failed, layer is off: ${String(err)}`);
    return undefined;
  }
}
