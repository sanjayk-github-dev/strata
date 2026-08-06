/**
 * Phase 3 gates — determination blocks (docs/TDD.md §8 Phase 3).
 *
 * This is the general branch: it applies to every document that decides something.
 * Phase 3 is deterministic structure only — classifying dispositions is Phase 6.
 */

import { describe, expect, it } from "vitest";

import {
  crossRefStats,
  extractCrossRefs,
  extractDeterminations,
  isLikelyProvisionRef,
} from "../src/pipeline/determinations.js";
import {
  deriveProvisionStatus,
  requiresEscalation,
  verifyCitation,
  FERC_RULEMAKING,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

/** Measured block counts — trim-then-anchor matching (see registry.ts). */
const EXPECTED_BLOCKS: Record<string, number> = {
  [DOCS.order2023]: 47,
  [DOCS.order2023A]: 31,
  [DOCS.order1920]: 66,
  [DOCS.order1920A]: 75,
  [DOCS.order1920B]: 11,
};

describe("block counts across the verification set", () => {
  for (const [frDocNumber, expected] of Object.entries(EXPECTED_BLOCKS)) {
    it(`${frDocNumber} → ${expected} determination blocks`, async () => {
      const d = await doc(frDocNumber);
      expect(extractDeterminations(d)).toHaveLength(expected);
    });
  }

  it.each([DOCS.nopr2214, DOCS.nopr2117])(
    "%s (proposed rule) → zero blocks, guarding against false positives",
    async (frDocNumber) => {
      // A NOPR proposes; it does not determine. Zero is correct behaviour, not a gap —
      // and a non-zero count here would mean the heading pattern is over-matching.
      const d = await doc(frDocNumber);
      expect(extractDeterminations(d)).toHaveLength(0);
    },
  );

  it("returns nothing when the T2 precondition does not hold", async () => {
    const d = await doc(DOCS.nopr2214);
    expect(d.capabilities).not.toContain("T2");
    expect(extractDeterminations(d)).toEqual([]);
  });
});

describe("every block's text round-trips to source", () => {
  it.each(Object.keys(EXPECTED_BLOCKS))("%s", async (frDocNumber) => {
    const d = await doc(frDocNumber);
    for (const det of extractDeterminations(d)) {
      const r = verifyCitation(d, det.citation);
      if (!r.ok) {
        throw new Error(`block ${det.id} failed verification: ${r.reason} — ${r.detail}`);
      }
      expect(r.match).toBe("exact");
    }
  });

  it("a block's quote is exactly the text at its span", async () => {
    const d = await doc(DOCS.order2023A);
    for (const det of extractDeterminations(d)) {
      const [a, b] = det.citation.span;
      expect(det.citation.quote).toBe(d.text.slice(a, b));
    }
  });
});

describe("block structure", () => {
  it("blocks appear in document order and do not overlap", async () => {
    const d = await doc(DOCS.order2023);
    const dets = extractDeterminations(d);
    for (let i = 1; i < dets.length; i++) {
      const prev = dets[i - 1]!.citation.span;
      const cur = dets[i]!.citation.span;
      expect(cur[0]).toBeGreaterThanOrEqual(prev[0]);
      // A determination never swallows the next one.
      expect(prev[1]).toBeLessThanOrEqual(cur[0]);
    }
  });

  it("every block is non-empty and bounded by the document", async () => {
    const d = await doc(DOCS.order2023A);
    for (const det of extractDeterminations(d)) {
      const [a, b] = det.citation.span;
      expect(b).toBeGreaterThan(a);
      expect(b).toBeLessThanOrEqual(d.text.length);
    }
  });

  it("block ids are unique and match their section ids", async () => {
    const d = await doc(DOCS.order2023);
    const dets = extractDeterminations(d);
    const ids = dets.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const det of dets) expect(det.citation.sectionId).toBe(det.id);
  });

  it("headingPath carries the surrounding context, not just the leaf", async () => {
    const d = await doc(DOCS.order2023A);
    const dets = extractDeterminations(d);
    expect(dets.length).toBeGreaterThan(0);
    for (const det of dets) {
      expect(det.headingPath.length).toBeGreaterThan(1);
      expect(det.headingPath.at(-1)).toMatch(/Determination$/);
    }
  });
});

describe("Phase 3 never guesses a disposition", () => {
  it("every block is emitted as unclassified", async () => {
    const d = await doc(DOCS.order2023A);
    for (const det of extractDeterminations(d)) {
      expect(det.disposition).toBe("unclassified");
    }
  });

  it("an unclassified disposition escalates rather than resolving to a status", async () => {
    const d = await doc(DOCS.order2023A);
    const det = extractDeterminations(d)[0]!;
    const status = deriveProvisionStatus(d.meta.status, det.disposition);
    expect(status).toBe("unknown");
    expect(requiresEscalation(status)).toBe(true);
  });
});

describe("cross-reference extraction", () => {
  const xref = FERC_RULEMAKING.crossReference!.pattern;

  it("extracts dotted provision references", () => {
    const refs = extractCrossRefs(
      "as set out in section 3.1.1.1 (Study Deposit) and section 7.5 of the LGIP",
      xref,
    );
    expect(refs).toContain("3.1.1.1");
    expect(refs).toContain("7.5");
  });

  it("is not corrupted by a shared regex lastIndex across calls", () => {
    // The convention's pattern carries the `g` flag. Reusing a stateful regex would
    // silently skip matches on the second call — a real and quiet bug class.
    const text = "see section 3.7 and section 4.4";
    const first = extractCrossRefs(text, xref);
    const second = extractCrossRefs(text, xref);
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it("deduplicates repeated references", () => {
    const refs = extractCrossRefs("section 3.7 … section 3.7 … section 3.7", xref);
    expect(refs).toEqual(["3.7"]);
  });

  it("treats statutory citations as non-provision references", () => {
    // FERC cites sections 205 and 206 of the Federal Power Act constantly. Joining a
    // determination to pro forma "section 206" would be wrong.
    expect(isLikelyProvisionRef("205")).toBe(false);
    expect(isLikelyProvisionRef("206")).toBe(false);
    expect(isLikelyProvisionRef("3.1.1.1")).toBe(true);
    expect(isLikelyProvisionRef("7")).toBe(true);
  });

  it("filters statutory references out of extracted blocks", async () => {
    const d = await doc(DOCS.order2023A);
    for (const det of extractDeterminations(d)) {
      expect(det.crossRefs).not.toContain("205");
      expect(det.crossRefs).not.toContain("206");
    }
  });
});

describe("cross-reference coverage — measured, not assumed", () => {
  it("is substantial where redline exists to join against", async () => {
    // Coverage only matters where T3 is available, because the Phase 7 join links
    // determinations to redline edits. Both RM22-14 rule documents carry redline.
    for (const id of [DOCS.order2023, DOCS.order2023A]) {
      const d = await doc(id);
      expect(d.capabilities).toContain("T3");
      const stats = crossRefStats(d);
      expect(stats.blocks).toBeGreaterThan(0);
      expect(stats.coverage).toBeGreaterThan(0.5);
    }
  });

  it("is low on documents with no redline — which is harmless, and worth recording", async () => {
    // RM21-17 discusses transmission planning rather than amending numbered pro forma
    // provisions, so it cites far fewer section numbers. These documents are T2-only,
    // so there is nothing to join to and nothing is lost. Recorded so the Phase 7 join
    // is not designed on an assumption of universal cross-referencing.
    const d = await doc(DOCS.order1920A);
    expect(d.capabilities).not.toContain("T3");
    const stats = crossRefStats(d);
    expect(stats.blocks).toBe(75);
    expect(stats.coverage).toBeLessThan(0.2);
  });

  it("reports how many statutory references were filtered", async () => {
    const d = await doc(DOCS.order2023A);
    const stats = crossRefStats(d);
    expect(stats.filteredStatutory).toBeGreaterThan(0);
  });
});
