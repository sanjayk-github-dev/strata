# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Strata** — a citation-grade regulatory change-intelligence workspace. When a regulator publishes a
new version of a proceeding, Strata isolates the changes that carry legal effect, explains what each
one does, and cites the exact source passage behind every claim, so a regulatory affairs expert can
*verify* an answer rather than derive it from a quarter-million words.

Read `docs/PRD.md` first — it defines the persona, the v1 scope boundary, and the product principles
that constrain implementation choices.

## Current state

**Phases 1–2 complete** (see `docs/TDD.md` §8): ingestion, convention registry, capability detection,
document model with sections/paragraphs/spans, and the citation model + verifier. 110 tests passing.
Phases 3–8 not started — no determination extraction, no redline parsing, no classification, no web
app yet.

## Commands

```bash
npm install
npm run analyze -- RM22-14          # pipeline only: version timeline + per-document analysis
npm run analyze -- 2024-06563       # a single document; FR URLs also accepted
npm test                            # all tests (69)
npx vitest run tests/ingest.test.ts # a single test file
npx vitest run -t "monotonic"       # a single test by name
npm run typecheck
```

First test run fetches ~15 MB of source XML from the Federal Register API and caches it to
`data/cache/` (gitignored); later runs are offline and fast.

`scripts/verify_manifest.py` is a leftover Python utility that checks the manifest against the live
API. It still works but should be ported to TypeScript — the project is otherwise single-language.

## Architecture

### Data source

Everything is retrieved from the **Federal Register public API** — no authentication, no scraping, no
PDF parsing, no OCR. `data/manifest.yaml` is the single source of truth; ingestion reads it rather than
hardcoding document numbers. Adding a proceeding is a YAML edit.

- Metadata: `https://www.federalregister.gov/api/v1/documents/{doc_number}.json`
- Full text: `https://www.federalregister.gov/documents/full_text/xml/{y}/{m}/{d}/{doc_number}.xml`

### The two structural facts everything depends on

**1. Agency orders publish their own redlines.** Each order's appendices restate the *entire* regulatory
text with changes marked up, using a convention declared in the appendix header — "Deletions are in
brackets and additions are in italics":

| Convention | XML | Meaning |
|---|---|---|
| `<E T="03">text</E>` | italics | addition |
| `[text]` | literal brackets | deletion |
| plain | — | unchanged |

**This convention is only valid inside appendix regions** — brackets carry ordinary meaning in the
preamble. Detect appendix boundaries first (`<HD SOURCE="HD1">Appendix C: …</HD>`), then parse.

Consequence: **change detection is deterministic.** Do not build a semantic differ or ask a model what
changed. Parse the markup.

**2. Most decisions leave no textual footprint.** A document splits roughly in half — a preamble of
numbered paragraphs carrying the agency's *reasoning*, and appendices carrying the *operative text*.
The dominant dispositions (clarify, sustain, decline) change nothing in the operative text while being
exactly the news the user needs.

**A redline-only pipeline misses the majority of what happened.** Both branches are required:

```
one version (~250,000 words)
  ├─ appendices → redline parse (deterministic) → several hundred edits → ~20 material
  └─ preamble   → heading parse (deterministic) → ~30 determination blocks → dispositions
                        joined on section cross-reference (¶187 → §3.1.1.1)
```

The preamble is organized in repeating `Requests for Rehearing and Clarification` → `Determination`
heading pairs, so determination blocks are locatable structurally. Preamble paragraphs cite operative
section numbers explicitly, which makes much of the join deterministic too.

### Citation rules (non-negotiable)

- **Never display a claim whose citation fails verification.** Suppress it. A failed citation is a
  rejected claim, not a low-confidence one. `gateClaims()` enforces this.
- **Model output goes through `locateQuote()`, not hand-built spans.** Models reproduce text reliably
  and character offsets unreliably, so the model supplies a quote and code computes the span.
- **Ambiguity is not resolved silently.** A quote occurring more than once is reported as `ambiguous`,
  never resolved to the first hit.
- **Whitespace tolerance is the only tolerance.** `exact` and `normalized` are the sole match tiers;
  there is deliberately no fuzzy matching. Collapsing whitespace cannot change words.

### The deterministic / LLM boundary

**Design principle: the LLM proposes, deterministic code disposes.** Every model output is either
constrained to a closed label set or carries a citation that code verifies against source. Nothing
reaches the user on the model's word alone.

The LLM is load-bearing in exactly four places:
1. Disposition classification — necessary because agency vocabulary is not formulaic. FERC writes
   *"we sustain"* / *"we clarify"* / *"we set aside"* and **never** "grant/deny rehearing". Regex is a
   prior, not a classifier (see `disposition_priors` in the manifest).
2. Residual materiality judgment, after deterministic rules absorb the obvious cases.
3. Implicit preamble↔appendix joins, where no explicit section cross-reference exists.
4. Rationale prose — emitted only when its citation verifies.

Everything else is code: API calls, XML parsing, paragraph numbering, redline extraction, section
anchoring, character offsets, rule-tier materiality, and **citation verification** (exact string match
of the quoted span at the stated anchor — the trust keystone).

Document-level draft/final/amended status is deterministic too, derived from the API's `action` field
via `status_map` in the manifest. **Provision-level** status is not — metadata tells you a document's
status, never whether a given provision is settled.

### Materiality is the actual problem

Of several hundred parsed edits, most are editorial (`[the]`, `[A]a`, italicized `i.e.,`) and a few
dozen carry legal effect. Separating them is the core intelligence task. Fixtures for both classes live
under `fixtures:` in the manifest — a classifier must get those right first.

Note that a change is a **disposition**, not a text diff: text is reworded with zero legal effect
(*affirmed*), and barely touched with large effect (*modified*). Expert readings of the same provision
legitimately differ, so surface disagreement rather than resolving it silently.

## Key files

| Path | Purpose |
|---|---|
| `docs/PRD.md` | Persona, scope boundary, product principles, functional requirements, metrics |
| `docs/TDD.md` | Architecture, capability tiers, invariants, phased delivery plan with test gates |
| `src/pipeline/registry.ts` | Agency conventions as data. **Start here when adding an agency** |
| `src/pipeline/document.ts` | Section/paragraph construction, capability detection |
| `src/pipeline/xml.ts` | FR XML → plain text with element spans |
| `src/pipeline/citation.ts` | **The trust keystone** — verification, quote location, display gate |
| `src/pipeline/card.ts` | ChangeCard assembly: provision status and confidence derivation |
| `data/manifest.yaml` | Verification set: 7 documents with measured tiers, counts, redline fixtures |
| `scripts/verify_manifest.py` | Data-drift guard against the live API (pending TS port) |

**The pipeline (`src/pipeline/**`) must stay free of framework imports.** The web app and CLI are thin
callers; if Next.js or Vercel APIs leak in, local runs and tests stop reflecting production.

## Constraints worth knowing

- **v1 stops at the verified change packet.** Mapping changes to a company's own obligations and
  routing them to reviewers is deliberately v2 — built on top of a verified change layer, not beside
  it. Don't quietly add inference layers on unverified output.
- **Never display a claim whose citation fails verification.** Suppress it. A failed citation is a
  rejected claim, not a low-confidence one.
- **Show what was filtered out.** Reducing hundreds of edits to ~20 is only credible if the remainder
  stays inspectable.
