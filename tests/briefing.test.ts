/**
 * The change briefing — what the reader actually opens.
 *
 * Two things are under test. Categorisation, which decides the order a reader meets the
 * changes in, and therefore what they read first. And statement generation, which is the
 * only place in the product where a model sentence is shown as prose — so its gate gets
 * the same adversarial treatment as the rest of the model tier.
 */

import { describe, expect, it } from "vitest";

import { StubLlmClient } from "../src/llm/index.js";
import {
  buildBriefing,
  categorise,
  CATEGORY_ORDER,
  classifyEdits,
  extractDeterminations,
  extractRedline,
  generateStatement,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

describe("categorisation", () => {
  it.each([
    ["shall submit within 60 calendar days of the request", "", "deadline"],
    ["a study deposit of $5,000 shall be non-refundable", "", "money"],
    ["generating facilities of 20 MW or larger", "", "threshold"],
    ["the Transmission Provider shall notify the customer", "", "obligation"],
    ["nothing of consequence changed here", "", "other"],
  ] as const)("%s → %s", (text, title, expected) => {
    expect(categorise(text, title)).toBe(expected);
  });

  it("classifies a definition as a definition, not an obligation", () => {
    // Regression guard. Definitions read "X shall mean Y", so an obligation check placed
    // ahead of the definition check swallowed every one of them — Order 2023's two
    // Definitions chapters reported zero defined-term changes while carrying 131.
    expect(categorise("Affected System shall mean an electric system", "1. Definitions")).toBe(
      "definition",
    );
    expect(categorise("some revised wording", "3.1 Definitions")).toBe("definition");
  });

  it("prefers the costlier consequence when several signals are present", () => {
    // Within one provision, a deadline outranks a fee outranks a threshold: the reader
    // who misses a deadline cannot recover, whereas a fee paid wrongly can be argued back.
    expect(categorise("a $500 fee due within 30 calendar days", "3.1 Study Deposit")).toBe(
      "deadline",
    );
    expect(categorise("a $500 fee for facilities above 20 MW", "3.1 Study Deposit")).toBe("money");
  });

  it("keeps a whole Definitions chapter under defined terms whatever it mentions", () => {
    // Order 2023's "Section 1. Definitions" carries 83 changes at once, and definitional
    // text that long mentions costs and days somewhere by certainty. Categorising it on
    // content filed the entire chapter under "Fees, deposits and penalties".
    expect(
      categorise("the study deposit shall mean the amount due within 30 days", "Section 1. Definitions"),
    ).toBe("definition");
  });

  it("every category has a place in the display order", () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
    for (const c of ["deadline", "money", "threshold", "obligation", "definition", "other"]) {
      expect(CATEGORY_ORDER).toContain(c);
    }
  });
});

describe("briefing assembly", () => {
  it("groups by affected provision, not by determination", async () => {
    // The shape this replaced produced one card per determination, which was incoherent
    // in both directions: a single determination adopting "the revisions to section 1 of
    // the pro forma LGIP" swallowed 85 edits — section 1 being the entire Definitions
    // chapter — while 226 other cards carried one trivial edit each.
    const d = await doc(DOCS.order2023);
    const rl = extractRedline(d);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, rl.edits));

    expect(b.changes.length).toBeGreaterThan(0);
    // One card per provision, so provision identity is unique across the briefing.
    expect(new Set(b.changes.map((c) => c.id)).size).toBe(b.changes.length);
    // And far fewer cards than there are edits — the grouping does real work.
    expect(b.changes.length).toBeLessThan(rl.edits.length / 2);
  });

  it("orders by category, then by priority within a category", async () => {
    const d = await doc(DOCS.order2023);
    const rl = extractRedline(d);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, rl.edits));

    const rank = { material: 0, "needs-review": 1, clarifying: 2 } as const;
    for (let i = 1; i < b.changes.length; i++) {
      const prev = b.changes[i - 1]!;
      const cur = b.changes[i]!;
      const dc = CATEGORY_ORDER.indexOf(cur.category) - CATEGORY_ORDER.indexOf(prev.category);
      expect(dc).toBeGreaterThanOrEqual(0);
      if (dc === 0) expect(rank[cur.priority]).toBeGreaterThanOrEqual(rank[prev.priority]);
    }
  });

  it("attaches only determinations that direct a change to the provision", async () => {
    // A determination *mentioning* section 3.1.2 while declining to add it must not
    // adopt that provision's unrelated edits: the card then read "we decline to adopt
    // the proposal to add new section 3.1.2" above nine changes it did not cause.
    const d = await doc(DOCS.order2023);
    const dets = extractDeterminations(d);
    const b = buildBriefing(d, dets, classifyEdits(d, extractRedline(d).edits));

    for (const c of b.changes.filter((x) => x.edits.length > 0)) {
      for (const det of c.determinations) {
        expect(det.amendedRefs).toContain(c.provisionNumber);
      }
    }
  });

  it("counts every category and drops nothing (invariant I1)", async () => {
    const d = await doc(DOCS.order2023);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, extractRedline(d).edits));

    const summed = Object.values(b.byCategory).reduce((a, n) => a + n, 0);
    expect(summed).toBe(b.changes.length);
    // Provisions whose every change was proved editorial are counted, not discarded.
    expect(b.editorialOnlyProvisions + b.editBackedProvisions).toBe(b.totalProvisions);
  });

  it("surfaces the defined-term changes that the ordering bug had hidden", async () => {
    const d = await doc(DOCS.order2023);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, extractRedline(d).edits));
    expect(b.byCategory.definition).toBeGreaterThan(0);
  });

  it("returns an empty briefing for a document with no redline, without failing", async () => {
    // A NOPR publishes no marked-up text. Nothing to brief is a result, not an error.
    const d = await doc(DOCS.nopr2214);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, extractRedline(d).edits));
    expect(b.changes).toEqual([]);
    expect(b.totalProvisions).toBe(0);
  });

  it("briefs a document that has determinations but no redline", async () => {
    // Order No. 1920 publishes no marked-up text at all. Building the briefing from edits
    // alone would show 1,792 paragraphs and 66 decisions as an empty page — which is
    // exactly what a redline-only tool does, and the reason this product is not one.
    const d = await doc(DOCS.order1920);
    const dets = extractDeterminations(d);
    const b = buildBriefing(d, dets, classifyEdits(d, extractRedline(d).edits));

    expect(b.editBackedProvisions).toBe(0);
    expect(b.changes).toHaveLength(dets.length);
    expect(b.changes.every((c) => c.edits.length === 0)).toBe(true);
    expect(Object.values(b.byCategory).reduce((a, n) => a + n, 0)).toBe(b.changes.length);
  });

  it("does not list a determination twice when its provision already has a card", async () => {
    const d = await doc(DOCS.order2023);
    const b = buildBriefing(d, extractDeterminations(d), classifyEdits(d, extractRedline(d).edits));
    const edited = new Set(
      b.changes.filter((c) => c.edits.length > 0).map((c) => c.provisionNumber),
    );
    for (const c of b.changes) {
      if (c.edits.length === 0 && c.provisionNumber) expect(edited.has(c.provisionNumber)).toBe(false);
    }
  });
});

describe("statement generation is citation-gated", () => {
  const edits = [
    { text: "sixty (60) Calendar Days", kind: "addition" as const },
    { text: "thirty (30) Calendar Days", kind: "deletion" as const },
  ];

  const call = (body: unknown) =>
    generateStatement(
      "3.1 Study Deposit",
      "within thirty (30) Calendar Days",
      "within sixty (60) Calendar Days",
      edits,
      new StubLlmClient([typeof body === "string" ? body : JSON.stringify(body)]),
    );

  it("passes a statement whose evidence is the changed text", async () => {
    const r = await call({
      statement: "The response window doubles from 30 to 60 calendar days.",
      evidence: "sixty (60) Calendar Days",
    });
    expect(r?.statement).toMatch(/60 calendar days/i);
  });

  it("suppresses a statement quoting text that was never edited", async () => {
    // The failure this exists for: a fluent, plausible sentence about a change the
    // document does not contain. Suppressed, not flagged and not downgraded.
    const r = await call({
      statement: "The deposit is now expressly non-refundable.",
      evidence: "shall be non-refundable",
    });
    expect(r).toBeNull();
  });

  it("suppresses a statement quoting unchanged surrounding text", async () => {
    // "within" appears in both before and after, so a document-wide quote search would
    // pass it. Grounding against the edits themselves is what makes the gate mean
    // "this text changed" rather than "this text exists".
    const r = await call({ statement: "Something changed.", evidence: "within" });
    expect(r).toBeNull();
  });

  it("rejects a one-character quote that any sentence would contain", async () => {
    const r = await generateStatement(
      "3.1 Study Deposit",
      "the deposit",
      "the deposits",
      [{ text: "s", kind: "addition" }],
      new StubLlmClient([
        JSON.stringify({
          statement: "The section was restructured.",
          evidence: "the section was restructured",
        }),
      ]),
    );
    expect(r).toBeNull();
  });

  it("returns null on malformed or empty model output rather than showing it", async () => {
    expect(await call("not json at all")).toBeNull();
    expect(await call({ statement: "", evidence: "sixty (60) Calendar Days" })).toBeNull();
    expect(await call({ statement: "A change occurred." })).toBeNull();
  });

  it("returns null when the provider fails, leaving the change shown but unsummarised", async () => {
    const failing = {
      label: "failing",
      complete: async () => {
        throw new Error("429 rate limited");
      },
    };
    expect(
      await generateStatement("3.1", "a", "b", edits, failing),
    ).toBeNull();
  });
});
