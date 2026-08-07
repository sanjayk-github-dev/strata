/**
 * Exchange the shared passphrase for an access cookie.
 *
 * The cookie holds an HMAC of the passphrase, never the passphrase, so it cannot be read
 * back into the secret it was issued for.
 */
import { NextResponse } from "next/server";

import {
  COOKIE_NAME,
  accessToken,
  configuredPasscode,
  timingSafeEqual,
} from "@/src/auth/passcode";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const passcode = configuredPasscode();
  if (!passcode) return NextResponse.json({ ok: true, gate: "off" });

  let supplied = "";
  try {
    const body = (await request.json()) as { passcode?: unknown };
    supplied = typeof body.passcode === "string" ? body.passcode.trim() : "";
  } catch {
    supplied = "";
  }

  if (!timingSafeEqual(supplied, passcode)) {
    return NextResponse.json({ error: "That passphrase is not right." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await accessToken(passcode), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
