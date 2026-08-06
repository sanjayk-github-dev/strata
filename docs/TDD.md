# Strata — Technical Design Document

**Status:** Draft v2
**Last updated:** 2026-08-05

Companion to `docs/PRD.md`. Covers how Strata is built, how it degrades on documents it cannot fully
parse, and how progress is verified at each step rather than only at the end.

---

## 1. Architectural premise

**The LLM proposes, deterministic code disposes.**

The model may *generate* candidates; code decides what reaches the user. Two mechanisms:

**Closed label sets.** The model selects from a fixed list — `material` / `clarifying` / `editorial`,
or `affirmed` / `clarified` / `modified` / `set-aside` / `sustained`. Any other output is rejected by
code and escalated, never rendered.

**Citation gating.**

```
Model returns:  claim   "the $5,000 application fee is now expressly non-refundable"
                anchor  LGIP §3.1.1.1, chars 4021–4035
                quote   "non-refundable"

Code runs:      source.slice(4021, 4035) === "non-refundable" ?
                    match    → render
                    no match → SUPPRESS  (not flagged, not downgraded — suppressed)
```

This is a **constraint architecture, not a reliability claim.** It assumes the model will sometimes be
wrong and bounds how that wrongness surfaces.

**Its honest limit:** it prevents fabricated quotes and invented categories. It does **not** prevent the
model from quoting a real passage accurately and reasoning wrongly from it. That failure mode survives —
which is why confidence flagging and expert feedback remain load-bearing rather than decorative.

Two properties of the source data make this achievable:

1. **Some agency orders publish their own redlines**, marked up per a convention the document itself
   declares. Where present, change *detection* is parsing, not inference.
2. **Decisions are structurally located** — the reasoning section pairs an arguments heading with a
   determination heading, repeatedly (`Comments` → `Commission Determination` in final rules;
   `Requests for Rehearing and Clarification` → `Determination` in rehearing orders), so decision
   blocks are found by heading traversal, not search.

What remains genuinely inferential is narrow: whether a detected change carries legal effect, what
disposition a decision block reaches, which provision an implicit reference points at, and the prose
explaining why a change matters.

---

## 2. Stack and tooling

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript |
| Unit / integration tests | **Vitest** |
| End-to-end tests | **Playwright** |
| Model provider | **OpenAI** (API key server-side only) |
| Database | **Neon Postgres** via Vercel Marketplace (`@neondatabase/serverless`) |
| Hosting | Vercel |

```bash
npm install                                  # setup
npm run dev                                  # full app at localhost:3000
npm run analyze -- RM22-14                   # pipeline only, no web server
npm test                                     # all unit + integration tests
npx vitest run tests/ingest.test.ts          # a single test file
npx vitest run -t "refuses without legend"   # a single test by name
npx playwright test                          # end-to-end
```

### Local-first, and the constraint it imposes

**The pipeline is a plain TypeScript library with zero Next.js or Vercel dependencies.** The web app and
the CLI are both thin callers over it.

This is not a preference. If platform APIs leak into the pipeline, local runs and unit tests stop
reflecting production, and the whole verification strategy below becomes theatre. Enforced by keeping
`lib/pipeline/**` free of framework imports, asserted in CI.

Consequences:
- The CLI runs the full pipeline with no web server and no database.
- **The cache sits behind an interface** — file-backed or in-memory locally, Postgres when deployed.
- `.env.local` carries the OpenAI key and (optionally) a Postgres URL. `vercel env pull` populates it.

---

## 3. Parser architecture — convention registry

Format dependence splits into two layers, only one of which generalises:

| Layer | Examples | Scope | Treatment |
|---|---|---|---|
| **Federal Register XML schema** | `<HD SOURCE="HD1">`, `<P>`, `<E T="03">`, `<FTNT>`, `<PRTPAGE>` | A published GPO standard covering **every federal agency** | Safe to depend on directly |
| **Agency drafting conventions** | `Determination` headings, bracket/italic redline legend, `187.` numbering, `section 3.1.1.1` refs | **One agency, sometimes one document type** | Must be *data*, never logic |

So the parser is generic over the schema; conventions are registry entries:

```ts
interface AgencyConvention {
  id: "ferc-rulemaking"
  matches: (meta: DocumentMeta) => boolean      // agency === "FERC" — NOT narrowed by type;
                                                // see note below

  paragraphNumbering: {
    pattern: /^(\d{1,4})\.\s/,
    scope: "preamble-top-level-P",   // excludes footnotes, appendices, separate opinions
    completeness: "contiguous-from-1"          // ← invariant I3
  }

  determinationBlocks: { headingPattern: /Determination$/ }   // applied to TRIMMED heading text

  redline: {
    legendPattern: /Deletions are in brackets and additions are in italics/,
    addition: "E[T=03]",
    deletion: "square-brackets",
    scope: "declaring-appendix-only"           // ← precondition
  }

  crossReference: { pattern: /section (\d+(?:\.\d+)*)/ }
}
```

Three rules make this structural rather than cosmetic:

1. **A convention declares its own preconditions, and the parser refuses to run without them.** No
   legend found ⇒ the redline capability is *unavailable*, never approximated.
2. **Absence of a convention is a first-class result, not an error.** An unrecognised agency yields
   enumeration only, reported plainly.
3. **Each registry entry ships with its verification set** — the documents it was validated against and
   their expected counts. The registry is configuration, documentation, and test fixture at once.

**`matches` selects by agency, never by document type.** An earlier draft matched
`agency === "FERC" && type === "Rule"` — wrong, because the RM22-14 NOPR carries **370 numbered
paragraphs** (measured) that citations must anchor into. Narrowing the convention to Rules would leave proposed
rules with no structure at all. The convention matches the agency broadly; each capability inside it
(determinations, redline) already declines gracefully on documents where its own precondition fails.
This is the preconditions-per-capability principle applied consistently.

Adding another agency is one entry plus a verification set. No core changes.

**Extensibility path (documented, not built):** a model proposes a candidate convention for an
unrecognised agency; a human confirms it; it is registered. This keeps the model out of the structural
layer at runtime while still generalising.

### Known parsing hazard — nested appendix namespaces

Order No. 2023's `HD1` headings include both `Appendix C: Pro forma LGIP` (document level) and
`Appendix C to LGIA` (nested inside the LGIA). Anchoring on heading text alone conflates them and
produces a **wrong citation anchor** — a user clicks to verify and lands on text that does not support
the claim. This is the most damaging bug available to this product.

**The citation verifier does not catch it.** If extraction and verification share the same wrong path,
verification passes. Section identity must therefore carry nesting depth, with its own dedicated test.

---

## 4. Capability tiers

Because any Federal Register docket can be submitted, the system must know per document what it can do —
and say so. This is the PRD's "escalate rather than guess" principle applied at document level.

| Tier | Precondition | Coverage | Yields |
|---|---|---|---|
| **T1 — Enumerate** | Federal Register API only | **Every federal docket, every agency** | Version timeline, dates, proposed/final/amended status |
| **T2 — Determinations** | `Determination` heading structure | Rule-type documents | Decision blocks, dispositions, cross-references |
| **T3 — Redline** | Redline legend declared in an appendix | Documents publishing marked-up text | Exact operative-text edits, materiality funnel |
| **T3b — Derived diff** | Same pro forma text present in two versions, unmarked | *Not built in v1* — see below | Change detection by alignment where no redline exists |

**What v1 detects, stated precisely.** Strata parses the change markup a version *publishes*; it does
not compute a diff between two documents. For T3 documents this is a distinction without a practical
difference — the agency marks up its own changes, and that markup is the change set. But the claim is
**"detects material changes as published within a version,"** not "compares versions." For T2-only
documents there is no text-level change detection at all, only dispositions.

**T3b is the capability that would close that gap.** Order No. 1920 and Order No. 1920-A both restate
`Appendix B: Pro Forma OATT Attachment K` in full, unmarked — the changes are present but nobody marked
them, so they must be computed. Deferred because it is a materially different engineering problem:
section alignment survives renumbering only with work; relocated text reads as an unrelated
deletion/addition pair; whitespace, pagination, and typography generate false positives. Most
importantly, **T3 is verifiable by construction — the agency's markup is ground truth — whereas T3b is
an assertion that needs its own validation.**

### Measured coverage across the verification set

| Document | T1 | T2 | T3 |
|---|---|---|---|
| NOPR RM22-14 (2022-13470) | ✓ | n/a — a proposal decides nothing | ✗ |
| **Order No. 2023 (2023-16628)** | ✓ | ✓ 47 blocks | ✓ |
| **Order No. 2023-A (2024-06563)** | ✓ | ✓ 31 blocks | ✓ |
| NOPR RM21-17 (2022-08973) | ✓ | n/a | ✗ |
| Order No. 1920 (2024-10872) | ✓ | ✓ 66 blocks | ✗ |
| Order No. 1920-A (2024-27982) | ✓ | ✓ 75 blocks | ✗ |
| Order No. 1920-B (2025-06941) | ✓ | ✓ 11 blocks | ✗ |

Redline markup is present in 2 of 7 documents; determination structure in **5 of 5 documents where the
question is meaningful** — a NOPR having no determinations is correct behaviour, not a gap. The
determination branch is therefore the general case and the redline branch the special case, which is why
§7 builds them in that order.

Order No. 1920 does carry pro forma tariff text (`Appendix B: Pro Forma OATT Attachment K`) — it simply
publishes it unmarked. **"Has pro forma text" and "has a parseable redline" are independent properties.**
Order No. 1920-A restates the same appendix, which is what makes T3b viable later.

### Resilience policy: degrade in coverage, never in confidence

- **Best effort on coverage.** Every tier whose precondition holds runs independently. A missing redline
  never blocks determination analysis. No document returns nothing.
- **Never approximate a tier whose precondition fails.** Order No. 1920 contains 3,158 italic tags;
  treating italics as additions without a declared legend would emit 3,158 fabricated regulatory
  changes, each carrying a citation, inside a product whose premise is verifiability. That is not
  degraded output — it is confident garbage, and it is worse than showing nothing.

---

## 5. Pipeline shape

```
docket ID or FR document URL          ← ANY Federal Register docket
        │
        ▼
   Federal Register API ──► document model (sections, ¶¶, char offsets)
        │
   convention registry ──► capability detection (T1 / T2 / T3)
        │
        ├──────────────────────────┬───────────────────────────┐
        ▼                          ▼                           │
  preamble regions          appendix regions                   │
  determination blocks      redline extraction                 │
  (deterministic)           (deterministic, T3 only)           │
        │                          │                           │
  disposition (model)      materiality: rules → model residual │
        │                          │                           │
        └──────────► join ◄────────┘                           │
              explicit § xref (deterministic)                  │
              implicit ref (retrieval)                         │
                           │                                   │
                 citation verification (gate) ◄────────────────┘
                           ▼
                     change cards ──► UI / CLI / cache
```

**`data/manifest.yaml` is not in the runtime path.** Its role is the test-fixture and regression
baseline set — seven documents with known tier assignments, counts, and redline fixtures — plus an
optional "featured dockets" list to seed the UI's empty state. Ingestion reads none of it.

---

## 6. Data model

```ts
type Status = 'proposed' | 'final' | 'amended'   // derived deterministically from FR `action`

interface Document {
  frDocNumber: string          // "2024-06563"
  docketIds: string[]
  agency: string
  title: string
  publicationDate: string
  action: string               // "Order on rehearing and clarification."
  status: Status
  sourceUrl: string
  text: string                 // plain text; all spans index into this
  capabilities: Tier[]
}

interface Section {
  id: string                   // stable path, e.g. "appendix-C/3.1.1.1"
  headingPath: string[]
  depth: number                // disambiguates "Appendix C" vs "Appendix C to LGIA"
  region: 'preamble' | 'appendix'
  span: [number, number]
}

interface Citation {
  frDocNumber: string
  sectionId: string
  paragraphNumber: number | null
  span: [number, number]
  quote: string
}

interface Edit {                                    // T3 only
  id: string
  sectionId: string
  kind: 'addition' | 'deletion'
  text: string
  citation: Citation
  materiality: 'material' | 'clarifying' | 'editorial' | 'undecided'
  decidedBy: 'rule' | 'model'
  ruleId?: string
}

interface Determination {                           // T2 only
  id: string
  headingPath: string[]
  disposition: 'affirmed' | 'clarified' | 'modified'
             | 'set-aside' | 'sustained' | 'unclassified'
  crossRefs: string[]
  citation: Citation
}

interface ChangeCard {                              // schema frozen in Phase 2
  id: string
  frDocNumber: string
  title: string
  edits: Edit[]                    // empty for a determination-only card
  determination?: Determination    // absent for a redline-only card
  effect: 'new' | 'strengthened' | 'relaxed'
        | 'clarified-no-change' | 'removed' | 'unknown'
  provisionStatus: ProvisionStatus // see below — provision-level draft/final
  rationale?: string               // model prose; present only if its citation verifies
  citations: Citation[]
  confidence: 'high' | 'medium' | 'low'
  escalated: boolean
}
```

`ChangeCard` is frozen in Phase 2 so later phases fill fields rather than reshape them, and the UI can
bind against it before the analysis layers are complete.

### Provision-level status

Document metadata settles the *document's* status. It says nothing about whether a **given provision**
inside it is settled — a rehearing order is typed `Rule`, yet provisions within it may be affirmed,
newly modified, or reopened. "Distinguishes draft from final" is only useful to a regulatory affairs
reader at this granularity, so it is a distinct field:

```ts
type ProvisionStatus =
  | 'proposed'   // appears in a proposed rule; not binding
  | 'adopted'    // newly established or changed here; binding from the effective date
  | 'settled'    // carried forward and expressly affirmed or sustained on challenge
  | 'reopened'   // set aside or rehearing granted; content in flux
  | 'unknown'    // disposition unclassified → escalated, never guessed
```

Derived from document `status` combined with the determination's `disposition`:

| Document status | Disposition | → `provisionStatus` |
|---|---|---|
| `proposed` | n/a | `proposed` |
| `final` | any | `adopted` |
| `amended` | `affirmed`, `sustained` | `settled` |
| `amended` | `clarified` | `settled` — meaning unchanged but now expressly interpreted |
| `amended` | `modified` | `adopted` |
| `amended` | `set-aside` | `reopened` |
| `amended` | *(none)*, but the redline shows the text changed | `adopted` |
| `amended` | *(none)*, no textual evidence | `unknown` |
| any | `unclassified` | `unknown` → escalate |

**Textual change is evidence.** Most edits are discussed by no determination at all, so
without this input every edit-only card in an amended document reported `unknown` — **268 of 299
cards** on Order No. 2023-A, which turns the field into noise a reviewer learns to ignore. The redline
is real evidence that the provision was amended here. With it: `adopted` 274, `settled` 23,
`reopened` 2, `unknown` 0.

An `unclassified` disposition still yields `unknown` even when the text changed. We know *that* it
changed, not *what the agency decided*, and guessing between "affirmed with rewording" and "modified"
is precisely what the design forbids.

The derivation is deterministic given a disposition; only the disposition itself is inferred. The
`unknown` row is the important one — an unclassifiable disposition must not silently collapse into a
confident status.

---

## 7. Invariants — asserted in every phase

| | Invariant | Why |
|---|---|---|
| **I1** | **Conservation** — `material + clarifying + editorial + undecided === total parsed` | The central product risk is an invisible false negative. A filter that loses items without accounting for them makes that risk unobservable |
| **I2** | **Verification gate** — a claim whose citation fails is *suppressed*, not downgraded | Failed verification is a rejected claim, not a low-confidence one |
| **I3** | **Completeness** — extracted paragraph numbering is contiguous from 1 to N | A gap means the parser missed content. Converts silent omission into a test failure, with no labeled data required |

I3 is available because agency paragraph numbering is gapless in practice — **verified across all seven
documents in the verification set**, each yielding a contiguous 1..N body sequence once separate
opinions are excluded (they restart at 1). The redline supplies a second self-check: it encodes both
before and after text, so both can be reconstructed and checked for well-formedness.

---

## 8. Delivery phases

Each phase is independently testable, leaves the repo coherent, and retires a named risk. The test
command is the contract.

Expected values come from direct measurement during design. **Exact** gates assert structure; **baseline**
gates guard against drift and are established on first run.

### Phase 1 — Ingestion, convention registry, capability detection

**Builds:** docket/URL → FR API → document model (sections, paragraphs, char offsets); the convention
registry with the FERC entry; capability detection; deterministic status from `action`.

**Test:** `npx vitest run tests/ingest.test.ts tests/registry.test.ts`

| Gate | Type |
|---|---|
| All 7 verification documents fetch and parse | exact |
| Capability tier assignment matches §4's table exactly | exact |
| Status derived from `action` matches for all 7 | exact |
| Every section and paragraph span round-trips to identical source text | exact, property |
| **I3**: paragraph numbering contiguous 1..683 on Order 2023-A | exact |
| Section identity carries nesting depth; `Appendix C` ≠ `Appendix C to LGIA` | exact |
| Unknown agency yields T1 only, without error | exact |

**Baseline corrections — done, from measured parser output:**

| Location | Was | Now |
|---|---|---|
| `data/manifest.yaml` | `numbered_paragraphs: 723` | `body_paragraphs: 683` + `separate_opinion_paragraphs: 10`. The 723 came from a regex over-matching appendix lists and separately-numbered concurrences |
| `docs/PRD.md` §2.2 | "723 numbered paragraphs" | **683** |
| `docs/PRD.md` §6, principle 3 | "21 changes from 683 … the other 662" | Illustrative figures removed; wording is now shape-only until the funnel produces real counts in Phase 5 |
| `data/manifest.yaml` | *(absent)* | Added measured `capabilities` and `body_paragraphs` tables for all 7 documents |

**Measured baselines established this phase** (all body sequences contiguous from 1 — invariant I3):

| Document | Body ¶¶ | Separate opinions | Determinations | Tiers |
|---|---|---|---|---|
| NOPR RM22-14 (2022-13470) | 370 | 0 | 0 | T1 |
| Order No. 2023 (2023-16628) | 1,785 | 0 | 47 | T1 T2 T3 |
| Order No. 2023-A (2024-06563) | **683** | 10 | 31 | T1 T2 T3 |
| NOPR RM21-17 (2022-08973) | 465 | 0 | 0 | T1 |
| Order No. 1920 (2024-10872) | 1,792 | 0 | 66 | T1 T2 |
| Order No. 1920-A (2024-27982) | 956 | 13 | 75 | T1 T2 |
| Order No. 1920-B (2025-06941) | 158 | 0 | 11 | T1 T2 |

**Paragraph-scope rule, as implemented and validated across all seven documents:** `<P>` elements
whose immediate parent is `<SUPLINF>`, matched on `/^\s*(\d{1,4})\.\s/`, taking the **monotonic
prefix**. The scope excludes footnote paragraphs and appendix numbered lists; the monotonic prefix
separates the main body from concurrences, which restart numbering at 1. Every document yields a
contiguous sequence under this rule — I3 is a general invariant, not a single-document coincidence.

**Risk retired:** every assumption about XML structure, and the assumption that conventions generalise.

---

### Phase 2 — Citation model and verifier

**Builds:** the `Citation` type, the exact-span verifier, and the frozen `ChangeCard` schema. The
verifier is built *before* there is any model output to verify — the gate exists before anything needs
gating.

**Test:** `npx vitest run tests/citation.test.ts`

| Gate | Type |
|---|---|
| Every citation constructed from parsed structure verifies | exact, property |
| Mutating any quote by one character causes rejection | exact, adversarial |
| Verification failure suppresses, never downgrades (**I2**) | exact |
| Citation to a nested section resolves to the correct section | exact |

**Two design decisions made during implementation:**

**1. Two verification paths, because models do not produce character offsets.** Asking a
model for a span is unreliable; asking it to reproduce text is not. So the practical
flow is `locateQuote(doc, quote)` — the model supplies a quote, **code finds it and
constructs the span**. A quote appearing nowhere is fabricated and rejected. A quote
appearing more than once is *ambiguous*: real text, but not a citation, since it does not
identify a location — reported as such rather than silently resolved to the first hit.
`verifyCitation(doc, citation)` remains for citations the pipeline builds itself (Phase 4
redline edits, Phase 3 determination blocks).

**2. Whitespace tolerance, bounded and justified.** Source text carries newlines and
indentation from the XML — `"non-refundable \n        application fee"` — so requiring
byte-identical quotes would reject faithful quotations. Verification therefore has exactly
two tiers, `exact` and `normalized` (whitespace runs collapsed), and **no fuzzy tier**.
Collapsing runs cannot merge or split words — `normalize("a b")` is `"a b"`, never
`"ab"` — so a changed word, a deleted space, or a `shall`→`may` swap still rejects. All
three are asserted.

**Section containment is checked, not assumed.** A citation naming one section while
pointing into another is rejected (`section-mismatch`). This is the runtime counterpart to
Phase 1's structural fix for the nested-appendix hazard: Phase 1 makes the ids distinct,
Phase 2 refuses citations whose span and section disagree.

**Result:** 40 Phase 2 tests. The CLI now reports a citation verification rate per
document (FR13) — `693/693 verified (100.0%)` on Order No. 2023-A. This is deterministic
instrumentation, not an eval: it needs no labeled data and no model.

**Risk retired:** the trust keystone.

---

### Phase 3 — Determination blocks (T2)

**Builds:** heading traversal to locate decision blocks; section cross-reference extraction. Built
before redline because it applies to 5 of 5 applicable documents rather than 2 of 7.

**Test:** `npx vitest run tests/determinations.test.ts`

| Gate | Type |
|---|---|
| Block counts: 47 / 31 / 66 / 75 / 11 across the five Rule documents | exact |
| **Zero** blocks for both NOPRs — guards against false positives | exact |
| Every block's text round-trips to source | exact, property |
| Cross-reference extraction coverage | measured |

**Matching spec, learned the hard way:** heading text must be **trimmed, then matched against
`/Determination$/`**. Both relaxations fail on real data: *contains*-matching over-counts (Order
1920-A has an argument heading *"…Adequately Supported Its Determination on Step One of Section
206"* — not a determination block), and anchoring without trimming under-counts (two of Order 2023's
genuine `"Commission Determination "` headings carry trailing whitespace). The design-time audit found
one of each failure mode; the counts above are trim-then-anchor counts.

**Determination blocks are sections.** Block extents come from the Phase 1 section tree rather than a
separate traversal: a block runs from its heading to the next heading at the same or higher level, so
sub-discussion is included and the next block is never swallowed. Verified non-overlapping and in
document order. Block sizes range from ~740 to ~36,600 characters.

**Dispositions are not guessed here.** Every block is emitted `unclassified`; Phase 6 classifies. The
Phase 2 derivation already handles the interim state correctly — `unclassified` yields
`provisionStatus: "unknown"`, which escalates rather than resolving to a confident status.

### Measured: cross-reference coverage varies by docket, and it is fine that it does

| Document | Blocks | Blocks carrying a provision reference |
|---|---|---|
| Order No. 2023 | 47 | **68%** |
| Order No. 2023-A | 31 | **65%** |
| Order No. 1920 | 66 | 3% |
| Order No. 1920-A | 75 | 0% |
| Order No. 1920-B | 11 | 0% |

RM21-17 discusses transmission planning rather than amending numbered pro forma provisions, so it
rarely cites section numbers. **This costs nothing:** those documents are T2-only, so there is no
redline for the Phase 7 join to link *to*. Coverage matters exactly where T3 exists — and there it is
65–68%. Recorded so Phase 7 is designed against measured coverage rather than an assumption of
universal cross-referencing, and so the retrieval fallback is sized honestly.

**Statutory references are excluded.** FERC cites Federal Power Act sections 205 and 206 constantly
(10 and 8 occurrences respectively in Order 2023-A's blocks alone). Joining a determination to pro
forma "section 206" would be wrong, so bare integers ≥ 100 are treated as statutory. This is a
documented heuristic, and the number it discards is reported alongside the coverage figure rather than
hidden.

**Result:** 28 Phase 3 tests, 138 total. The CLI reports blocks, coverage, and filtered statutory
references per document.

**Risk retired:** whether the general branch is structurally reliable.

---

### Phase 4 — Redline extraction (T3)

**Builds:** legend detection, appendix-scoped redline parsing, nesting-aware anchoring.

**Test:** `npx vitest run tests/redline.test.ts`

| Gate | Type |
|---|---|
| The 5 fixtures in `data/manifest.yaml` parse to expected addition/deletion | exact |
| **Legend absent ⇒ capability unavailable, never a wrong parse** | exact |
| Brackets outside appendix regions are not treated as deletions | exact |
| Order No. 1920 yields zero edits despite 3,158 italic tags | exact |
| Total edit count per document | baseline |

That fourth gate is the one that matters most: it asserts the resilience policy directly.

### Region bounds — three findings that changed the design

**1. The declaring *section* is the wrong scope.** The XML marks nested appendices
(`Appendix 1 to LGIP`) at the same heading level as document-level ones (`Appendix C: …`), so a
top-level appendix section closes at its first nested sibling — spans of 259, 181, 180 characters.
`<EXTRACT>` is no better: it is fragmented, and in Order No. 2023 no EXTRACT contains the legend at
all. **The region is `[first legend declaration, end of <SUPLINF>)`** — which matches how the
declaration reads, since a note saying "deletions are in brackets" governs what follows. Order No.
2023-A declares once across four redlined appendices; Order No. 2023 declares in each of four. The
same rule covers both.

**2. The region must end at `<SUPLINF>`, not the document.** The Federal Register footer is literally
`[FR Doc. 2024-06563 Filed 4-15-24; 8:45 am]` — a bracket pair that would otherwise be extracted as a
deletion on every document.

**3. No length cap on deletions.** A 300-character cap silently truncated real content: **33
deletions across the two documents exceed it**, the longest running to ~2,800 characters.

### Exclusions

| Excluded | Why | Count (2023-A / 2023) |
|---|---|---|
| Italics inside `<FTNT>` | Typography — case names, OASIS URLs — never additions | 25 / 157 |
| Brackets inside `<FTNT>` | Citations, not deletions | 0 / 19 |
| Unmatched brackets | Reported, never silently dropped (**I1**) | 0 / 7 |

**A limitation worth stating:** italic-by-typographic-convention is *indistinguishable* from
italic-as-addition. `i.e.,`, `e.g.,` and `et seq.` are conventionally italicised in legal prose and
are extracted as additions. This is by design — the markup genuinely does not distinguish them — and
Phase 5's `italicisation-only` editorial rule is what absorbs them.

### Adjacency grouping

A deletion followed by the addition replacing it is one logical change, and materiality can only be
judged on the pair: `[A]` + `a` is a capitalisation fix, while `a[n]` + `non-refundable` changes what
a fee is. **Adjacency is measured in non-whitespace characters** — the source carries XML indentation,
so roughly 25 raw characters separate that pair, and a raw-distance threshold splits it.

**Measured:** Order No. 2023-A → 1,431 edits (502 additions, 929 deletions) in 1,262 logical groups.
Order No. 2023 → 1,715 edits (1,225 / 490) in 746 groups.

**Result:** 28 Phase 4 tests, 166 total. Every edit's citation verifies; all are emitted `undecided`
with no `decidedBy`, since nothing has classified them yet.

**Risk retired:** silent misparsing — the worst available failure mode.

---

### Phase 5 — Materiality, rule tier

**Builds:** deterministic classifier. Editorial: article changes, capitalisation, whitespace,
italicisation-only, cross-reference renumbering. Material: changed currency amount, capacity threshold,
day count, `shall`→`may`, defined-term change. Emits the funnel report and a static HTML report.

The HTML report binds to the Phase 2 `ChangeCard` schema, so every phase from here is visually
demonstrable without waiting for the web app.

**Test:** `npx vitest run tests/materiality-rules.test.ts`

| Gate | Type |
|---|---|
| 3 editorial fixtures classify editorial; 2 material fixtures classify material | exact |
| **I1** conservation holds | exact, property |
| Rule coverage — share of edits decided without a model — **reported, not assumed** | measured |

### Measured: rules carry roughly two-thirds to three-quarters

The open question this phase existed to answer.

| Document | Edits | Groups | Material | Editorial | Undecided | **Rule coverage** |
|---|---|---|---|---|---|---|
| Order No. 2023-A | 1,431 | 1,262 | 68 | 927 | 436 | **69.5%** |
| Order No. 2023 | 1,715 | 746 | 941 | 99 | 675 | **60.6%** |

Rules decided the majority, and a real remainder — 436 and 675 edits — genuinely needs judgement. That
is the two-tier design working as intended rather than a shortfall: those go to Phase 6 confidence-scored
and escalable, not defaulted to a classification.

Order No. 2023's high material share is expected — it is the final rule establishing the pro forma text
wholesale, so its redline against the prior baseline is substantive throughout. Order No. 2023-A is a
rehearing order making targeted revisions, hence the long editorial tail (750 bare `[the]` deletions).

### Rules operate on groups, and are equivalence tests

Materiality is a property of a *replacement*, not of either side. `[A]` + `a` is a capitalisation fix,
but neither half says that alone — hence Phase 4's adjacency grouping.

Each editorial rule reconstructs the before and after readings and asks whether they are **equivalent**
once a legally irrelevant difference is normalised away. That is far stronger than matching the edit
text, because it cannot be fooled by an edit that merely looks trivial.

| Rule | Class | Fired (2023-A) |
|---|---|---|
| `article-only` | editorial | 750 |
| `case-only` | editorial | 61 |
| `typographic-convention` | editorial | 43 |
| `numeric-change` | material | 27 |
| `negation-change` | material | 16 |
| `modal-change` | material | 10 |
| `cross-reference-renumber` | editorial | 73 |
| *(none — undecided)* | — | 282 |

**Context is part of the reconstruction.** `[3.4]` → `3.5` is a threshold change or a cross-reference
renumbering depending entirely on whether "section" precedes it — a word outside the edit spans.
Reconstructing only the edits made that rule unable to fire; found by test, not inspection. Sixty
characters of context on each side, clipped to the containing section, fixed it and lifted coverage
from 75.1% to 78.8%. Context is safe for equivalence rules because it appears identically on both
sides and so can never manufacture a difference.

**Two findings from measuring real output:**

- **Spelled-out numbers were invisible.** `"" → "ten"` and `"" → "fifteen"` were landing in
  `undecided` purely because the digit regex could not see them, though they are exactly as material
  as `10 → 15`. Legal drafting writes "within ten (10) Business Days". Adding word-numbers lifted
  coverage from 71.3% to 75.1%.
- **`defined-term change` was evaluated and deliberately not implemented**, despite being listed
  above. It fires on genuinely ambiguous cases (`"" → "Standard"`, a renaming rather than an
  obligation change), and almost any sizeable addition contains a capitalised term. A rule that is
  merely probably right belongs in the model tier where its output is confidence-scored and escalable
  — not here, where it would be reported as deterministic fact. `days` → `Business Days` therefore
  stays `undecided` on purpose.

### Static HTML report

Emitted from this phase onward, so every later phase is visually demonstrable without waiting for the
web app: `npm run analyze -- 2024-06563 out/report`. Renders the funnel, the material changes with
deletions struck through and additions highlighted in context, each with its rule and citation — and
**the filtered remainder, expandable**, because a filter the reader cannot inspect is one they cannot
trust.

**Result:** 24 Phase 5 tests, 205 total.

### Two false positives found by reading the generated report

Both were visible in the rendered output and invisible in the aggregate numbers, which is the argument
for emitting the report this phase rather than at the end.

- **Whitespace at the edit boundary broke cross-reference detection.** `Section 9.[6] 7` reconstructs
  to `Section 9.6` / `Section 9. 7` — the space is XML layout between a deletion and its replacement,
  not content. The cross-reference pattern could not match a number with a space inside it, so a pure
  renumbering was reported as a material numeric change. It was the *first card in the report*.
- **Restating a number in words was counted as a change.** `within ⟦+ten⟧ (10) Business Days` adds the
  word form beside an existing digit: the drafting changed, the deadline did not. Comparing surface
  forms as a multiset flagged it; comparing numeric **values as a set** does not.

The second correction is significant — material fell from 201 to 68 and coverage from 78.8% to 69.5%.
Nothing was lost: those groups moved to `undecided`, so they still surface for review. The rule tier
simply stopped asserting confidence it had not earned, which is the trade the design asks for.

**Known limitation — moves are reported as two changes.** A definition relocated within a section
appears as a deletion in one place and an addition in another, with no link between them. Move
detection is deferred; the pair is surfaced, not lost.

**Risk retired:** whether deterministic rules carry the majority of the volume. **They do — roughly
60–70%, measured, with the remainder honestly routed to judgement.**

---

### Phase 6 — Model-tier classification

**Builds:** disposition classification (T2) and residual materiality (T3), constrained to closed label
sets. Model interactions recorded to fixtures so the suite runs deterministically offline.

### Provider-agnostic by construction

Any OpenAI-compatible `/chat/completions` endpoint works — OpenAI, Groq, Together, OpenRouter, or a
local vLLM/Ollama server — configured by three environment variables (`LLM_API_KEY`, `LLM_BASE_URL`,
`LLM_MODEL`; `OPENAI_*` accepted as fallbacks). See `.env.example`.

Two decisions make this cheap rather than a compromise:

- **`fetch`, not a vendor SDK.** The surface needed is one POST to a stable, widely-implemented
  contract. A vendor SDK imports that vendor's assumptions about endpoints, error shapes, and
  parameters — exactly what breaks when the same code is pointed at Groq or a local server.
- **Output validation is never delegated to the provider.** Structured-output support varies (OpenAI
  has strict `json_schema`; several compatible providers offer only `json_object`, some neither).
  Because the architecture validates every output against a closed label set and gates every claim on
  citation verification regardless, provider-side schema enforcement is a convenience, not a
  dependency. Markdown-fenced JSON and JSON embedded in prose — both common on compatible providers —
  are tolerated by the parser.

**Test:** `npx vitest run tests/classify.test.ts`

| Gate | Type |
|---|---|
| Output constrained to the closed label set; invalid output escalates rather than throwing | exact |
| Every emitted claim passes **I2** before render | exact, property |
| Phase 5 fixtures still classify correctly | exact, regression |
| **I1** still holds after model classification | exact, property |
| `provisionStatus` derives correctly for every row of §6's table | exact |
| `unclassified` disposition ⇒ `provisionStatus: 'unknown'` and `escalated: true` | exact |
| Rule/model agreement on a deliberate overlap sample | measured |

All seven gates are covered by `tests/classify.test.ts` (30 tests), except `provisionStatus`
derivation, whose table-driven test lives with the derivation itself in `tests/citation.test.ts`.
I2 is asserted as a **property** across the full range of model behaviour — grounded quote,
fabricated quote, invalid label, malformed output, provider failure — because "true by
construction" is a claim worth testing rather than assuming.

Regex cannot substitute here: FERC writes *"we sustain"*, *"we clarify"*, *"we set aside"* and **never**
"grant/deny rehearing" — zero occurrences of either. Phrase frequency is a prior, not a classifier.

### The verifier doubles as a confidence signal

For dispositions the model returns a label *and* a supporting quote. The label is constrained to the
closed set; the quote goes through `locateQuote`. If it verifies, the citation **narrows** from the
whole block to the supporting passage. If it does not, the label is kept but the item is **escalated**
— a model that cannot point at real text supporting its answer has not earned confidence in it. This
is the same verifier from Phase 2 used as evidence-of-grounding rather than only as a gate.

### Failure modes are the specification

Twenty-three tests, nearly all asserting behaviour under bad model output, because that is what the
architecture exists to bound:

| Model does | System does |
|---|---|
| Returns an unrecognised label | Escalates; never coerced to the nearest valid one |
| Returns a fabricated supporting quote | Keeps the label, escalates, falls back to the block citation |
| Returns malformed or non-JSON output | Escalates; never throws |
| Omits items from a batch | Those stay `undecided` and escalate — **conservation (I1)** |
| Invents an item index | Ignored; the real item stays `undecided` |
| Reports low confidence | Escalates |
| Provider errors or times out | Whole batch stays `undecided`; the pipeline does not fall over |

**Cost control:** residual materiality is batched (default 20 items per call), turning hundreds of
judgements into a few dozen requests. Determination blocks run to ~36,000 characters, so a bounded
head is sent — dispositions are stated near the top. The trade is explicit, and an ungrounded answer
escalates rather than being trusted.

**Determinism:** cassettes key on a hash of the prompt and model, so a prompt edit invalidates
recordings by design. A cassette miss during replay is an error, never a silent live call — a test
that quietly hits the network is one that fails differently on someone else's machine.

### Measured against a live provider (Groq, `llama-3.1-8b-instant`)

Dispositions on Order No. 2023-A, 8 blocks: **6 grounded in verified quotes**, 2 escalated as
ungrounded. Labels: clarified 3, sustained 2, modified 2, set-aside 1. The grounding is real — the
model located passages that the verifier then confirmed byte-for-byte against source:

> *"Accordingly, we set aside this aspect of Order No. 2023"* → `set-aside` → `reopened`
> *"we modify 3.1.1.1 as follows to clarify the applicable study deposits"* → `modified` → `adopted`

Residual materiality, 40 groups: editorial 22, clarifying 11, **material 7**. One of the material
findings is an independent corroboration worth recording — the model flagged
`letter of credit, [or] cash` → `+ a surety bond`, which is exactly the change Troutman Pepper's
published analysis of this order identified as a modification ("allowed surety bonds and other
reasonably acceptable forms beyond cash and letters of credit"). The pipeline reached a major law
firm's conclusion from source, with a citation.

### Provider comparison, same document and prompts

| | Groq `llama-3.1-8b-instant` | OpenAI `gpt-5.6-luna` |
|---|---|---|
| Dispositions grounded in a verified quote | 6 / 8 | **7 / 8** |
| Residual material found (of 40) | 7 | **12** |
| Rule/model agreement on overlap | — | **90%** (18/20) |
| Reason quality | terse — *"Changed type of agreement"* | specific — *"Changes an unspecified fifteen-day period to fifteen Business Days"* |
| Self-reported confidence | uniform `1.0` | 0.88–0.99, 6 distinct values |
| Latency per call | ~0.4s | ~2.7s |
| Wall clock, same run | 61s (rate-limit backoff) | 36s |

**The stronger model resolved the case the rule tier deliberately declined.** Phase 5 left
`days` → `Business Days` as `undecided` because a general defined-term rule would have been merely
probably right. The model classified it material with the reason *"Changes an unspecified fifteen-day
period to fifteen Business Days"*. That is the two-tier design working end to end: the rule tier
declines, the model tier resolves, and neither guesses.

### Portability found a real breakage

`gpt-5.6-luna` **rejects an explicit `temperature`**, accepting only its default — returning 400 for
`temperature: 0`, which is exactly what a classifier wants. This is the class of failure that appears
the moment the same code is pointed at a different model, so the client detects the rejection from the
error body and drops the parameter for subsequent calls. Matched on the provider's own message rather
than a model allowlist, since allowlists go stale with every release.

### Three findings from running it live

**1. Rate limits are a first-class failure mode, not an edge case.** Groq's free tier for this model
is **6,000 tokens per minute**. Eight disposition calls at ~1,500 prompt tokens each exhaust it, and
the original retry policy (3 attempts, ≤8s backoff) gave up long before a rolling token window
reopens. The result was **40 of 40 residual groups reported as escalated** — work silently lost.
Fixed by honouring `retry-after` and backing off up to 45s on 429 specifically.

**2. A provider outage must not look like a judgement.** This is the more important fix. "The model
judged this ambiguous" is the product working; "the provider rate-limited us" is an incident. Both
previously surfaced as a bare escalation count, so a reviewer had no way to tell that a third of the
document was **never analysed**. Escalations now carry a reason — `ambiguous`, `ungrounded`,
`invalid-output`, `omitted`, `provider-error` — and the CLI calls out never-analysed items explicitly.

**3. Self-reported confidence is not a usable escalation signal.** The 8B model returned
`confidence: 1.0` on all 40 residual judgements. The stronger model did vary — 0.88 to 0.99 across six
distinct values — but **never dropped below the 0.7 threshold**, so the low-confidence path never fired
on either. Confidence is systematically inflated, and a threshold on it quietly becomes a no-op.

The two signals that *are* robust are both checked rather than self-reported:

- **Grounding** — does the model's supporting quote verify against source? This is the architectural
  bet restated, and it is what separates the 7 usable dispositions from the 1 escalated.
- **Rule/model agreement** on an overlap sample, which needs no labelled data. Measured at **90%**.

### The agreement gate found a bug in the rule tier

Its first run disagreed on `exceeding 25 percent` → `exceeding twenty-five percent`: the rule said
material, the model said editorial. **The model was right.** `twenty-five` was parsing as two tokens
worth 20 and 5 rather than one value of 25, so the value set appeared to change when only the spelling
had. Fixed — hyphenated compounds are now one token — and agreement rose from 85% to 90%.

This is the argument for the gate in one example: a check that needs no ground truth still located a
false positive in the deterministic tier. The two remaining disagreements are both cases where the
model prefers `clarifying` to the rule's label, and both readings are defensible — which is the PRD's
"interpretation is genuinely contested" showing up in the measurements.

---

### Phase 7 — Join and assembled cards

**Builds:** deterministic join on explicit cross-reference; retrieval fallback for implicit references;
assembled `ChangeCard`.

**Test:** `npx vitest run tests/join.test.ts`

| Gate | Type |
|---|---|
| Explicit cross-reference joins resolve deterministically | exact |
| Cards carry verified citations on every branch they claim | exact, property |
| Unjoined items surface as their own group — never dropped (**I1**) | exact, property |
| Join coverage split: explicit / implicit / unjoined | measured |

### Measured on Order No. 2023-A

| | |
|---|---|
| Determinations joined by explicit cross-reference | **16** of 31 |
| Joined by lexical fallback | 1 |
| No textual footprint — decision only | 14 |
| Edits no determination discusses | 264 |
| **Total cards** | **295** — 38 material, 257 needing review |

Cards come in three shapes, all legitimate: *determination + edits* (a decision and the text it
moved), *determination alone* (a decision with no textual footprint — the majority of what happens,
and precisely what a redline-only tool shows as nothing at all), and *edits alone* (text moved with no
discussion of it).

### A mention is not an amendment

Found by reading a real card, not by a test. Order No. 2023's first assembled card cited §2.3 and
§3.1.2 and attached nine text changes. The determination actually read:

> *"Because we do not adopt the NOPR proposal…, we **decline to adopt** the proposal to add new
> section 3.1.2…"* — and, of §2.3, *"the **existing requirements** in section 2.3…"*

One reference was a decision *not* to create a provision; the other was context. Nine unrelated edits
were attached to a decision that changed nothing. The card read perfectly and was wrong — exactly the
failure this document calls least visible and most damaging.

`Determination` now carries two fields. `crossRefs` is every provision mentioned, kept as context for
the reader. **`amendedRefs` is only those the agency directs a change to**, and only that is joined
on. A reference qualifies when its sentence carries directive language (*"we modify section X"*) and
does not carry declining language (*decline*, *do not adopt*, *reject*, *existing requirements*,
*would read*).

Measured on Order No. 2023-A: **20 of 31 determinations mention a provision; only 9 direct a change to
one.** Explicit joins fell from 16 to 6 — the drop is the fix working, not a regression.

### Cards are an overlapping cover, not a partition

First-come-first-served claiming suppressed **six real joins** on this document, because two
determinations can bear on the same provision and the second was being silently dropped. I1 requires
that nothing is *lost*, not that nothing appears twice — so a group may now appear on more than one
card, and an edit discussed by two decisions is shown under both.

### Two measurement-driven corrections

**Top-level provisions head differently.** Sub-provisions read `3.1.1.1 Study Deposit`, but top-level
ones read `Section 3. Interconnection Requests`. A pattern handling only the first form left every
bare-digit cross-reference — `5`, `7`, `9` — unmatched.

**The lexical fallback scored against the wrong text.** Comparing determination vocabulary to the
*edit fragment* produced a best score of 0.00 for fourteen of fifteen candidates: sixty characters of
diff rarely contains a capitalised defined term. Scoring against the enclosing provision's heading —
the actual topic signal — is what makes the fallback function at all. Even so it contributes only one
join here, and that is reported rather than dressed up: **explicit cross-referencing carries this
join, and the honest fallback rate is low.**

A related defect in the same matcher: a sentence-initial "The" fused onto the following term, so
`Interconnection Customer` and `The Interconnection Customer` were distinct strings — the silent kind
of mismatch that makes lexical scoring quietly useless.

### Priority, because card count alone is not a useful number

295 cards is tractable only if the ones that move an obligation come first. Cards sort
**material → needs-review → clarifying**, with escalated items ahead of their peers in each band,
since the product's claim is that ambiguity is surfaced rather than resolved.

---

### Phase 8 — Web app and deployment

**Builds:** Next.js app, streaming analyze route, Postgres cache, feedback persistence.

**Test:** `npx vitest run tests/api.test.ts && npx playwright test`

| Gate | Maps to |
|---|---|
| Docket ID or FR URL → timeline with status badges | PRD W1 |
| Unsupported source → clear message naming what *is* supported | §4 |
| Version → funnel counts match pipeline output exactly | PRD W2, I1 |
| Briefing entry → cited source passage rendered without navigating away | PRD FR9 |
| Filtered groups expandable in place | PRD FR11 |
| Expert feedback persists across reload | PRD FR12 |
| Citation verification rate surfaced per version | PRD FR13 |
| **All API responses under 4.5 MB** | §9 |
| A docket absent from the manifest analyses correctly | arbitrary-input promise |

---

### Phase 9 — The briefing

**Builds:** provision-level grouping, impact categorisation, model-written change statements.

**Test:** `npx vitest run tests/briefing.test.ts`

| Gate | Type |
|---|---|
| One entry per affected provision; provision identity unique across the briefing | exact, property |
| Ordering is category-major, priority-minor | property |
| Category counts sum to the entry count (**I1**) | exact, property |
| `editorialOnly + editBacked == totalProvisions` (**I1**) | exact |
| A document with determinations and no redline still briefs | exact |
| A determination already attached to an edit-backed entry is not listed twice | property |
| A statement whose quote is not in the added or deleted text is suppressed (**I2**) | exact |

Phase 7 organised the output **by determination**, and reading the result showed why that was wrong.
One determination adopting *"the revisions to section 1 of the pro forma LGIP"* swallowed 85 edits —
section 1 being the entire Definitions chapter — while 226 other cards carried a single trivial edit
each. Worse, a card could read *"Clarified — no text change"* directly above *"85 text changes"*,
because the disposition described the determination and the edits described provisions.

The unit is now **the affected provision**, and determinations attach to it as evidence. Both
pathologies disappear: the 85-edit card splits along provision boundaries, the singleton edits have
somewhere to belong, and the status describes the same thing the edits do.

### Ordering is a product decision, so it is stated explicitly

Entries group into six categories, ordered by **cost of missing one**: deadlines, then fees, then
thresholds, then obligations, then defined terms, then everything else. A deadline that passes cannot
be recovered; a fee paid wrongly can be argued back; a definition can be re-read.

Measured on Order No. 2023 — 201 affected provisions: **74 deadline · 22 fees · 9 thresholds ·
24 obligations · 5 defined terms · 68 other**, with 14 further provisions changed in editorial ways
only and not listed.

### Three categorisation defects, each found by reading output

**Definitions were invisible.** The obligation test (`\bshall\b`) ran ahead of the definition test,
and a definition reads *"X shall mean Y"* — so both Definitions chapters, 131 changes between them,
filed under "Who must do what" and the defined-terms count read **0**. `shall` is the most common word
in regulatory text and the weakest signal available; it now runs last.

**A Definitions chapter is a definitions change whatever it mentions.** With 83 changes aggregated into
one entry, the text mentions costs, days and megawatts somewhere by certainty — Order 2023's
`Section 1. Definitions` filed under "Fees, deposits and penalties" on that basis. Where the provision
title settles the question, the title wins.

**Categorising on before/after windows read the neighbourhood, not the change.** Those windows carry
the unchanged surroundings, so `Recitals` landed under fees because untouched text near the edits says
"security". Categorisation now reads the added and deleted text alone. Two near-identical provisions —
*Models for Non-synchronous Small Generating Facilities* and *Models for Non-Synchronous Generators* —
had been landing in different categories; they now agree.

### Statements are citation-gated against the edits, not the document

A change statement is one model-written sentence. The gate is **not** `locateQuote`: a document-wide
search passes any quote of unchanged surrounding text, which would let the model describe a change
the document does not contain and still verify. The quote must match text this document actually
added or deleted, with a length floor so a one-character edit cannot ground an arbitrary sentence.

Ungrounded means the entry still reaches the reader with its redline; only the sentence is withheld.
Same for a provider failure — the briefing is useful without statements, so they are never on the
critical path.

The statement budget spreads across categories rather than taking a global top-N. A flat slice of an
ordering that is category-major spent all 24 calls on deadlines and left every other section of the
page unsummarised.

### Repeated substitutions collapse

A term renamed throughout a pro forma agreement produces one edit per occurrence — *Applicable
Reliability Council → Electric Reliability Organization* appears eleven times in one provision.
Identical substitutions are shown once with their count, so the handful of genuinely distinct edits
in the same provision are not buried. Nothing is dropped; the count is displayed.

---

### Cut order under time pressure

| Cut | Cost |
|---|---|
| Second docket (RM21-17) from the verification set | Near zero — the parser is shared; it is a generality check |
| Phase 8 web app | The demo, but not the engineering claim — the Phase 5 HTML report still shows results |
| **Phase 3 determination branch** | **Highest.** Most of the product value lives here. Cut last |

---

## 9. Deployment

### Vercel Hobby limits (verified against Vercel docs, 2026-07-01)

The widely-cited "10 second timeout" is stale. With Fluid Compute, on by default for new projects:

| | Hobby |
|---|---|
| Max function duration | **300s** |
| Memory | 2 GB / 1 vCPU |
| Bundle size | 250 MB (Node) |
| Request/response body | **4.5 MB** ← the binding constraint |
| Billing | Active CPU only — model-call I/O wait is not billed |

Hobby is restricted to personal, non-commercial use.

**Design rule from the 4.5 MB cap:** API routes return change cards paginated and reference source spans
by offset. Full document text is never embedded in a response; the client requests spans on demand.

### Routes

```
/api/proceeding?docket=…   T1 enumerate           <2s, always succeeds
/api/analyze?doc=…         T2/T3 pipeline         streamed, 300s budget
/api/feedback              expert judgments       persisted
```

`/api/analyze` streams progress events as stages complete:

```
fetching document…       ✓  2.4 MB
parsing structure…       ✓  683 paragraphs, 6 appendices
detecting capability…    ✓  T1 + T2 + T3
extracting redline…      ✓  N edits
applying rules…          ✓  N editorial, M undecided
classifying…             ▓▓▓▓▓░░░  41/68
```

Results cache on completion; a second request for the same document is instant. The cache doubles as the
precompute path — a demo docket warmed once behaves like a static artifact without a separate build step.

**Risk:** a large document with many model calls could approach the 300s ceiling. Mitigations: batch and
bound classification concurrency, cache per stage rather than only at completion, cap the residual set
sent to the model. If it still exceeds budget, fall back to committing precomputed artifacts for the
demo dockets.

### Storage

Vercel sunset its first-party Postgres and KV in December 2024. Current options: Vercel Blob and Global
Config are first-party; relational and key-value stores come from the Marketplace (`vercel install neon`),
with credentials auto-injected as environment variables.

**Neon Postgres as the single store.** One integration covers both needs:

```sql
analyses (fr_doc_number, pipeline_version, result jsonb, created_at)
feedback (id, analysis_id, card_id, verdict, note, created_at)
```

Analysis cache as `jsonb` keyed by document number and pipeline version; feedback as ordinary rows, which
is the natural shape for aggregating disagreement rate. Vercel Blob is the upgrade path if cached
payloads outgrow the free tier.

Behind a cache interface, so local development runs file-backed with no database.

---

## 10. Confidence and escalation

Confidence is derived, not model-reported alone:

| Signal | Effect |
|---|---|
| Citation fails verification | **Suppressed entirely** — not a confidence level (I2) |
| Decided by deterministic rule | `high` |
| Rule and model agree | `high` |
| Rule and model disagree | `low`, `escalated: true` |
| Model confidence below threshold | `low`, `escalated: true` |
| Output outside the closed label set | `unclassified`, `escalated: true` |

Escalated cards sort first, render visually distinct, and carry an explicit "needs expert review"
affordance rather than an assertion. The product is permitted to say *"this is ambiguous, here is the
passage"*; it is never permitted to resolve ambiguity silently.

---

## 11. Evals

**Not built in v1.** Expert feedback in the UI is the labeling mechanism instead. What that yields
without any labeled data on day one:

| Mechanism | Needs labels? | Yields |
|---|---|---|
| Citation verification rate | No | A deterministic trust number immediately |
| Rule/model agreement rate | No | Where judgment is genuinely contested |
| **I1 / I3** invariant assertions | No | Silent-omission detection |
| In-UI expert feedback | *Produces* them | Labels accumulate through use |

**The design this bootstraps into.** Accumulated feedback becomes the labeled set, scored on materiality
and disposition, sliced by document type and capability tier, with regression gates in CI. Two
disciplines carry forward from the design work:

- Ground truth should be **tiered by provenance** — deterministic where the markup or metadata settles
  it, borrowed from published expert analysis where it does not, and labelled honestly as
  "expert-corroborated" rather than "gold".
- Where independent expert readings of the same provision disagree — as published law-firm analyses of
  the same order demonstrably do — that disagreement is **reported as genuine ambiguity**, not resolved
  arbitrarily in favour of one reading.

Recall is weighted above precision: a false negative is invisible to the user, while a false positive
costs thirty seconds.

---

## 12. Audit history and rollback

Every analysis run is an immutable row keyed by `(fr_doc_number, pipeline_version)`. Analyses are never
updated in place; a re-run inserts a new row. Feedback rows reference the specific `analysis_id` they
were recorded against, so a judgment is always attributable to the exact output that produced it.

This yields rollback for free: serving an earlier `analysis_id` reconstructs precisely what a user saw
on a given date, which is the auditability requirement the PRD's problem statement identifies — *"we read
an alert" is not a defensible record.*

Deletion is never destructive; corrections are new rows. Fuller event-sourcing (compensating events,
state as a fold) is the v2 shape once reviewer workflow introduces mutable project state.

---

## 13. Data isolation

**v1 is a single-tenant demo, stated plainly rather than implied.** The design nonetheless separates
data by sensitivity from the start:

| Data | Sensitivity | Handling |
|---|---|---|
| Source documents | **Public** federal records | Cacheable, shareable across all users |
| Analysis output | Derived from public data | Cacheable across users; keyed by document + pipeline version |
| Expert feedback | **Private** — reveals what an organisation is paying attention to | Never shared across tenants; scoped rows |

Multi-tenancy adds `tenant_id` to `feedback` and any future company-context tables, with row-level
filtering at the query layer. Document and analysis caches remain shared, since they contain nothing
tenant-specific — a property worth preserving deliberately, because it is what makes the cache useful.

---

## 14. Security

| Concern | Handling |
|---|---|
| OpenAI API key | Server-side only; never exposed to the client or embedded in a bundle |
| Database credentials | Injected as environment variables by the Vercel/Neon integration |
| Source documents | Public federal records — no confidential data leaves the boundary in v1 |
| User input | Docket IDs and FR URLs validated against expected shapes before any fetch; no arbitrary URL fetching |
| Model provider data flow | v1 sends only public regulatory text |

**The change that matters at v2.** Once company context — obligations, projects, internal documents —
enters the system, that data is confidential and its exposure to a third-party model provider becomes an
explicit decision requiring a data processing agreement, provider retention settings, and potentially
on-premise or zero-retention inference. This is called out now because it is far cheaper to design for
than to retrofit, and because a regulated enterprise will ask about it in the first conversation.

---

## 15. Deferred to v2

### Explicit scope decision — company context is not ingested in v1

Stated plainly so it reads as a decision rather than an oversight: **v1 ingests regulatory proceedings
only.** It does not ingest a company context of obligations, projects, and documents, in any form —
not even as an unused data model.

The consequence is that Strata v1 analyses what a regulator published; it cannot say what that means
for a *particular* organisation's obligations or projects. That capability, and the reviewer routing
built on it, is the v2 boundary described in `docs/PRD.md` §5 and §12.

The sequencing rationale: an impact-mapping layer inherits every error from the change-detection layer
beneath it, and then hides those errors behind a second inference step. Getting change detection
verifiable first is what makes the mapping trustworthy later. The mapping itself is expected to be a
*join* on provision references rather than an inference problem, provided the obligation register
carries source references — which is how obligation registers are maintained in practice.

| Area | Note |
|---|---|
| **Company-context ingestion** | Obligations, projects, documents. Obligations can be extracted from operative regulatory text rather than invented; only the assignment layer (owner, project, document) need be synthetic |
| **Company-context data model** | Schema for the above |
| **Impact mapping** | Change → affected obligations, projects, documents. A join on provision reference, not an inference problem, provided the obligation register carries source references |
| **Reviewer routing** | Depends on the mapping above |
| **T3b derived diff** | Alignment-based change detection where pro forma text is published without a redline — closes the RM21-17 gap |
| **Model-proposed conventions** | Generalising the registry to unrecognised agencies with human confirmation |
| **State commission proceedings** | Measured, not assumed — see below |

### State commission expansion — measured on a real order, not assumed

Dissected during design: a 77-page final order from a state utility commission rate case (IURC Cause
No. 46258). Findings that shape the eventual expansion:

- **Native-text PDF, not a scan** — 253K chars (≈63K tokens) extract; modern filings are born-digital.
  Older records and exhibits still need OCR.
- **Extraction is lossy at the word level** — `"APPROV AL"`, `"DEPRECIA TION"`, `"c harges"`, page
  numbers injected mid-sentence. Exact-match citation verification breaks untreated; the ladder becomes
  exact → whitespace-normalised → **escalate**, never fuzzy-accept, against a **pinned extractor
  version**. The trusted computing base grows to include the extractor — with FR XML we verify against
  government-published bytes; here, against our own extraction layer. Weaker guarantee, honestly tiered.
- **Visual structure does not survive extraction** — the order's numbered sections are real on the page
  and absent from extracted text. Anchors degrade to page + normalised span.
- **But state conventions exist** — the order closes with formulaic, numbered ordering paragraphs
  (*"IT IS THEREFORE ORDERED … that: 1. … 2. AES Indiana is authorized to … $71,059,000 … 4. AES
  Indiana shall file …"*). The marker phrase is deterministically findable: a convention-registry
  entry, textual rather than XML. Ordering paragraphs are actor + modal + duty — a natural
  machine-readable obligation register, and a candidate seed for the v2 company-context layer.
- **The reliability line is extraction vs. synthesis.** Extraction from one document is reliable with
  verification. "What changed" across a rate case is cross-document synthesis — petition, testimony,
  settlement, and order are different documents by different authors with no redline ground truth —
  and belongs in the escalate-to-expert tier.
- **Size is a cost problem, not a context problem.** A single order (≈63K tokens) fits modern model
  contexts whole — the federal mega-rules are larger. The real constraint is docket volume (a full
  rate-case record is dozens of filings), answered by triage, and the 300s function budget, answered
  by the existing staged-cache design.
