/**
 * Substantive outline — filtering statutory boilerplate out of a document's structure.
 *
 * The design constraint is generality: FERC calls its substantive section "Proposed
 * Reforms" in one NOPR and "Regional Transmission Planning" in another, so matching on
 * titles would work on the first and fail on the second. These tests exist to keep the
 * filter defined by what is *the same* across rulemakings, not by what a particular one
 * happens to be called.
 */

import { describe, expect, it } from "vitest";

import { isAdministrative, substantiveOutline } from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

describe("administrative sections are recognised generically", () => {
  it.each([
    "Table of Contents",
    "IV. Information Collection Statement",
    "XI. Information Collection Statement",
    "V. Environmental Analysis",
    "VI. Regulatory Flexibility Act",
    "XIV. Comment Procedures",
    "VIII. Document Availability",
    "III. Proposed Compliance Procedures",
  ])("%s is administrative", (title) => {
    expect(isAdministrative(title)).toBe(true);
  });

  it.each([
    "II. Proposed Reforms",
    "IV. Regional Transmission Planning",
    "IV. Consideration of Potential Reforms and Request for Comment",
    "VII. Exercise of a Federal Right of First Refusal",
  ])("%s is substantive", (title) => {
    expect(isAdministrative(title)).toBe(false);
  });

  it("matches regardless of the numeral position", () => {
    // "Information Collection Statement" is section IV in one document and XI in another.
    expect(isAdministrative("IV. Information Collection Statement")).toBe(
      isAdministrative("XI. Information Collection Statement"),
    );
  });
});

describe("the outline generalises across documents", () => {
  it("keeps the substantive sections of a NOPR and drops the boilerplate", async () => {
    const d = await doc(DOCS.nopr2214);
    const outline = substantiveOutline(d);
    const titles = outline.map((o) => o.title);

    expect(titles.some((t) => /Proposed Reforms/i.test(t))).toBe(true);
    expect(titles.some((t) => /Table of Contents/i.test(t))).toBe(false);
    expect(titles.some((t) => /Information Collection/i.test(t))).toBe(false);
    expect(titles.some((t) => /Regulatory Flexibility/i.test(t))).toBe(false);
  });

  it("keeps every substantive section when a NOPR has several", async () => {
    // RM21-17's NOPR proposes across six topics. Showing only the largest would lose
    // most of what it proposes — which is why the filter excludes boilerplate rather
    // than selecting a single winner.
    const d = await doc(DOCS.nopr2117);
    const outline = substantiveOutline(d);
    expect(outline.length).toBeGreaterThan(4);
    expect(outline.filter((o) => o.primary)).toHaveLength(1);
  });

  it("marks exactly one section primary, and it is the largest", async () => {
    const d = await doc(DOCS.nopr2214);
    const outline = substantiveOutline(d);
    const primary = outline.filter((o) => o.primary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.size).toBe(Math.max(...outline.map((o) => o.size)));
  });

  it("excludes separate opinions appended after the body", async () => {
    // Commissioner concurrences sit under agency-name headings and are large enough to
    // survive a size floor. The boundary reuses the paragraph-numbering reset that
    // invariant I3 already depends on, rather than matching those headings.
    const d = await doc(DOCS.order2023A);
    expect(d.paragraphs.some((p) => p.isSeparateOpinion)).toBe(true);
    const titles = substantiveOutline(d).map((o) => o.title);
    expect(titles.some((t) => /^Federal Energy Regulatory Commission$/i.test(t))).toBe(false);
    expect(titles.some((t) => /^Department of Energy$/i.test(t))).toBe(false);
  });

  it("carries direct subsections for context", async () => {
    const d = await doc(DOCS.nopr2214);
    const proposed = substantiveOutline(d).find((o) => /Proposed Reforms/i.test(o.title));
    expect(proposed!.children.length).toBeGreaterThan(0);
    expect(proposed!.children.some((c) => /First-Ready, First-Served/i.test(c.title))).toBe(true);
  });

  it("works on final rules too, not only proposals", async () => {
    const d = await doc(DOCS.order1920);
    const outline = substantiveOutline(d);
    expect(outline.length).toBeGreaterThan(3);
    expect(outline.every((o) => !isAdministrative(o.title))).toBe(true);
  });
});
