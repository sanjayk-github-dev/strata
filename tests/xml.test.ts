/**
 * XML projection tests.
 *
 * Parsing itself is `sax`'s job. What is tested here is our *projection* — the rules
 * turning parser events into plain text with offsets. Those rules are load-bearing for
 * citation verification: an offset that shifts by one breaks every citation downstream,
 * and it would break silently.
 *
 * The BLOCK and SKIP_CONTENT tag lists in xml.ts are hand-curated, which makes them the
 * most plausible source of a future regression. Invariant I3 (contiguous paragraph
 * numbering) is the runtime guard; these are the unit guards.
 */

import { describe, expect, it } from "vitest";

import { normalizeHeading, parseFrXml } from "../src/pipeline/xml.js";

const text = (xml: string) => parseFrXml(xml).text;

describe("entity decoding", () => {
  it.each([
    ["<R><P>a &lt; b &amp; c &gt; d</P></R>", "a < b & c > d"],
    ["<R><P>fee &#8805; 20 MW</P></R>", "fee ≥ 20 MW"],
    ["<R><P>Customer&#8217;s LGIA</P></R>", "Customer’s LGIA"],
    ["<R><P>&#167; 35.28</P></R>", "§ 35.28"],
    ["<R><P>&quot;quoted&quot;</P></R>", '"quoted"'],
  ])("%s", (xml, expected) => {
    expect(text(xml).trim()).toBe(expected);
  });

  it("decodes the entity that appears most in real source", () => {
    // &amp; dominates the corpus (73 occurrences in Order 2023-A alone).
    expect(text("<R><P>Rates &amp; Charges</P></R>").trim()).toBe("Rates & Charges");
  });
});

describe("mixed content keeps offsets exact", () => {
  it("inline elements contribute text without disturbing surrounding offsets", () => {
    const { text: t, elements } = parseFrXml('<R><P>a &amp; <E T="03">b&#8805;c</E> d</P></R>');
    expect(t).toBe("a & b≥c d\n");

    const e = elements.find((x) => x.tag === "E")!;
    // This is the property the whole redline branch rests on: an <E> span must slice
    // back to exactly the italicised text, after entity decoding.
    expect(t.slice(e.span[0], e.span[1])).toBe("b≥c");
  });

  it("every element span round-trips for nested structure", () => {
    const { text: t, elements } = parseFrXml(
      '<R><SUPLINF><HD SOURCE="HD1">Head</HD><P>one <E T="03">two</E> three</P></SUPLINF></R>',
    );
    for (const el of elements) {
      expect(el.span[0]).toBeGreaterThanOrEqual(0);
      expect(el.span[1]).toBeLessThanOrEqual(t.length);
      expect(el.span[1]).toBeGreaterThanOrEqual(el.span[0]);
    }
    const hd = elements.find((x) => x.tag === "HD")!;
    expect(t.slice(hd.span[0], hd.span[1]).trim()).toBe("Head");
  });
});

describe("projection rules", () => {
  it("suppresses page-break content entirely", () => {
    // <PRTPAGE P="27123"/> carries a page number that is not part of the prose. Emitting
    // it would inject digits mid-sentence and corrupt quotes.
    expect(text('<R><P>x<PRTPAGE P="27123"/>y</P></R>').trim()).toBe("xy");
  });

  it("separates block elements so adjacent text never merges", () => {
    // If a block tag were missing from the BLOCK set, these would run together as
    // "onetwo" and the paragraph-number regex could stop matching — the exact failure
    // invariant I3 exists to catch.
    const t = text("<R><SUPLINF><P>one</P><P>two</P></SUPLINF></R>");
    expect(t).toContain("one\n");
    expect(t).not.toContain("onetwo");
  });

  it("keeps numbered paragraphs anchorable at line start", () => {
    // The convention's pattern is anchored with ^, so block separation is what makes
    // paragraph numbering detectable at all.
    const t = text("<R><SUPLINF><P>1. First.</P><P>2. Second.</P></SUPLINF></R>");
    const lines = t.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]!.trim()).toMatch(/^1\.\s/);
    expect(lines[1]!.trim()).toMatch(/^2\.\s/);
  });

  it("records ancestry, which paragraph scoping depends on", () => {
    // <P> directly under <SUPLINF> is a numbered paragraph; <P> inside <FTNT> is not.
    const { elements } = parseFrXml(
      "<R><SUPLINF><P>1. Body.</P><FTNT><P>1. Footnote.</P></FTNT></SUPLINF></R>",
    );
    const ps = elements.filter((e) => e.tag === "P");
    expect(ps).toHaveLength(2);
    expect(ps[0]!.ancestors.at(-1)).toBe("SUPLINF");
    expect(ps[1]!.ancestors.at(-1)).toBe("FTNT");
    expect(ps[1]!.ancestors).toContain("FTNT");
  });

  it("records attributes, which capability detection depends on", () => {
    const { elements } = parseFrXml('<R><HD SOURCE="HD2">x</HD><E T="03">y</E></R>');
    expect(elements.find((e) => e.tag === "HD")!.attrs["SOURCE"]).toBe("HD2");
    expect(elements.find((e) => e.tag === "E")!.attrs["T"]).toBe("03");
  });
});

describe("heading normalisation", () => {
  it("collapses the internal whitespace real headings carry", () => {
    // Genuine FERC headings contain newlines and indentation:
    // "9.2 \n        Response to Notifications".
    expect(normalizeHeading("9.2 \n        Response to Notifications")).toBe(
      "9.2 Response to Notifications",
    );
  });

  it("trims trailing whitespace — the under-count bug from design", () => {
    // Two of Order No. 2023's genuine determination headings carry a trailing space.
    // Anchoring /Determination$/ without trimming missed them.
    expect(normalizeHeading("C.  Commission Determination ")).toBe("C. Commission Determination");
  });
});
