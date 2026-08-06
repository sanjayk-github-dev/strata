/**
 * Phase 7 gates — join and assembled cards (docs/TDD.md §8 Phase 7).
 *
 * The join is where the two branches meet, and where a mistake is least visible: a card
 * that attaches a decision to the wrong provision reads perfectly well and is simply
 * wrong. Hence the emphasis on citations verifying on every branch a card claims.
 */

import { describe, expect, it } from "vitest";

import {
  assembleCards,
  buildProvisionIndex,
  cardPriority,
  classifyEdits,
  definedTerms,
  extractDeterminations,
  extractRedline,
  provisionNumberOf,
  verifyCitation,
  type ParsedDocument,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

async function assembled(id: string) {
  const d: ParsedDocument = await doc(id);
  const rl = extractRedline(d);
  const dets = extractDeterminations(d);
  const m = classifyEdits(d, rl.edits);
  return { d, rl, dets, m, ...assembleCards(d, dets, m, rl.region?.span ?? null) };
}

describe("provision numbering", () => {
  it("reads sub-provision headings", () => {
    expect(provisionNumberOf("3.1.1.1 Study Deposit")).toBe("3.1.1.1");
    expect(provisionNumberOf("2.4 No Applicability to Transmission Service")).toBe("2.4");
  });

  it("reads top-level headings, which use a different form", () => {
    // Measured: an initial pattern handling only "3.1.1 Foo" left every bare-digit
    // cross-reference ("5", "7", "9") unmatched, because top-level provisions head as
    // "Section 3. Interconnection Requests".
    expect(provisionNumberOf("Section 3. Interconnection Requests")).toBe("3");
    expect(provisionNumberOf("Section 13. Miscellaneous")).toBe("13");
  });

  it("returns null for headings that carry no provision number", () => {
    expect(provisionNumberOf("Appendix C: Changes to the Pro Forma LGIP")).toBeNull();
    expect(provisionNumberOf("Standard Large Generator Interconnection Procedures")).toBeNull();
  });

  it("indexes provisions inside the redline region", async () => {
    const { d, rl } = await assembled(DOCS.order2023A);
    const index = buildProvisionIndex(d, rl.region!.span);
    expect(index.size).toBeGreaterThan(100);
    expect(index.has("3.1.1.1")).toBe(true);
    // Every indexed section really does sit inside the region.
    for (const sections of index.values()) {
      for (const s of sections) {
        expect(s.span[0]).toBeGreaterThanOrEqual(rl.region!.span[0]);
        expect(s.span[0]).toBeLessThan(rl.region!.span[1]);
      }
    }
  });
});

describe("explicit joins resolve deterministically", () => {
  it("links a determination to a provision it directs a change to", async () => {
    // Measured: 6 explicit joins on this document, down from 16 before directive
    // filtering. The drop is the point — 20 of 31 determinations *mention* a provision
    // but only 9 *direct a change* to one, and joining on mentions attached unrelated
    // edits to decisions that changed nothing.
    const { cards } = await assembled(DOCS.order2023A);
    const explicit = cards.filter((c) => c.joinKind === "explicit");
    expect(explicit.length).toBeGreaterThan(0);

    for (const card of explicit) {
      expect(card.determination).toBeDefined();
      expect(card.provisionRefs.length).toBeGreaterThan(0);
      expect(card.edits.length).toBeGreaterThan(0);
      // Every provision a card claims to amend must be one the determination directed,
      // never merely mentioned.
      for (const ref of card.provisionRefs) {
        expect(card.determination!.amendedRefs).toContain(ref);
      }
    }
  });

  it("joins on directives only — mentions never attach edits", async () => {
    const { cards } = await assembled(DOCS.order2023A);
    for (const card of cards) {
      if (!card.determination || card.edits.length === 0) continue;
      if (card.joinKind !== "explicit") continue;
      expect(card.determination.amendedRefs.length).toBeGreaterThan(0);
    }
  });

  it("is stable across runs — the same input yields the same joins", async () => {
    const a = await assembled(DOCS.order2023A);
    const b = await assembled(DOCS.order2023A);
    expect(a.cards.map((c) => `${c.id}:${c.joinKind}`)).toEqual(
      b.cards.map((c) => `${c.id}:${c.joinKind}`),
    );
  });

  it("lets two determinations bear on the same provision", async () => {
    // Cards are an overlapping cover, not a partition. First-come-first-served claiming
    // suppressed six real joins on this document — a second decision about a provision is
    // a real decision, and hiding it would lose information I1 exists to protect.
    const { cards } = await assembled(DOCS.order2023A);
    const editToCards = new Map<string, number>();
    for (const c of cards) {
      if (!c.determination) continue;
      for (const e of c.edits) editToCards.set(e.id, (editToCards.get(e.id) ?? 0) + 1);
    }
    const shared = [...editToCards.values()].filter((n) => n > 1);
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("cards carry verified citations on every branch they claim", () => {
  it.each([DOCS.order2023A, DOCS.order1920])("%s", async (id) => {
    const { d, cards } = await assembled(id);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.citations.length).toBeGreaterThan(0);
      for (const c of card.citations) {
        const v = verifyCitation(d, c);
        if (!v.ok) throw new Error(`card ${card.id}: ${v.reason} — ${v.detail}`);
      }
    }
  });

  it("a card claiming a determination carries that determination's citation", async () => {
    const { cards } = await assembled(DOCS.order2023A);
    for (const card of cards) {
      if (!card.determination) continue;
      expect(card.citations).toContainEqual(card.determination.citation);
    }
  });

  it("a card claiming edits carries each edit's citation", async () => {
    const { cards } = await assembled(DOCS.order2023A);
    for (const card of cards) {
      for (const e of card.edits) expect(card.citations).toContainEqual(e.citation);
    }
  });
});

describe("invariant I1 — nothing is dropped", () => {
  it("every edit is either carded or accounted for as editorial", async () => {
    const { rl, m, cards } = await assembled(DOCS.order2023A);
    const carded = new Set(cards.flatMap((c) => c.edits.map((e) => e.id)));
    const editorial = m.groups
      .filter((g) => g.result.materiality === "editorial")
      .flatMap((g) => g.group.edits).length;
    expect(carded.size + editorial).toBe(rl.edits.length);
  });

  it("every determination appears on exactly one card", async () => {
    const { dets, cards } = await assembled(DOCS.order2023A);
    const ids = cards.filter((c) => c.determination).map((c) => c.determination!.id);
    expect(ids).toHaveLength(dets.length);
    expect(new Set(ids).size).toBe(dets.length);
  });

  it("a determination that joins to nothing still gets a card", async () => {
    // The majority of decisions leave no textual footprint. A join that finds nothing is
    // the normal case, not a failure, and the decision must still reach the reviewer.
    const { cards, coverage } = await assembled(DOCS.order2023A);
    expect(coverage.unjoinedDeterminations).toBeGreaterThan(0);
    const detOnly = cards.filter((c) => c.determination && c.edits.length === 0);
    expect(detOnly.length).toBe(coverage.unjoinedDeterminations);
  });

  it("edits no determination discusses still get cards", async () => {
    const { cards, coverage } = await assembled(DOCS.order2023A);
    const editOnly = cards.filter((c) => !c.determination);
    expect(editOnly.length).toBe(coverage.editOnlyCards);
    expect(editOnly.length).toBeGreaterThan(0);
  });
});

describe("join coverage is measured", () => {
  it("reports the explicit / implicit / unjoined split", async () => {
    const { coverage } = await assembled(DOCS.order2023A);
    expect(
      coverage.joinedExplicit + coverage.joinedImplicit + coverage.unjoinedDeterminations,
    ).toBe(coverage.determinations);
    expect(coverage.joinedExplicit).toBeGreaterThan(0);
  });

  it("a document with no redline yields determination-only cards", async () => {
    // Order No. 1920 has 66 determinations and no parseable redline. Every card is a
    // decision with no operative text attached — which is exactly what a redline-only
    // tool would show as nothing at all.
    const { cards, coverage } = await assembled(DOCS.order1920);
    expect(coverage.determinations).toBe(66);
    expect(coverage.joinedExplicit).toBe(0);
    expect(coverage.editOnlyCards).toBe(0);
    expect(cards).toHaveLength(66);
    expect(cards.every((c) => c.determination && c.edits.length === 0)).toBe(true);
  });

  it("a proposed rule yields no cards at all", async () => {
    const { cards } = await assembled(DOCS.nopr2214);
    expect(cards).toHaveLength(0);
  });
});

describe("review priority", () => {
  it("orders material first, then items needing review", async () => {
    const { cards } = await assembled(DOCS.order2023A);
    const rank = { material: 0, "needs-review": 1, clarifying: 2 } as const;
    for (let i = 1; i < cards.length; i++) {
      expect(rank[cards[i]!.priority]).toBeGreaterThanOrEqual(rank[cards[i - 1]!.priority]);
    }
  });

  it("counts every card in exactly one priority band", async () => {
    const { cards, coverage } = await assembled(DOCS.order2023A);
    const total = Object.values(coverage.byPriority).reduce((a, b) => a + b, 0);
    expect(total).toBe(cards.length);
  });

  it("treats an unclassified disposition as needing review", async () => {
    const { cards } = await assembled(DOCS.order1920);
    // Phase 6 has not run here, so every disposition is unclassified and must escalate.
    expect(cards.every((c) => c.escalated)).toBe(true);
    expect(cards.every((c) => c.provisionStatus === "unknown")).toBe(true);
  });
});

describe("lexical fallback", () => {
  it("extracts multi-word defined terms and ignores single words", () => {
    const terms = definedTerms("The Interconnection Customer shall notify Transmission Provider.");
    expect(terms).toContain("interconnection customer");
    expect(terms).toContain("transmission provider");
    expect(terms).not.toContain("the");
  });

  it("scores nothing when there is no shared vocabulary", () => {
    const a = definedTerms("Cluster Study Report Meeting");
    const b = definedTerms("Network Upgrade Cost Allocation");
    let shared = 0;
    for (const t of b) if (a.has(t)) shared++;
    expect(shared).toBe(0);
  });
});
