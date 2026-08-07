/**
 * Rule-tier materiality classification.
 *
 * Separating the handful of edits that move an obligation from the hundreds that do not
 * is the core intelligence task. This module is the deterministic half: rules that fire
 * only when they are certain, leaving everything else `undecided` for the model tier in
 * Phase 6.
 *
 * The governing principle is the product's, not an optimisation: **escalate rather than
 * guess**. A rule that is merely probably right belongs in the model tier, where its
 * output is confidence-scored and can be escalated, rather than here, where it would be
 * reported as a deterministic fact.
 *
 * Rules operate on *groups* rather than individual edits. `[A]` + `a` is a capitalisation
 * fix with no legal effect, but neither half says that alone — materiality is a property
 * of the replacement, not of either side of it.
 */

import { groupAdjacentEdits, type EditGroup } from "./redline.js";
import type { Edit, Materiality, ParsedDocument } from "./types.js";

// ---------------------------------------------------------------------------
// Before / after reconstruction
// ---------------------------------------------------------------------------

export interface BeforeAfter {
  before: string;
  after: string;
}

/**
 * How much surrounding text to include on each side of a group.
 *
 * Some rules are context-dependent: `[3.4]` → `3.5` is a threshold change or a
 * cross-reference renumbering depending entirely on whether the word "section" precedes
 * it, and that word is outside the edit spans. Reconstructing only the edits made the
 * cross-reference rule unable to fire — found by test, not by inspection.
 *
 * Context is safe for the equivalence-based rules because it appears identically on both
 * sides, so it can never manufacture a difference. Edits belonging to *other* groups
 * appear in the context as raw source on both sides, for the same reason.
 */
const CONTEXT_CHARS = 60;

/**
 * Reconstruct the text a group changed, as it read before and after.
 *
 * Within the window: deletions contribute their bracketed content to `before` only;
 * additions contribute to `after` only; everything else is unchanged context and appears
 * in both. This is what makes the editorial rules principled rather than pattern-matched
 * — they ask whether the two readings are equivalent, not whether the edit text looks a
 * certain way.
 */
export function reconstruct(
  doc: ParsedDocument,
  group: EditGroup,
  contextChars = CONTEXT_CHARS,
): BeforeAfter {
  const edits = [...group.edits].sort((a, b) => a.citation.span[0] - b.citation.span[0]);

  // Widen for context, clipped to the containing section so we never pull in unrelated
  // provisions, and to the document bounds.
  const section = doc.sections.find((s) => s.id === edits[0]?.sectionId);
  const lowerBound = section ? section.span[0] : 0;
  const upperBound = section ? section.span[1] : doc.text.length;
  const start = Math.max(lowerBound, group.span[0] - contextChars);
  const end = Math.min(upperBound, group.span[1] + contextChars);

  let before = "";
  let after = "";
  let cursor = start;

  for (const edit of edits) {
    const [a, b] = edit.citation.span;
    if (a < cursor) continue; // defensive: overlapping spans contribute once
    const context = doc.text.slice(cursor, a);
    before += context;
    after += context;

    if (edit.kind === "deletion") before += edit.text;
    else after += edit.text;

    cursor = b;
  }

  const tail = doc.text.slice(cursor, end);
  return { before: before + tail, after: after + tail };
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const noArticles = (s: string) => ws(s.replace(/\b(?:the|an|a)\b/gi, " "));

/** Tokens italicised by legal typographic convention rather than as additions. */
const TYPOGRAPHIC = new Set([
  "i.e.",
  "i.e.,",
  "e.g.",
  "e.g.,",
  "et seq.",
  "id.",
  "supra",
  "infra",
  "cf.",
  "see",
  "viz.",
]);

const MODALS = /\b(?:shall|may|must|will|should|shall not|may not)\b/gi;

/** Numbers, with the unit or symbol attached where present. */
const NUMBERS = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|MW|kW|kV|days?|business days?|months?|years?)?/gi;

/**
 * Numbers spelled out in words.
 *
 * Legal drafting writes "within ten (10) Business Days", and an amendment may touch
 * either form. Measured on real output: changes like "" → "ten" and "" → "fifteen" were
 * landing in `undecided` purely because the digit regex could not see them, even though
 * they are exactly as material as "10" → "15".
 */
const ONES =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";

/**
 * Hyphenated compounds are matched as one token.
 *
 * Found by the rule/model agreement check: "exceeding 25 percent" → "exceeding
 * twenty-five percent" was classified material, because "twenty-five" parsed as two
 * separate words worth 20 and 5 rather than one value of 25 — so the value set appeared
 * to change when only the spelling had. The model disagreed and was right.
 */
const NUMBER_WORDS = new RegExp(
  `\\b(?:(?:${TENS})-(?:${ONES})|${TENS}|${ONES}|hundred|thousand)\\b`,
  "gi",
);

/**
 * A number acting as a cross-reference rather than a threshold.
 *
 * The number pattern tolerates internal whitespace, which is not cosmetic. When a
 * renumbering is marked up as `Section 9.[6] 7`, reconstruction yields "Section 9.6" for
 * before and "Section 9. 7" for after — the space is XML layout between the deletion and
 * its replacement, not content. Without this tolerance the two sides mask differently,
 * the cross-reference rule fails to fire, and a pure renumbering is reported as a
 * material numeric change. That was the first card in the generated report.
 */
const CROSSREF_NUMBER =
  /\b(?:section|sections|appendix|article|attachment|part)\s+\d(?:\s*[.\d])*/gi;

const NEGATION = /\b(?:not|no|nor|never|non)\b|\bnon-/gi;

function multiset(s: string, re: RegExp): string[] {
  return (s.match(new RegExp(re.source, re.flags)) ?? []).map((x) => ws(x).toLowerCase()).sort();
}

const sameMultiset = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const WORD_VALUES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

/**
 * The set of numeric *values* a text mentions, digits and words unified.
 *
 * A set rather than a multiset, and values rather than surface forms, because legal
 * drafting states the same number twice: "within ten (10) Business Days". Adding the
 * word form beside an existing digit changes the drafting, not the deadline — and a
 * multiset comparison of surface forms reported exactly that as a material change in the
 * generated report.
 */
function numericValues(s: string): Set<number> {
  const out = new Set<number>();
  for (const m of s.matchAll(new RegExp(NUMBERS.source, NUMBERS.flags))) {
    const n = Number(m[0].replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && m[0].trim() !== "") out.add(n);
  }
  for (const m of s.matchAll(new RegExp(NUMBER_WORDS.source, NUMBER_WORDS.flags))) {
    const v = wordValue(m[0]);
    if (v !== undefined) out.add(v);
  }
  return out;
}

/** Resolve a word-number token, including hyphenated compounds like "twenty-five". */
function wordValue(token: string): number | undefined {
  const t = token.toLowerCase();
  const direct = WORD_VALUES[t];
  if (direct !== undefined) return direct;
  const [tens, ones] = t.split("-");
  if (!tens || !ones) return undefined;
  const a = WORD_VALUES[tens];
  const b = WORD_VALUES[ones];
  return a !== undefined && b !== undefined ? a + b : undefined;
}

const sameValues = (a: Set<number>, b: Set<number>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleResult {
  materiality: Materiality;
  ruleId: string;
  reason: string;
}

export interface MaterialityRule {
  id: string;
  materiality: Exclude<Materiality, "undecided">;
  reason: string;
  test(ba: BeforeAfter, group: EditGroup): boolean;
}

/**
 * Editorial rules — equivalence tests.
 *
 * Each asks whether the before and after readings are the same once a legally
 * irrelevant difference is normalised away. That is a much stronger basis than matching
 * the edit text, because it cannot be fooled by an edit that merely *looks* trivial.
 */
const EDITORIAL_RULES: MaterialityRule[] = [
  {
    id: "whitespace-only",
    materiality: "editorial",
    reason: "Whitespace only; the wording is unchanged.",
    test: ({ before, after }) => ws(before) === ws(after),
  },
  {
    id: "case-only",
    materiality: "editorial",
    reason: "Capitalisation only; the wording is unchanged.",
    test: ({ before, after }) => ws(before).toLowerCase() === ws(after).toLowerCase(),
  },
  {
    id: "article-only",
    materiality: "editorial",
    reason: "Article change only (a / an / the).",
    test: ({ before, after }) =>
      noArticles(before).toLowerCase() === noArticles(after).toLowerCase(),
  },
  {
    id: "typographic-convention",
    materiality: "editorial",
    reason:
      "Italicisation of a conventionally italicised token; the markup cannot distinguish " +
      "this from an addition, so it is treated as typography.",
    test: (_ba, group) =>
      group.edits.length > 0 &&
      group.edits.every(
        (e) => e.kind === "addition" && TYPOGRAPHIC.has(e.text.trim().toLowerCase()),
      ),
  },
  {
    id: "cross-reference-renumber",
    materiality: "editorial",
    reason: "A cross-reference was renumbered; the obligation it points to is unchanged.",
    test: ({ before, after }) => {
      const b = before.replace(CROSSREF_NUMBER, "§REF");
      const a = after.replace(CROSSREF_NUMBER, "§REF");
      // Equivalent once cross-references are masked, but not already equal — otherwise a
      // simpler rule would have fired.
      return ws(b).toLowerCase() === ws(a).toLowerCase() && ws(before) !== ws(after);
    },
  },
];

/**
 * Material rules — signals that a legal obligation moved.
 *
 * Deliberately narrow. Each fires on a change that cannot be anything but substantive:
 * a negation, a modal verb, or a number that is not a cross-reference.
 */
const MATERIAL_RULES: MaterialityRule[] = [
  {
    id: "negation-change",
    materiality: "material",
    reason: "A negation was added or removed, which reverses the sense of the provision.",
    test: ({ before, after }) =>
      !sameMultiset(multiset(before, NEGATION), multiset(after, NEGATION)),
  },
  {
    id: "modal-change",
    materiality: "material",
    reason: "A modal verb changed — the distinction between an obligation and a permission.",
    test: ({ before, after }) => !sameMultiset(multiset(before, MODALS), multiset(after, MODALS)),
  },
  {
    id: "numeric-change",
    materiality: "material",
    reason: "A numeric value changed — a threshold, amount, deadline, or count.",
    test: ({ before, after }) => {
      // Mask cross-references first: renumbering is editorial and is handled above.
      const b = before.replace(CROSSREF_NUMBER, "§REF");
      const a = after.replace(CROSSREF_NUMBER, "§REF");
      return !sameValues(numericValues(b), numericValues(a));
    },
  },
];

/**
 * Evaluated and deliberately NOT implemented: "defined-term change".
 *
 * The TDD lists it among the material rules, and it is genuinely a material signal in
 * principle — "days" → "Business Days" changes a deadline. But measured against real
 * output it fires on cases that are honestly ambiguous ("" → "Standard", where the term
 * is being renamed rather than the obligation changed), and almost any sizeable addition
 * contains a capitalised term.
 *
 * A rule that is merely probably right belongs in the model tier, where its output is
 * confidence-scored and escalable, not here, where it would be reported as a
 * deterministic fact. These cases are left `undecided` on purpose.
 */

/**
 * Classify one group.
 *
 * Editorial rules run first: they are equivalence tests, so a group they accept has no
 * legal effect regardless of what other signals it carries. Anything neither set decides
 * stays `undecided` — the model tier's input, not a silent default.
 */
export function classifyGroup(doc: ParsedDocument, group: EditGroup): RuleResult {
  const ba = reconstruct(doc, group);

  for (const rule of EDITORIAL_RULES) {
    if (rule.test(ba, group)) {
      return { materiality: rule.materiality, ruleId: rule.id, reason: rule.reason };
    }
  }
  for (const rule of MATERIAL_RULES) {
    if (rule.test(ba, group)) {
      return { materiality: rule.materiality, ruleId: rule.id, reason: rule.reason };
    }
  }
  return {
    materiality: "undecided",
    ruleId: "none",
    reason: "No deterministic rule applies; requires judgement.",
  };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export interface ClassifiedGroup {
  group: EditGroup;
  result: RuleResult;
  beforeAfter: BeforeAfter;
}

/** Counts of one unit, by verdict. Must sum to that unit's total — invariant I1. */
export interface FunnelCounts {
  material: number;
  clarifying: number;
  editorial: number;
  undecided: number;
}

export interface Funnel {
  totalEdits: number;
  totalGroups: number;
  /** Per-edit counts. These must sum to totalEdits — invariant I1. */
  material: number;
  clarifying: number;
  editorial: number;
  undecided: number;
  /**
   * The same verdicts counted per revision, summing to totalGroups.
   *
   * A revision is what a reader counts — one substitution, one insertion. An edit is a
   * single piece of the agency's markup, and a substitution is two of them, so edit
   * counts run to roughly double what a reader would say changed. Both are kept: the
   * edit counts are the conservation check over what was parsed, the revision counts are
   * what a person is shown.
   */
  revisions: FunnelCounts;
  /** Share of edits decided without a model. Measured, never assumed. */
  ruleCoverage: number;
  /** How many groups each rule decided, for auditing the rule set. */
  byRule: Record<string, number>;
}

export interface MaterialityResult {
  groups: ClassifiedGroup[];
  edits: Edit[];
  funnel: Funnel;
}

/** Apply the rule tier to a document's redline edits. */
export function classifyEdits(doc: ParsedDocument, edits: readonly Edit[]): MaterialityResult {
  const groups = groupAdjacentEdits(doc, edits);
  const classified: ClassifiedGroup[] = [];
  const byRule: Record<string, number> = {};

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

  const out: Edit[] = [];

  for (const group of groups) {
    const result = classifyGroup(doc, group);
    classified.push({ group, result, beforeAfter: reconstruct(doc, group) });
    byRule[result.ruleId] = (byRule[result.ruleId] ?? 0) + 1;
    revisions[result.materiality]++;

    for (const edit of group.edits) {
      counts[result.materiality]++;
      out.push({
        ...edit,
        materiality: result.materiality,
        ...(result.materiality === "undecided"
          ? {}
          : { decidedBy: "rule" as const, ruleId: result.ruleId }),
      });
    }
  }

  const decided = counts.material + counts.clarifying + counts.editorial;
  return {
    groups: classified,
    edits: out,
    funnel: {
      totalEdits: edits.length,
      totalGroups: groups.length,
      material: counts.material,
      clarifying: counts.clarifying,
      editorial: counts.editorial,
      undecided: counts.undecided,
      revisions,
      ruleCoverage: edits.length === 0 ? 0 : decided / edits.length,
      byRule,
    },
  };
}
