/**
 * Phase 8 gates — the web app's API surface (docs/TDD.md §8 Phase 8).
 *
 * These run against a real Next.js server started by the suite, not against mocked
 * handlers: the point is to catch the things that only appear when the app actually
 * boots — module resolution, streaming, payload size, serialisation.
 *
 * Skipped automatically when the server cannot start, so the suite stays runnable
 * without a build step.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let usable = false;
let serverLog = "";

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/proceeding?q=`, { signal: AbortSignal.timeout(2000) });
      // Any HTTP answer means it is listening; 400 is the expected reply to an empty query.
      if (res.status > 0) return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

beforeAll(async () => {
  server = spawn("npx", ["next", "dev", "--port", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LLM_API_KEY: "", OPENAI_API_KEY: "" }, // deterministic: no model calls
  });
  server.stdout?.on("data", (b: Buffer) => (serverLog += b.toString()));
  server.stderr?.on("data", (b: Buffer) => (serverLog += b.toString()));

  usable = await waitForServer(120_000);
  if (!usable) {
    console.error(`Next.js dev server did not start on :${PORT}\n${serverLog.slice(-2000)}`);
  }
}, 120_000);

afterAll(() => {
  server?.kill("SIGTERM");
});

/**
 * Skip at run time, not at collection time.
 *
 * `usable ? it : it.skip` looks equivalent and is not: the ternary is evaluated when tests
 * are *registered*, which happens before `beforeAll` has started the server, so every test
 * was permanently skipped and the suite reported green while asserting nothing.
 */
beforeEach((ctx) => {
  if (!usable) ctx.skip();
});

describe("proceeding enumeration (PRD W1)", () => {
  it("resolves a docket to every published version", async () => {
    const res = await fetch(`${BASE}/api/proceeding?q=RM22-14`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(3);
    expect(body.versions.map((v: { status: string }) => v.status)).toEqual([
      "proposed",
      "final",
      "amended",
    ]);
  });

  it("resolves a bare document number", async () => {
    const res = await fetch(`${BASE}/api/proceeding?q=2024-06563`);
    const body = await res.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].frDocNumber).toBe("2024-06563");
  });

  it("rejects an unsupported source by naming what is supported", async () => {
    const res = await fetch(`${BASE}/api/proceeding?q=https://elibrary.ferc.gov/x`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe("unsupported-source");
    expect(body.error).toMatch(/federalregister\.gov/);
  });
});

async function analyzeDoc(docNumber: string) {
  const res = await fetch(`${BASE}/api/analyze?doc=${docNumber}&model=0`);
  expect(res.status).toBe(200);
  const text = await res.text();
  const messages = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, any>);
  const last = messages[messages.length - 1];
  if (!last) throw new Error("stream produced no messages");
  return { messages, last, bytes: text.length };
}

describe("analysis stream (PRD W2)", () => {
  async function analyze(docNumber: string) {
    const res = await fetch(`${BASE}/api/analyze?doc=${docNumber}&model=0`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const messages = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, any>);
    const last = messages[messages.length - 1];
    if (!last) throw new Error("stream produced no messages");
    return { messages, last, bytes: text.length };
  }

  it("streams stages before the result", async () => {
    const { messages, last } = await analyze("2024-06563");
    const stages = messages.filter((m) => m.stage).map((m) => m.stage);
    // Progress must arrive incrementally; a reviewer watching a blank page for thirty
    // seconds cannot tell whether anything is happening.
    expect(stages).toContain("parsed");
    expect(stages).toContain("determinations");
    expect(stages).toContain("redline");
    expect(stages).toContain("rules");
    expect(stages).toContain("cards");
    // The result is last.
    expect(last).toHaveProperty("result");
  }, 180_000);

  it("funnel counts in the response match the pipeline exactly", async () => {
    const { last } = await analyze("2024-06563");
    const result = last.result;
    const f = result.funnel;
    expect(f.material + f.editorial + f.undecided).toBe(f.totalEdits); // I1
    expect(result.verificationRate).toBe(1);
    expect(result.provisionsChanged).toBe(result.changes.length);
    // The unit shown to the reader conserves too: a revision is a substitution or an
    // insertion, an edit is one piece of markup, and a substitution is two of those.
    const r = result.funnel.revisions;
    expect(r.material + r.clarifying + r.editorial + r.undecided).toBe(result.funnel.totalGroups);
    expect(
      Object.values(result.byCategory as Record<string, number>).reduce((a, n) => a + n, 0),
    ).toBe(result.changes.length);
  }, 180_000);

  it("stays well under the 4.5 MB platform body limit", async () => {
    // The design rule from docs/TDD.md §9: cards reference spans by offset and the client
    // fetches source on demand, rather than embedding a 2.3 MB document in the response.
    const { bytes } = await analyze("2024-06563");
    expect(bytes).toBeLessThan(4_500_000);
    expect(bytes).toBeLessThan(1_000_000); // and in practice, far under
  }, 180_000);

  it("surfaces the compliance filing deadline on a final rule", async () => {
    // The date that binds the reader's own organisation, and the one thing the operative
    // text never states.
    const { last } = await analyze("2023-16628");
    const cd = last.result.complianceDeadlines;
    expect(cd).toHaveLength(1);
    expect(cd[0].dueOn).toBe("2023-12-05");
    expect(cd[0].description).toBe("90 days from publication");
  }, 180_000);

  it("reports a document with no redline honestly", async () => {
    const { last } = await analyze("2024-10872");
    const result = last.result;
    expect(result.redline.available).toBe(false);
    expect(result.redline.reason).toMatch(/does not declare a redline convention/i);
    // Determinations still carry: 66 decisions to review, which is exactly what a
    // redline-only tool would show as nothing at all.
    expect(result.changes).toHaveLength(66);
    expect(result.changes.every((c: { revisionCount: number }) => c.revisionCount === 0)).toBe(
      true,
    );
  }, 180_000);
});

describe("a proposed rule is useful, not a page of zeroes", () => {
  it("surfaces the comment deadline, which is the costliest thing to miss", async () => {
    // The PRD names a blown comment deadline as the top cost: the record closes and
    // there is no second opportunity to shape the rule. For a NOPR it belongs above
    // everything else on the page.
    const { last } = await analyzeDoc("2022-13470");
    expect(last.result.meta.commentsCloseOn).toBe("2022-10-13");
    expect(last.result.meta.datesNote).toMatch(/Reply Comments/i);
    expect(last.result.meta.cfrReferences).toContain("18 CFR Part 35");
  }, 180_000);

  it("shows the agency's own abstract rather than a generated summary", async () => {
    // Authoritative, published, and free of our inference — the right kind of summary for
    // a product whose premise is verifiability.
    const { last } = await analyzeDoc("2022-13470");
    expect(last.result.meta.abstract).toMatch(/Notice of Proposed Rulemaking/i);
  }, 180_000);

  it("shows the document's own outline when there is nothing else to analyse", async () => {
    const { last } = await analyzeDoc("2022-13470");
    expect(last.result.changes).toHaveLength(0);
    const titles = last.result.outline.map((o: { title: string }) => o.title);
    expect(titles.some((t: string) => /Proposed Reforms/i.test(t))).toBe(true);
  }, 180_000);

  it("reports the citation denominator, not a bare percentage", async () => {
    // "100% verified" with nothing to compare against is noise. The count is what makes
    // the number mean anything.
    const { last } = await analyzeDoc("2022-13470");
    expect(last.result.claimsChecked).toBe(370);
    expect(last.result.verificationRate).toBe(1);
  }, 180_000);
});

describe("in-place source verification (PRD FR9)", () => {
  it("returns the cited passage with surrounding context", async () => {
    const res = await fetch(`${BASE}/api/source?doc=2024-06563&start=1406682&end=1406696&pad=80`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const join = (segs: Array<{ text: string }>) => segs.map((s) => s.text).join("");
    expect(join(body.quote)).toHaveLength(14);
    expect(join(body.before).length).toBeGreaterThan(0);
    expect(join(body.after).length).toBeGreaterThan(0);
    expect(body.sectionPath.length).toBeGreaterThan(0);
    expect(body.sourceUrl).toMatch(/federalregister\.gov/);
  }, 120_000);

  it("marks the additions and deletions inside the passage it returns", async () => {
    // Plain text answers "is this really in the document?" but not "what changed in it?",
    // which is the question a reviewer opening the source actually has. Additions are
    // italics in the XML and vanish entirely once the text is flattened.
    const res = await fetch(`${BASE}/api/source?doc=2024-06563&start=1406682&end=1406696&pad=600`);
    const body = await res.json();
    expect(body.redlined).toBe(true);
    const all = [...body.before, ...body.quote, ...body.after];
    expect(all.some((s: { kind: string }) => s.kind === "addition")).toBe(true);
    expect(all.some((s: { kind: string }) => s.kind === "unchanged")).toBe(true);
  }, 120_000);

  it("refuses an oversized span rather than shipping the document", async () => {
    const res = await fetch(`${BASE}/api/source?doc=2024-06563&start=0&end=999999`);
    expect(res.status).toBe(413);
  }, 120_000);

  it("rejects a span outside the document", async () => {
    const res = await fetch(`${BASE}/api/source?doc=2024-06563&start=99000000&end=99000010`);
    expect(res.status).toBe(400);
  }, 120_000);
});

describe("expert feedback (PRD FR12)", () => {
  it("persists a verdict and reads it back", async () => {
    const cardId = `test-${Date.now()}`;
    const post = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frDocNumber: "test-doc",
        cardId,
        verdict: "disagree",
        note: "reads as clarifying",
      }),
    });
    expect(post.status).toBe(200);

    const list = await fetch(`${BASE}/api/feedback?doc=test-doc`);
    const body = await list.json();
    expect(body.records.some((r: { cardId: string }) => r.cardId === cardId)).toBe(true);
  });

  it("rejects a verdict outside the closed set", async () => {
    const res = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frDocNumber: "x", cardId: "y", verdict: "lgtm" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON without falling over", async () => {
    const res = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
