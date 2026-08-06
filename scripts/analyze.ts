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
  resolveVersions,
  UnsupportedSourceError,
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
