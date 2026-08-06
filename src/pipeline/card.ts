/**
 * Change card assembly helpers.
 *
 * The ChangeCard schema is frozen here in Phase 2 (see types.ts) so later phases fill
 * fields rather than reshape them, and the UI can bind against it before the analysis
 * layers exist.
 */

import type {
  Confidence,
  Disposition,
  ProvisionStatus,
  Status,
} from "./types.js";

/**
 * Provision-level draft/final status (docs/TDD.md §6).
 *
 * Deterministic given a disposition — only the disposition itself is inferred. The
 * `unknown` case is the important one: an unclassifiable disposition must not collapse
 * into a confident status, so it escalates instead.
 */
export function deriveProvisionStatus(
  documentStatus: Status,
  disposition: Disposition | undefined,
): ProvisionStatus {
  if (disposition === "unclassified") return "unknown";

  switch (documentStatus) {
    case "proposed":
      // A proposed rule proposes; nothing in it binds yet.
      return "proposed";

    case "final":
      return "adopted";

    case "amended":
      if (!disposition) return "unknown";
      switch (disposition) {
        case "affirmed":
        case "sustained":
          // Carried forward and expressly upheld on challenge.
          return "settled";
        case "clarified":
          // Text unchanged, but now expressly interpreted — still binding.
          return "settled";
        case "modified":
          return "adopted";
        case "set-aside":
          // Rehearing granted; the provision's content is in flux.
          return "reopened";
        default:
          return "unknown";
      }
  }
}

/** True when a provision status requires expert review rather than assertion. */
export function requiresEscalation(status: ProvisionStatus): boolean {
  return status === "unknown";
}

/**
 * Confidence derivation (docs/TDD.md §10).
 *
 * Note what is absent: citation failure is not a confidence level. A claim whose
 * citation fails is suppressed by the gate before confidence is ever considered.
 */
export interface ConfidenceInputs {
  decidedBy: "rule" | "model";
  /** Set when both a rule and the model classified the same item. */
  ruleModelAgree?: boolean;
  /** Model self-reported confidence in [0, 1], when available. */
  modelConfidence?: number;
  /** True when model output fell outside the closed label set. */
  outOfVocabulary?: boolean;
  modelConfidenceThreshold?: number;
}

export function deriveConfidence(inputs: ConfidenceInputs): {
  confidence: Confidence;
  escalated: boolean;
} {
  const threshold = inputs.modelConfidenceThreshold ?? 0.7;

  if (inputs.outOfVocabulary) return { confidence: "low", escalated: true };
  if (inputs.ruleModelAgree === false) return { confidence: "low", escalated: true };
  if (inputs.decidedBy === "rule") return { confidence: "high", escalated: false };
  if (inputs.ruleModelAgree === true) return { confidence: "high", escalated: false };

  if (inputs.modelConfidence !== undefined && inputs.modelConfidence < threshold) {
    return { confidence: "low", escalated: true };
  }
  return { confidence: "medium", escalated: false };
}
