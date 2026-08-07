/**
 * The static HTML report.
 *
 * The CLI's surface drifted once already: the workspace moved to a provision-level
 * briefing while the report went on grouping by materiality rule, so the two disagreed
 * about what the product's output even was. These tests assert that the report renders
 * the same briefing the workspace does, in the same order and the same units.
 */

import { describe, expect, it } from "vitest";

import {
  buildBriefing,
  CATEGORY_LABEL,
  classifyEdits,
  extractComplianceDeadlines,
  extractDeterminations,
  extractRedline,
} from "../src/pipeline/index.js";
import { renderReport } from "../src/report/html.js";
import { DOCS, doc } from "./fixtures.js";

async function report(frDocNumber: string) {
  const d = await doc(frDocNumber);
  const materiality = classifyEdits(d, extractRedline(d).edits);
  const determinations = extractDeterminations(d);
  return {
    d,
    materiality,
    determinations,
    briefing: buildBriefing(d, determinations, materiality),
    html: renderReport({
      doc: d,
      materiality,
      determinations,
      verificationRate: 1,
      complianceDeadlines: extractComplianceDeadlines(d, determinations),
    }),
  };
}

describe("the report renders the briefing, not the old card shape", () => {
  it("groups by impact category, in the display order", async () => {
    const { html, briefing } = await report(DOCS.order2023);
    const positions = (Object.keys(briefing.byCategory) as Array<keyof typeof CATEGORY_LABEL>)
      .filter((c) => briefing.byCategory[c] > 0)
      .map((c) => html.indexOf(CATEGORY_LABEL[c]));

    expect(positions.every((p) => p >= 0)).toBe(true);
    // Deadlines first, other changes last — the same order the workspace uses.
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("leads each provision with the text as amended, then the redline", async () => {
    const { html } = await report(DOCS.order2023);
    expect(html).toContain("As adopted");
    expect(html).toContain("What changed");
    expect(html.indexOf("As adopted")).toBeLessThan(html.indexOf("What changed"));
    // And the leading deadline passage really carries its deadline.
    expect(html).toMatch(/one hundred fifty \(150\) Calendar Days/);
  });

  it("counts revisions, not pieces of markup", async () => {
    const { html, materiality } = await report(DOCS.order2023);
    const f = materiality.funnel;
    expect(html).toContain(`${f.revisions.material + f.revisions.undecided}`);
    expect(html).toContain("revisions to review");
    // The edit total is the conservation check, not something the reader is shown.
    expect(html).not.toContain("redline edits");
  });

  it("surfaces the compliance filing deadline", async () => {
    const { html } = await report(DOCS.order2023);
    expect(html).toContain("Compliance filing due 2023-12-05");
  });

  it("keeps the filtered remainder inspectable (PRD §6, principle 3)", async () => {
    const { html } = await report(DOCS.order2023);
    expect(html).toContain("Filtered out as editorial");
  });
});

describe("documents that brief differently", () => {
  it("briefs from determinations alone where there is no redline", async () => {
    const { html, briefing } = await report(DOCS.order1920);
    expect(briefing.editBackedProvisions).toBe(0);
    expect(html).toContain("provisions changed");
    expect(html).toContain("Compliance filing due 2025-06-12");
    // Nothing claims a text change that did not happen.
    expect(html).toContain("no change to the regulatory text");
  });

  it("shows a proposed rule's own outline rather than a page of zeroes", async () => {
    const { html, briefing } = await report(DOCS.nopr2214);
    expect(briefing.changes).toHaveLength(0);
    expect(html).toContain("What this document proposes");
    expect(html).toContain("Proposed Reforms");
    // A NOPR directs no compliance filing.
    expect(html).not.toContain("Compliance filing due");
  });
});

describe("the report is self-contained and honest about what it is", () => {
  it("references no external stylesheet, script, or font", async () => {
    const { html } = await report(DOCS.order2023A);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("says the one-sentence summaries are missing, rather than implying none exist", async () => {
    // The report runs with no model provider by design. Silently omitting the statements
    // would read as "this change has nothing worth saying about it".
    const { html } = await report(DOCS.order2023A);
    expect(html).toMatch(/requires a model provider/i);
  });

  it("escapes regulatory text rather than letting it break the document", async () => {
    // Every ampersand the renderer emits comes from `esc`, so a bare one is text that
    // reached the page unescaped — the same hole that would let source text close a tag.
    const { html } = await report(DOCS.order2023);
    const bare = [...html.matchAll(/&(?!(?:amp|lt|gt|quot|#39|#\d+);)/g)];
    expect(bare.map((m) => html.slice(m.index, m.index! + 20))).toEqual([]);

    // And the markup the report emits around that text stays balanced.
    const count = (re: RegExp) => (html.match(re) ?? []).length;
    expect(count(/<del>/g)).toBe(count(/<\/del>/g));
    expect(count(/<ins>/g)).toBe(count(/<\/ins>/g));
  });
});
