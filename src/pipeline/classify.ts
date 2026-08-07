/**
 * Model-tier classification — the first and only point a model enters the pipeline.
 *
 * Two jobs, both narrow:
 *   1. Disposition of a determination block (T2) — necessary because agency vocabulary is
 *      not formulaic. FERC writes "we sustain", "we clarify", "we set aside", and never
 *      "grant/deny rehearing". Phrase frequency is a prior, not a classifier.
 *   2. Materiality of the edits the rule tier declined (T3) — the genuine judgement calls.
 *
 * Everything the model returns is either constrained to a closed label set or checked
 * against source. Invalid output escalates; it never throws, and it never becomes a
 * silent default. See docs/TDD.md §1.
 */

import { locateQuote } from "./citation.js";
import { deriveConfidence } from "./card.js";
import type { ClassifiedGroup, MaterialityResult } from "./materiality.js";
import type {
  Confidence,
  Determination,
  Disposition,
  Edit,
  Materiality,
  ParsedDocument,
} from "./types.js";
import { LlmError, type LlmClient } from "../llm/types.js";

/**
 * Why an item was escalated.
 *
 * The distinction matters more than it looks. "The model judged this ambiguous" is the
 * product working — escalate rather than guess. "The provider rate-limited us" is an
 * incident. Reporting both as a bare escalation count hides an outage behind a feature,
 * and a reviewer would have no way to tell that half the document was never analysed.
 */
export type EscalationReason =
  | "none"
  | "ambiguous"
  | "ungrounded"
  | "invalid-output"
  | "omitted"
  | "provider-error";

const DISPOSITIONS: readonly Disposition[] = [
  "affirmed",
  "clarified",
  "modified",
  "set-aside",
  "sustained",
];

const MATERIALITIES: readonly Materiality[] = ["material", "clarifying", "editorial"];

/**
 * How much of a determination block to send.
 *
 * Blocks run to ~36,000 characters. Dispositions are stated near the top ("We affirm…",
 * "We are not persuaded…"), so a bounded head keeps cost proportionate. The trade is
 * explicit: a disposition stated only in a long block's tail would be missed, which is
 * why an ungrounded answer escalates rather than being trusted.
 */
const BLOCK_HEAD_CHARS = 6000;

/** Tolerate providers that wrap JSON in markdown fences — several compatible ones do. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: the outermost JSON object or array in the text.
    const m = candidate.match(/[[{][\s\S]*[\]}]/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Disposition classification (T2)
// ---------------------------------------------------------------------------

const DISPOSITION_SYSTEM = `You classify how a regulatory agency disposed of an issue in a rulemaking order.

Choose exactly one disposition:
- "affirmed"   the agency upheld its prior position without changing it
- "sustained"  the agency rejected a challenge; the prior position stands
- "clarified"  the agency explained what existing text means without changing it
- "modified"   the agency changed a requirement
- "set-aside"  the agency withdrew or reopened a prior requirement

Respond with JSON only:
{"disposition": "<one of the five>", "quote": "<a short verbatim sentence from the text supporting this>", "confidence": <0.0-1.0>}

The quote MUST be copied verbatim from the supplied text. Do not paraphrase, correct, or
shorten mid-sentence. If no sentence clearly supports a disposition, return
{"disposition": "unclear", "quote": "", "confidence": 0.0}.`;

export interface ClassifiedDetermination {
  determination: Determination;
  confidence: Confidence;
  escalated: boolean;
  escalationReason: EscalationReason;
  /** Present when the model's supporting quote verified against source. */
  supportingQuote?: string;
  reason: string;
}

export async function classifyDisposition(
  doc: ParsedDocument,
  determination: Determination,
  llm: LlmClient,
): Promise<ClassifiedDetermination> {
  const [start, end] = determination.citation.span;
  const body = doc.text.slice(start, Math.min(end, start + BLOCK_HEAD_CHARS));

  let parsed: unknown = null;
  try {
    const res = await llm.complete({
      system: DISPOSITION_SYSTEM,
      json: true,
      temperature: 0,
      user: `Heading: ${determination.headingPath.slice(-3).join(" > ")}\n\n---\n${body}\n---`,
    });
    parsed = extractJson(res.text);
  } catch (err) {
    // A provider failure must not take down the pipeline — but it is reported as an
    // incident, not as a judgement of ambiguity.
    const detail = err instanceof LlmError ? ` (${err.message})` : "";
    return unclassified(
      determination,
      `Provider call failed${detail}; this block was never analysed.`,
      "provider-error",
    );
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const raw = typeof obj["disposition"] === "string" ? obj["disposition"] : "";
  const disposition = DISPOSITIONS.find((d) => d === raw);

  if (!disposition) {
    // Out-of-vocabulary output is escalated, never coerced into the nearest label.
    return unclassified(
      determination,
      raw === "unclear"
        ? "The model found no passage clearly stating a disposition."
        : `Model returned an unrecognised disposition (${JSON.stringify(raw).slice(0, 40)}).`,
      raw === "unclear" ? "ambiguous" : "invalid-output",
    );
  }

  const modelConfidence = typeof obj["confidence"] === "number" ? obj["confidence"] : undefined;
  const quote = typeof obj["quote"] === "string" ? obj["quote"] : "";

  // The model's quote is grounding evidence, and the verifier doubles as a confidence
  // signal here: a model that cannot point at real text supporting its label has not
  // earned the label.
  let citation = determination.citation;
  let grounded = false;
  if (quote.trim() !== "") {
    const located = locateQuote(doc, quote, { sectionId: determination.id });
    if (located.ok) {
      citation = located.citation;
      grounded = true;
    }
  }

  const { confidence, escalated } = deriveConfidence({
    decidedBy: "model",
    modelConfidence: grounded ? modelConfidence : 0,
  });

  return {
    determination: { ...determination, disposition, citation },
    confidence,
    escalated: escalated || !grounded,
    escalationReason: !grounded ? "ungrounded" : escalated ? "ambiguous" : "none",
    ...(grounded ? { supportingQuote: citation.quote } : {}),
    reason: grounded
      ? `Disposition "${disposition}", grounded in a verified passage.`
      : `Disposition "${disposition}", but the supporting quote could not be verified against source — escalated.`,
  };
}

function unclassified(
  determination: Determination,
  reason: string,
  escalationReason: EscalationReason,
): ClassifiedDetermination {
  return {
    determination: { ...determination, disposition: "unclassified" },
    confidence: "low",
    escalated: true,
    escalationReason,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Residual materiality (T3)
// ---------------------------------------------------------------------------

const MATERIALITY_SYSTEM = `You judge whether an edit to regulatory text changes a legal obligation.

For each numbered item you are given the text BEFORE and AFTER an amendment. Classify each:
- "material"   the obligation changed: who must act, what they must do, by when, how much,
               or a defined term whose meaning carries legal weight
- "clarifying" the wording changed to remove ambiguity, but the obligation is the same
- "editorial"  no legal effect at all: formatting, cross-reference labels, house style

Respond with JSON only, one entry per item, using the item numbers given:
{"results": [{"i": <number>, "materiality": "<one of the three>", "reason": "<max 15 words>", "confidence": <0.0-1.0>}]}

Judge only what the text shows. If an item is genuinely ambiguous, use a confidence below 0.5.`;

export interface ClassifiedResidual {
  group: ClassifiedGroup;
  materiality: Materiality;
  confidence: Confidence;
  escalated: boolean;
  escalationReason: EscalationReason;
  reason: string;
}

/**
 * Fold model judgements back into the rule-tier result.
 *
 * Without this the model tier is decorative: `classifyResiduals` computes a judgement for
 * every group the rules declined, and if the caller does not apply it, the cards still
 * show those groups as "needs review". The work is done, reported, and discarded — which
 * is exactly what was happening in the analyze route.
 *
 * Escalated judgements are deliberately NOT applied. A judgement the model itself flagged
 * as low-confidence, ungrounded, or never made — a provider outage — must not silently
 * become a confident label on a card. Those stay `undecided` and keep reaching a human.
 */
export function applyResiduals(
  materiality: MaterialityResult,
  residuals: readonly ClassifiedResidual[],
): MaterialityResult {
  const decided = new Map<ClassifiedGroup, ClassifiedResidual>();
  for (const r of residuals) {
    if (r.materiality === "undecided" || r.escalated) continue;
    decided.set(r.group, r);
  }
  if (decided.size === 0) return materiality;

  const counts: Record<Materiality, number> = {
    material: 0,
    clarifying: 0,
    editorial: 0,
    undecided: 0,
  };
  const revisions: Record<Materiality, number> = {
    material: 0,
    clarifying: 0,
    editorial: 0,
    undecided: 0,
  };
  const byRule: Record<string, number> = {};
  const groups: ClassifiedGroup[] = [];
  const edits: Edit[] = [];

  for (const g of materiality.groups) {
    const applied = decided.get(g);
    const next: ClassifiedGroup = applied
      ? {
          ...g,
          result: {
            materiality: applied.materiality,
            ruleId: "model",
            reason: applied.reason,
          },
        }
      : g;

    groups.push(next);
    byRule[next.result.ruleId] = (byRule[next.result.ruleId] ?? 0) + 1;
    revisions[next.result.materiality]++;
    for (const edit of next.group.edits) {
      counts[next.result.materiality]++;
      edits.push(
        next.result.materiality === "undecided"
          ? { ...edit, materiality: "undecided" }
          : {
              ...edit,
              materiality: next.result.materiality,
              decidedBy: applied ? ("model" as const) : ("rule" as const),
              ruleId: next.result.ruleId,
            },
      );
    }
  }

  const total = materiality.funnel.totalEdits;
  const settled = counts.material + counts.clarifying + counts.editorial;
  return {
    groups,
    edits,
    funnel: {
      ...materiality.funnel,
      material: counts.material,
      clarifying: counts.clarifying,
      editorial: counts.editorial,
      undecided: counts.undecided,
      revisions,
      // Coverage now means "settled by either tier", so it is reported, not conflated
      // with the rule tier's own share.
      ruleCoverage: total === 0 ? 0 : settled / total,
      byRule,
    },
  };
}

export interface ResidualOptions {
  /** Items per request. Batching keeps hundreds of judgements to a few dozen calls. */
  batchSize?: number;
  /** Cap the number of groups sent, to bound cost on very large documents. */
  limit?: number;
}

/**
 * Measure agreement between the rule tier and the model on groups the rules already
 * decided.
 *
 * A quality signal that needs no labelled data. The rules are certain by construction, so
 * on this overlap the model should agree; systematic disagreement means one tier is
 * wrong, and which one is worth knowing before trusting the model on the cases where
 * only it has an opinion.
 *
 * This exists because self-reported confidence turned out not to be a usable escalation
 * signal — measured across providers it is inflated and never crosses a sane threshold,
 * so it silently becomes a no-op.
 */
export interface AgreementReport {
  sampled: number;
  agreed: number;
  disagreed: number;
  /** Model gave no usable answer for these; excluded from the rate. */
  unanswered: number;
  agreementRate: number;
  examples: Array<{ ruleId: string; rule: Materiality; model: Materiality; before: string; after: string }>;
}

export async function measureAgreement(
  doc: ParsedDocument,
  groups: readonly ClassifiedGroup[],
  llm: LlmClient,
  sampleSize = 20,
): Promise<AgreementReport> {
  const decided = groups.filter((g) => g.result.materiality !== "undecided");
  // Spread the sample across the document rather than taking a contiguous head, which
  // would over-represent whichever rule dominates the opening sections.
  const step = Math.max(1, Math.floor(decided.length / sampleSize));
  const sample: ClassifiedGroup[] = [];
  for (let i = 0; i < decided.length && sample.length < sampleSize; i += step) {
    sample.push(decided[i]!);
  }

  const outcome = await classifyBatch(sample, llm);
  const report: AgreementReport = {
    sampled: sample.length,
    agreed: 0,
    disagreed: 0,
    unanswered: 0,
    agreementRate: 0,
    examples: [],
  };

  sample.forEach((g, k) => {
    const r = outcome.results.get(k);
    if (!r || r.materiality === "undecided") {
      report.unanswered++;
      return;
    }
    if (r.materiality === g.result.materiality) {
      report.agreed++;
    } else {
      report.disagreed++;
      if (report.examples.length < 6) {
        report.examples.push({
          ruleId: g.result.ruleId,
          rule: g.result.materiality,
          model: r.materiality,
          before: g.beforeAfter.before.replace(/\s+/g, " ").trim().slice(0, 60),
          after: g.beforeAfter.after.replace(/\s+/g, " ").trim().slice(0, 60),
        });
      }
    }
  });

  const answered = report.agreed + report.disagreed;
  report.agreementRate = answered === 0 ? 0 : report.agreed / answered;
  return report;
}

export async function classifyResiduals(
  doc: ParsedDocument,
  groups: readonly ClassifiedGroup[],
  llm: LlmClient,
  opts: ResidualOptions = {},
): Promise<ClassifiedResidual[]> {
  const batchSize = opts.batchSize ?? 20;
  const pending = groups.filter((g) => g.result.materiality === "undecided");
  const selected = opts.limit ? pending.slice(0, opts.limit) : pending;

  const out: ClassifiedResidual[] = [];

  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = selected.slice(i, i + batchSize);
    const outcome = await classifyBatch(batch, llm);

    batch.forEach((group, k) => {
      const r = outcome.results.get(k);
      if (!r) {
        // Conservation (I1): an item the model omitted stays undecided and escalates.
        // It is never dropped and never defaulted.
        out.push({
          group,
          materiality: "undecided",
          confidence: "low",
          escalated: true,
          escalationReason: outcome.providerError ? "provider-error" : "omitted",
          reason: outcome.providerError
            ? `Provider call failed (${outcome.providerError.slice(0, 120)}); never analysed.`
            : "The model returned no judgement for this item.",
        });
        return;
      }
      out.push({ group, ...r });
    });
  }

  return out;
}

interface BatchOutcome {
  results: Map<number, Omit<ClassifiedResidual, "group">>;
  /** Set when the call itself failed — the batch was never analysed. */
  providerError?: string;
}

async function classifyBatch(
  batch: readonly ClassifiedGroup[],
  llm: LlmClient,
): Promise<BatchOutcome> {
  const results = new Map<number, Omit<ClassifiedResidual, "group">>();

  const items = batch
    .map((g, k) => {
      const before = g.beforeAfter.before.replace(/\s+/g, " ").trim().slice(0, 600);
      const after = g.beforeAfter.after.replace(/\s+/g, " ").trim().slice(0, 600);
      return `${k}.\nBEFORE: ${before}\nAFTER:  ${after}`;
    })
    .join("\n\n");

  let parsed: unknown = null;
  try {
    const res = await llm.complete({
      system: MATERIALITY_SYSTEM,
      json: true,
      temperature: 0,
      user: items,
    });
    parsed = extractJson(res.text);
  } catch (err) {
    // The batch was never analysed. Reported as an incident so it is not mistaken for a
    // judgement that these items are ambiguous.
    const detail = err instanceof LlmError ? err.message : String(err);
    return { results, providerError: detail };
  }

  const container = (parsed ?? {}) as Record<string, unknown>;
  const list = Array.isArray(container["results"])
    ? (container["results"] as unknown[])
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];

  for (const entry of list) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const idx = typeof e["i"] === "number" ? e["i"] : Number(e["i"]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;

    const rawLabel = typeof e["materiality"] === "string" ? e["materiality"] : "";
    const label = MATERIALITIES.find((m) => m === rawLabel);
    const modelConfidence = typeof e["confidence"] === "number" ? e["confidence"] : undefined;
    const reason = typeof e["reason"] === "string" ? e["reason"].slice(0, 160) : "";

    if (!label) {
      results.set(idx, {
        materiality: "undecided",
        confidence: "low",
        escalated: true,
        escalationReason: "invalid-output",
        reason: `Model returned an unrecognised label (${JSON.stringify(rawLabel).slice(0, 40)}).`,
      });
      continue;
    }

    const { confidence, escalated } = deriveConfidence({ decidedBy: "model", modelConfidence });
    results.set(idx, {
      materiality: label,
      confidence,
      escalated,
      escalationReason: escalated ? "ambiguous" : "none",
      reason: reason || `Model classified this as ${label}.`,
    });
  }

  return { results };
}

// ---------------------------------------------------------------------------
// Change statements
// ---------------------------------------------------------------------------

const STATEMENT_SYSTEM = `You state, in one sentence, what an amendment to regulatory text changed.

You are given a provision name and the text BEFORE and AFTER an amendment. Write the
sentence a regulatory affairs analyst would want: what is now required, permitted,
prohibited, or changed in amount — not a description of the edit.

Good:  "The $5,000 application fee is now expressly non-refundable."
Bad:   "The word 'non-refundable' was added before 'application fee'."

Respond with JSON only:
{"statement": "<one sentence, max 25 words>", "evidence": "<the exact added or deleted words this rests on, copied verbatim>"}

The evidence MUST be text that was added or deleted — not unchanged surrounding text. If
the change carries no substantive meaning, return {"statement": "", "evidence": ""}.`;

export interface StatementResult {
  statement: string;
  evidence: string;
}

/**
 * Generate a one-sentence statement of what a provision's change did.
 *
 * The gate here is tighter than `locateQuote` and simpler: the model's evidence must be
 * text that was actually added or deleted. Unchanged surrounding text appears in the
 * document and would pass a document-wide search, so verifying against the document alone
 * would let the model support a claim about a change by quoting text that did not change.
 * Matching against the edits themselves closes that.
 */
export async function generateStatement(
  provision: string,
  before: string,
  after: string,
  edits: ReadonlyArray<{ text: string; kind: "addition" | "deletion" }>,
  llm: LlmClient,
): Promise<StatementResult | null> {
  let parsed: unknown = null;
  try {
    const res = await llm.complete({
      system: STATEMENT_SYSTEM,
      json: true,
      temperature: 0,
      user:
        `Provision: ${provision}\n\n` +
        `BEFORE: ${before.replace(/\s+/g, " ").trim().slice(0, 900)}\n\n` +
        `AFTER:  ${after.replace(/\s+/g, " ").trim().slice(0, 900)}`,
    });
    parsed = extractJson(res.text);
  } catch {
    return null; // a provider failure leaves the change unsummarised, never unshown
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const statement = typeof obj["statement"] === "string" ? obj["statement"].trim() : "";
  const evidence = typeof obj["evidence"] === "string" ? obj["evidence"].trim() : "";
  if (statement === "" || evidence === "") return null;

  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(evidence);
  const grounded = edits.some((e) => {
    const t = norm(e.text);
    if (t.length === 0) return false;
    // Either the quoted evidence sits inside an edit, or the whole of a substantial edit
    // sits inside the quote. The length floor on the second direction matters: a
    // one-character edit ("s", a comma) is contained in nearly any sentence, so without
    // it the gate would pass anything the model wrote.
    return t.includes(target) || (t.length >= 8 && target.includes(t));
  });

  // Ungrounded means the model described a change it cannot point at. The provision still
  // reaches the reader with its redline; only the sentence is withheld.
  return grounded ? { statement, evidence } : null;
}
