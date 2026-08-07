/**
 * Deployment self-check.
 *
 * Reports the three things that are configuration rather than code, and that fail
 * silently when wrong: whether the access gate is armed, whether a model provider is
 * configured, and whether anything written survives the instance. A deploy that is
 * quietly open, quietly running deterministic-only, or quietly losing feedback should be
 * visible in one request.
 *
 * Deliberately public — it names no secrets, only whether each is present.
 */
import { NextResponse } from "next/server";

import { configuredPasscode } from "@/src/auth/passcode";
import { resolveLlmConfig } from "@/src/llm/index";
import { feedbackDurability } from "@/src/store/feedback";

export const runtime = "nodejs";

export function GET(): Response {
  const llm = resolveLlmConfig();
  return NextResponse.json({
    ok: true,
    accessGate: configuredPasscode() ? "armed" : "open",
    modelProvider: llm ? { configured: true, model: llm.model } : { configured: false },
    feedback: feedbackDurability(),
  });
}
