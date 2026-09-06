/**
 * Shared data contract between the pipeline (Node), the email renderer and (from
 * phase 2) the static site. Must stay browser-safe: no `node:` imports, no
 * runtime deps.
 *
 * The one thing to understand before editing: this project's temporal model is
 * the INVERSE of a news reader's. A news item is most valuable the moment it
 * appears and decays from there. An opportunity is worthless in April and
 * unmissable on September 28th. Anything that treats `publishedAt` as a quality
 * signal is wrong here, and `ItemKind` exists to make that impossible to write
 * by accident.
 */

/* ---------------------------------- lanes --------------------------------- */

export const LANES = [
  "deadlines",
  "fellowships",
  "mstp-labs",
  "venture-founder",
  "conferences",
  "causal-genetics",
  "tools-platforms",
] as const;

export type Lane = (typeof LANES)[number];

export const LANE_LABELS: Record<Lane, string> = {
  deadlines: "Deadlines & Actions",
  fellowships: "Fellowships & Scholarships",
  "mstp-labs": "MSTP, Labs & PIs",
  "venture-founder": "Venture, Founder & Frontier Roles",
  conferences: "Conferences & Abstracts",
  "causal-genetics": "Causal Human Genetics",
  "tools-platforms": "Tools, Platforms & the Business of Genomics",
};

export const LANE_BLURBS: Record<Lane, string> = {
  deadlines:
    "Dated obligations from your own tracker: what closes soon, what needs confirming, and which step comes next.",
  fellowships:
    "New and refreshed named awards, plus anything new that fits the profile.",
  "mstp-labs":
    "MD/PhD programs, and the labs and PIs doing causal human genetics you would want to name in an application.",
  "venture-founder":
    "Nucleate, Flagship, Activate, age1, TechAtlas, FROs, Astera, and roles at the companies building the tools.",
  conferences:
    "Abstract deadlines you cannot miss: ARDD, CSHL, Keystone, GRC, ASHG, ABRCMS, Cell Symposia, AGE.",
  "causal-genetics":
    "GWAS, Mendelian randomization, fine-mapping, colocalization, burden tests, PheWAS, perturbation screens, single-cell and spatial epigenomics, epigenetic editing, biomarkers of aging.",
  "tools-platforms":
    "Sequencing and methylation platforms, single-cell instruments, target-discovery companies, and the deals that move the tickers.",
};

/** Rendered first and exempt from the round-robin. A preprint never displaces a deadline. */
export const PINNED_LANE: Lane = "deadlines";

/* -------------------------------- deadlines -------------------------------- */

/**
 * `confirmed` — a human read the page and wrote the date down.
 * `projected`  — rolled forward from a prior cycle. Plausible, not trusted.
 * `rolling`    — genuinely no deadline (always-open, or reviewed as received).
 * `unknown`    — there IS a deadline and we do not know it. Never conflate with
 *                `rolling`: one needs no action, the other needs you to go look.
 */
export type DeadlineKind = "confirmed" | "projected" | "rolling" | "unknown";

/**
 * Where the date came from. `yaml` is the only value that may drive an alert.
 * Everything else is advisory and renders with a "verify" affordance — see
 * the README's one rule.
 */
export type DateProvenance = "yaml" | "derived" | "hash-change" | "claude-proposed";

/** Day precision is the floor for an alert. A month-precision date cannot ring. */
export type DeadlinePrecision = "minute" | "day" | "month" | "unknown";

export interface Deadline {
  kind: DeadlineKind;
  /** YYYY-MM-DD in `timeZone`. Absent for `rolling` and `unknown`. */
  date?: string;
  /** "23:59" / "14:00". PD Soros closes 2 PM ET and that moves the answer. */
  timeOfDay?: string;
  /** IANA zone. Oxford deadlines are Europe/London: a 5h shift can move the DAY. */
  timeZone: string;
  precision: DeadlinePrecision;
  /**
   * The cycle keyed by the year the AWARD starts, not the year the page was
   * written. This is what makes a refreshed cycle a NEW item at the same URL.
   */
  cycleYear: number;
  cycleYearConfident: boolean;
  /** Date by which a human must re-confirm. Crossing it is an event, not a warning. */
  verifyBy?: string;
  /** Verbatim span the date came from, when there is one. Never paraphrased. */
  evidence?: string;
  provenance: DateProvenance;
}

/**
 * A step is a dated obligation inside one application. Rhodes is the reason this
 * type exists: the Harvard endorsement deadline PRECEDES the national one by
 * weeks, missing it ends the application regardless of the October date, and it
 * is published on a host that returns 403 to everything. The T-minus ladder runs
 * off the earliest UNMET gating step, never off the headline deadline.
 */
export interface OpportunityStep {
  id: string;
  label: string;
  /** YYYY-MM-DD. */
  due?: string;
  timeOfDay?: string;
  /** Step id that must complete first. */
  precondition?: string;
  /** "avature" | "amcas" | "embark" | … — which portal, since they differ. */
  system?: string;
  /** Missing this one ends the application. Drives the ladder and the subject line. */
  gating: boolean;
  status: "pending" | "done" | "missed";
  note?: string;
}

export type OpportunityStatus =
  | "active"
  | "watch"
  | "ruled-out"
  | "closed"
  | "submitted"
  | "won";

export interface Eligibility {
  /** Prose, shown verbatim. The system NEVER computes eligibility. */
  notes?: string;
  degreeStage?: string[];
  citizenship?: string[];
  source?: string;
}

export interface RuledOut {
  reason: string;
  citation?: string;
}

export interface OpportunityFacts {
  programId: string;
  label: string;
  org?: string;
  status: OpportunityStatus;
  /** `high` pins the item regardless of `keepThreshold`. */
  priority: "high" | "normal";
  deadline: Deadline;
  steps: OpportunityStep[];
  /** Index into `steps` of the next step whose precondition is satisfied. -1 if none. */
  nextStepIndex: number;
  /** The date the ladder actually runs off: earliest unmet gating step, else `deadline`. */
  effectiveDate?: string;
  eligibility?: Eligibility;
  ruledOut?: RuledOut;
  /** Set when a fetched page disagrees with the YAML. NEVER overwrites it. */
  discrepancy?: { field: string; yaml: string; page: string; evidence: string; url: string };
  /** True when a human needs to look. Drives the Verify block. */
  needsVerification: boolean;
  verifyReason?: string;
  url?: string;
  verifiedOn?: string;
}

/* --------------------------------- scoring -------------------------------- */

export interface ScoreFactor {
  /**
   * Stable key: `deadlineUrgency`, `lexicon`, `event.cycle-opened`, `lane.fellowships`.
   *
   * INVARIANT, asserted in CI: no key may start with `llm` or `claude`. The model
   * never contributes a point. That assertion is the machine-checkable statement
   * of this project's whole design.
   */
  key: string;
  label: string;
  raw: number;
  weight: number;
  /** Signed points contributed. */
  contribution: number;
  evidence?: string[];
}

export interface ScoreBreakdown {
  total: number;
  factors: ScoreFactor[];
  penalties: ScoreFactor[];
  laneScores: Partial<Record<Lane, number>>;
  /** Hash of weights.json. Golden tests pin it so a weight edit fails loudly. */
  weightsVersion: string;
}

/* ---------------------------------- items --------------------------------- */

export type ItemKind = "news" | "opportunity";

export type BodyProvenance =
  | "content:encoded"
  | "description"
  | "scraped"
  | "abstract"
  | "api"
  | "dek"
  | "yaml"
  | "none";

export type SourceKind =
  | "news"
  | "journal"
  | "preprint"
  | "jobs"
  | "grants"
  | "forum"
  | "conference"
  | "registry";

export type OpportunityEvent =
  | "deadline-imminent"
  | "cycle-opened"
  | "verify-deadline"
  | "step-due"
  | "eligibility-changed"
  | "new-program"
  | "page-changed"
  | "role-posted"
  | "cohort-announced"
  | "deadline-passed";

export type NewsEvent =
  | "major-journal-primary"
  | "preprint"
  | "financing"
  | "ma"
  | "approval"
  | "readout"
  | "personnel"
  | "opinion";

export type EventType = OpportunityEvent | NewsEvent;

export const EVENT_LABELS: Record<EventType, string> = {
  "deadline-imminent": "Closing soon",
  "cycle-opened": "Cycle opened",
  "verify-deadline": "Confirm this year's date",
  "step-due": "Step due",
  "eligibility-changed": "Eligibility changed",
  "new-program": "New program",
  "page-changed": "Page changed",
  "role-posted": "Role posted",
  "cohort-announced": "Cohort announced",
  "deadline-passed": "Closed",
  "major-journal-primary": "Major-journal paper",
  preprint: "Preprint",
  financing: "Financing",
  ma: "M&A",
  approval: "Regulatory approval",
  readout: "Trial readout",
  personnel: "Move / appointment",
  opinion: "Opinion / roundup",
};

/** Fields every item has, whatever its kind. score/, cluster/ and state/ are kind-blind. */
export interface ItemCore {
  id: string;
  clusterId: string;
  title: string;
  url: string;
  canonicalUrl: string;
  sourceId: string;
  sourceName: string;
  publisherGroup: string;
  sourceKind: SourceKind;
  /**
   * When the PAGE was published or updated. For an opportunity this is metadata
   * and NOT a quality signal — a Rhodes page last edited in March is not stale
   * in September. See isStale().
   */
  publishedAt?: string;
  datePrecision: "second" | "minute" | "day" | "unknown";
  /** First run that saw this id. Prevents fake freshness and drives `isNew`. */
  firstSeenAt: string;
  isNew: boolean;
  bodyProvenance: BodyProvenance;
  lanes: Partial<Record<Lane, number>>;
  primaryLane: Lane;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  watchHits: string[];
}

export interface NewsItem extends ItemCore {
  kind: "news";
  /** 1-3 sentences in document order. Extractive. Never fabricated. */
  digest: string[];
  digestSource: "extractive" | "abstract" | "dek";
  eventTypes: NewsEvent[];
  paywalled: boolean;
}

export interface OpportunityItem extends ItemCore {
  kind: "opportunity";
  /**
   * NON-optional, and that is the whole argument for the union. Were this
   * optional on one flat type, scoreItem() would branch on `deadline !== undefined`
   * and the first opportunity whose date failed to resolve would fall through to
   * the news recency path and get buried for being eight months old — a plausible
   * digest with Rhodes silently missing from it.
   */
  opportunity: OpportunityFacts;
  eventTypes: OpportunityEvent[];
  /** Whole days until `effectiveDate`. Negative once passed. Undefined if undated. */
  daysUntil?: number;
  /** The ladder rung this card was emitted for. Undefined for continuous items. */
  rung?: number;
}

export type DigestItem = NewsItem | OpportunityItem;

export function isOpportunity(item: DigestItem): item is OpportunityItem {
  return item.kind === "opportunity";
}

export function isNews(item: DigestItem): item is NewsItem {
  return item.kind === "news";
}

/* --------------------------- countdown & digest --------------------------- */

/**
 * One row of the always-on strip. Rendered EVERY day for everything inside the
 * horizon, independent of the rung ladder, and it is the last thing shed when
 * the email is trimmed to fit under Gmail's clip. Cards are episodic; the strip
 * is continuity.
 */
export interface CountdownRow {
  programId: string;
  label: string;
  /** What the countdown is actually to — may be a gating step, not the deadline. */
  target: string;
  date: string;
  daysUntil: number;
  kind: DeadlineKind;
  precision: DeadlinePrecision;
  gating: boolean;
  /** Rendered as "1 Oct 2026, 23:59 BST (18:59 ET)". */
  displayWhen: string;
  needsVerification: boolean;
  url?: string;
}

export interface VerifyRow {
  programId: string;
  label: string;
  reason: string;
  /** Days since `verifiedOn`, when known. */
  staleDays?: number;
  url?: string;
}

export type SourceStatus = "ok" | "not-modified" | "degraded" | "failed";

export interface SourceHealth {
  sourceId: string;
  sourceName: string;
  status: SourceStatus;
  httpStatus?: number;
  error?: string;
  itemsParsed: number;
  itemsKept: number;
  parseWarnings: string[];
  latencyMs: number;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  /** A source marked optional cannot make a run unusable. */
  optional: boolean;
}

export type DropReason =
  | "no-title"
  | "no-url"
  | "too-old"
  | "duplicate"
  | "below-threshold"
  | "no-date"
  | "deadline-passed"
  | "ruled-out"
  | "eligibility-mismatch"
  | "not-yet-watched"
  | "no-rung"
  | "rolling-cooldown"
  | "over-cap";

/**
 * A dated regulatory event.
 *
 * Note what this is NOT: a price. Every keyless quote source turned out to be
 * unusable — Yahoo 429s even from residential IPs, Stooq answers 200 with a
 * SHA-256 proof-of-work challenge, Alpha Vantage allows 25 requests a DAY, and
 * Tiingo's free tier is licensed "internal use only" so emailing the numbers
 * anywhere would breach it. The two that work need API keys.
 *
 * That turned out not to matter, because the prices were the part with no
 * value. A daily percentage move is not something a student can act on, and it
 * is the one number in the digest that is embarrassing when wrong and worthless
 * when right. The DATES are the signal — and a PDUFA date is the same object as
 * a fellowship deadline: a dated thing you can prepare for. So catalysts run
 * through the same countdown machinery as everything else in the tracker,
 * rather than sitting in a price table nobody acts on.
 */
export interface Catalyst {
  /** YYYY-MM-DD. */
  date: string;
  ticker?: string;
  company?: string;
  label: string;
  kind: "pdufa" | "adcomm";
  /** Which feed it came from, for provenance in the email. */
  source: string;
  /** Whole days until the date, at build time. */
  daysUntil: number;
  /** True when the ticker is on the watchlist rather than merely in the feed. */
  watched: boolean;
}

export interface MarketSection {
  /** The date the catalysts were computed against. */
  asOf: string;
  catalysts: Catalyst[];
  /** Its own health. A catalyst outage must never make a run unusable. */
  health: SourceHealth[];
}

export interface DailyDigest {
  schemaVersion: 1;
  date: string;
  runId?: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  health: SourceHealth[];
  /** Keyed by id. An item is stored once, never duplicated across lanes. */
  items: Record<string, DigestItem>;
  lanes: { id: Lane; label: string; blurb: string; itemIds: string[] }[];
  /** Continuous. Never shed. */
  countdown: CountdownRow[];
  verify: VerifyRow[];
  markets?: MarketSection;
  /** Model-written, optional, and rendered LAST so it can never displace a date. */
  editorial?: string;
  stats: {
    fetched: number;
    kept: number;
    deadlinesTracked: number;
    verifiedLast7d: number;
    medianScore: number;
    dropped: Partial<Record<DropReason, number>>;
  };
  emailedAt?: string;
}

export interface RunStatus {
  runId?: string;
  startedAt: string;
  finishedAt: string;
  outcome: "ok" | "unusable" | "error";
  message?: string;
  date?: string;
  sourcesOk: number;
  sourcesTotal: number;
  itemsKept: number;
  deadlinesTracked: number;
}
