import { hostOf } from "../normalize/url";
import { CookieJar } from "./cookies.ts";
import { createHostGate, createLimiter, sleep } from "./pool.ts";
import { contentHash, HttpCache } from "./cache.ts";
import { describeWrongShape, type BodyShape } from "./shape.ts";

/**
 * The one fetch path for the whole pipeline.
 *
 * We never use rss-parser's `parseURL`: in testing it hung for over two minutes
 * on these feeds (and 403s on endpoints.news), while native fetch + parseString
 * returned in seconds. Fetch here, parse from the string.
 *
 * The Accept header is load-bearing, not decoration — endpoints.news is
 * header-sensitive and rejects requests that don't look like a real client.
 *
 * Redirects are followed by hand rather than with `redirect: "follow"`. Three
 * things need to happen per hop and the built-in follower does none of them:
 * cookies must be carried across the chain (see cookies.ts — this is what makes
 * nature.com serve XML instead of bouncing through its IdP), conditional
 * headers must be dropped once we are no longer asking for the entity we hold
 * an ETag for, and the shape of the final body has to be checked before
 * anything is written to the cache.
 */

/**
 * Identifies the tool and a contact, in the `Mozilla/5.0 (compatible; …)` form
 * publishers' WAFs expect. A bare `biotech-insights/0.2` gets a 403 from
 * endpoints.news — verified. This is not spoofing a browser: the bot name and
 * contact URL are right there, which is what robots etiquette actually asks for.
 */
export const USER_AGENT =
  process.env.VR_USER_AGENT ??
  "Mozilla/5.0 (compatible; vita-radar/0.1; personal daily digest; +https://github.com/emehra1/vita-radar)";

export const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8";

/** Chains longer than this are a loop, not a redirect. */
const MAX_REDIRECTS = 8;

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  accept?: string;
  etag?: string;
  lastModified?: string;
  crawlDelayMs?: number;
  cacheKey?: string;
  /**
   * What the body should look like. When set, a 200 carrying the wrong shape is
   * treated as a soft block: retried, and never written to the cache.
   */
  expect?: BodyShape;
  /** Replay from .cache/raw instead of hitting the network. */
  fromCache?: boolean;
}

export interface FetchResult {
  status: number;
  notModified: boolean;
  body?: string;
  etag?: string;
  lastModified?: string;
  finalUrl: string;
  timingMs: number;
  attempts: number;
  fromCache: boolean;
  /** Hops followed on the successful attempt; >0 means we were redirected. */
  redirects: number;
  error?: string;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const limit = createLimiter(6);
const hostGate = createHostGate(250);

export function createHttpClient(cache: HttpCache) {
  // One jar per client, so one per run. Sessions a publisher hands out are
  // reused for the rest of the run and then thrown away with the process.
  const jar = new CookieJar();

  // Hosts that have already served an interstitial and kept serving it through
  // a full retry budget. Retrying is worth one source's while — the attempt
  // that follows a bounce carries the session cookie the bounce handed out —
  // but it must not be worth every source's. Eleven nature.com feeds behind a
  // 700ms host gate, each retrying three times into a host that is refusing us,
  // is 33 serialized requests and minutes of backoff to reach the same answer.
  // Once one source has established the host is blocking, the rest fail fast.
  const blocking = new Set<string>();

  return async function fetchWithPolicy(
    url: string,
    options: FetchOptions = {},
  ): Promise<FetchResult> {
    const key = options.cacheKey ?? url;
    const started = Date.now();

    if (options.fromCache) {
      const body = await cache.readRaw(key);
      return {
        status: body ? 200 : 504,
        notModified: false,
        body,
        finalUrl: url,
        timingMs: Date.now() - started,
        attempts: 0,
        fromCache: true,
        redirects: 0,
        error: body ? undefined : "not in cache",
      };
    }

    const host = hostOf(url);
    const retries = options.retries ?? 2;

    return limit(() =>
      hostGate(host, options.crawlDelayMs ?? 250, async () => {
        let lastError = "";
        let lastStatus = 0;

        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) {
            const backoff = Math.min(30_000, 800 * 2 ** attempt);
            await sleep(backoff * (0.5 + Math.random() * 0.5));
          }

          try {
            const hop = await followRedirects(url, jar, options);
            const { response, redirects, finalUrl } = hop;
            lastStatus = response.status;

            if (response.status === 304) {
              return {
                status: 304,
                notModified: true,
                finalUrl,
                timingMs: Date.now() - started,
                attempts: attempt + 1,
                fromCache: false,
                redirects,
              };
            }

            if (!response.ok) {
              lastError = `HTTP ${response.status}`;
              if (RETRYABLE.has(response.status) && attempt < retries) {
                const retryAfter = Number(response.headers.get("retry-after"));
                if (Number.isFinite(retryAfter) && retryAfter > 0) {
                  await sleep(Math.min(30_000, retryAfter * 1000));
                }
                continue;
              }
              return {
                status: response.status,
                notModified: false,
                finalUrl,
                timingMs: Date.now() - started,
                attempts: attempt + 1,
                fromCache: false,
                redirects,
                error: lastError,
              };
            }

            const body = await response.text();

            // A 200 carrying an interstitial is a soft block, and it is the
            // failure mode that actually happens here — Fastly answering a
            // cache miss with an IdP bounce, or a WAF answering a datacenter IP
            // with a consent page. Retrying is worth it (the next attempt
            // usually carries a session cookie the first one earned), and
            // caching it is actively harmful: the poisoned body outlives the
            // run and gets replayed on tomorrow's 304.
            const wrongShape = options.expect
              ? describeWrongShape(body, options.expect)
              : undefined;
            if (wrongShape) {
              lastError = `expected ${options.expect === "json" ? "JSON" : "XML"}, ${wrongShape}`;
              if (attempt < retries && !blocking.has(host)) continue;

              // Forget anything we hold for this key. Declining to write the
              // interstitial is not enough on its own: `http-meta.json` is
              // committed, so a validator cached before this gate existed
              // outlives the runner, and sending it again earns a 304 for a
              // consent page — a failure that reports as a successful fetch.
              blocking.add(host);
              await cache.purge(key);
              return {
                status: response.status,
                notModified: false,
                finalUrl,
                timingMs: Date.now() - started,
                attempts: attempt + 1,
                fromCache: false,
                redirects,
                error: lastError,
              };
            }

            const etag = response.headers.get("etag") ?? undefined;
            const lastModified = response.headers.get("last-modified") ?? undefined;

            cache.set(key, {
              etag,
              lastModified,
              fetchedAt: new Date().toISOString(),
              status: response.status,
              contentHash: contentHash(body),
            });
            await cache.writeRaw(key, body);

            return {
              status: response.status,
              notModified: false,
              body,
              etag,
              lastModified,
              finalUrl,
              timingMs: Date.now() - started,
              attempts: attempt + 1,
              fromCache: false,
              redirects,
            };
          } catch (error) {
            lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            if (attempt >= retries) break;
          }
        }

        return {
          status: lastStatus || 0,
          notModified: false,
          finalUrl: url,
          timingMs: Date.now() - started,
          attempts: retries + 1,
          fromCache: false,
          redirects: 0,
          error: lastError || "fetch failed",
        };
      }),
    );
  };
}

/**
 * Walks a redirect chain by hand, carrying cookies forward.
 *
 * Conditional headers are sent on the first hop only. Once redirected we are
 * being handed a different resource — nature.com sends its feed requests to
 * idp.nature.com — and an `If-None-Match` built from the feed's ETag has no
 * meaning there. Forwarding it invites a 304 from a service that has never seen
 * the entity, which the caller would then try to satisfy from cache.
 */
async function followRedirects(
  startUrl: string,
  jar: CookieJar,
  options: FetchOptions,
): Promise<{ response: Response; redirects: number; finalUrl: string }> {
  let current = startUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: options.accept ?? FEED_ACCEPT,
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br",
    };
    if (redirects === 0) {
      if (options.etag) headers["if-none-match"] = options.etag;
      if (options.lastModified) headers["if-modified-since"] = options.lastModified;
    }
    const cookie = jar.header(current);
    if (cookie) headers.cookie = cookie;

    const response = await fetch(current, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers,
      redirect: "manual",
    });

    jar.absorb(current, response.headers);

    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
    if (!isRedirect || !location) {
      return { response, redirects, finalUrl: current };
    }

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return { response, redirects, finalUrl: current };
    }
    // Every method we issue is GET, so 307/308 need no special handling; the
    // only thing that changes across a hop is which cookies apply.
    current = next;
  }

  throw new Error(`too many redirects (>${MAX_REDIRECTS}) starting at ${startUrl}`);
}

export type HttpClient = ReturnType<typeof createHttpClient>;
