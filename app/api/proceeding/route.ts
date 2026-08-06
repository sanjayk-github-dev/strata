/**
 * T1 — enumerate every published version of a proceeding.
 *
 * Always available, for every federal docket at every agency. Fast: one API call, no
 * document parsing.
 */
import { NextResponse } from "next/server";

import { resolveVersions, UnsupportedSourceError } from "@/src/pipeline/index";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const input = new URL(request.url).searchParams.get("q")?.trim();
  if (!input) {
    return NextResponse.json({ error: "Provide ?q=<docket, document number, or FR URL>" }, { status: 400 });
  }

  try {
    const versions = await resolveVersions(input);
    return NextResponse.json({ input, versions });
  } catch (err) {
    if (err instanceof UnsupportedSourceError) {
      // Naming what IS supported, rather than a bare rejection.
      return NextResponse.json({ error: err.message, kind: "unsupported-source" }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 502 },
    );
  }
}
