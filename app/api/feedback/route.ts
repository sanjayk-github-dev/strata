/**
 * Expert feedback (PRD FR12).
 *
 * This is the product's only source of labelled data — evals are deliberately not built
 * in v1, and this is what they would bootstrap from (docs/TDD.md §11). Append-only.
 */
import { NextResponse } from "next/server";

import { feedbackStore, type Verdict } from "@/src/store/feedback";

export const runtime = "nodejs";

const VERDICTS: readonly Verdict[] = ["agree", "disagree", "recategorize"];

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const frDocNumber = typeof body["frDocNumber"] === "string" ? body["frDocNumber"] : "";
  const cardId = typeof body["cardId"] === "string" ? body["cardId"] : "";
  const raw = typeof body["verdict"] === "string" ? body["verdict"] : "";
  const verdict = VERDICTS.find((v) => v === raw);
  const note = typeof body["note"] === "string" ? body["note"].slice(0, 2000) : undefined;

  if (!frDocNumber || !cardId || !verdict) {
    return NextResponse.json(
      { error: `Provide frDocNumber, cardId, and verdict (${VERDICTS.join(" | ")})` },
      { status: 400 },
    );
  }

  const record = await feedbackStore().add({ frDocNumber, cardId, verdict, ...(note ? { note } : {}) });
  return NextResponse.json({ record });
}

export async function GET(request: Request): Promise<Response> {
  const frDocNumber = new URL(request.url).searchParams.get("doc");
  if (!frDocNumber) return NextResponse.json({ error: "Provide ?doc=" }, { status: 400 });
  return NextResponse.json({ records: await feedbackStore().listFor(frDocNumber) });
}
