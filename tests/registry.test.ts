/**
 * Convention registry gates.
 *
 * Each registry entry ships with its verification set (docs/TDD.md §3 rule 3); these
 * tests are the FERC entry's. Several assertions encode failure modes the design-time
 * audit actually hit — they are regression guards, not hypotheticals.
 */

import { describe, expect, it } from "vitest";

import {
  FERC_RULEMAKING,
  deriveStatus,
  findConvention,
  resolveInput,
  UnsupportedSourceError,
  type DocumentMeta,
} from "../src/pipeline/index.js";
import { countDeterminations } from "../src/pipeline/document.js";
import { normalizeHeading, parseFrXml } from "../src/pipeline/xml.js";
import { DOCS, doc } from "./fixtures.js";

const ferc = (over: Partial<DocumentMeta> = {}): DocumentMeta => ({
  frDocNumber: "0000-00000",
  docketIds: ["RM22-14"],
  agency: "FEDERAL ENERGY REGULATORY COMMISSION",
  agencies: ["Federal Energy Regulatory Commission"],
  title: "t",
  publicationDate: "2024-01-01",
  type: "Rule",
  action: "Final rule.",
  status: "final",
  pageLength: 1,
  htmlUrl: "",
  xmlUrl: "",
  abstract: null,
  commentsCloseOn: null,
  effectiveOn: null,
  datesNote: null,
  cfrReferences: [],
  ...over,
});

describe("convention matching", () => {
  it("matches FERC documents by agency", () => {
    expect(findConvention(ferc())?.id).toBe("ferc-rulemaking");
  });

  it("matches proposed rules too, NOT only Rule-type documents", () => {
    // Regression guard. An earlier design narrowed `matches` to type === "Rule", which
    // would have stripped structure from the RM22-14 NOPR — a document carrying 370
    // numbered paragraphs that citations must be able to anchor into.
    const nopr = ferc({ type: "Proposed Rule", action: "Notice of proposed rulemaking." });
    expect(findConvention(nopr)?.id).toBe("ferc-rulemaking");
  });

  it("returns null for an unregistered agency rather than throwing", () => {
    const epa = ferc({
      agency: "ENVIRONMENTAL PROTECTION AGENCY",
      agencies: ["Environmental Protection Agency"],
    });
    expect(findConvention(epa)).toBeNull();
  });
});

describe("status derivation", () => {
  it.each([
    ["Notice of proposed rulemaking.", "Proposed Rule", "proposed"],
    ["Advance notice of proposed rulemaking.", "Proposed Rule", "proposed"],
    ["Final rule.", "Rule", "final"],
    ["Final order.", "Rule", "final"],
    ["Order on rehearing and clarification.", "Rule", "amended"],
  ])("%s → %s", (action, type, expected) => {
    expect(deriveStatus(action, type)).toBe(expected);
  });

  it("falls back to the FR type field when the action string is unrecognised", () => {
    expect(deriveStatus("Something entirely new.", "Proposed Rule")).toBe("proposed");
    expect(deriveStatus("", "Rule")).toBe("final");
  });
});

describe("determination heading matching — trim, then anchor", () => {
  const pattern = FERC_RULEMAKING.determinations!.headingPattern;

  it("anchors: a heading merely containing the word is not a determination block", () => {
    // Order No. 1920-A really contains this argument heading. Contains-matching
    // over-counted it as a determination block during design.
    const argument =
      "2. The Commission Adequately Supported Its Determination on Step One of Section 206";
    expect(pattern.test(argument)).toBe(false);
    expect(argument.includes("Determination")).toBe(true);
  });

  it("trims: genuine headings with trailing whitespace still match", () => {
    // Two of Order No. 2023's real headings carry a trailing space. Anchoring without
    // trimming under-counted them during design.
    const raw = "C.  Commission Determination ";
    expect(pattern.test(raw)).toBe(false);
    expect(pattern.test(normalizeHeading(raw))).toBe(true);
  });

  it.each([
    [DOCS.order2023, 47],
    [DOCS.order2023A, 31],
    [DOCS.order1920, 66],
    [DOCS.order1920A, 75],
    [DOCS.order1920B, 11],
  ])("%s → %i determination blocks", async (frDocNumber, expected) => {
    const d = await doc(frDocNumber);
    expect(countDeterminations(d.text, parseFrXml("<x/>").elements, pattern)).toBe(0); // sanity
    const { elements } = parseFrXml(await rawXml(frDocNumber));
    expect(countDeterminations(d.text, elements, pattern)).toBe(expected);
  });

  it.each([DOCS.nopr2214, DOCS.nopr2117])(
    "%s (proposed rule) → zero determination blocks",
    async (frDocNumber) => {
      const d = await doc(frDocNumber);
      expect(d.capabilities).not.toContain("T2");
    },
  );
});

describe("redline precondition", () => {
  const legend = FERC_RULEMAKING.redline!.legendPattern;

  it("recognises the declared legend", () => {
    expect(legend.test("Deletions are in brackets and additions are in italics.")).toBe(true);
  });

  it("does not fire on unrelated italic-heavy prose", () => {
    expect(legend.test("The Commission emphasises certain terms in italics throughout.")).toBe(
      false,
    );
  });
});

describe("input resolution", () => {
  it("accepts a docket identifier", () => {
    expect(resolveInput("RM22-14")).toEqual({ kind: "docket", docketId: "RM22-14" });
    expect(resolveInput("rm22-14")).toEqual({ kind: "docket", docketId: "RM22-14" });
  });

  it("accepts a bare FR document number", () => {
    expect(resolveInput("2024-06563")).toEqual({
      kind: "document",
      frDocNumber: "2024-06563",
    });
  });

  it("accepts Federal Register document URLs", () => {
    const url =
      "https://www.federalregister.gov/documents/2024/04/16/2024-06563/improvements-to-generator";
    expect(resolveInput(url)).toEqual({ kind: "document", frDocNumber: "2024-06563" });
  });

  it("accepts the full-text XML URL form", () => {
    const url =
      "https://www.federalregister.gov/documents/full_text/xml/2024/04/16/2024-06563.xml";
    expect(resolveInput(url)).toEqual({ kind: "document", frDocNumber: "2024-06563" });
  });

  it.each([
    "https://elibrary.ferc.gov/eLibrary/filelist?accession_num=20240321-3061",
    "https://www.regulations.gov/document/EPA-HQ-OAR-2023-0072-0001",
    "https://puc.hawaii.gov/dockets/",
    "",
    "   ",
  ])("rejects unsupported source %s", (input) => {
    expect(() => resolveInput(input)).toThrow(UnsupportedSourceError);
  });

  it("names what IS supported when rejecting", () => {
    try {
      resolveInput("https://elibrary.ferc.gov/x");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/federalregister\.gov/);
      expect((err as Error).message).toMatch(/docket identifier/i);
    }
  });
});

// Helper: re-read cached XML for element-level assertions.
async function rawXml(frDocNumber: string): Promise<string> {
  const { FileCache } = await import("../src/cache/file.js");
  const cached = await new FileCache().get(`xml/${frDocNumber}`);
  if (cached === null) throw new Error(`expected ${frDocNumber} to be cached by fixtures`);
  return cached;
}
