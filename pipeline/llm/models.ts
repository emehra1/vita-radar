/**
 * The four numbers per model that are wrong if you guess them, plus the two
 * model IDs this project actually calls.
 *
 * Everything in here was read off the Claude API reference rather than recalled,
 * because each field has a failure mode that is invisible at runtime:
 *
 * - A wrong price makes the per-run dollar ceiling in client.ts a lie, and the
 *   ceiling is the only thing standing between a retry bug and a $200 month.
 * - `minCacheablePrefixTokens` is NOT monotonic across generations — 512 on
 *   Opus 5, 1024 on Sonnet 5, but 4096 on Haiku 4.5. A prefix under the minimum
 *   does not error. It returns `cache_read_input_tokens: 0` forever and you pay
 *   full input price on every call while believing the cache is working. This
 *   is why pipeline/llm/profile.ts is deliberately enormous.
 * - `supportsEffort` is false on Haiku 4.5: sending `output_config.effort` to it
 *   is a 400, not a silently ignored field. Guessing "all current models take
 *   effort" turns the whole locator layer off with a schema error.
 *
 * Model IDs are bare and never date-suffixed. `claude-haiku-4-5`, never
 * `claude-haiku-4-5-20251001`.
 */

/** Cheap, high-volume, and never trusted with a date. See llm/locate.ts. */
export const LOCATOR_MODEL = "claude-haiku-4-5";

/** One call a day, writing at most 120 words that render last. See llm/editorial.ts. */
export const EDITORIAL_MODEL = "claude-opus-5";

export type ModelId = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

export interface ModelSpec {
  id: ModelId;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /**
   * Shortest prefix that will cache AT ALL on this model. Under it, nothing
   * caches and nothing complains.
   */
  minCacheablePrefixTokens: number;
  /** False means `output_config.effort` is a 400 on this model, not a no-op. */
  supportsEffort: boolean;
  contextWindow: number;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  "claude-opus-5": {
    id: "claude-opus-5",
    inputPerMTok: 5,
    outputPerMTok: 25,
    minCacheablePrefixTokens: 512,
    supportsEffort: true,
    contextWindow: 1_000_000,
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    inputPerMTok: 2,
    outputPerMTok: 10,
    minCacheablePrefixTokens: 1024,
    supportsEffort: true,
    contextWindow: 1_000_000,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    inputPerMTok: 1,
    outputPerMTok: 5,
    minCacheablePrefixTokens: 4096,
    supportsEffort: false,
    contextWindow: 200_000,
  },
};

/** A cache WRITE costs 1.25x base input on the 5-minute TTL this layer uses. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** A cache READ costs 0.1x base input. The whole reason profile.ts is worth its size. */
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * The subset of `Usage` this layer reads. Declared structurally rather than
 * imported so the cost estimator and its tests need no SDK, and so a stub
 * client in tests can hand back a plain object.
 */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Dollars for one call.
 *
 * `input_tokens` from the API already EXCLUDES the cached and cache-written
 * tokens, so the three input terms are added, never max'd. Getting that wrong
 * in the safe direction (double-counting) is fine; getting it wrong the other
 * way silently raises the real ceiling above the configured one.
 */
export function estimateUsd(model: ModelId, usage: UsageLike): number {
  const spec = MODELS[model];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const inputUsd =
    (input +
      cacheRead * CACHE_READ_MULTIPLIER +
      cacheWrite * CACHE_WRITE_MULTIPLIER) *
    (spec.inputPerMTok / 1_000_000);
  const outputUsd = output * (spec.outputPerMTok / 1_000_000);
  return inputUsd + outputUsd;
}

/**
 * Rough token count for prose, used only to check a prompt clears a model's
 * cache minimum before we rely on caching.
 *
 * Four characters per token UNDER-counts dense technical prose full of
 * acronyms, and that is the direction we want: a prompt this says is big enough
 * really is big enough. Never use it for billing — `usage` is the truth.
 */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/** True when `prompt` is long enough that `cache_control` on it will do anything. */
export function willCache(model: ModelId, prompt: string): boolean {
  return estimateTokens(prompt) >= MODELS[model].minCacheablePrefixTokens;
}
