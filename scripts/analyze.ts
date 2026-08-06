#!/usr/bin/env tsx
/**
 * Strata CLI — runs the pipeline with no web server and no database.
 *
 *   npm run analyze -- RM22-14
 *   npm run analyze -- 2024-06563
 *   npm run analyze -- https://www.federalregister.gov/documents/2024/04/16/2024-06563/...
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { renderReport } from "../src/report/html.js";
import {
  analyzeDocument,
  classifyEdits,
  bodyParagraphs,
  citeParagraph,
  assembleCards,
  crossRefStats,
  extractDeterminations,
  extractRedline,
  gateClaims,
  groupAdjacentEdits,
  resolveVersions,
  UnsupportedSourceError,
  type Claim,
} from "../src/pipeline/index.js";
import type { ParsedDocument } from "../src/pipeline/index.js";

const STATUS_LABEL = { proposed: "PROPOSED", final: "FINAL", amended: "AMENDED" } as const;

function summarize(doc: ParsedDocument): void {
  const body = bodyParagraphs(doc);
  const separate = doc.paragraphs.length - body.length;
  const appendices = doc.sections.filter(
    (s) => s.depth === 1 && /^Appendix\s/i.test(s.headingPath[0] ?? ""),
  );

  console.log(`\n  ${doc.meta.frDocNumber}  ${STATUS_LABEL[doc.meta.status]}`);
  console.log(`  ${doc.meta.title.slice(0, 90)}`);
  console.log(`  ${doc.meta.publicationDate} · ${doc.meta.pageLength ?? "?"}pp · ${doc.meta.action}`);
  console.log(`  convention: ${doc.conventionId ?? "(none registered for this agency)"}`);
  console.log(
    `  text: ${doc.text.length.toLocaleString()} chars · ` +
      `sections: ${doc.sections.length} (${appendices.length} top-level appendices)`,
  );
  console.log(
    `  paragraphs: ${body.length} body` +
      (separate > 0 ? ` (+${separate} in separate opinions)` : ""),
  );

  console.log("  capabilities:");
  for (const n of doc.capabilityNotes) {
    console.log(`    ${n.available ? "✓" : "·"} ${n.tier}  ${n.reason}`);
  }

  // Citation self-check (FR13). Every paragraph is cited and re-verified against source.
  // Deterministic instrumentation — no labeled data, no model involved.
  const claims: Claim[] = [];
  for (let i = 0; i < doc.paragraphs.length; i++) {
    const c = citeParagraph(doc, i);
    if (c) claims.push({ text: `¶${c.paragraphNumber}`, citation: c });
  }
  const gate = gateClaims(doc, claims);
  const pct = (gate.verificationRate * 100).toFixed(1);
  console.log(
    `  citations: ${gate.passed.length}/${claims.length} verified (${pct}%)` +
      (gate.suppressed.length > 0 ? ` · ${gate.suppressed.length} suppressed` : ""),
  );

  // T2 — determination blocks. Structure only; dispositions are classified in Phase 6.
  const dets = extractDeterminations(doc);
  if (dets.length > 0) {
    const stats = crossRefStats(doc);
    console.log(
      `  determinations: ${dets.length} blocks · ` +
        `${(stats.coverage * 100).toFixed(0)}% carry a provision reference ` +
        `(${stats.totalRefs} refs, ${stats.filteredStatutory} statutory filtered)`,
    );
    for (const det of dets.slice(0, 3)) {
      const size = det.citation.span[1] - det.citation.span[0];
      const ctx = det.headingPath.slice(-2).join(" › ");
      console.log(
        `      · ${ctx.slice(0, 62).padEnd(62)} ${String(size).padStart(6)}ch  ` +
          `${det.crossRefs.slice(0, 4).join(",") || "—"}`,
      );
    }
    if (dets.length > 3) console.log(`      … ${dets.length - 3} more`);
  }

  // T3 — redline. Deterministic: the agency published the markup, we parse it.
  const rl = extractRedline(doc);
  if (rl.region) {
    const groups = groupAdjacentEdits(doc, rl.edits);
    const d = rl.diagnostics;
    console.log(
      `  redline: ${rl.edits.length} edits ` +
        `(${d.additions} additions, ${d.deletions} deletions) → ${groups.length} logical changes`,
    );
    console.log(
      `      excluded: ${d.italicsInFootnotes} footnote italics, ` +
        `${d.bracketsInFootnotes} footnote brackets · unmatched brackets: ${d.unmatchedBrackets}`,
    );

    // Phase 5 — rule-tier materiality. The funnel.
    const f = classifyEdits(doc, rl.edits).funnel;
    console.log(
      `  materiality: ${f.material} material · ${f.editorial} editorial · ` +
        `${f.undecided} undecided → ${(f.ruleCoverage * 100).toFixed(1)}% decided by rule`,
    );
    const asm = assembleCards(doc, dets, classifyEdits(doc, rl.edits), rl.region.span);
    const cv = asm.coverage;
    console.log(
      `  cards: ${cv.totalCards} (${cv.byPriority.material} material · ` +
        `${cv.byPriority["needs-review"]} need review · ${cv.byPriority.clarifying} clarifying)`,
    );
    console.log(
      `      joins: ${cv.joinedExplicit} explicit · ${cv.joinedImplicit} implicit · ` +
        `${cv.unjoinedDeterminations} determinations with no textual footprint · ` +
        `${cv.editOnlyCards} edits nothing discusses`,
    );

    const top = Object.entries(f.byRule)
      .filter(([k]) => k !== "none")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    console.log(`      rules fired: ${top}`);
  } else if (rl.unavailableReason) {
    console.log(`  redline: unavailable — ${rl.unavailableReason.split(".")[0]}.`);
  }
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: npm run analyze -- <docket-id | FR document number | FR URL>");
    process.exit(2);
  }

  let versions;
  try {
    versions = await resolveVersions(input);
  } catch (err) {
    if (err instanceof UnsupportedSourceError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (versions.length === 0) {
    console.error(`\n  No Federal Register documents found for "${input}".\n`);
    process.exit(1);
  }

  console.log(`\n  ${input} — ${versions.length} published version(s)\n`);
  for (const v of versions) {
    const label = STATUS_LABEL[v.status].padEnd(8);
    console.log(
      `    ${v.publicationDate}  ${label} ${v.frDocNumber}  ` +
        `${String(v.pageLength ?? "?").padStart(4)}pp  ${v.title.slice(0, 58)}`,
    );
  }

  const reportPath = process.argv[3];

  // Analyse substantive documents; notices carry no analysable structure.
  const substantive = versions.filter((v) => v.type === "Rule" || v.type === "Proposed Rule");
  console.log(`\n  analysing ${substantive.length} rule document(s)…`);

  for (const v of substantive) {
    const parsed = await analyzeDocument(v.frDocNumber);
    summarize(parsed);

    if (reportPath) {
      const rl = extractRedline(parsed);
      const claims: Claim[] = [];
      for (let i = 0; i < parsed.paragraphs.length; i++) {
        const c = citeParagraph(parsed, i);
        if (c) claims.push({ text: `¶${c.paragraphNumber}`, citation: c });
      }
      const out = reportPath.replace(/\.html?$/, "") + `-${v.frDocNumber}.html`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        renderReport({
          doc: parsed,
          materiality: classifyEdits(parsed, rl.edits),
          determinations: extractDeterminations(parsed),
          verificationRate: gateClaims(parsed, claims).verificationRate,
        }),
        "utf8",
      );
      console.log(`  report: ${out}`);
    }
  }
  console.log();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
