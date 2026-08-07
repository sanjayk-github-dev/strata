/**
 * Shared-passphrase access gate.
 *
 * This is a doorlock, not authentication. It exists because a deployed instance calls a
 * paid model API with the operator's key on every uncached analysis, so an open URL is an
 * open wallet — a crawler finding it can spend real money, repeatedly. Keeping an
 * evaluation link off the open web is the other reason, and the lesser one.
 *
 * What it deliberately is not: per-person identity, an audit trail, or protection against
 * someone the passphrase was shared with. If those are needed, they need real accounts.
 *
 * The cookie carries an HMAC of the passphrase rather than the passphrase itself, so a
 * stolen cookie cannot be read back into the secret. Comparison is constant-time, because
 * a timing oracle on a short shared secret is worth the four lines it costs to avoid.
 */

const encoder = new TextEncoder();

/**
 * Web Crypto rather than `node:crypto`, so the same code runs in Next.js middleware
 * (which is edge-runtime even when the routes it guards are Node).
 */
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const COOKIE_NAME = "strata_access";

/** The value a valid cookie carries. Derived from the passphrase, never equal to it. */
export function accessToken(passcode: string): Promise<string> {
  return hmac(passcode, "strata-access-v1");
}

/** Length-safe, constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  // Compare over the longer length so a length mismatch costs the same as a value one.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * The configured passphrase, or null when the gate is off.
 *
 * Off is a legitimate configuration — local development, and anyone running this on their
 * own machine. It is not a silent default in deployment: the deployment checklist sets
 * `SITE_PASSCODE`, and `/api/health` reports whether the gate is armed so a misconfigured
 * deploy is visible rather than quietly open.
 */
export function configuredPasscode(): string | null {
  const raw = process.env["SITE_PASSCODE"];
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

export async function isValidCookie(value: string | undefined, passcode: string): Promise<boolean> {
  if (!value) return false;
  return timingSafeEqual(value, await accessToken(passcode));
}
