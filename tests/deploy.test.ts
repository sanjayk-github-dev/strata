/**
 * Deployment concerns: the access gate, and surviving a read-only filesystem.
 *
 * Both are things that work locally and fail only once deployed, which is the worst shape
 * for a bug. A serverless bundle's filesystem is read-only outside the temp directory, so
 * the first cache write throws EROFS and takes the whole analysis with it — and an
 * unarmed access gate is silent by nature.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COOKIE_NAME,
  accessToken,
  configuredPasscode,
  isValidCookie,
  timingSafeEqual,
} from "../src/auth/passcode.js";
import { FileCache } from "../src/cache/file.js";
import { resetCacheDirForTests, writableCacheDir } from "../src/cache/dir.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetCacheDirForTests();
});

describe("the access gate", () => {
  it("is off when no passphrase is configured", () => {
    delete process.env["SITE_PASSCODE"];
    expect(configuredPasscode()).toBeNull();

    // Whitespace is not a passphrase — an env var set to " " must not arm the gate and
    // then reject everyone, nor arm it and accept a space.
    process.env["SITE_PASSCODE"] = "   ";
    expect(configuredPasscode()).toBeNull();
  });

  it("is armed when one is", () => {
    process.env["SITE_PASSCODE"] = "  open sesame  ";
    expect(configuredPasscode()).toBe("open sesame");
  });

  it("issues a cookie that does not contain the passphrase", async () => {
    // A cookie is visible to anything that can read the request. Carrying the secret
    // itself would mean a single intercepted request hands over the passphrase.
    const token = await accessToken("correct horse battery staple");
    expect(token).not.toContain("correct");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts its own cookie and rejects one issued for a different passphrase", async () => {
    const token = await accessToken("alpha");
    expect(await isValidCookie(token, "alpha")).toBe(true);
    expect(await isValidCookie(token, "beta")).toBe(false);
    expect(await isValidCookie(undefined, "alpha")).toBe(false);
    expect(await isValidCookie("", "alpha")).toBe(false);
  });

  it("compares without leaking length or position", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
  });

  it("names the cookie stably", () => {
    // Renaming it silently logs every reviewer out mid-evaluation.
    expect(COOKIE_NAME).toBe("strata_access");
  });
});

describe("a read-only filesystem degrades, it does not fail", () => {
  it("falls back to a temp directory when the preferred one cannot be written", () => {
    const unwritable = "/proc/strata-cannot-write-here";
    const dir = writableCacheDir(unwritable);
    expect(dir).not.toBe(unwritable);
    expect(dir.startsWith(tmpdir())).toBe(true);
  });

  it("honours STRATA_CACHE_DIR when it is writable", () => {
    const explicit = mkdtempSync(join(tmpdir(), "strata-explicit-"));
    try {
      process.env["STRATA_CACHE_DIR"] = explicit;
      expect(writableCacheDir("/proc/nope")).toBe(explicit);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it("uses the preferred directory when it is writable", () => {
    const preferred = mkdtempSync(join(tmpdir(), "strata-preferred-"));
    try {
      delete process.env["STRATA_CACHE_DIR"];
      expect(writableCacheDir(preferred)).toBe(preferred);
    } finally {
      rmSync(preferred, { recursive: true, force: true });
    }
  });

  it("a cache write that cannot land is a slower run, not a failed one", async () => {
    // The whole point: every value in this cache is re-fetchable from the Federal
    // Register API, so an unwritable cache costs a round trip and nothing else. Throwing
    // here would turn a read-only deployment into a product that cannot analyse anything.
    const cache = new FileCache("/proc/strata-cannot-write-here");
    await expect(cache.set("k", "v")).resolves.toBeUndefined();
    await expect(cache.get("k")).resolves.toBeNull();
  });

  it("round-trips through a writable directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-rt-"));
    try {
      const cache = new FileCache(dir);
      await cache.set("xml/2024-06563", "<RULE/>");
      expect(await cache.get("xml/2024-06563")).toBe("<RULE/>");
      expect(await cache.get("xml/absent")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
