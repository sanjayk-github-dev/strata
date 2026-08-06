/**
 * Phase 5 gates — rule-tier materiality (docs/TDD.md §8 Phase 5).
 *
 * The rule tier must be *certain*, not merely usually right. Tests therefore assert both
 * that rules fire on their cases and that they decline everything else, leaving it for
 * the model tier rather than guessing.
 */

import { describe, expect, it } from "vitest";

import {
  buildDocument,
  classifyEdits,
  classifyGroup,
  extractRedline,
  groupAdjacentEdits,
  reconstruct,
  type DocumentMeta,
  type ParsedDocument,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

const META: DocumentMeta = {
  frDocNumber: "9999-00001",
  docketIds: ["RM99-1"],
  agency: "FEDERAL ENERGY REGULATORY COMMISSION",
  agencies: ["Federal Energy Regulatory Commission"],
  title: "Synthetic",
  publicationDate: "2026-01-01",
  type: "Rule",
  action: "Order on rehearing and clarification.",
  status: "amended",
  pageLength: 1,
  htmlUrl: "",
  xmlUrl: "",
};

/** Build a minimal FERC document whose appendix declares the redline convention. */
function synthetic(body: string): ParsedDocument {
  return buildDocument(
    META,
    `<RULE><PREAMB><AGENCY>FERC</AGENCY></PREAMB><SUPLINF>` +
      `<HD SOURCE="HD1">Appendix C: Changes to the Pro Forma LGIP</HD>` +
      `<NOTE><P>Deletions are in brackets and additions are in italics.</P></NOTE>` +
      `<P>${body}</P></SUPLINF></RULE>`,
  );
}

function classifyOne(body: string) {
  const d = synthetic(body);
  const edits = extractRedline(d).edits;
  const groups = groupAdjacentEdits(d, edits);
  expect(groups.length).toBeGreaterThan(0);
  return { d, group: groups[0]!, result: classifyGroup(d, groups[0]!) };
}

describe("before/after reconstruction", () => {
  it("deletions appear only in before, additions only in after", () => {
    const { d, group } = classifyOne('The fee is a[n] <E T="03">non-refundable</E> charge.');
    const { before, after } = reconstruct(d, group);
    expect(before).toContain("n");
    expect(before).not.toContain("non-refundable");
    expect(after).toContain("non-refundable");
  });

  it("unchanged context appears in both", () => {
    const { d, group } = classifyOne('Customer [shall] <E T="03">may</E> submit.');
    const { before, after } = reconstruct(d, group);
    expect(before).toContain("shall");
    expect(after).toContain("may");
    expect(before).not.toContain("may");
    expect(after).not.toContain("shall");
  });
});

describe("editorial rules — equivalence tests", () => {
  it("case-only change", () => {
    // "Service [A]allows" → the pair is a capitalisation fix with no legal effect.
    const { result } = classifyOne('Service [A]<E T="03">a</E>llows the Customer.');
    expect(result.materiality).toBe("editorial");
    expect(result.ruleId).toBe("case-only");
  });

  it("article-only change", () => {
    const { result } = classifyOne("Appendix C of [the] Interconnection Agreement.");
    expect(result.materiality).toBe("editorial");
    expect(result.ruleId).toBe("article-only");
  });

  it("typographic-convention italicisation", () => {
    const { result } = classifyOne('behaviour (<E T="03">i.e.,</E> charging at peak).');
    expect(result.materiality).toBe("editorial");
    expect(result.ruleId).toBe("typographic-convention");
  });

  it("cross-reference renumbering survives whitespace at the edit boundary", () => {
    // Regression. Marked up as "Section 9.[6] 7", reconstruction yields "Section 9.6"
    // and "Section 9. 7" — the space is XML layout between a deletion and its
    // replacement, not content. Without whitespace tolerance in the cross-reference
    // pattern the two sides mask differently and a pure renumbering is reported as a
    // material numeric change. This was the first card in the generated report.
    const { result } = classifyOne(
      'issued pursuant to Section 9.[6] <E T="03">7</E> of this LGIP.',
    );
    expect(result.materiality).toBe("editorial");
    expect(result.ruleId).toBe("cross-reference-renumber");
  });

  it("cross-reference renumbering is editorial, not a numeric change", () => {
    // This is the one place the numeric rule must NOT fire: the obligation pointed to is
    // unchanged, only its label moved.
    const { result } = classifyOne('as set out in section [3.4]<E T="03">3.5</E> herein.');
    expect(result.materiality).toBe("editorial");
    expect(result.ruleId).toBe("cross-reference-renumber");
  });
});

describe("material rules — narrow and certain", () => {
  it("negation added", () => {
    const { result } = classifyOne('a[n] <E T="03">non-refundable</E> application fee.');
    expect(result.materiality).toBe("material");
    expect(result.ruleId).toBe("negation-change");
  });

  it("modal verb changed — obligation vs permission", () => {
    const { result } = classifyOne('Customer [shall] <E T="03">may</E> submit the request.');
    expect(result.materiality).toBe("material");
    expect(result.ruleId).toBe("modal-change");
  });

  it("numeric threshold changed", () => {
    const { result } = classifyOne("for Interconnection Requests [&#8805; 20 MW] &lt; 80 MW.");
    expect(result.materiality).toBe("material");
    expect(result.ruleId).toBe("numeric-change");
  });

  it("currency amount changed", () => {
    const { result } = classifyOne('a fee of [$5,000]<E T="03">$10,000</E> payable.');
    expect(result.materiality).toBe("material");
    expect(result.ruleId).toBe("numeric-change");
  });

  it("restating a number in words is NOT a numeric change", () => {
    // Regression. Legal drafting states the same number twice — "within ten (10)
    // Business Days". Adding the word form beside an existing digit changes the
    // drafting, not the deadline. Comparing surface forms reported this as material in
    // the generated report; comparing values does not.
    const { result } = classifyOne('or within <E T="03">ten</E> (10) Business Days of filing.');
    expect(result.materiality).not.toBe("material");
  });

  it("spelled-out numbers count as numeric changes", () => {
    // Found by measuring real output: "" → "ten" and "" → "fifteen" were landing in
    // undecided purely because the digit regex could not see them, though they are
    // exactly as material as 10 → 15.
    const { result } = classifyOne('within [ten]<E T="03">fifteen</E> Business Days.');
    expect(result.materiality).toBe("material");
    expect(result.ruleId).toBe("numeric-change");
  });
});

describe("the rule tier declines rather than guesses", () => {
  it("leaves a substantive wording change undecided", () => {
    // No negation, no modal, no number: genuinely a judgement call, so it goes to the
    // model tier rather than being labelled with false confidence.
    const { result } = classifyOne('the [Interconnection]<E T="03">Transmission</E> Study.');
    expect(result.materiality).toBe("undecided");
    expect(result.ruleId).toBe("none");
  });

  it("a defined-term change is left undecided by design", () => {
    // "days" → "Business Days" is material in principle, but the general rule fires on
    // ambiguous renamings too, so it is deferred to the model tier deliberately.
    const { result } = classifyOne('within ten [d]<E T="03">Business D</E>ays.');
    expect(result.materiality).toBe("undecided");
  });
});

describe("manifest fixtures classify correctly on the real document", () => {
  it("2 material fixtures → material", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);

    for (const text of ["non-refundable", "≥ 20 MW"]) {
      const g = m.groups.find((x) => x.group.edits.some((e) => e.text.trim() === text));
      expect(g, `fixture ${text} not found`).toBeDefined();
      expect(g!.result.materiality).toBe("material");
    }
  });

  it("editorial fixtures → editorial", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);

    const italic = m.groups.find((x) =>
      x.group.edits.some((e) => e.kind === "addition" && e.text.trim() === "i.e.,"),
    );
    expect(italic!.result.materiality).toBe("editorial");
    expect(italic!.result.ruleId).toBe("typographic-convention");

    // Bare "[the]" deletions are the single largest editorial class.
    const article = m.groups.find(
      (x) =>
        x.group.edits.length === 1 &&
        x.group.edits[0]!.kind === "deletion" &&
        x.group.edits[0]!.text.trim() === "the",
    );
    expect(article!.result.materiality).toBe("editorial");
    expect(article!.result.ruleId).toBe("article-only");
  });
});

describe("invariant I1 — conservation", () => {
  it.each([DOCS.order2023A, DOCS.order2023])("%s: nothing is dropped", async (id) => {
    const d = await doc(id);
    const edits = extractRedline(d).edits;
    const m = classifyEdits(d, edits);
    const f = m.funnel;

    expect(f.material + f.clarifying + f.editorial + f.undecided).toBe(f.totalEdits);
    expect(f.totalEdits).toBe(edits.length);
    expect(m.edits).toHaveLength(edits.length);
  });

  it("grouping does not lose edits", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);
    const inGroups = m.groups.reduce((n, g) => n + g.group.edits.length, 0);
    expect(inGroups).toBe(m.funnel.totalEdits);
  });

  it("rule tally accounts for every group", async () => {
    const d = await doc(DOCS.order2023A);
    const f = classifyEdits(d, extractRedline(d).edits).funnel;
    expect(Object.values(f.byRule).reduce((a, b) => a + b, 0)).toBe(f.totalGroups);
  });
});

describe("decision provenance", () => {
  it("rule-decided edits carry decidedBy and ruleId", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);
    for (const e of m.edits.filter((x) => x.materiality !== "undecided")) {
      expect(e.decidedBy).toBe("rule");
      expect(e.ruleId).toBeDefined();
      expect(e.ruleId).not.toBe("none");
    }
  });

  it("undecided edits carry no decider — nothing decided them", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);
    for (const e of m.edits.filter((x) => x.materiality === "undecided")) {
      expect(e.decidedBy).toBeUndefined();
      expect(e.ruleId).toBeUndefined();
    }
  });
});

describe("rule coverage — measured, not assumed", () => {
  it("is reported and substantial, with a real remainder for the model tier", async () => {
    const d = await doc(DOCS.order2023A);
    const f = classifyEdits(d, extractRedline(d).edits).funnel;

    // Measured 75.1%. Asserted as a band: the point of this gate is that the number is
    // produced and stays in a sane range, not that it is frozen to a decimal.
    expect(f.ruleCoverage).toBeGreaterThan(0.6);
    expect(f.ruleCoverage).toBeLessThan(0.95);
    // A meaningful share genuinely needs judgement — this is what Phase 6 exists for.
    expect(f.undecided).toBeGreaterThan(100);
  });

  it("produces a funnel that reduces hundreds of edits to a reviewable few", async () => {
    const d = await doc(DOCS.order2023A);
    const f = classifyEdits(d, extractRedline(d).edits).funnel;
    expect(f.totalEdits).toBeGreaterThan(1000);
    // Material edits are a small fraction — the reduction that is the product.
    expect(f.material / f.totalEdits).toBeLessThan(0.2);
    expect(f.editorial).toBeGreaterThan(f.material);
  });

  it("a document with no redline yields an empty funnel, not an error", async () => {
    const d = await doc(DOCS.order1920);
    const f = classifyEdits(d, extractRedline(d).edits).funnel;
    expect(f.totalEdits).toBe(0);
    expect(f.ruleCoverage).toBe(0);
  });
});
