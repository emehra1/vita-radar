/**
 * The boilerplate stripper, tested against the real text that motivated it.
 *
 * Every NewLimit posting opens with the same company blurb, so on the first live
 * run an Executive Assistant role scored as causal-genetics research on
 * "healthspan", "reprogramming", "functional genomics" and "perturbation
 * screening". The words were right; they were just the company's words rather
 * than the job's.
 */

import { describe, expect, it } from "vitest";

import { findBoilerplate, stripBoilerplate, stripSourceBoilerplate } from "../pipeline/digest/boilerplate.ts";

const BLURB =
  "NewLimit is a biotechnology company working to radically extend human healthspan. " +
  "We are developing medicines to treat age-related diseases by reprogramming the epigenome. " +
  "We leverage functional genomics, pooled perturbation screening, and machine learning models.";

const postings = [
  `${BLURB} We are hiring an Executive Assistant to support the leadership team with scheduling.`,
  `${BLURB} We are hiring an Executive Recruiter to build out our technical hiring pipeline.`,
  `${BLURB} We are hiring a Laboratory Operations Specialist to manage reagent inventory.`,
  `${BLURB} We seek a Computational Biologist to analyse perturb-seq screens at single-cell resolution.`,
];

describe("findBoilerplate", () => {
  it("finds the sentences every posting shares", () => {
    const boiler = findBoilerplate(postings);
    expect(boiler.size).toBeGreaterThanOrEqual(3);
  });

  it("says nothing with too few items to generalise from", () => {
    // Two documents that happen to share a sentence are not evidence of boilerplate.
    expect(findBoilerplate([postings[0]!, postings[1]!]).size).toBe(0);
  });

  it("leaves a sentence unique to one item alone", () => {
    const boiler = findBoilerplate(postings);
    const stripped = stripBoilerplate(postings[3]!, boiler);
    expect(stripped).toMatch(/perturb-seq/);
    expect(stripped).not.toMatch(/radically extend human healthspan/);
  });
});

describe("stripSourceBoilerplate", () => {
  const items = postings.map((bodyText, i) => ({ sourceId: "gh-newlimit", bodyText, i }));

  it("removes the company blurb from every posting at once", () => {
    const { stripped } = stripSourceBoilerplate(items);
    for (const body of stripped) {
      expect(body).not.toMatch(/functional genomics, pooled perturbation screening/);
    }
  });

  /**
   * The regression, stated as the outcome that matters: after stripping, an
   * administrative role retains none of the lexicon's high-signal terms, while a
   * genuinely relevant role retains its own.
   */
  it("leaves an admin role with no high-signal terms and a research role with its own", () => {
    const { stripped } = stripSourceBoilerplate(items);
    const admin = stripped[0]!.toLowerCase();
    const research = stripped[3]!.toLowerCase();

    for (const term of ["healthspan", "reprogramming", "functional genomics", "perturbation screening"]) {
      expect(admin).not.toContain(term);
    }
    expect(research).toContain("perturb-seq");
    expect(research).toContain("single-cell");
  });

  it("keeps sources independent — one company's blurb is not stripped from another's", () => {
    const mixed = [
      ...items,
      { sourceId: "gh-other", bodyText: `${BLURB} A totally different employer that happens to reuse this text.`, i: 9 },
    ];
    const { stripped } = stripSourceBoilerplate(mixed);
    // The lone item from gh-other has no siblings, so nothing is stripped from it.
    expect(stripped[stripped.length - 1]).toMatch(/radically extend human healthspan/);
  });

  it("returns bodies in input order", () => {
    const { stripped } = stripSourceBoilerplate(items);
    expect(stripped).toHaveLength(items.length);
    expect(stripped[3]).toMatch(/Computational Biologist/);
  });
});
