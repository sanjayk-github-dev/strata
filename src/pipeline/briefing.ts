/**
 * The change briefing.
 *
 * The unit here is **an affected provision**, not a determination and not an edit. That
 * is what a regulatory affairs analyst tracks: "§3.1.1.1 Study Deposit changed", not
 * "determination 192 touched things" and not "edit a1406682".
 *
 * Organising by determination produced cards that were incoherent in both directions. One
 * determination reading "we adopt the proposed revisions to section 1 of the pro forma
 * LGIP" swallowed 85 edits, because section 1 is the entire Definitions chapter — while
 * 226 other cards carried a single trivial edit each. A provision-level unit splits the
 * first and gives the second somewhere to belong.
 *
 * It also removes a contradiction the old shape could not avoid: a card showed
 * "Clarified — no text change" beside "85 text changes", because the disposition
 * described the determination and the edits described provisions. Here the card is about
 * the provision, and determinations are attached as *evidence*.
 */

import { sectionAtOffset } from "./citation.js";
import type { ClassifiedGroup, MaterialityResult } from "./materiality.js";
import { deriveProvisionStatus } from "./card.js";
import { provisionNumberOf } from "./join.js";
import type {
  Citation,
  Determination,
  Edit,
  ParsedDocument,
  ProvisionStatus,
} from "./types.js";

/**
 * What kind of consequence a change carries.
 *
 * These are the axes this reader triages on, and each is detectable from signals the rule
 * tier already computes. Ordered by how costly the change is to miss: a deadline that
 * passes cannot be recovered, whereas a definition can be re-read.
 */
export type ImpactCategory =
  | "deadline"
  | "money"
  | "threshold"
  | "obligation"
  | "definition"
  | "other";

export const CATEGORY_ORDER: ImpactCategory[] = [
  "deadline",
  "money",
  "threshold",
  "obligation",
  "definition",
  "other",
];

export const CATEGORY_LABEL: Record<ImpactCategory, string> = {
  deadline: "Deadlines and timing",
  money: "Fees, deposits and penalties",
  threshold: "Thresholds and eligibility",
  obligation: "Who must do what",
  definition: "Defined terms",
  other: "Other changes",
};

/**
 * Timing language, which has to be narrower than it first looks.
 *
 * A bare `\bdays?\b` seemed obviously right and was not: every FERC agreement ends
 * "executed ... on the day and year first above written", so the signature block of the
 * pro forma LGIA matched, and a 33-edit Recitals entry sat at the top of the briefing
 * under "Deadlines and timing" with no deadline in it. A period of time is a deadline
 * when it is *counted* — "one hundred fifty (150) Calendar Days" — or when the text names
 * the timing concept outright.
 */
const DEADLINE = new RegExp(
  [
    String.raw`\b(?:calendar|business|working)\s+days?\b`, // the form FERC actually uses
    String.raw`\b\d+\s+(?:days?|weeks?|months?|years?)\b`,
    String.raw`\(\d+\)\s*(?:calendar\s+|business\s+|working\s+)?(?:days?|weeks?|months?)\b`,
    String.raw`\bwithin\s+(?:\S+\s+){0,4}?(?:days?|weeks?|months?|hours?)\b`,
    String.raw`\bno later than\b`,
    String.raw`\bdeadline`,
    String.raw`\btimeline`,
    String.raw`\bprocessing time\b`,
    String.raw`\bdue date\b`,
    String.raw`\bwindow\b`, // "Cluster Request Window" — a defined filing period
  ].join("|"),
  "i",
);

/**
 * `\bsecurity\b` alone was too broad in the other direction: reliability and system
 * security are discussed constantly in these documents and are not money. Financial
 * security has its own vocabulary, so use that.
 */
const MONEY =
  /\$|\bfees?\b|\bdeposit|\bpenalt|\brefund|\bcosts?\b|\bsurety\b|\bletter of credit\b|\bfinancial security\b|\bsecurity (?:deposit|arrangement|instrument)/i;

/** Bare "at least" and "no more than" quantify anything; require the quantity. */
const THRESHOLD =
  /\bMW\b|\bkV\b|\bpercent\b|%|\bthreshold|\bexceeds?\b|\bat least\s+\d|\bno more than\s+\d/i;

/** "will" is future tense far more often than it is an obligation. */
const OBLIGATION = /\b(?:shall|must|may not|is required to|are required to)\b/i;

/**
 * Classify by what changed, preferring the most consequential signal present.
 *
 * Reads the *changed* text rather than the whole provision: a provision about deadlines
 * that had a fee corrected is a fee change, not a deadline change. The provision's title
 * enters only where it settles the question outright, which is the definitions case.
 *
 * Order among the consequence categories is by cost of missing one: a deadline that
 * passes cannot be recovered, a fee paid wrongly can be argued back.
 */
export function categorise(changedText: string, provisionTitle: string): ImpactCategory {
  // A section titled "Definitions" is defining terms, whatever vocabulary appears inside
  // it. This has to precede the consequence checks because the card is the whole section:
  // Order 2023's "Section 1. Definitions" carries 83 changes, and a 4,000-character blob
  // of definitional text mentions costs, days and megawatts somewhere by certainty. It
  // filed under "Fees, deposits and penalties" on that basis, which is not what a reader
  // scanning for a fee change wants to open.
  if (/\bdefinitions?\b/i.test(provisionTitle)) return "definition";

  if (DEADLINE.test(changedText)) return "deadline";
  if (MONEY.test(changedText)) return "money";
  if (THRESHOLD.test(changedText)) return "threshold";
  // A definition introduced inside some other provision. Placed ahead of obligations
  // because definitions read "X shall mean Y", and an obligation check in front of it
  // swallowed every one of them — 131 defined-term changes reported as zero.
  if (/\bshall mean\b/i.test(changedText)) return "definition";
  if (OBLIGATION.test(changedText)) return "obligation";
  return "other";
}

export interface ProvisionChange {
  id: string;
  /** "3.1.1.1 Study Deposit", or the heading where there is no provision number. */
  provision: string;
  provisionNumber: string | null;
  provisionPath: string[];
  category: ImpactCategory;
  /** Material if any constituent change is; otherwise needs-review, else clarifying. */
  priority: "material" | "needs-review" | "clarifying";
  edits: Edit[];
  /**
   * Revisions in this provision — one substitution, one insertion, one deletion.
   *
   * What a reader counts. `edits` holds the individual pieces of the agency's markup, and
   * a substitution is two of those, so an edit count runs to roughly double what a person
   * would say changed in the provision.
   */
  revisionCount: number;
  /** Determinations that direct a change to this provision — evidence, not organiser. */
  determinations: Determination[];
  provisionStatus: ProvisionStatus;
  escalated: boolean;
  citations: Citation[];
  /** One sentence saying what changed. Present only when its evidence verified. */
  statement?: string;
  /** The specific added or deleted text the statement rests on. */
  statementEvidence?: string;
}

export interface Briefing {
  changes: ProvisionChange[];
  byCategory: Record<ImpactCategory, number>;
  /** Provisions touched only by changes the rules proved editorial. */
  editorialOnlyProvisions: number;
  /** Provisions whose operative text this document changed, editorial ones included. */
  totalProvisions: number;
  /** Of `changes`, how many are backed by changed text rather than by a determination. */
  editBackedProvisions: number;
}

const PRIORITY_RANK = { material: 0, "needs-review": 1, clarifying: 2 } as const;

export function buildBriefing(
  doc: ParsedDocument,
  determinations: readonly Determination[],
  materiality: MaterialityResult,
): Briefing {
  const cardable = materiality.groups.filter((g) => g.result.materiality !== "editorial");

  // Group by the provision each change sits in.
  const buckets = new Map<string, { groups: ClassifiedGroup[]; path: string[] }>();
  for (const g of cardable) {
    const section = sectionAtOffset(doc, g.group.span[0]);
    const key = section?.id ?? "unanchored";
    const bucket = buckets.get(key);
    if (bucket) bucket.groups.push(g);
    else buckets.set(key, { groups: [g], path: section?.headingPath ?? ["(unanchored)"] });
  }

  // Index determinations by the provisions they direct a change to.
  const byProvisionNumber = new Map<string, Determination[]>();
  for (const det of determinations) {
    for (const ref of det.amendedRefs) {
      const list = byProvisionNumber.get(ref);
      if (list) list.push(det);
      else byProvisionNumber.set(ref, [det]);
    }
  }

  const changes: ProvisionChange[] = [];
  const byCategory: Record<ImpactCategory, number> = {
    deadline: 0,
    money: 0,
    threshold: 0,
    obligation: 0,
    definition: 0,
    other: 0,
  };

  for (const [id, { groups, path }] of buckets) {
    const provision = path[path.length - 1] ?? "(unanchored)";
    const provisionNumber = provisionNumberOf(provision);
    const edits = groups.flatMap((g) => g.group.edits);

    // Categorise on the added and deleted text alone.
    //
    // The before/after windows were the obvious input and the wrong one: they carry the
    // unchanged surroundings too, so a provision hit whatever category its neighbourhood
    // happened to mention. Order 2023's "Recitals" landed under fees because the
    // untouched text around the edits says "security". What changed is the only evidence
    // for what kind of change it is.
    const changedText = groups
      .flatMap((g) => g.group.edits.map((e) => e.text))
      .join(" ")
      .slice(0, 6000);
    const category = categorise(changedText, provision);
    byCategory[category]++;

    const priority = groups.some((g) => g.result.materiality === "material")
      ? "material"
      : groups.some((g) => g.result.materiality === "undecided")
        ? "needs-review"
        : "clarifying";

    const dets = provisionNumber ? (byProvisionNumber.get(provisionNumber) ?? []) : [];
    const disposition = dets[0]?.disposition;

    changes.push({
      id,
      provision,
      provisionNumber,
      provisionPath: path,
      category,
      priority,
      edits,
      revisionCount: groups.length,
      determinations: dets,
      provisionStatus: deriveProvisionStatus(doc.meta.status, disposition, {
        textualChange: edits.length > 0,
      }),
      escalated: priority === "needs-review",
      citations: [...edits.map((e) => e.citation), ...dets.map((d) => d.citation)],
    });
  }

  // Fixed before the determination-only pass below, so the conservation invariant stays
  // over the population it describes: provisions whose text this document changed.
  const editBackedProvisions = changes.length;

  /**
   * Determinations that changed no text this document publishes.
   *
   * Most documents are in this position: 5 of the 7 verification documents carry
   * determinations and no parseable redline, so building the briefing from edits alone
   * would show Order No. 1920 — 66 determinations, 1,792 paragraphs — as an empty page.
   * A decision that a provision stands as written is a reviewable change in status even
   * when the operative text is untouched, and it is the only thing a redline-only tool
   * would miss entirely.
   *
   * Skipped where the provision already has an edit-backed card: there the determination
   * is attached above as evidence, and listing it again would double-count it.
   */
  const covered = new Set(changes.map((c) => c.provisionNumber).filter((n) => n !== null));
  for (const det of determinations) {
    if (det.amendedRefs.some((ref) => covered.has(ref))) continue;

    const heading = det.headingPath;
    // The determination's own heading is "Commission Determination"; the issue it decides
    // is named by its parent. That is what the reader is tracking.
    const provision = heading[heading.length - 2] ?? heading[heading.length - 1] ?? "(untitled)";
    const body = doc.text.slice(det.citation.span[0], det.citation.span[0] + 4000);
    const category = categorise(body, provision);
    byCategory[category]++;

    const priority =
      det.disposition === "unclassified"
        ? "needs-review"
        : det.disposition === "modified" || det.disposition === "set-aside"
          ? "material"
          : "clarifying";

    changes.push({
      id: det.id,
      provision,
      provisionNumber: det.amendedRefs[0] ?? null,
      provisionPath: heading,
      category,
      priority,
      edits: [],
      revisionCount: 0,
      determinations: [det],
      provisionStatus: deriveProvisionStatus(doc.meta.status, det.disposition, {
        textualChange: false,
      }),
      escalated: priority === "needs-review",
      citations: [det.citation],
    });
  }

  changes.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      // Tie-break on the unit the entry displays. Sorting on edits put a provision with
      // one large inserted block above one with fifteen separate revisions, because the
      // insert carried more pieces of markup.
      b.revisionCount - a.revisionCount,
  );

  const allProvisions = new Set(
    materiality.groups
      .map((g) => sectionAtOffset(doc, g.group.span[0])?.id)
      .filter((x): x is string => x !== undefined),
  );

  return {
    changes,
    byCategory,
    editorialOnlyProvisions: allProvisions.size - buckets.size,
    totalProvisions: allProvisions.size,
    editBackedProvisions,
  };
}
