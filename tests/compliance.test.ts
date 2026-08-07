/**
 * The compliance filing deadline.
 *
 * The operative text of a final rule says what the tariff must say and never says when
 * the tariff has to be filed. That date binds the reader's own organisation, it appears
 * once, in prose, and missing it is not recoverable — so the extraction is asserted
 * against measured values on every document in the verification set, including the ones
 * that correctly yield nothing.
 */

import { describe, expect, it } from "vitest";

import {
  describeDeadline,
  extractComplianceDeadlines,
  extractDeterminations,
  verifyCitation,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

async function deadlines(frDocNumber: string) {
  const d = await doc(frDocNumber);
  return { d, found: extractComplianceDeadlines(d, extractDeterminations(d)) };
}

describe("what the agency directed", () => {
  it("Order No. 2023 → 90 calendar days from publication, resolved to a date", async () => {
    const { found } = await deadlines(DOCS.order2023);
    expect(found).toHaveLength(1);
    const c = found[0]!;
    expect(c.count).toBe(90);
    expect(c.unit).toBe("days");
    expect(c.anchor).toBe("publication");
    // Published 2023-09-06; the document's own terms put the filing 90 days later.
    expect(c.dueOn).toBe("2023-12-05");
    expect(c.sentence).toMatch(/within 90 calendar days of the publication date/i);
    expect(describeDeadline(c)).toBe("90 days from publication");
  });

  it("Order No. 1920 → both deadlines, ten months and twelve", async () => {
    // Regression guard. Excluding any sentence containing "request" dropped the second:
    // "In response to MISO's request for a separate, longer compliance timeline, we also
    // modify the NOPR proposal and require … within 12 months" is a genuine directive
    // that happens to name who asked for it.
    const { found } = await deadlines(DOCS.order1920);
    expect(found.map((c) => c.count)).toEqual([10, 12]);
    expect(found.every((c) => c.unit === "months")).toBe(true);
    expect(found.every((c) => c.anchor === "effective")).toBe(true);
    // Effective 2024-08-12.
    expect(found.map((c) => c.dueOn)).toEqual(["2025-06-12", "2025-08-12"]);
  });

  it("reports the period but no date when the anchor is another document", async () => {
    // Order 2023-A extends Order 2023's deadline: "within 210 calendar days of the
    // publication of Order No. 2023". Resolving that against 2023-A's own publication
    // date would produce a confidently wrong date, so it resolves to nothing.
    const { found } = await deadlines(DOCS.order2023A);
    expect(found).toHaveLength(1);
    expect(found[0]!.count).toBe(210);
    expect(found[0]!.dueOn).toBeNull();
    expect(found[0]!.anchor).toBe("unstated");
  });
});

describe("what the agency did not direct", () => {
  it.each([DOCS.nopr2214, DOCS.nopr2117])(
    "%s (proposed rule) directs no compliance filing",
    async (frDocNumber) => {
      // A NOPR proposes a deadline; it does not set one. Reading its proposal as the
      // deadline would put a date on the page that binds nobody.
      const { found } = await deadlines(frDocNumber);
      expect(found).toEqual([]);
    },
  );

  it.each([DOCS.order1920A, DOCS.order1920B])(
    "%s sets no new deadline of its own",
    async (frDocNumber) => {
      // These orders discuss the existing deadline and its arithmetic without setting a
      // new one — "In calculating the required dates for compliance filings (e.g., 10
      // months …)" is a description, and reading it as a directive would be a fabrication.
      const { found } = await deadlines(frDocNumber);
      expect(found).toEqual([]);
    },
  );

  it("does not mistake a commenter's proposal for the agency's decision", async () => {
    // The same block carries "EEI suggests a 240-day deadline for compliance filings" and
    // "Consumers Energy and NRECA support the proposed requirement … within 180 days".
    const { d, found } = await deadlines(DOCS.order2023);
    expect(found.map((c) => c.count)).not.toContain(240);
    expect(found.map((c) => c.count)).not.toContain(180);
    // Both sentences really are in the document — the filter is doing work, not lucky.
    expect(d.text).toMatch(/EEI suggests a 240-day deadline/i);
  });
});

describe("every deadline carries a verified citation", () => {
  it.each([DOCS.order2023, DOCS.order1920, DOCS.order2023A])(
    "%s citations verify against source",
    async (frDocNumber) => {
      const { d, found } = await deadlines(frDocNumber);
      expect(found.length).toBeGreaterThan(0);
      for (const c of found) {
        const v = verifyCitation(d, c.citation);
        expect(v.ok).toBe(true);
        // And the citation points at the sentence it claims, not merely somewhere valid.
        expect(d.text.slice(c.citation.span[0], c.citation.span[1]).replace(/\s+/g, " ")).toBe(
          c.sentence,
        );
      }
    },
  );
});
