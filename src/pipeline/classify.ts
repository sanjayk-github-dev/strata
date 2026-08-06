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
import type { ClassifiedGroup } from "./materiality.js";
import type {
  Confidence,
  Determination,
  Disposition,
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

export interface ResidualOptions {
  /** Items per request. Batching keeps hundreds of judgements to a few dozen calls. */
  batchSize?: number;
  /** Cap the number of groups sent, to bound cost on very large documents. */
  limit?: number;
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
