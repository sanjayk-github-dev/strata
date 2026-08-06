/**
 * Join the two branches, and assemble change cards.
 *
 * The reasoning branch (T2) says *what the agency decided*; the redline branch (T3) says
 * *what the text now says*. Neither alone is a reviewable change: a determination without
 * operative text is a decision you cannot act on, and an edit without a determination is a
 * diff you cannot explain. Joining them is what produces a card worth an expert's time.
 *
 * The join is deterministic wherever the agency cross-references a provision explicitly,
 * which measurement in Phase 3 put at 65% of determination blocks. The rest falls back to
 * lexical retrieval, and whatever neither settles is surfaced as its own group rather than
 * quietly dropped — invariant I1.
 */

import { sectionAtOffset } from "./citation.js";
import type { ClassifiedGroup, MaterialityResult } from "./materiality.js";
import type {
  ChangeCard,
  Determination,
  Effect,
  ParsedDocument,
  Section,
} from "./types.js";
import { deriveProvisionStatus } from "./card.js";

// ---------------------------------------------------------------------------
// Provision index
// ---------------------------------------------------------------------------

/**
 * Leading provision number of a section heading.
 *
 * Two forms occur and both matter. Sub-provisions head as `3.1.1.1 Study Deposit`, while
 * top-level provisions head as `Section 3. Interconnection Requests` — measured, after an
 * initial pattern that only handled the first form left every bare-digit cross-reference
 * ("5", "7", "9") unmatched.
 */
export function provisionNumberOf(heading: string): string | null {
  const m = heading.match(/^(?:Section\s+)?(\d+(?:\.\d+)*)\s*[.\s]/i);
  return m?.[1] ?? null;
}

export type ProvisionIndex = Map<string, Section[]>;

/** Map provision number → the section(s) carrying it, within the redline region. */
export function buildProvisionIndex(doc: ParsedDocument, region: [number, number]): ProvisionIndex {
  const index: ProvisionIndex = new Map();
  for (const section of doc.sections) {
    if (section.span[0] < region[0] || section.span[0] >= region[1]) continue;
    const num = provisionNumberOf(section.headingPath[section.headingPath.length - 1] ?? "");
    if (!num) continue;
    const list = index.get(num);
    if (list) list.push(section);
    else index.set(num, [section]);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Lexical fallback
// ---------------------------------------------------------------------------

/**
 * Defined terms — capitalised multi-word phrases.
 *
 * These carry the signal in this corpus: a determination about study deposits and the
 * provision it amends will both say "Cluster Study" and "Interconnection Customer". Plain
 * word overlap drowns in boilerplate; defined terms do not.
 */
export function definedTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][a-z]+)(?:\s+(?:[A-Z][a-z]+|of|to|the))*\b/g)) {
    // Strip a leading article. "the" is legitimate *inside* a term ("Appendix C of the
    // LGIA") but a sentence-initial "The" would otherwise fuse onto the term, so the same
    // defined term yields two different strings depending on where the sentence started —
    // which is exactly the kind of silent mismatch that makes lexical scoring useless.
    const term = m[0].trim().replace(/^(?:The|A|An)\s+/, "");
    if (term.split(/\s+/).length >= 2) out.add(term.toLowerCase());
  }
  return out;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of b) if (a.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Minimum lexical overlap to accept an implicit join. Below this, the item is unjoined. */
const IMPLICIT_THRESHOLD = 0.34;

/**
 * Topic text for a group: its section heading plus the amended provision text.
 *
 * Scoring against the edit fragment alone does not work — measured, and it produced a
 * best score of 0.00 for fourteen of fifteen unjoined determinations. A fragment of
 * sixty characters rarely contains a capitalised defined term, so there is nothing to
 * match on. The heading of the provision the edit sits in ("3.1.1 Study Deposits") is
 * the actual topic signal, and it is what a determination discussing study deposits will
 * echo.
 */
function groupTopicText(doc: ParsedDocument, group: ClassifiedGroup): string {
  const section = sectionAtOffset(doc, group.group.span[0]);
  const heading = section ? section.headingPath.slice(-2).join(" ") : "";
  return `${heading} ${group.beforeAfter.after}`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type JoinKind = "explicit" | "implicit" | "none";

export interface JoinedCard extends ChangeCard {
  /** How the determination and edits were linked, for auditing the join itself. */
  joinKind: JoinKind;
  /** Provision numbers the determination cited, where it cited any. */
  provisionRefs: string[];
  priority: CardPriority;
}

export interface JoinCoverage {
  determinations: number;
  joinedExplicit: number;
  joinedImplicit: number;
  unjoinedDeterminations: number;
  /** Groups carded without a determination — text changed, nothing discusses it. */
  editOnlyCards: number;
  /** Retained and inspectable, but not carded. */
  editorialGroupsFiltered: number;
  totalCards: number;
  /** Cards by review priority — what an expert actually triages against. */
  byPriority: Record<CardPriority, number>;
}

/**
 * Review priority.
 *
 * Card count alone is not a useful number: 294 cards is only tractable if the ones that
 * move an obligation come first and the judgement calls come before the housekeeping.
 * Escalated items sort ahead of their peers within each band, since the product's claim
 * is that ambiguity is surfaced rather than resolved.
 */
export type CardPriority = "material" | "needs-review" | "clarifying";

const PRIORITY_ORDER: Record<CardPriority, number> = {
  material: 0,
  "needs-review": 1,
  clarifying: 2,
};

export function cardPriority(card: JoinedCard, groups: readonly ClassifiedGroup[]): CardPriority {
  if (groups.some((g) => g.result.materiality === "material")) return "material";
  if (card.escalated || groups.some((g) => g.result.materiality === "undecided")) {
    return "needs-review";
  }
  return "clarifying";
}

export interface AssemblyResult {
  cards: JoinedCard[];
  coverage: JoinCoverage;
}

/** Effect of a group, from the shape of its edits. Deliberately coarse. */
function effectOf(group: ClassifiedGroup): Effect {
  const kinds = new Set(group.group.edits.map((e) => e.kind));
  if (group.result.materiality === "editorial") return "clarified-no-change";
  if (kinds.has("addition") && kinds.has("deletion")) return "strengthened";
  if (kinds.has("addition")) return "new";
  if (kinds.has("deletion")) return "removed";
  return "unknown";
}

/**
 * Assemble reviewable cards from both branches.
 *
 * Three shapes result, and all three are legitimate:
 *   - determination + edits — a decision and the text it moved
 *   - determination alone   — a decision with no textual footprint, which is the majority
 *                             of what happens and what a redline-only tool cannot see
 *   - edits alone           — text moved with no determination discussing it
 */
export function assembleCards(
  doc: ParsedDocument,
  determinations: readonly Determination[],
  materiality: MaterialityResult,
  region: [number, number] | null,
): AssemblyResult {
  const index = region ? buildProvisionIndex(doc, region) : (new Map() as ProvisionIndex);

  // Groups worth carding. Editorial is retained for inspection but not surfaced as a card.
  const cardable = materiality.groups.filter((g) => g.result.materiality !== "editorial");
  const editorialCount = materiality.groups.length - cardable.length;

  const claimed = new Set<ClassifiedGroup>();
  const cards: JoinedCard[] = [];
  const coverage: JoinCoverage = {
    determinations: determinations.length,
    joinedExplicit: 0,
    joinedImplicit: 0,
    unjoinedDeterminations: 0,
    editOnlyCards: 0,
    editorialGroupsFiltered: editorialCount,
    totalCards: 0,
    byPriority: { material: 0, "needs-review": 0, clarifying: 0 },
  };

  for (const det of determinations) {
    // --- explicit: the agency named the provision ---
    const sectionIds = new Set<string>();
    // Only provisions the determination directs a change to — a mention is not an
    // amendment. See extractDirectiveRefs.
    for (const ref of det.amendedRefs) {
      for (const s of index.get(ref) ?? []) sectionIds.add(s.id);
    }
    // Deliberately not filtered by `claimed`: two determinations can bear on the same
    // provision, and suppressing the second would hide a real decision. Cards are
    // therefore an overlapping cover rather than a partition — I1 requires that nothing
    // is dropped, not that nothing appears twice.
    let matched = cardable.filter((g) =>
      g.group.edits.some((e) => sectionIds.has(e.sectionId)),
    );
    let joinKind: JoinKind = matched.length > 0 ? "explicit" : "none";

    // --- implicit: no usable cross-reference, so fall back to lexical overlap ---
    if (matched.length === 0) {
      const detTerms = definedTerms(
        doc.text.slice(det.citation.span[0], Math.min(det.citation.span[1], det.citation.span[0] + 4000)),
      );
      const scored = cardable
        .filter((g) => !claimed.has(g))
        .map((g) => ({ g, score: overlapScore(detTerms, definedTerms(groupTopicText(doc, g))) }))
        .filter((x) => x.score >= IMPLICIT_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      if (scored.length > 0) {
        matched = scored.map((x) => x.g);
        joinKind = "implicit";
      }
    }

    for (const g of matched) claimed.add(g);
    if (joinKind === "explicit") coverage.joinedExplicit++;
    else if (joinKind === "implicit") coverage.joinedImplicit++;
    else coverage.unjoinedDeterminations++;

    cards.push(makeCard(doc, det, matched, joinKind, det.amendedRefs));
  }

  // --- edits nothing discussed ---
  for (const g of cardable) {
    if (claimed.has(g)) continue;
    cards.push(makeCard(doc, undefined, [g], "none", []));
    coverage.editOnlyCards++;
  }

  for (const c of cards) coverage.byPriority[c.priority]++;
  cards.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      Number(b.escalated) - Number(a.escalated) ||
      (a.citations[0]?.span[0] ?? 0) - (b.citations[0]?.span[0] ?? 0),
  );

  coverage.totalCards = cards.length;
  return { cards, coverage };
}

function makeCard(
  doc: ParsedDocument,
  determination: Determination | undefined,
  groups: readonly ClassifiedGroup[],
  joinKind: JoinKind,
  provisionRefs: string[],
): JoinedCard {
  const edits = groups.flatMap((g) => g.group.edits);
  const citations = [
    ...(determination ? [determination.citation] : []),
    ...edits.map((e) => e.citation),
  ];

  const escalated =
    determination?.disposition === "unclassified" ||
    groups.some((g) => g.result.materiality === "undecided");

  const anchor = determination
    ? determination.headingPath.slice(-2).join(" › ")
    : sectionTitle(doc, groups[0]);

  const card: JoinedCard = {
    id: determination ? `d${determination.id}` : `e${groups[0]?.group.span[0] ?? 0}`,
    frDocNumber: doc.meta.frDocNumber,
    title: anchor,
    edits,
    ...(determination ? { determination } : {}),
    effect: groups[0] ? effectOf(groups[0]) : "unknown",
    provisionStatus: deriveProvisionStatus(doc.meta.status, determination?.disposition, {
      textualChange: edits.length > 0,
    }),
    citations,
    confidence: escalated ? "low" : "medium",
    escalated,
    joinKind,
    provisionRefs,
    priority: "clarifying", // replaced below, once the card object exists
  };

  card.priority = cardPriority(card, groups);
  return card;
}

function sectionTitle(doc: ParsedDocument, group: ClassifiedGroup | undefined): string {
  if (!group) return "(unanchored)";
  const s = sectionAtOffset(doc, group.group.span[0]);
  return s ? s.headingPath.slice(-2).join(" › ") : "(unanchored)";
}
