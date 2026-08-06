/**
 * Run the pipeline over one document, streaming progress.
 *
 * Streamed rather than awaited because a cold run parses 2.3 MB of XML and may make model
 * calls; a reviewer watching a blank page for thirty seconds has no idea whether anything
 * is happening or which stage is slow. Each stage emits an NDJSON line as it completes.
 *
 * Model classification runs only when a provider is configured. Without one the route
 * still returns everything the deterministic tiers produce, and says so — the same
 * degrade-in-coverage-never-in-confidence policy applied to configuration.
 */
import {
  analyzeDocument,
  buildBriefing,
  CATEGORY_LABEL,
  generateStatement,
  classifyDisposition,
  classifyEdits,
  classifyResiduals,
  crossRefStats,
  extractDeterminations,
  applyResiduals,
  officialUrl,
  STAGE_LABEL,
  CATEGORY_ORDER,
  substantiveOutline,
  TIER_LABEL,
  extractRedline,
  gateClaims,
  citeParagraph,
  type Claim,
  type Determination,
} from "@/src/pipeline/index";
import { cachedLlmFromEnv } from "@/src/llm/index";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Word count without allocating an array over a multi-megabyte string. */
function approxWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const space = ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
    if (!space && !inWord) words++;
    inWord = !space;
  }
  return words;
}

/**
 * Collapse edits that make the same substitution over and over.
 *
 * A term renamed throughout a pro forma agreement produces one edit per occurrence:
 * "Applicable Reliability Council" → "Electric Reliability Organization" appears dozens of
 * times in Order No. 2023's Article 1. Listing each one buries the handful of edits that
 * are actually distinct. The count is kept, so nothing is hidden — only repeated.
 */
function collapseRepeats(
  edits: ReadonlyArray<{ kind: string; text: string; materiality?: string }>,
): Array<{ kind: string; text: string; materiality?: string; repeats: number }> {
  const out: Array<{ kind: string; text: string; materiality?: string; repeats: number }> = [];
  const seen = new Map<string, number>();
  for (const e of edits) {
    const key = `${e.kind}:${e.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
    const at = seen.get(key);
    if (at !== undefined) {
      out[at]!.repeats++;
      continue;
    }
    seen.set(key, out.length);
    out.push({
      kind: e.kind,
      text: e.text.slice(0, 260),
      materiality: e.materiality,
      repeats: 1,
    });
  }
  return out;
}

interface Stage {
  stage: string;
  detail?: string;
  done?: boolean;
}

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const docNumber = p.get("doc");
  const useModel = p.get("model") !== "0";
  if (!docNumber) return new Response("Provide ?doc=", { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: Stage | Record<string, unknown>) => {
        const stage = (obj as Stage).stage;
        const payload = stage ? { ...obj, label: STAGE_LABEL[stage] ?? stage } : obj;
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        emit({ stage: "fetching", detail: `Federal Register ${docNumber}` });
        const doc = await analyzeDocument(docNumber);
        emit({
          stage: "parsed",
          detail: `${approxWords(doc.text).toLocaleString()} words · ${doc.sections.length} sections`,
          done: true,
        });

        emit({
          stage: "capabilities",
          detail: doc.capabilities.map((t) => TIER_LABEL[t]).join(" · "),
          done: true,
          capabilities: doc.capabilityNotes.map((n) => ({ ...n, label: TIER_LABEL[n.tier] })),
          meta: doc.meta,
        });

        // Citation self-check — deterministic instrumentation, no labels needed (FR13).
        const claims: Claim[] = [];
        for (let i = 0; i < doc.paragraphs.length; i++) {
          const c = citeParagraph(doc, i);
          if (c) claims.push({ text: `¶${c.paragraphNumber}`, citation: c });
        }
        const gate = gateClaims(doc, claims);
        const verificationRate = gate.verificationRate;
        const claimsChecked = claims.length;

        /**
         * The document's own top-level structure.
         *
         * For a proposed rule this is the only substantive analysis available — there are
         * no determinations to find and no redline to parse — but the outline is the
         * agency's own account of what it is proposing, and it is worth showing rather
         * than presenting a page of zeroes.
         */
        const outline = substantiveOutline(doc);

        let determinations: Determination[] = extractDeterminations(doc);
        emit({
          stage: "determinations",
          detail: `${determinations.length} determinations · ${(crossRefStats(doc).coverage * 100).toFixed(0)}% cite a provision`,
          done: true,
        });

        const rl = extractRedline(doc);
        emit({
          stage: "redline",
          detail: rl.region
            ? `${rl.edits.length.toLocaleString()} text changes found`
            : "This document publishes no marked-up text",
          done: true,
        });

        let materiality = classifyEdits(doc, rl.edits);
        emit({
          stage: "rules",
          detail:
            `${materiality.funnel.material} change an obligation · ` +
            `${materiality.funnel.editorial} editorial only · ` +
            `${materiality.funnel.undecided} need judgement`,
          done: true,
        });

        // ---- model tier, when configured ----
        const llm = useModel ? cachedLlmFromEnv() : null;
        if (llm) {
          emit({ stage: "model", detail: `Reading determinations (${llm.label})` });

          const classified: Determination[] = [];
          for (const [i, det] of determinations.entries()) {
            const r = await classifyDisposition(doc, det, llm);
            classified.push(r.determination);
            if (i % 5 === 0 || i === determinations.length - 1) {
              emit({
                stage: "model",
                detail: `Determination ${i + 1} of ${determinations.length}`,
              });
            }
          }
          determinations = classified;

          const residuals = await classifyResiduals(doc, materiality.groups, llm, { limit: 60 });
          // Fold the judgements in. Computing them and discarding them would make the
          // whole model tier decorative — the cards would still say "needs review".
          materiality = applyResiduals(materiality, residuals);

          const read = determinations.filter((d) => d.disposition !== "unclassified").length;
          const settled = residuals.filter(
            (r) => r.materiality !== "undecided" && !r.escalated,
          ).length;
          emit({
            stage: "model",
            detail: `${read} determinations read · ${settled} further changes classified`,
            done: true,
          });
        } else {
          emit({
            stage: "model",
            detail: useModel
              ? "No model configured — automatic screening only"
              : "Skipped",
            done: true,
          });
        }

        const briefing = buildBriefing(doc, determinations, materiality);

        // Statements for the changes a reader will actually open first. Bounded on
        // purpose: one model call per provision, and the briefing is useful without them.
        if (llm) {
          // Spread across categories rather than taking the global top 25. The briefing is
          // ordered by category, so a flat slice spent the entire budget on deadlines and
          // left every other section of the page unsummarised.
          const top = CATEGORY_ORDER.flatMap((cat) =>
            briefing.changes
              .filter((c) => c.category === cat && c.priority === "material" && c.edits.length > 0)
              .slice(0, 4),
          ).slice(0, 24);
          for (const [i, change] of top.entries()) {
            const group = materiality.groups.find((g) =>
              g.group.edits.some((e) => change.edits.some((x) => x.id === e.id)),
            );
            if (!group) continue;
            const r = await generateStatement(
              change.provision,
              group.beforeAfter.before,
              group.beforeAfter.after,
              change.edits,
              llm,
            );
            if (r) {
              change.statement = r.statement;
              change.statementEvidence = r.evidence;
            }
            if (i % 5 === 0) {
              emit({ stage: "summarise", detail: `Change ${i + 1} of ${top.length}` });
            }
          }
          const written = top.filter((c) => c.statement).length;
          emit({
            stage: "summarise",
            detail: `${written} of ${top.length} summarised`,
            done: true,
          });
        }

        emit({
          stage: "cards",
          detail: `${briefing.changes.length} affected provisions`,
          done: true,
        });

        // Cards without full quote text: the client fetches spans on demand (FR9), which
        // is what keeps responses small enough to be served anywhere.
        emit({
          result: {
            meta: { ...doc.meta, officialUrl: officialUrl(doc.meta.htmlUrl, doc.meta.frDocNumber) },
            capabilities: doc.capabilityNotes.map((n) => ({ ...n, label: TIER_LABEL[n.tier] })),
            verificationRate,
            claimsChecked,
            outline,
            funnel: materiality.funnel,
            provisionsChanged: briefing.changes.length,
            determinationCount: determinations.length,
            redline: { available: !!rl.region, reason: rl.unavailableReason ?? null },
            categories: CATEGORY_LABEL,
            byCategory: briefing.byCategory,
            editorialOnlyProvisions: briefing.editorialOnlyProvisions,
            changes: briefing.changes.map((c) => ({
              id: c.id,
              provision: c.provision,
              provisionNumber: c.provisionNumber,
              provisionPath: c.provisionPath,
              category: c.category,
              priority: c.priority,
              escalated: c.escalated,
              provisionStatus: c.provisionStatus,
              statement: c.statement ?? null,
              statementEvidence: c.statementEvidence ?? null,
              disposition: c.determinations[0]?.disposition ?? null,
              determinationCount: c.determinations.length,
              editCount: c.edits.length,
              edits: collapseRepeats(c.edits).slice(0, 8),
              citations: c.citations.slice(0, 4).map((x) => ({
                span: x.span,
                sectionId: x.sectionId,
              })),
            })),
          },
        });
      } catch (err) {
        emit({ error: err instanceof Error ? err.message : "Analysis failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
