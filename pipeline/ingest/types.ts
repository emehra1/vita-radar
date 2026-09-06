import type { BodyProvenance, Lane, SourceKind } from "../../lib/types.ts";
import type { DatePrecision } from "../normalize/pubdates.ts";

/** One item after normalization, before extraction/scoring. */
export interface NormalizedItem {
  sourceId: string;
  sourceName: string;
  publisherGroup: string;
  sourceKind: SourceKind;
  authority: number;
  laneHints: Partial<Record<Lane, number>>;
  paywalled: boolean;

  title: string;
  url: string;
  canonicalUrl: string;
  guid?: string;

  publishedAt?: Date;
  datePrecision: DatePrecision;
  dateConfident: boolean;

  /** Best available body text. Never a fabricated summary. */
  bodyText: string;
  bodyProvenance: BodyProvenance;

  /** Set for opportunity-role sources: which registry program this concerns. */
  programId?: string;
  /** Set by the ATS parser so a wrong board token can be caught by assertion. */
  companyName?: string;
  location?: string;

  categories: string[];
  authors: string[];
  doi?: string;
  nctIds: string[];
  warnings: string[];
}

export interface IngestResult {
  items: NormalizedItem[];
  parsed: number;
  warnings: string[];
  /**
   * Items the source served correctly and OUR rules discarded.
   *
   * Distinct from "kept nothing" and the distinction is load-bearing. A source
   * returning an empty feed is broken; a source whose every item failed our own
   * `requireAny` gate is working perfectly and simply had nothing on topic.
   * Conflating them marks three healthy fellowship feeds degraded every day,
   * which is how a health table stops being read.
   */
  filteredByRule?: number;
}
