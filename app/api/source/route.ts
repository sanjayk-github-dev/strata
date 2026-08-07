/**
 * Serve a source span for in-place verification (PRD FR9).
 *
 * Spans are fetched on demand rather than shipping the document to the client. A single
 * order is 2.3 MB of text; embedding it in a response would blow the platform's 4.5 MB
 * body limit and make every card payload enormous for no benefit.
 *
 * The response includes the span's own text plus surrounding context, so a reviewer sees
 * the cited passage *in situ* rather than as a bare fragment — and, where the document
 * publishes a redline, with the additions and deletions still marked. Flattened to plain
 * text the passage answers "is this really in the document?" but not "what changed in
 * it?", which is the question the reviewer actually arrived with.
 */
import { NextResponse } from "next/server";

import { analyzeDocument, extractRedline, segmentSource, sectionAtOffset } from "@/src/pipeline/index";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_SPAN = 20_000;

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const docNumber = p.get("doc");
  const start = Number(p.get("start"));
  const end = Number(p.get("end"));
  const pad = Math.min(Number(p.get("pad") ?? 400), 2000);

  if (!docNumber || !Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    return NextResponse.json({ error: "Provide doc, start, end" }, { status: 400 });
  }
  if (end - start > MAX_SPAN) {
    return NextResponse.json({ error: `Span exceeds ${MAX_SPAN} characters` }, { status: 413 });
  }

  try {
    const doc = await analyzeDocument(docNumber);
    if (start < 0 || end > doc.text.length) {
      return NextResponse.json({ error: "Span outside document" }, { status: 400 });
    }
    const section = sectionAtOffset(doc, start);
    const rl = extractRedline(doc);
    const seg = (from: number, to: number) =>
      segmentSource(doc.text.slice(from, to), from, rl.edits);

    const beforeStart = Math.max(0, start - pad);
    const afterEnd = Math.min(doc.text.length, end + pad);
    return NextResponse.json({
      before: seg(beforeStart, start),
      quote: seg(start, end),
      after: seg(end, afterEnd),
      /** True where the markup is meaningful, so the client can label it honestly. */
      redlined: rl.region !== null,
      sectionPath: section?.headingPath ?? [],
      sourceUrl: doc.meta.htmlUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 502 },
    );
  }
}
