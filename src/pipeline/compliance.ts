/**
 * The compliance filing deadline.
 *
 * A final rule's operative text says what the tariff must say. It does not say when the
 * utility has to file the tariff — that lives in one sentence of the preamble, under a
 * "Compliance Procedures" heading, and it is the single date in the document that carries
 * a hard consequence for the reader's own organisation. Order No. 2023 gives ninety
 * calendar days from publication; Order No. 1920 gives ten months from the effective
 * date, and a further twelve for interregional coordination.
 *
 * Extraction is structural, not lexical. The section that decides compliance timing is a
 * determination block under a Compliance heading, which Phase 3 already locates; all this
 * adds is finding the directive sentence inside it and resolving the period against the
 * document's own publication and effective dates. Nothing here is inferred by a model,
 * and every result carries a citation that the verifier checks like any other claim.
 */

import { locateQuote } from "./citation.js";
import type { Citation, Determination, ParsedDocument } from "./types.js";

/** The agency directing a filing, as distinct from describing what someone asked for. */
const DIRECTIVE =
  /\b(?:we|the Commission)\b[^.]{0,120}?\b(?:require|direct|will require|are requiring)\b/i;

/**
 * Language that makes a sentence a report of someone else's position, or arithmetic about
 * a deadline set elsewhere.
 *
 * Narrow on purpose. A first draft also excluded any sentence containing "request", which
 * dropped Order No. 1920's second deadline — "In response to MISO's request for a
 * separate, longer compliance timeline, we also modify the NOPR proposal and require each
 * transmission provider to submit a separate compliance filing within 12 months" — a
 * genuine directive that happens to name who asked for it. Requiring the agency's own
 * directive voice already excludes commenter positions, which never carry it.
 */
const REPORTED = /\b(?:suggests?|urges?|argues?|would be more appropriate|in calculating)\b/i;

const PERIOD =
  /\bwithin\s+((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|eighteen|twenty|thirty|forty-five|sixty|ninety|one hundred eighty))\s+(?:calendar\s+|business\s+)?(days?|months?|years?)\b/i;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
  "forty-five": 45,
  sixty: 60,
  ninety: 90,
  "one hundred eighty": 180,
};

/** What the period is counted from. The document says which; it is never assumed. */
export type DeadlineAnchor = "publication" | "effective" | "unstated";

export interface ComplianceDeadline {
  /** The sentence, verbatim. */
  sentence: string;
  count: number;
  unit: "days" | "months" | "years";
  anchor: DeadlineAnchor;
  /**
   * The resolved date, when the anchor is known and dated in the document's metadata.
   *
   * Null is a real answer: a period counted from an effective date the agency has not yet
   * set cannot be resolved, and guessing one would be worse than reporting the period.
   */
  dueOn: string | null;
  citation: Citation;
}

function parseCount(raw: string): number | null {
  const digits = Number(raw);
  if (Number.isFinite(digits)) return digits;
  return WORD_NUMBERS[raw.toLowerCase()] ?? null;
}

function addPeriod(iso: string, count: number, unit: ComplianceDeadline["unit"]): string | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (unit === "days") date.setUTCDate(date.getUTCDate() + count);
  else if (unit === "months") date.setUTCMonth(date.getUTCMonth() + count);
  else date.setUTCFullYear(date.getUTCFullYear() + count);
  return date.toISOString().slice(0, 10);
}

function anchorOf(sentence: string): DeadlineAnchor {
  if (/\bpublication date\b|\bdate of publication\b|\bpublished in the Federal Register\b/i.test(sentence)) {
    return "publication";
  }
  if (/\beffective date\b|\bbecomes effective\b/i.test(sentence)) return "effective";
  return "unstated";
}

/**
 * Compliance filing deadlines stated in this document.
 *
 * Returns [] where the document sets none — a proposed rule directs no filing, and an
 * order on rehearing usually leaves the original deadline standing. That is the honest
 * result, not a failure.
 */
export function extractComplianceDeadlines(
  doc: ParsedDocument,
  determinations: readonly Determination[],
): ComplianceDeadline[] {
  const blocks = determinations.filter((d) =>
    d.headingPath.some((h) => /compliance procedures?\b/i.test(h)),
  );

  const out: ComplianceDeadline[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const body = doc.text.slice(block.citation.span[0], block.citation.span[1]);
    for (const raw of body.split(/(?<=\.)\s+/)) {
      const sentence = raw.replace(/\s+/g, " ").trim();
      if (!/compliance filing/i.test(sentence)) continue;
      if (!DIRECTIVE.test(sentence) || REPORTED.test(sentence)) continue;

      const period = PERIOD.exec(sentence);
      if (!period) continue;
      const count = parseCount(period[1]!);
      if (count === null) continue;
      const unit = period[2]!.toLowerCase().replace(/s$/, "") + "s";

      // Citation over assertion, as everywhere else: the sentence is located in source and
      // the span computed by code, never taken from the extractor's own bookkeeping.
      const located = locateQuote(doc, sentence, { sectionId: block.id });
      if (!located.ok) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);

      const anchor = anchorOf(sentence);
      const from =
        anchor === "publication"
          ? doc.meta.publicationDate
          : anchor === "effective"
            ? doc.meta.effectiveOn
            : null;

      out.push({
        sentence,
        count,
        unit: unit as ComplianceDeadline["unit"],
        anchor,
        dueOn: from ? addPeriod(from, count, unit as ComplianceDeadline["unit"]) : null,
        citation: located.citation,
      });
    }
  }

  return out;
}

/** "90 calendar days from publication — due 2023-11-21", or the period alone. */
export function describeDeadline(d: ComplianceDeadline): string {
  const from =
    d.anchor === "publication"
      ? "from publication"
      : d.anchor === "effective"
        ? "from the effective date"
        : "from the date the document states";
  return `${d.count} ${d.unit} ${from}`;
}
