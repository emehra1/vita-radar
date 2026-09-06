import { createHash } from "node:crypto";

/**
 * Item identity is derived from the canonical URL only — never from
 * `${source}-${url}`, which would make the same story from a syndicated feed
 * look like a different item and break first-seen dating.
 */
export function itemId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

export function shortHash(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function clusterId(memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  return `c_${shortHash(sorted.join("|"), 10)}`;
}
