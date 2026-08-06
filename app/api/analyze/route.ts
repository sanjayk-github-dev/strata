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
  applyResiduals,
  officialUrl,
  STAGE_LABEL,
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
        const outline = doc.sections
          .filter((sec) => sec.depth <= 2 && sec.region === "preamble")
          .slice(0, 60)
          .map((sec) => ({
            id: sec.id,
            depth: sec.depth,
            title: sec.headingPath[sec.headingPath.length - 1] ?? "",
            span: sec.span,
          }));

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

        const { cards, coverage } = assembleCards(
          doc,
          determinations,
          materiality,
          rl.region?.span ?? null,
        );
        emit({ stage: "cards", detail: `${cards.length} changes to review`, done: true });

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
