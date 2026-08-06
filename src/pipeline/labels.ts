/**
 * User-facing vocabulary.
 *
 * The reader is a regulatory affairs analyst. They know "docket", "rehearing", "pro forma
 * tariff", "disposition" — and have no reason to know "T2", "join kind", or "materiality
 * tier", which are our internal names for our own machinery. Exposing those makes the
 * product look like a debug view of itself.
 *
 * Every string a user sees comes from here, so the mapping is auditable in one place
 * rather than scattered through components.
 */

import type { Tier } from "./types.js";

/** What each capability means to a reader, not what we call it internally. */
export const TIER_LABEL: Record<Tier, string> = {
  T1: "Version history",
  T2: "Commission determinations",
  T3: "Marked-up text (redline)",
};

/** How a decision was linked to the text it changed. */
export const JOIN_LABEL: Record<string, string> = {
  explicit: "linked by section citation",
  implicit: "linked by topic match",
  none: "no linked text change",
};

/**
 * Provision status in the reader's terms.
 *
 * "adopted" is accurate but ambiguous out of context — adopted *when*? "Amended in this
 * order" says what actually happened.
 */
export const PROVISION_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed — not yet binding",
  adopted: "Amended in this order",
  settled: "Upheld — unchanged",
  reopened: "Reopened",
  unknown: "Undetermined",
};

/** Dispositions are genuine terms of art; they stay, with a plain gloss. */
export const DISPOSITION_LABEL: Record<string, string> = {
  affirmed: "Affirmed",
  sustained: "Sustained — challenge rejected",
  clarified: "Clarified — no text change",
  modified: "Modified",
  "set-aside": "Set aside",
  unclassified: "Not yet determined",
};

export const PRIORITY_LABEL: Record<string, string> = {
  material: "Changes an obligation",
  "needs-review": "Needs expert review",
  clarifying: "Clarifying",
};

export const MATERIALITY_LABEL: Record<string, string> = {
  material: "Changes an obligation",
  clarifying: "Clarifying",
  editorial: "Editorial only",
  undecided: "Needs review",
};

/** Federal Register document page, for verifying against the source of record. */
export function officialUrl(htmlUrl: string, frDocNumber: string): string {
  return htmlUrl || `https://www.federalregister.gov/d/${frDocNumber}`;
}
