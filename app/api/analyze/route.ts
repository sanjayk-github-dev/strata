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
  assembleCards,
  classifyDisposition,
  classifyEdits,
  classifyResiduals,
  crossRefStats,
  extractDeterminations,
  extractRedline,
  gateClaims,
  citeParagraph,
  type Claim,
  type Determination,
} from "@/src/pipeline/index";
import { HttpLlmClient, resolveLlmConfig } from "@/src/llm/index";

export const runtime = "nodejs";
export const maxDuration = 300;

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
      const emit = (obj: Stage | Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));

      try {
        emit({ stage: "fetching", detail: docNumber });
        const doc = await analyzeDocument(docNumber);
        emit({
          stage: "parsed",
          detail: `${doc.text.length.toLocaleString()} chars · ${doc.sections.length} sections`,
          done: true,
        });

        emit({
          stage: "capabilities",
          detail: doc.capabilities.join(" + "),
          done: true,
          capabilities: doc.capabilityNotes,
          meta: doc.meta,
        });

        // Citation self-check — deterministic instrumentation, no labels needed (FR13).
        const claims: Claim[] = [];
        for (let i = 0; i < doc.paragraphs.length; i++) {
          const c = citeParagraph(doc, i);
          if (c) claims.push({ text: `¶${c.paragraphNumber}`, citation: c });
        }
        const verificationRate = gateClaims(doc, claims).verificationRate;

        let determinations: Determination[] = extractDeterminations(doc);
        emit({
          stage: "determinations",
          detail: `${determinations.length} blocks · ${(crossRefStats(doc).coverage * 100).toFixed(0)}% cross-referenced`,
          done: true,
        });

        const rl = extractRedline(doc);
        emit({
          stage: "redline",
          detail: rl.region
            ? `${rl.edits.length} edits`
            : (rl.unavailableReason ?? "unavailable"),
          done: true,
        });

        const materiality = classifyEdits(doc, rl.edits);
        emit({
          stage: "rules",
          detail: `${materiality.funnel.material} material · ${materiality.funnel.editorial} editorial · ${materiality.funnel.undecided} undecided`,
          done: true,
        });

        // ---- model tier, when configured ----
        const cfg = useModel ? resolveLlmConfig() : null;
        if (cfg) {
          const llm = new HttpLlmClient(cfg);
          emit({ stage: "model", detail: `classifying dispositions via ${llm.label}` });

          const classified: Determination[] = [];
          for (const [i, det] of determinations.entries()) {
            const r = await classifyDisposition(doc, det, llm);
            classified.push(r.determination);
            if (i % 5 === 0 || i === determinations.length - 1) {
              emit({ stage: "model", detail: `dispositions ${i + 1}/${determinations.length}` });
            }
          }
          determinations = classified;

          const residuals = await classifyResiduals(doc, materiality.groups, llm, { limit: 60 });
          const decided = residuals.filter((r) => r.materiality !== "undecided").length;
          emit({
            stage: "model",
            detail: `${determinations.filter((d) => d.disposition !== "unclassified").length} dispositions · ${decided} residuals decided`,
            done: true,
          });
        } else {
          emit({
            stage: "model",
            detail: useModel
              ? "no provider configured — deterministic tiers only"
              : "skipped",
            done: true,
          });
        }

        const { cards, coverage } = assembleCards(
          doc,
          determinations,
          materiality,
          rl.region?.span ?? null,
        );
        emit({ stage: "cards", detail: `${cards.length} cards`, done: true });

        // Cards without full quote text: the client fetches spans on demand (FR9), which
        // is what keeps responses small enough to be served anywhere.
        emit({
          result: {
            meta: doc.meta,
            capabilities: doc.capabilityNotes,
            verificationRate,
            funnel: materiality.funnel,
            coverage,
            redline: { available: !!rl.region, reason: rl.unavailableReason ?? null },
            cards: cards.map((c) => ({
              id: c.id,
              title: c.title,
              priority: c.priority,
              escalated: c.escalated,
              joinKind: c.joinKind,
              provisionRefs: c.provisionRefs,
              provisionStatus: c.provisionStatus,
              effect: c.effect,
              disposition: c.determination?.disposition ?? null,
              editCount: c.edits.length,
              edits: c.edits.slice(0, 12).map((e) => ({
                kind: e.kind,
                text: e.text.slice(0, 300),
                materiality: e.materiality,
                ruleId: e.ruleId ?? null,
                span: e.citation.span,
              })),
              citations: c.citations.slice(0, 12).map((x) => ({
                span: x.span,
                sectionId: x.sectionId,
                paragraphNumber: x.paragraphNumber,
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
