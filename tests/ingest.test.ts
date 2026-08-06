/**
 * Phase 1 gates — ingestion, document model, capability detection.
 * See docs/TDD.md §8 Phase 1 for the gate table this file implements.
 */

import { describe, expect, it } from "vitest";

import { bodyParagraphs, buildDocument, type Tier } from "../src/pipeline/index.js";
import { normalizeHeading } from "../src/pipeline/xml.js";
import { DOCS, doc, verificationSet } from "./fixtures.js";

/**
 * Expected capability tiers per document — docs/TDD.md §4.
 *
 * This table IS the arbitrary-URL promise's regression guard: it asserts both that
 * available tiers run and that unavailable ones are declined rather than approximated.
 */
const EXPECTED_TIERS: Record<string, Tier[]> = {
  [DOCS.nopr2214]: ["T1"],
  [DOCS.order2023]: ["T1", "T2", "T3"],
  [DOCS.order2023A]: ["T1", "T2", "T3"],
  [DOCS.nopr2117]: ["T1"],
  [DOCS.order1920]: ["T1", "T2"],
  [DOCS.order1920A]: ["T1", "T2"],
  [DOCS.order1920B]: ["T1", "T2"],
};

/** Body paragraph counts, measured. Each sequence is contiguous 1..N (invariant I3). */
const EXPECTED_BODY_PARAGRAPHS: Record<string, number> = {
  [DOCS.nopr2214]: 370,
  [DOCS.order2023]: 1785,
  [DOCS.order2023A]: 683,
  [DOCS.nopr2117]: 465,
  [DOCS.order1920]: 1792,
  [DOCS.order1920A]: 956,
  [DOCS.order1920B]: 158,
};

describe("all verification documents parse", () => {
  it("manifest declares the expected seven documents", () => {
    expect(verificationSet).toHaveLength(7);
  });

  for (const v of verificationSet) {
    it(`${v.doc_number} (${v.label}) fetches and parses`, async () => {
      const d = await doc(v.doc_number);
      expect(d.text.length).toBeGreaterThan(1000);
      expect(d.sections.length).toBeGreaterThan(0);
      expect(d.meta.frDocNumber).toBe(v.doc_number);
    });
  }
});

describe("status derives deterministically from the FR action field", () => {
  for (const v of verificationSet) {
    it(`${v.doc_number} → ${v.status}`, async () => {
      const d = await doc(v.doc_number);
      expect(d.meta.status).toBe(v.status);
      expect(d.meta.action).toBe(v.action);
    });
  }
});

describe("capability detection", () => {
  for (const [frDocNumber, tiers] of Object.entries(EXPECTED_TIERS)) {
    it(`${frDocNumber} → ${tiers.join(" + ")}`, async () => {
      const d = await doc(frDocNumber);
      expect(d.capabilities).toEqual(tiers);
    });
  }

  it("every tier carries a human-readable reason, available or not", async () => {
    const d = await doc(DOCS.order1920);
    const t3 = d.capabilityNotes.find((n) => n.tier === "T3");
    expect(t3?.available).toBe(false);
    // Unavailability must be explained, never silent.
    expect(t3?.reason).toMatch(/no redline legend/i);
  });

  it("declines redline on a document with many italic tags but no legend", async () => {
    // Order No. 1920 carries thousands of italic tags. Treating them as additions
    // would fabricate thousands of regulatory changes. The precondition must hold.
    const d = await doc(DOCS.order1920);
    expect(d.capabilities).not.toContain("T3");
  });

  it("yields T1 only for an agency with no registered convention", () => {
    const meta = {
      frDocNumber: "9999-00001",
      docketIds: ["EPA-HQ-OAR-9999"],
      agency: "ENVIRONMENTAL PROTECTION AGENCY",
      agencies: ["Environmental Protection Agency"],
      title: "A rule from an agency Strata has no convention for",
      publicationDate: "2026-01-01",
      type: "Rule",
      action: "Final rule.",
      status: "final" as const,
      pageLength: 10,
      htmlUrl: "",
      xmlUrl: "",
    };
    const xml =
      `<RULE><PREAMB><AGENCY>EPA</AGENCY></PREAMB><SUPLINF>` +
      `<HD SOURCE="HD1">I. Background</HD><P>1. Some text.</P>` +
      `<HD SOURCE="HD2">Commission Determination</HD>` +
      `<P>Deletions are in brackets and additions are in italics.</P>` +
      `</SUPLINF></RULE>`;

    const d = buildDocument(meta, xml);
    expect(d.conventionId).toBeNull();
    expect(d.capabilities).toEqual(["T1"]);
    // Even though the text contains both a determination heading and a legend phrase,
    // no convention claims this agency, so neither is acted on.
    expect(d.paragraphs).toHaveLength(0);
  });
});

describe("invariant I3 — paragraph numbering is contiguous from 1", () => {
  for (const [frDocNumber, expected] of Object.entries(EXPECTED_BODY_PARAGRAPHS)) {
    it(`${frDocNumber} → 1..${expected}, no gaps`, async () => {
      const d = await doc(frDocNumber);
      const nums = bodyParagraphs(d).map((p) => p.number);
      expect(nums).toHaveLength(expected);
      expect(nums).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
    });
  }

  it("separate opinions are flagged, not merged into the body sequence", async () => {
    // Order 2023-A ends with concurrences that restart numbering at 1.
    const d = await doc(DOCS.order2023A);
    const separate = d.paragraphs.filter((p) => p.isSeparateOpinion);
    expect(separate.length).toBe(10);
    expect(separate[0]?.number).toBe(1);
  });
});

describe("spans round-trip into the document text", () => {
  it("every paragraph span starts with its own number", async () => {
    const d = await doc(DOCS.order2023A);
    for (const p of d.paragraphs) {
      const slice = d.text.slice(p.span[0], p.span[1]);
      expect(slice.trimStart().startsWith(`${p.number}.`)).toBe(true);
    }
  });

  it("every section span starts with its own heading", async () => {
    const d = await doc(DOCS.order2023A);
    for (const s of d.sections) {
      const head = s.headingPath[s.headingPath.length - 1]!;
      // Headings carry internal newlines and indentation in the source XML — e.g.
      // "9.2 \n        Response to Notifications" — so the raw window must be wider
      // than the normalized heading. normalizeHeading collapses it back.
      const end = Math.min(s.span[1], s.span[0] + head.length * 4 + 300);
      const slice = normalizeHeading(d.text.slice(s.span[0], end));
      expect(slice.startsWith(head)).toBe(true);
    }
  });

  it("spans are well-formed and within bounds", async () => {
    const d = await doc(DOCS.order2023A);
    for (const s of d.sections) {
      expect(s.span[0]).toBeGreaterThanOrEqual(0);
      expect(s.span[1]).toBeLessThanOrEqual(d.text.length);
      expect(s.span[1]).toBeGreaterThan(s.span[0]);
    }
  });
});

describe("section identity carries nesting depth", () => {
  it("distinguishes a document-level appendix from a same-named nested one", async () => {
    // Order No. 2023 contains both "Appendix C: Pro forma LGIP" (document level) and
    // "Appendix C to LGIA" (nested). Conflating them yields a citation anchor pointing
    // at text that does not support the claim — a bug the citation verifier cannot
    // catch, because extraction and verification would share the same wrong path.
    const d = await doc(DOCS.order2023);
    const cs = d.sections.filter((s) =>
      /^Appendix C\b/i.test(s.headingPath[s.headingPath.length - 1] ?? ""),
    );
    expect(cs.length).toBeGreaterThanOrEqual(2);

    const ids = new Set(cs.map((s) => s.id));
    expect(ids.size).toBe(cs.length); // every id unique

    const spans = new Set(cs.map((s) => `${s.span[0]}:${s.span[1]}`));
    expect(spans.size).toBe(cs.length); // and they point at different text
  });

  it("section ids are unique across the whole document", async () => {
    const d = await doc(DOCS.order2023);
    const ids = d.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ids encode the hierarchy, so depth is recoverable from the id", async () => {
    const d = await doc(DOCS.order2023A);
    for (const s of d.sections) {
      expect(s.id.split("/")).toHaveLength(s.depth);
    }
  });
});
