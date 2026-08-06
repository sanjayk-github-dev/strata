/**
 * Phase 4 gates — redline extraction (docs/TDD.md §8 Phase 4).
 *
 * The named risk for this phase is silent misparsing. Most of these tests assert what
 * the parser must NOT do.
 */

import { describe, expect, it } from "vitest";

import {
  extractRedline,
  findRedlineRegion,
  groupAdjacentEdits,
  verifyCitation,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

/** Measured baselines. Drift here means the parser changed behaviour. */
const BASELINES = {
  [DOCS.order2023A]: { edits: 1431, additions: 502, deletions: 929 },
  [DOCS.order2023]: { edits: 1715, additions: 1225, deletions: 490 },
} as const;

const NO_REDLINE = [DOCS.order1920, DOCS.order1920A, DOCS.order1920B, DOCS.nopr2214, DOCS.nopr2117];

describe("the precondition is enforced — never a wrong parse", () => {
  it.each(NO_REDLINE)("%s yields zero edits and says why", async (frDocNumber) => {
    const d = await doc(frDocNumber);
    const r = extractRedline(d);
    expect(r.edits).toEqual([]);
    expect(r.region).toBeNull();
    expect(r.unavailableReason).toMatch(/does not declare a redline convention/i);
  });

  it("Order No. 1920 yields zero edits despite thousands of italic tags", async () => {
    // The single most important assertion in this phase. Order No. 1920 carries
    // thousands of <E T="03"> tags and no legend. Treating them as additions would
    // fabricate thousands of regulatory changes, each with a citation, inside a product
    // whose premise is verifiability.
    const d = await doc(DOCS.order1920);
    expect(d.markup.italics.length).toBeGreaterThan(2000);
    expect(extractRedline(d).edits).toHaveLength(0);
  });

  it("brackets in a no-legend document are not treated as deletions", async () => {
    // Order No. 1920's preamble contains bracket pairs that look exactly like redline
    // deletions — "[p]", "[s]", "[processes]" — because FERC quotes marked-up tariff
    // text inside its reasoning. Without a legend, none of them are edits.
    const d = await doc(DOCS.order1920);
    expect(d.text).toMatch(/\[[a-z]\]/);
    expect(extractRedline(d).edits).toHaveLength(0);
  });

  it("capability detection and extraction agree", async () => {
    for (const id of [...NO_REDLINE, DOCS.order2023, DOCS.order2023A]) {
      const d = await doc(id);
      const hasT3 = d.capabilities.includes("T3");
      expect(extractRedline(d).region !== null).toBe(hasT3);
    }
  });
});

describe("region bounds", () => {
  it("starts at the legend declaration", async () => {
    const d = await doc(DOCS.order2023A);
    const region = findRedlineRegion(d)!;
    expect(region).not.toBeNull();
    const at = d.text.slice(region.legendOffset, region.legendOffset + 60);
    expect(at).toMatch(/Deletions are in brackets/i);
    expect(region.span[0]).toBe(region.legendOffset);
  });

  it("ends at the document body, excluding the Federal Register footer", async () => {
    // The footer is literally "[FR Doc. 2024-06563 Filed 4-15-24; 8:45 am]" — a bracket
    // pair that would otherwise be extracted as a deletion.
    const d = await doc(DOCS.order2023A);
    const region = findRedlineRegion(d)!;
    expect(region.span[1]).toBe(d.markup.bodySpan[1]);

    const tail = d.text.slice(region.span[1]);
    expect(tail).toMatch(/\[FR Doc\./);

    const r = extractRedline(d);
    expect(r.edits.some((e) => e.text.includes("FR Doc."))).toBe(false);
  });

  it("the region covers only part of the document, not all of it", async () => {
    const d = await doc(DOCS.order2023A);
    const region = findRedlineRegion(d)!;
    // The preamble must be outside — it contains bracket-shaped quoted tariff text.
    expect(region.span[0]).toBeGreaterThan(1_000_000);
    expect(region.span[1] - region.span[0]).toBeLessThan(d.text.length / 2);
  });
});

describe("manifest fixtures parse to the expected edits", () => {
  it('a[n] <E>non-refundable</E> → deletion "n" + addition "non-refundable"', async () => {
    const d = await doc(DOCS.order2023A);
    const r = extractRedline(d);

    const addition = r.edits.filter((e) => e.text.trim() === "non-refundable");
    expect(addition).toHaveLength(1);
    expect(addition[0]!.kind).toBe("addition");

    // The deletion that pairs with it groups into one logical change.
    const groups = groupAdjacentEdits(d, r.edits);
    const group = groups.find((g) => g.edits.some((e) => e.id === addition[0]!.id))!;
    expect(group.edits.map((e) => `${e.kind}:${e.text.trim()}`)).toEqual([
      "deletion:n",
      "addition:non-refundable",
    ]);
  });

  it('[≥ 20 MW] → a single deletion', async () => {
    const d = await doc(DOCS.order2023A);
    const hits = extractRedline(d).edits.filter((e) => e.text.trim() === "≥ 20 MW");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("deletion");
  });

  it("editorial fixtures are extracted as edits, for Phase 5 to classify", async () => {
    // "[the]" and italicised "i.e.," are genuine markup and must be extracted. Judging
    // them editorial is Phase 5's job — extraction does not pre-filter.
    const d = await doc(DOCS.order2023A);
    const edits = extractRedline(d).edits;
    expect(edits.filter((e) => e.kind === "deletion" && e.text.trim() === "the").length).toBeGreaterThan(100);
    expect(edits.filter((e) => e.kind === "addition" && e.text.trim() === "i.e.,").length).toBeGreaterThan(0);
  });
});

describe("edit counts and citations", () => {
  for (const [frDocNumber, expected] of Object.entries(BASELINES)) {
    it(`${frDocNumber} → ${expected.edits} edits`, async () => {
      const d = await doc(frDocNumber);
      const r = extractRedline(d);
      expect(r.edits).toHaveLength(expected.edits);
      expect(r.diagnostics.additions).toBe(expected.additions);
      expect(r.diagnostics.deletions).toBe(expected.deletions);
      expect(r.diagnostics.additions + r.diagnostics.deletions).toBe(r.edits.length);
    });

    it(`${frDocNumber} — every edit's citation verifies`, async () => {
      const d = await doc(frDocNumber);
      for (const e of extractRedline(d).edits) {
        const v = verifyCitation(d, e.citation);
        if (!v.ok) throw new Error(`edit ${e.id} failed: ${v.reason} — ${v.detail}`);
      }
    });
  }

  it("edits are ordered by position and carry unique ids", async () => {
    const d = await doc(DOCS.order2023A);
    const edits = extractRedline(d).edits;
    for (let i = 1; i < edits.length; i++) {
      expect(edits[i]!.citation.span[0]).toBeGreaterThanOrEqual(edits[i - 1]!.citation.span[0]);
    }
    expect(new Set(edits.map((e) => e.id)).size).toBe(edits.length);
  });

  it("every edit anchors to a real section", async () => {
    const d = await doc(DOCS.order2023A);
    const ids = new Set(d.sections.map((s) => s.id));
    for (const e of extractRedline(d).edits) {
      expect(ids.has(e.sectionId)).toBe(true);
      expect(e.citation.sectionId).toBe(e.sectionId);
    }
  });
});

describe("Phase 4 never classifies", () => {
  it("every edit is emitted undecided with no decider", async () => {
    const d = await doc(DOCS.order2023A);
    for (const e of extractRedline(d).edits) {
      expect(e.materiality).toBe("undecided");
      expect(e.decidedBy).toBeUndefined();
    }
  });
});

describe("exclusions and diagnostics", () => {
  it("italics inside footnotes are excluded — they are typography, not additions", async () => {
    // The footnote in Order 2023-A's Appendix C italicises a list of OASIS URLs.
    const d = await doc(DOCS.order2023A);
    const r = extractRedline(d);
    expect(r.diagnostics.italicsInFootnotes).toBe(25);
    expect(r.edits.some((e) => e.text.includes("oasis.oati.com"))).toBe(false);
  });

  it("brackets inside footnotes are excluded", async () => {
    const d = await doc(DOCS.order2023);
    expect(extractRedline(d).diagnostics.bracketsInFootnotes).toBeGreaterThan(0);
  });

  it("unmatched brackets are reported, not silently dropped (I1)", async () => {
    const d = await doc(DOCS.order2023);
    // Order No. 2023 has a small number of unbalanced brackets in the region. The count
    // is surfaced so a rise would be visible rather than quietly losing deletions.
    expect(extractRedline(d).diagnostics.unmatchedBrackets).toBe(7);
  });

  it("long deletions are not truncated by a length cap", async () => {
    // A 300-character cap silently truncated real content during design: 33 deletions
    // across the two documents exceed it, the longest running to ~2,800 characters.
    const d = await doc(DOCS.order2023);
    const lengths = extractRedline(d)
      .edits.filter((e) => e.kind === "deletion")
      .map((e) => e.text.length);
    expect(Math.max(...lengths)).toBeGreaterThan(2000);
    expect(lengths.filter((n) => n > 300).length).toBeGreaterThan(20);
  });
});

describe("adjacency grouping", () => {
  it("is measured in non-whitespace characters", async () => {
    // Source XML puts newlines and indentation between a deletion and the addition
    // replacing it — roughly 25 raw characters for "a[n] <E>non-refundable</E>". A raw
    // distance threshold splits that pair; this is the regression guard.
    const d = await doc(DOCS.order2023A);
    const r = extractRedline(d);
    const addition = r.edits.find((e) => e.text.trim() === "non-refundable")!;
    const deletion = r.edits.find(
      (e) => e.kind === "deletion" && e.citation.span[1] <= addition.citation.span[0],
    );
    expect(deletion).toBeDefined();

    const groups = groupAdjacentEdits(d, r.edits);
    const group = groups.find((g) => g.edits.some((e) => e.id === addition.id))!;
    expect(group.edits.length).toBe(2);

    const rawGap = addition.citation.span[0] - group.edits[0]!.citation.span[1];
    expect(rawGap).toBeGreaterThan(3); // raw distance alone would have split them
  });

  it("does not group edits separated by real text", async () => {
    const d = await doc(DOCS.order2023A);
    const groups = groupAdjacentEdits(d, extractRedline(d).edits);
    for (const g of groups.slice(0, 400)) {
      if (g.edits.length < 2) continue;
      for (let i = 1; i < g.edits.length; i++) {
        const between = d.text.slice(g.edits[i - 1]!.citation.span[1], g.edits[i]!.citation.span[0]);
        expect(between.trim()).toBe("");
      }
    }
  });

  it("conservation: grouping loses no edits (I1)", async () => {
    const d = await doc(DOCS.order2023A);
    const edits = extractRedline(d).edits;
    const groups = groupAdjacentEdits(d, edits);
    expect(groups.reduce((n, g) => n + g.edits.length, 0)).toBe(edits.length);
    expect(groups.length).toBeLessThan(edits.length); // some really did pair
  });
});
