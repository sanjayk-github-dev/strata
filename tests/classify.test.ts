/**
 * Phase 6 gates — model-tier classification (docs/TDD.md §8 Phase 6).
 *
 * Almost every test here asserts what happens when the model behaves badly: invalid
 * labels, fabricated quotes, malformed JSON, omitted items, provider failures. That is
 * the point of the architecture — the model is assumed to be wrong sometimes, and the
 * system's job is to bound how that wrongness surfaces.
 *
 * Runs offline. Stubs cover the failure paths (which cannot be recorded on demand);
 * cassettes cover real provider output where recorded.
 */

import { describe, expect, it } from "vitest";

import { StubLlmClient, cassetteKey } from "../src/llm/index.js";
import {
  classifyDisposition,
  classifyEdits,
  classifyResiduals,
  deriveProvisionStatus,
  extractDeterminations,
  extractJson,
  extractRedline,
  requiresEscalation,
  verifyCitation,
} from "../src/pipeline/index.js";
import { DOCS, doc } from "./fixtures.js";

const jsonOf = (o: unknown) => JSON.stringify(o);

describe("JSON extraction tolerates provider quirks", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses markdown-fenced JSON — several compatible providers wrap output", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON embedded in prose", () => {
    expect(extractJson('Sure! Here it is:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("returns null rather than throwing on unparseable output", () => {
    expect(extractJson("I'm afraid I can't do that.")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("disposition classification", () => {
  async function firstBlock() {
    const d = await doc(DOCS.order2023A);
    const det = extractDeterminations(d)[0]!;
    return { d, det };
  }

  it("accepts a valid disposition grounded in a verified quote", async () => {
    const { d, det } = await firstBlock();
    // Quote real text from inside the block so it will verify.
    const real = d.text.slice(det.citation.span[0] + 400, det.citation.span[0] + 520);

    const llm = new StubLlmClient([
      jsonOf({ disposition: "sustained", quote: real, confidence: 0.9 }),
    ]);
    const out = await classifyDisposition(d, det, llm);

    expect(out.determination.disposition).toBe("sustained");
    expect(out.escalated).toBe(false);
    expect(out.supportingQuote).toBeDefined();
    // The citation narrowed from the whole block to the supporting passage, and verifies.
    expect(verifyCitation(d, out.determination.citation).ok).toBe(true);
    expect(out.determination.citation.span[1] - out.determination.citation.span[0]).toBeLessThan(
      det.citation.span[1] - det.citation.span[0],
    );
  });

  it("escalates when the supporting quote cannot be verified", async () => {
    // A correct-looking label with a fabricated quote is the dangerous case: the label
    // may be right, but nothing grounds it. The verifier doubles as a confidence signal.
    const { d, det } = await firstBlock();
    const llm = new StubLlmClient([
      jsonOf({
        disposition: "affirmed",
        quote: "The Commission hereby abolishes all interconnection deposits.",
        confidence: 0.99,
      }),
    ]);
    const out = await classifyDisposition(d, det, llm);

    expect(out.determination.disposition).toBe("affirmed");
    expect(out.escalated).toBe(true);
    expect(out.supportingQuote).toBeUndefined();
    expect(out.reason).toMatch(/could not be verified/i);
    // Falls back to the block citation, which is code-supplied and always verifies.
    expect(verifyCitation(d, out.determination.citation).ok).toBe(true);
  });

  it("escalates an out-of-vocabulary label instead of coercing it", async () => {
    const { d, det } = await firstBlock();
    const llm = new StubLlmClient([
      jsonOf({ disposition: "partially granted in part", quote: "", confidence: 0.8 }),
    ]);
    const out = await classifyDisposition(d, det, llm);

    expect(out.determination.disposition).toBe("unclassified");
    expect(out.escalated).toBe(true);
    expect(out.reason).toMatch(/unrecognised disposition/i);
  });

  it("escalates when the model declines to decide", async () => {
    const { d, det } = await firstBlock();
    const llm = new StubLlmClient([jsonOf({ disposition: "unclear", quote: "", confidence: 0 })]);
    const out = await classifyDisposition(d, det, llm);
    expect(out.determination.disposition).toBe("unclassified");
    expect(out.escalated).toBe(true);
  });

  it("escalates on malformed output rather than throwing", async () => {
    const { d, det } = await firstBlock();
    for (const bad of ["not json at all", "", "{unclosed", "[1,2,3]"]) {
      const out = await classifyDisposition(d, det, new StubLlmClient([bad]));
      expect(out.determination.disposition).toBe("unclassified");
      expect(out.escalated).toBe(true);
    }
  });

  it("escalates on provider failure rather than taking down the pipeline", async () => {
    const { d, det } = await firstBlock();
    const failing = {
      label: "failing",
      complete: () => Promise.reject(new Error("503 upstream")),
    };
    const out = await classifyDisposition(d, det, failing);
    expect(out.determination.disposition).toBe("unclassified");
    expect(out.escalated).toBe(true);
    expect(out.reason).toMatch(/failed/i);
  });

  it("an unclassified disposition still yields provisionStatus unknown", async () => {
    const { d, det } = await firstBlock();
    const out = await classifyDisposition(d, det, new StubLlmClient(["garbage"]));
    const status = deriveProvisionStatus(d.meta.status, out.determination.disposition);
    expect(status).toBe("unknown");
    expect(requiresEscalation(status)).toBe(true);
  });

  it("a classified disposition derives a real provision status", async () => {
    const { d, det } = await firstBlock();
    const real = d.text.slice(det.citation.span[0] + 300, det.citation.span[0] + 420);
    const out = await classifyDisposition(
      d,
      det,
      new StubLlmClient([jsonOf({ disposition: "set-aside", quote: real, confidence: 0.9 })]),
    );
    // amended + set-aside → reopened (docs/TDD.md §6)
    expect(deriveProvisionStatus(d.meta.status, out.determination.disposition)).toBe("reopened");
  });
});

describe("residual materiality", () => {
  async function residuals(limit = 6) {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);
    const undecided = m.groups.filter((g) => g.result.materiality === "undecided");
    expect(undecided.length).toBeGreaterThan(limit);
    return { d, groups: undecided.slice(0, limit) };
  }

  it("applies valid labels from a batched response", async () => {
    const { d, groups } = await residuals(4);
    const llm = new StubLlmClient([
      jsonOf({
        results: [
          { i: 0, materiality: "material", reason: "threshold moved", confidence: 0.9 },
          { i: 1, materiality: "editorial", reason: "house style", confidence: 0.95 },
          { i: 2, materiality: "clarifying", reason: "same duty, clearer", confidence: 0.8 },
          { i: 3, materiality: "material", reason: "new duty", confidence: 0.85 },
        ],
      }),
    ]);

    const out = await classifyResiduals(d, groups, llm, { batchSize: 10 });
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.materiality)).toEqual([
      "material",
      "editorial",
      "clarifying",
      "material",
    ]);
    expect(out.every((r) => r.escalated === false)).toBe(true);
  });

  it("keeps an omitted item undecided — conservation (I1)", async () => {
    // The model returning fewer results than inputs must never silently drop an item.
    const { d, groups } = await residuals(4);
    const llm = new StubLlmClient([
      jsonOf({
        results: [
          { i: 0, materiality: "material", reason: "x", confidence: 0.9 },
          { i: 2, materiality: "editorial", reason: "y", confidence: 0.9 },
        ],
      }),
    ]);

    const out = await classifyResiduals(d, groups, llm, { batchSize: 10 });
    expect(out).toHaveLength(4); // every input accounted for
    expect(out[1]!.materiality).toBe("undecided");
    expect(out[1]!.escalated).toBe(true);
    expect(out[3]!.materiality).toBe("undecided");
    expect(out[3]!.escalated).toBe(true);
  });

  it("escalates an out-of-vocabulary label", async () => {
    const { d, groups } = await residuals(2);
    const llm = new StubLlmClient([
      jsonOf({
        results: [
          { i: 0, materiality: "very important", reason: "x", confidence: 0.9 },
          { i: 1, materiality: "editorial", reason: "y", confidence: 0.9 },
        ],
      }),
    ]);

    const out = await classifyResiduals(d, groups, llm, { batchSize: 10 });
    expect(out[0]!.materiality).toBe("undecided");
    expect(out[0]!.escalated).toBe(true);
    expect(out[0]!.reason).toMatch(/unrecognised label/i);
    expect(out[1]!.materiality).toBe("editorial");
  });

  it("ignores hallucinated item indices", async () => {
    const { d, groups } = await residuals(2);
    const llm = new StubLlmClient([
      jsonOf({
        results: [
          { i: 0, materiality: "material", reason: "x", confidence: 0.9 },
          { i: 97, materiality: "material", reason: "invented", confidence: 0.9 },
        ],
      }),
    ]);

    const out = await classifyResiduals(d, groups, llm, { batchSize: 10 });
    expect(out).toHaveLength(2);
    expect(out[1]!.materiality).toBe("undecided");
  });

  it("low model confidence escalates", async () => {
    const { d, groups } = await residuals(1);
    const llm = new StubLlmClient([
      jsonOf({ results: [{ i: 0, materiality: "material", reason: "unsure", confidence: 0.2 }] }),
    ]);
    const out = await classifyResiduals(d, groups, llm, { batchSize: 10 });
    expect(out[0]!.materiality).toBe("material");
    expect(out[0]!.escalated).toBe(true);
    expect(out[0]!.confidence).toBe("low");
  });

  it("a whole-batch failure leaves every item undecided, not dropped", async () => {
    const { d, groups } = await residuals(5);
    const failing = { label: "failing", complete: () => Promise.reject(new Error("nope")) };
    const out = await classifyResiduals(d, groups, failing, { batchSize: 10 });
    expect(out).toHaveLength(5);
    expect(out.every((r) => r.materiality === "undecided" && r.escalated)).toBe(true);
  });

  it("batches, rather than making one call per item", async () => {
    const { d, groups } = await residuals(6);
    const llm = new StubLlmClient([jsonOf({ results: [] })]);
    await classifyResiduals(d, groups, llm, { batchSize: 3 });
    expect(llm.callCount).toBe(2); // 6 items / batch of 3
  });

  it("only classifies groups the rule tier declined", async () => {
    const d = await doc(DOCS.order2023A);
    const m = classifyEdits(d, extractRedline(d).edits);
    const decided = m.groups.filter((g) => g.result.materiality !== "undecided").slice(0, 5);
    const llm = new StubLlmClient([jsonOf({ results: [] })]);

    const out = await classifyResiduals(d, decided, llm);
    expect(out).toHaveLength(0);
    expect(llm.callCount).toBe(0); // nothing to ask about
  });
});

describe("cassette keying", () => {
  it("is stable for identical requests", () => {
    const req = { system: "s", user: "u", json: true };
    expect(cassetteKey("m", req)).toBe(cassetteKey("m", req));
  });

  it("changes when the prompt changes — a prompt edit must invalidate recordings", () => {
    const a = cassetteKey("m", { system: "s", user: "u" });
    const b = cassetteKey("m", { system: "s v2", user: "u" });
    expect(a).not.toBe(b);
  });

  it("changes when the model changes", () => {
    const req = { system: "s", user: "u" };
    expect(cassetteKey("openai/gpt-4o-mini", req)).not.toBe(cassetteKey("groq/llama", req));
  });
});
