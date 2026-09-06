/**
 * The catalyst watchlist.
 *
 * The two FDA calendars carry ~1,800 events between them, 65 of which fall
 * inside the next year. Printing all 65 is the same as printing none: the
 * reader stops looking. This file is the filter that makes the catalyst block
 * worth reading, and it is a list of TICKERS rather than of companies because
 * the calendar's SUMMARY leads with a ticker and nothing else in it is stable —
 * the same company appears as "Merck & Co.\, Inc.", "MERCK & CO.\, INC." and
 * "MERCK" in three different rows of the same feed.
 *
 * Being on this list changes ordering and nothing else. An unwatched catalyst is
 * still parsed, still counted and still rendered if it fits the horizon; it just
 * sorts below every watched one. Nothing here can move a date, and a catalyst
 * cannot ring an alert at all — `canAlert()` requires `provenance: "yaml"`, and
 * a calendar somebody else maintains is not that.
 */

/**
 * Large pharma. Watched for approvals rather than for the companies themselves:
 * a PDUFA date at one of these is the readout that moves a whole therapeutic
 * area, and it is the kind of thing worth knowing before an interview.
 */
const LARGE_PHARMA = [
  "LLY", "NVO", "PFE", "MRK", "ABBV", "AZN", "NVS", "JNJ", "BMY", "GILD",
  "AMGN", "SNY", "GSK",
] as const;

/**
 * Genomics instruments, reagents and clinical testing — the `tools-platforms`
 * lane with a ticker attached. These rarely have PDUFA dates of their own; they
 * appear here because a diagnostic (GRAIL's Galleri, an Exact or Natera assay)
 * goes through an advisory committee, and because the sequencing-economics story
 * is the one this reader actually follows.
 *
 * "A" is Agilent, and it is the one entry the feed parser can never match: a
 * one-letter token at the head of a SUMMARY is indistinguishable from an initial
 * in a company name, so `extractTicker()` requires two characters. Kept in the
 * set anyway so the list stays a truthful statement of what is watched — the
 * cost is one row that sorts as unwatched, not a wrong row.
 */
const GENOMICS_TOOLS = [
  "ILMN", "TXG", "PACB", "TMO", "DHR", "A", "QGEN", "BRKR", "NTRA", "EXAS",
  "TEM", "GRAL",
] as const;

/**
 * Genetic medicine and causal-target companies — the `causal-genetics` lane.
 * These are the comparables: what an antisense or siRNA drug can get approved
 * for, and how far an editing company has actually got, is the evidence base for
 * every claim this reader would make in an application.
 */
const GENETIC_MEDICINE = [
  "VRTX", "ALNY", "IONS", "REGN", "BEAM", "NTLA", "VERV", "CRSP", "RXRX",
  "SDGR",
] as const;

/**
 * Aging-adjacent public companies. A short list on purpose: almost everything
 * interesting in longevity biotech is private (Altos, NewLimit, Retro), so the
 * public tape is a poor proxy for the field. These two are here because a
 * regulatory date at either is genuinely informative about whether an
 * aging-biology endpoint can clear the FDA at all.
 */
const AGING = ["BIOA", "UBX"] as const;

export const WATCHED_TICKERS: Set<string> = new Set<string>([
  ...LARGE_PHARMA,
  ...GENOMICS_TOOLS,
  ...GENETIC_MEDICINE,
  ...AGING,
]);

/**
 * Why a ticker is watched, for the handful where the reason is not obvious from
 * the name. Rendered next to a catalyst row when present, so a row reads as
 * "this is why you care" rather than as a stock symbol.
 *
 * Deliberately not exhaustive. A note for every ticker would be noise, and the
 * large-cap pharma names need no explanation.
 */
export const TICKER_NOTES: Record<string, string> = {
  GRAL: "GRAIL. The Illumina acquisition and forced divestiture is the canonical tools-company M&A-overreach case study, and liquid biopsy is the diagnostics-reimbursement story in miniature.",
  ILMN: "Sequencing incumbent; the price-per-genome curve runs through here",
  TXG: "10x Genomics — single-cell instrument economics, and the patent fights",
  PACB: "Long reads; the read-length-vs-cost trade the tools lane is about",
  NTRA: "Cell-free DNA testing at scale — the clinical end of the tools story",
  EXAS: "Screening assays; the reimbursement precedent GRAIL is chasing",
  TEM: "Tempus — multimodal clinical-genomic data as the product",
  ALNY: "siRNA, approved and commercial. The proof a genetic modality ships",
  IONS: "Antisense comparable; the longest track record of dosing a transcript",
  VRTX: "CFTR is the causal-target argument's best worked example",
  BEAM: "Base editing — in-human data is the field's near-term evidence",
  NTLA: "In vivo CRISPR; the delivery question decided in public",
  VERV: "Base editing a common-disease target (PCSK9), not a rare one",
  CRSP: "Casgevy is the first approved CRISPR medicine; its uptake is the signal",
  RXRX: "Recursion — phenomics-to-clinic, the tools-to-drugs bet",
  SDGR: "Schrodinger — physics-based design held to the same clinical bar",
  BIOA: "BioAge — an aging-biology endpoint actually in the clinic",
  UBX: "Unity — senolytics, and the cautionary readouts that go with them",
};
