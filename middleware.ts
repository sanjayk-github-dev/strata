/**
 * Access gate.
 *
 * Runs before every page and API route. When `SITE_PASSCODE` is unset the gate is off and
 * this is a pass-through, which is the local-development case; when it is set, an
 * unrecognised visitor gets the unlock page and nothing else.
 *
 * The gate is here rather than in each route because a route added later would otherwise
 * be open by default — and the expensive route is the one that spends model credits.
 */
import { NextResponse, type NextRequest } from "next/server";

import { COOKIE_NAME, configuredPasscode, isValidCookie } from "@/src/auth/passcode";

/** Paths that must answer before the visitor has unlocked anything. */
const PUBLIC = ["/unlock", "/api/unlock", "/api/health"];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const passcode = configuredPasscode();
  if (!passcode) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (await isValidCookie(request.cookies.get(COOKIE_NAME)?.value, passcode)) {
    return NextResponse.next();
  }

  // An API call gets a status it can act on; a page gets somewhere to go.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "This instance requires a passphrase." }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own static output, which carries nothing worth gating.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
