#!/usr/bin/env tsx
/**
 * Run model-tier classification against a live provider.
 *
 *   npm run classify -- 2024-06563              # disposition + a sample of residuals
 *   npm run classify -- 2024-06563 --all        # every undecided group (costs more)
 *   npm run classify -- 2024-06563 --record     # also write cassettes for the test suite
 *
 * Works with any OpenAI-compatible provider. Configure in .env.local:
 *   LLM_API_KEY=…
 *   LLM_BASE_URL=https://api.groq.com/openai/v1     (default: OpenAI)
 *   LLM_MODEL=llama-3.3-70b-versatile               (default: gpt-4o-mini)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  CassetteLlmClient,
  HttpLlmClient,
  MissingLlmConfigError,
  resolveLlmConfig,
} from "../src/llm/index.js";
import {
  analyzeDocument,
  classifyDisposition,
  classifyEdits,
  classifyResiduals,
  deriveProvisionStatus,
  extractDeterminations,
  extractRedline,
} from "../src/pipeline/index.js";

/** Minimal .env.local loader — avoids a dependency for one file. */
function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m?.[1]) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const id = process.argv[2];
  if (!id) {
    console.error("usage: npm run classify -- <FR document number> [--all] [--record]");
    process.exit(2);
  }
  const all = process.argv.includes("--all");
  const record = process.argv.includes("--record");

  const cfg = resolveLlmConfig();
  if (!cfg) {
    console.error(`\n${new MissingLlmConfigError().message}\n`);
    process.exit(2);
  }

  const live = new HttpLlmClient(cfg);
  const llm = record
    ? new CassetteLlmClient(live.label, { live, record: true })
    : live;

  console.log(`\n  provider: ${live.label}${record ? "  (recording cassettes)" : ""}`);

  const doc = await analyzeDocument(id);
  console.log(`  ${doc.meta.frDocNumber} — ${doc.meta.status.toUpperCase()}\n`);

  // ---- T2: dispositions -------------------------------------------------
  const dets = extractDeterminations(doc);
  if (dets.length > 0) {
    const sample = all ? dets : dets.slice(0, 8);
    console.log(`  Dispositions (${sample.length} of ${dets.length} blocks)`);

    const tally: Record<string, number> = {};
    let escalated = 0;
    let incidents = 0;

    for (const det of sample) {
      const r = await classifyDisposition(doc, det, llm);
      const d = r.determination.disposition;
      tally[d] = (tally[d] ?? 0) + 1;
      if (r.escalated) escalated++;
      if (r.escalationReason === "provider-error") incidents++;

      const status = deriveProvisionStatus(doc.meta.status, d);
      const flag = r.escalated ? "⚠" : "✓";
      const head = det.headingPath.slice(-2).join(" › ").slice(0, 52).padEnd(52);
      console.log(`    ${flag} ${d.padEnd(12)} ${status.padEnd(9)} ${head}`);
      if (r.supportingQuote) {
        console.log(`         “${r.supportingQuote.replace(/\s+/g, " ").trim().slice(0, 92)}”`);
      }
    }
    const summary = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    console.log(`    → ${summary}  ·  ${escalated} escalated`);
    if (incidents > 0) {
      console.log(
        `    ⚠ ${incidents} block(s) were NEVER ANALYSED — the provider call failed. ` +
          `This is an outage, not a judgement.`,
      );
    }
    console.log();
  }

  // ---- T3: residual materiality ----------------------------------------
  const rl = extractRedline(doc);
  if (rl.region) {
    const m = classifyEdits(doc, rl.edits);
    const undecided = m.groups.filter((g) => g.result.materiality === "undecided");
    const limit = all ? undefined : 40;
    console.log(
      `  Residual materiality (${limit ? Math.min(limit, undecided.length) : undecided.length} of ${undecided.length} undecided groups)`,
    );

    const out = await classifyResiduals(doc, m.groups, llm, { limit });
    const tally: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    let escalated = 0;
    for (const r of out) {
      tally[r.materiality] = (tally[r.materiality] ?? 0) + 1;
      if (r.escalated) escalated++;
      if (r.escalationReason !== "none") {
        byReason[r.escalationReason] = (byReason[r.escalationReason] ?? 0) + 1;
      }
    }

    for (const r of out.filter((x) => x.materiality === "material").slice(0, 6)) {
      const b = r.group.beforeAfter.before.replace(/\s+/g, " ").trim().slice(0, 46);
      const a = r.group.beforeAfter.after.replace(/\s+/g, " ").trim().slice(0, 46);
      console.log(`    ⬤ ${r.reason.slice(0, 58)}`);
      console.log(`       − ${b}`);
      console.log(`       + ${a}`);
    }

    const summary = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    console.log(`    → ${summary}  ·  ${escalated} escalated`);
    const reasons = Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    if (reasons) console.log(`      escalation reasons: ${reasons}`);
    const never = byReason["provider-error"] ?? 0;
    if (never > 0) {
      console.log(
        `    ⚠ ${never} group(s) were NEVER ANALYSED — the provider call failed. ` +
          `This is an outage, not a judgement.`,
      );
    }

    // Combined funnel: rules first, model on the remainder.
    const f = m.funnel;
    const modelMaterial = tally["material"] ?? 0;
    const stillUndecided = tally["undecided"] ?? 0;
    console.log(
      `\n  Combined: ${f.material} material by rule + ${modelMaterial} by model · ` +
        `${stillUndecided} still need expert review`,
    );
  }

  console.log();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
