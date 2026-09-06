/**
 * Weighted term lists, one per news lane.
 *
 * The job here is NARROWING, not coverage. `biotech-insights` already delivers
 * broad industry news every morning; if this digest repeats it, both get skimmed.
 * So these lexicons are deliberately tight around causal human genetics,
 * single-cell epigenomics, and the tools/venture angle — the places where an
 * item is worth reading twice.
 *
 * Matching rules, carried over from the sibling because they were learned the
 * hard way:
 *   · whole words only, so "MR" does not fire on "MRI" and "TAPS" not on "taps"
 *   · a title hit counts double — a term in the headline is what the piece is
 *     ABOUT, a term in paragraph nine is a mention
 *   · repeated terms saturate as 1 + ln(count), so one word said twenty times
 *     cannot outscore three different concepts
 *   · the body is scored on its first 1200 characters, so a long paper does not
 *     out-score a short one purely by being long
 */

import type { Lane } from "../../lib/types.ts";

export interface LexTerm {
  term: string;
  weight: number;
}

/**
 * Terms shorter than this are skipped unless listed in ACRONYMS. "MR" and "eQTL"
 * are real signals; a bare 3-letter string usually is not.
 */
export const MIN_TERM_LENGTH = 4;

/** Short, case-SENSITIVE tokens. Matched with word boundaries and exact case. */
export const ACRONYMS: LexTerm[] = [
  { term: "GWAS", weight: 3 },
  { term: "MR", weight: 1.5 },
  { term: "QTL", weight: 2 },
  { term: "eQTL", weight: 3 },
  { term: "pQTL", weight: 3 },
  { term: "sQTL", weight: 2.5 },
  { term: "PRS", weight: 2 },
  { term: "PheWAS", weight: 3 },
  { term: "TWAS", weight: 3 },
  { term: "ATAC", weight: 3 },
  { term: "TAPS", weight: 3 },
  { term: "WGBS", weight: 2.5 },
  { term: "scRNA", weight: 2 },
  { term: "CUT&RUN", weight: 2 },
  { term: "CRISPRi", weight: 2.5 },
  { term: "CRISPRa", weight: 2.5 },
  { term: "UKB", weight: 2 },
  { term: "LDSC", weight: 2.5 },
];

export const LEXICONS: Record<Lane, LexTerm[]> = {
  /* Dated obligations never come from a feed; this lane is registry-only. */
  deadlines: [],

  fellowships: [
    { term: "fellowship", weight: 2 },
    { term: "scholarship", weight: 2 },
    { term: "scholars program", weight: 2.5 },
    { term: "call for applications", weight: 3 },
    { term: "applications are open", weight: 3 },
    { term: "applications open", weight: 3 },
    { term: "now accepting applications", weight: 3 },
    { term: "cohort", weight: 1.5 },
    { term: "stipend", weight: 2 },
    { term: "rhodes", weight: 2.5 },
    { term: "marshall scholarship", weight: 2.5 },
    { term: "gates cambridge", weight: 3 },
    { term: "knight-hennessy", weight: 3 },
    { term: "hertz", weight: 2.5 },
    { term: "soros", weight: 2.5 },
    { term: "schmidt science", weight: 2.5 },
    { term: "gilliam", weight: 2.5 },
  ],

  "mstp-labs": [
    { term: "md/phd", weight: 3 },
    { term: "md-phd", weight: 3 },
    { term: "medical scientist training", weight: 3 },
    { term: "physician scientist", weight: 2.5 },
    { term: "physician-scientist", weight: 2.5 },
    { term: "mstp", weight: 3 },
    { term: "amcas", weight: 2.5 },
    { term: "post-baccalaureate", weight: 2 },
    { term: "postbac", weight: 2 },
    { term: "kirschstein", weight: 2.5 },
    { term: "f30", weight: 3 },
    { term: "t32", weight: 2 },
  ],

  "venture-founder": [
    { term: "entrepreneur in residence", weight: 3 },
    { term: "founder in residence", weight: 3.5 },
    { term: "scientific co-founder", weight: 3.5 },
    { term: "scientific cofounder", weight: 3.5 },
    { term: "company creation", weight: 2.5 },
    { term: "venture fellow", weight: 3 },
    { term: "seed round", weight: 1.5 },
    { term: "series a", weight: 1.5 },
    { term: "spinout", weight: 2 },
    { term: "incubator", weight: 1.5 },
    { term: "accelerator", weight: 1.5 },
    { term: "focused research organization", weight: 3 },
    { term: "nucleate", weight: 2.5 },
    { term: "flagship pioneering", weight: 2.5 },
    { term: "third rock", weight: 2 },
    { term: "atlas venture", weight: 2 },
    { term: "arch venture", weight: 2 },
    { term: "convergent research", weight: 3 },
    { term: "translational", weight: 1 },
  ],

  /* Registry-only, same as `deadlines`. */
  conferences: [],

  "causal-genetics": [
    { term: "mendelian randomization", weight: 4 },
    { term: "mendelian randomisation", weight: 4 },
    { term: "causal inference", weight: 3 },
    { term: "causal variant", weight: 3.5 },
    { term: "genome-wide association", weight: 3.5 },
    { term: "fine-mapping", weight: 3.5 },
    { term: "fine mapping", weight: 3 },
    { term: "colocalization", weight: 3.5 },
    { term: "colocalisation", weight: 3.5 },
    { term: "burden test", weight: 3 },
    { term: "rare variant", weight: 2.5 },
    { term: "polygenic", weight: 2.5 },
    { term: "heritability", weight: 2 },
    { term: "target discovery", weight: 3.5 },
    { term: "target identification", weight: 3 },
    { term: "genetic evidence", weight: 3 },
    { term: "human genetics", weight: 2.5 },
    { term: "biobank", weight: 2.5 },
    { term: "exome", weight: 2 },
    { term: "perturbation screen", weight: 3.5 },
    { term: "perturb-seq", weight: 3.5 },
    { term: "crispr screen", weight: 3 },
    { term: "functional genomics", weight: 3 },
    { term: "single-cell", weight: 2.5 },
    { term: "single cell", weight: 2 },
    { term: "spatial transcriptomics", weight: 2.5 },
    { term: "epigenom", weight: 3 },
    { term: "epigenetic editing", weight: 4 },
    { term: "epigenetic clock", weight: 3.5 },
    { term: "dna methylation", weight: 3.5 },
    { term: "methylome", weight: 3 },
    { term: "bisulfite", weight: 3 },
    { term: "chromatin", weight: 2.5 },
    { term: "chromatin accessibility", weight: 3 },
    { term: "3d genome", weight: 2.5 },
    { term: "enhancer", weight: 2 },
    { term: "regulatory element", weight: 2.5 },
    { term: "transcription factor", weight: 2 },
    { term: "reprogramming", weight: 3 },
    { term: "partial reprogramming", weight: 3.5 },
    { term: "yamanaka", weight: 3 },
    { term: "biomarkers of aging", weight: 3.5 },
    { term: "biological age", weight: 3 },
    { term: "healthspan", weight: 2.5 },
    { term: "senescence", weight: 2 },
    { term: "longevity", weight: 2 },
    { term: "aging", weight: 1.5 },
  ],

  "tools-platforms": [
    { term: "sequencing platform", weight: 3 },
    { term: "long-read", weight: 2.5 },
    { term: "nanopore", weight: 2.5 },
    { term: "illumina", weight: 2 },
    { term: "10x genomics", weight: 3 },
    { term: "pacific biosciences", weight: 2.5 },
    { term: "spatial platform", weight: 2.5 },
    { term: "consumable", weight: 2 },
    { term: "instrument", weight: 1.5 },
    { term: "assay", weight: 1.5 },
    { term: "throughput", weight: 1.5 },
    { term: "gross margin", weight: 2 },
    { term: "pull-through", weight: 2.5 },
    { term: "razor", weight: 1.5 },
    { term: "diagnostics", weight: 1.5 },
    { term: "laboratory developed test", weight: 2.5 },
    { term: "reimbursement", weight: 2 },
    { term: "tech transfer", weight: 2.5 },
    { term: "licensing deal", weight: 2 },
    { term: "royalty", weight: 2 },
  ],
};

/**
 * Terms that are a hard veto, applied BEFORE scoring.
 *
 * A gate is cheaper than a penalty and, more importantly, it cannot be
 * out-voted: the sibling's `offTopic` penalty existed because an authoritative
 * source could carry a Nature Futures short story or an astrophysics item into a
 * biotech digest on authority alone.
 */
export const VETO_PATTERNS: RegExp[] = [
  /\bcorrection\b|\berratum\b|\bretraction\b/i,
  /\bbook review\b|\bobituary\b|\bcorrespondence\b/i,
  /\bnature futures\b|\bscience fiction\b/i,
  /\bjob alert digest\b/i,
  /\bwebinar recording\b/i,
];
