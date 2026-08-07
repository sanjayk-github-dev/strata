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
import {
  mergeSpans,
  PASSAGE_CONTEXT,
  reconstructPassage,
  type ClassifiedGroup,
  type MaterialityResult,
} from "./materiality.js";
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
  deadline: "Deadlines and time limits",
  money: "Fees, deposits and penalties",
  threshold: "Thresholds and eligibility",
  obligation: "Who must do what",
  definition: "Defined terms",
  other: "Other changes",
};

/**
 * What each group contains, in a sentence.
 *
 * A reader asked whether every card under "Deadlines and timing" was a deadline, and what
 * "timing" meant. Both are fair questions about a two-word heading: the group holds
 * *provisions whose time requirements changed*, which is not the same as a list of dates,
 * and nothing on the page said so. A category label that needs explaining should carry
 * the explanation.
 */
export const CATEGORY_GLOSS: Record<ImpactCategory, string> = {
  deadline:
    "Provisions whose time requirements changed — how long a step may take, or when the clock starts.",
  money:
    "Provisions changing an amount owed, a deposit or security requirement, or whether money is refundable.",
  threshold:
    "Provisions changing a size, capacity, or eligibility limit — the line between being covered and not.",
  obligation:
    "Provisions moving a duty between parties, or adding and removing one.",
  definition:
    "Provisions changing a defined term, which carries into every other provision that uses it.",
  other: "Substantive changes that do not fall into the groups above.",
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
/**
 * Timing language, strongest signal first.
 *
 * The order is load-bearing twice over. A bare `\bdays?\b` seemed obviously right and was
 * not: every FERC agreement ends "executed ... on the day and year first above written",
 * so the pro forma LGIA's signature block matched and a 33-revision Recitals entry sat at
 * the top of the briefing with no deadline in it. A period of time is a deadline when it
 * is *counted* or when the text names the timing concept outright.
 *
 * Strongest-first matters again when choosing what a card opens on. "Processing Time" in
 * a heading is a real timing signal and a useless place to start reading; "one hundred
 * fifty (150) Calendar Days" is the thing the reader came for.
 */
const DEADLINE_SIGNALS = [
  /\b(?:\d+|\(\d+\))\s*(?:calendar|business|working)\s+days?\b/i,
  /\b(?:calendar|business|working)\s+days?\b/i,
  /\bwithin\s+(?:\S+\s+){0,4}?(?:days?|weeks?|months?|hours?)\b/i,
  /\bno later than\b/i,
  /\b\d+\s+(?:days?|weeks?|months?|years?)\b/i,
  /\(\d+\)\s*(?:days?|weeks?|months?)\b/i,
  /\bdue date\b/i,
  /\bdeadline/i,
  /\btimeline/i,
  /\bwindow\b/i, // "Cluster Request Window" — a defined filing period
  /\bprocessing time\b/i,
];

/**
 * `\bsecurity\b` alone was too broad in the other direction: reliability and system
 * security are discussed constantly in these documents and are not money. Financial
 * security has its own vocabulary, so use that.
 */
const MONEY_SIGNALS = [
  /\$[\d,]+/,
  /\bfinancial security\b/i,
  /\bsecurity (?:deposit|arrangement|instrument)/i,
  /\bletter of credit\b/i,
  /\b(?:non-?)?refund/i,
  /\bpenalt/i,
  /\bdeposit/i,
  /\bfees?\b/i,
  /\bsurety\b/i,
  /\bcosts?\b/i,
  /\$/,
];

/** Bare "at least" and "no more than" quantify anything; require the quantity. */
const THRESHOLD_SIGNALS = [
  /\b\d[\d,.]*\s*(?:MW|kV)\b/i,
  /\b\d[\d,.]*\s*percent\b|\b\d[\d,.]*\s*%/i,
  /\bat least\s+\d/i,
  /\bno more than\s+\d/i,
  /\bthreshold/i,
  /\bexceeds?\b/i,
  /\bMW\b|\bkV\b|\bpercent\b|%/,
];

const DEFINITION_SIGNALS = [/\bshall mean\b/i];

/** "will" is future tense far more often than it is an obligation. */
const OBLIGATION_SIGNALS = [/\b(?:shall not|may not|must not)\b/i, /\b(?:shall|must|is required to|are required to)\b/i];

export const CATEGORY_SIGNALS: Record<Exclude<ImpactCategory, "other">, RegExp[]> = {
  deadline: DEADLINE_SIGNALS,
  money: MONEY_SIGNALS,
  threshold: THRESHOLD_SIGNALS,
  definition: DEFINITION_SIGNALS,
  obligation: OBLIGATION_SIGNALS,
};

const has = (signals: RegExp[], text: string) => signals.some((re) => re.test(text));

/** Offset of the strongest signal present, or -1. Used to choose where a card opens. */
function strongestSignalAt(signals: RegExp[], text: string): number {
  for (const re of signals) {
    const at = text.search(re);
    if (at !== -1) return at;
  }
  return -1;
}

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

  if (has(DEADLINE_SIGNALS, changedText)) return "deadline";
  if (has(MONEY_SIGNALS, changedText)) return "money";
  if (has(THRESHOLD_SIGNALS, changedText)) return "threshold";
  // A definition introduced inside some other provision. Placed ahead of obligations
  // because definitions read "X shall mean Y", and an obligation check in front of it
  // swallowed every one of them — 131 defined-term changes reported as zero.
  if (has(DEFINITION_SIGNALS, changedText)) return "definition";
  if (has(OBLIGATION_SIGNALS, changedText)) return "obligation";
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
  /**
   * The provision as it reads after the amendment, over the passages that changed.
   *
   * The reader's first question is what they are now obliged to do, and a list of redline
   * fragments cannot answer it — it is a diff with no document behind it. Reconstructed
   * deterministically (drop the bracketed deletions, keep the italicised additions), so
   * this is source text, not a summary, and it carries a span like any other citation.
   */
  passages: Passage[];
  /** Passages before the display cap, so the remainder stays honest. */
  passageCount: number;
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

export interface Passage {
  text: string;
  /** The same window as it read before the amendment — the model's input, not shown. */
  before: string;
  span: [number, number];
  /** True for the passage carrying the signal that decided this provision's category. */
  leads: boolean;
  /** Text was dropped before / after what is shown. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * How much of one passage to print.
 *
 * Adjacent revisions merge into a single window, and in a heavily amended provision that
 * window is the whole provision — §3.5.2.1's twenty revisions merge into one passage of
 * several thousand characters. Section 1. Definitions produced one of 6,569.
 */
const MAX_PASSAGE_CHARS = 900;

/**
 * Window a passage so it opens on the text that put the provision in its category.
 *
 * Without this the leading passage still begins wherever the provision begins. The top
 * deadline card opened on "Number of Interconnection Requests that had Cluster Studies
 * completed…" and the reader had to read several hundred characters to reach the hundred
 * and fifty Calendar Days that filed it under deadlines — which is precisely the
 * complaint the category was supposed to answer.
 */
function focus(
  text: string,
  signals: RegExp[] | null,
): { text: string; clippedStart: boolean; clippedEnd: boolean } {
  const at = signals ? strongestSignalAt(signals, text) : -1;
  if (text.length <= MAX_PASSAGE_CHARS && at <= 0) {
    return { text, clippedStart: false, clippedEnd: false };
  }

  // Back up to the start of the sentence carrying the signal, so the passage opens on a
  // whole thought rather than mid-clause.
  let start = 0;
  if (at > 0) {
    const lead = text.slice(Math.max(0, at - 400), at);
    const boundary = lead.lastIndexOf(". ");
    if (boundary !== -1) {
      start = at - (lead.length - boundary - 2);
    } else {
      // No sentence break within reach. Snap forward to a word boundary rather than
      // opening mid-word — the passage began "egion during the reporting quarter".
      const rough = Math.max(0, at - 120);
      const space = text.indexOf(" ", rough);
      start = space === -1 || space > at ? rough : space + 1;
    }
  }
  const end = Math.min(text.length, start + MAX_PASSAGE_CHARS);
  return {
    text: text.slice(start, end),
    clippedStart: start > 0,
    clippedEnd: end < text.length,
  };
}

/**
 * How many passages a card shows.
 *
 * Section 1. Definitions changes in 73 places; printing all of them would put 20,000
 * characters in one card. The count is reported so the remainder is visible.
 */
const MAX_PASSAGES = 4;

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

    // Widen each revision to something readable, merge what overlaps, and reconstruct.
    const windows = mergeSpans(
      groups.map(
        (g) => [g.group.span[0] - PASSAGE_CONTEXT, g.group.span[1] + PASSAGE_CONTEXT] as const,
      ),
      PASSAGE_CONTEXT,
    );
    const signals = category === "other" ? null : CATEGORY_SIGNALS[category];
    const all: Passage[] = windows.map((w) => {
      const sec = id === "unanchored" ? undefined : id;
      const r = reconstructPassage(doc, w, materiality.edits, sec);
      const b = reconstructPassage(doc, w, materiality.edits, sec, "before");
      const leads = signals ? has(signals, r.text) : false;
      const f = focus(r.text, leads ? signals : null);
      return {
        text: f.text,
        before: b.text,
        span: r.span,
        leads,
        clippedStart: f.clippedStart,
        clippedEnd: f.clippedEnd,
      };
    });
    // The passage that earned the category goes first; the rest keep document order.
    const ordered = [...all.filter((x) => x.leads), ...all.filter((x) => !x.leads)];

    changes.push({
      id,
      provision,
      provisionNumber,
      provisionPath: path,
      category,
      priority,
      edits,
      revisionCount: groups.length,
      passages: ordered.slice(0, MAX_PASSAGES),
      passageCount: ordered.length,
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
      passages: [],
      passageCount: 0,
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
