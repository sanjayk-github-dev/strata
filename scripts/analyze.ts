#!/usr/bin/env tsx
/**
 * Strata CLI — runs the pipeline with no web server and no database.
 *
 *   npm run analyze -- RM22-14
 *   npm run analyze -- 2024-06563
 *   npm run analyze -- https://www.federalregister.gov/documents/2024/04/16/2024-06563/...
 */

import {
  analyzeDocument,
  bodyParagraphs,
  citeParagraph,
  crossRefStats,
  extractDeterminations,
  gateClaims,
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

  // Analyse substantive documents; notices carry no analysable structure.
  const substantive = versions.filter((v) => v.type === "Rule" || v.type === "Proposed Rule");
  console.log(`\n  analysing ${substantive.length} rule document(s)…`);

  for (const v of substantive) {
    summarize(await analyzeDocument(v.frDocNumber));
  }
  console.log();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
