# Strata — Product Requirements Document

**Product:** Strata — a citation-grade regulatory change-intelligence workspace
**Status:** Draft v1
**Last updated:** 2026-08-05

---

## 1. Summary

Regulatory affairs teams at regulated enterprises own portfolios of active proceedings. When a
regulator publishes a new version of one, someone has to determine what actually changed, whether it
binds the company, and what position to take — usually against a filing deadline.

Today that determination is derived by hand from documents that run to a quarter of a million words,
and the reasoning behind it lives in an email thread.

Strata reads the full document, isolates the changes that carry legal effect, explains what each one
does, and cites the exact source passage behind every claim. The expert's job shifts from *deriving*
the answer to *verifying* it.

v1 serves federal energy rulemakings before the Federal Energy Regulatory Commission (FERC) and
delivers a citation-verified change packet for a single proceeding version.

---

## 2. Problem

### 2.1 The work

A regulatory affairs manager owns a **beat**: a named portfolio of proceedings, usually split by
jurisdiction and sometimes by subject. For each proceeding in the portfolio they are accountable for
knowing its current state, what it requires of the company, what the company's position is, and what
must be filed by when.

They own the *translation* — what this text means for us — and the calendar. They do not own the
*determination*. Technical impact is validated by engineering and operations subject-matter experts;
the legal position is signed by counsel. No single person can sign off alone, which is why the
translation has to be legible and evidenced, not just correct.

### 2.2 The scale

A single agency order is not a long article. It is a book. Measured on one representative rehearing
order (FERC Order No. 2023-A, 238 Federal Register pages):

| | |
|---|---|
| Total words | **250,331** (roughly three novels) |
| Reasoning section | 135,543 words across **683 numbered paragraphs** |
| Redlined regulatory text | 114,788 words |
| Revisions in the redline | **1,250** (1,419 individual brackets and italic runs) |
| Edits that change a legal obligation | **68** — the rest are editorial or need expert judgement |

The preceding order in the same proceeding is longer still, at 336 Federal Register pages. A team may
carry a dozen such proceedings simultaneously.

### 2.3 Why this is hard, not merely long

**A change is a disposition, not a text diff.** Regulators reword provisions without changing their
effect, and change effect while barely touching the words. In Order No. 2023-A, a 150-day study
deadline was rewritten and *affirmed* — no obligation moved. Elsewhere, deleting three characters from
a deposit threshold materially changed who pays what.

**Most decisions leave no textual footprint at all.** The dominant dispositions — *clarify*, *sustain*,
*decline* — change nothing in the regulatory text while being precisely what the expert needs to know.
When a regulator sustains its prior position on a deadline, the text is identical and the news is
decisive: the argument lost, stop planning around relief. Any system that only diffs text is blind to
the majority of what happened.

**Superseded text is indistinguishable from operative text.** A proceeding accumulates a proposed rule,
a final rule, and one or more rehearing orders. All remain published. All are retrievable. Only some
are still binding, and nothing in the documents themselves ranks them.

**Interpretation is genuinely contested.** Two major law firms publishing summaries of the same order
categorized the same provisions differently — one calling a set of changes *clarifications*, the other
calling them *modifications*. This is not sloppiness; it is a real interpretive question. A product
that resolves it silently is lying to its user.

### 2.4 How this is done today

The first read is almost never the source document. It is a law firm client alert or trade press
summary — generic to the industry, arriving days after publication, citing nothing the reader can
verify against, and knowing nothing about the reader's company. Someone then re-derives the
company-specific answer by hand, typically with keyword search inside a several-hundred-page PDF. The
resulting obligations land in a spreadsheet and the reasoning lands in an email thread.

### 2.5 What a miss costs

- **A comment deadline passes.** The record closes. There is no second opportunity to shape the rule.
- **A compliance filing is missed or misscoped**, creating direct regulatory exposure.
- **A position is taken on superseded text**, which surfaces later in front of the regulator.
- **An interpretation cannot be reconstructed.** When an auditor asks why the company acted as it did
  two years ago, "we read an alert" is not a defensible record.

---

## 3. Target user

### 3.1 Primary persona — Director of Federal Regulatory Affairs

Works at a regulated energy enterprise with both a regulated utility business and a development
pipeline. Owns federal rulemakings end to end.

**Accountable for:** knowing the state of every proceeding in the portfolio; producing the company's
position; hitting comment and compliance deadlines; briefing executives.

**Constraints:** cannot delegate reading, because knowing which paragraph matters *is* the expertise.
Cannot accept an unsourced answer, because the position will be filed publicly and defended.

**Currently spends most of their time on:** finding what matters inside very long documents, deciding
whether a change is real or editorial, and translating provisions into concrete obligations. The
filing and calendar work is comparatively mechanical.

### 3.2 Secondary personas

| Persona | Relationship to the product |
|---|---|
| **Compliance / tariff administration** | Consumes the enumerated obligations and deadlines; works from operative regulatory text, not reasoning |
| **In-house and outside counsel** | Interpretive authority; signs the position; needs the source passage, never a summary |
| **Engineering / operations SMEs** | Validate whether a technical change actually binds; read only what is routed to them |
| **Development / origination** | Care about project-level exposure — deposits, deadlines, penalties |

### 3.3 Design implication

The primary user is an expert whose professional credibility attaches to the output. That single fact
drives the product principles in §6: an expert will not adopt a tool that asks to be trusted. They will
adopt one that makes verification fast.

---

## 4. Jobs to be done

**Primary job.** *When a new version of a proceeding I own is published, I need to know what actually
changed and whether it binds us, so I can take a defensible position before the deadline.*

Supporting jobs:

- *When I read a claim about a change, I need to see the exact source passage, so I can confirm it
  myself rather than trusting the tool.*
- *When something is ambiguous, I need it flagged as ambiguous, so I can apply judgment instead of
  discovering the error later.*
- *When I brief counsel or an SME, I need to hand them the evidence, not my paraphrase of it.*

---

## 5. Goals and non-goals

### Goals (v1)

| # | Goal |
|---|---|
| G1 | Ingest every published version of a proceeding from a single identifier |
| G2 | Distinguish proposed from final from amended, at both document and provision level |
| G3 | Separate changes that carry legal effect from editorial noise, and show the ratio |
| G4 | Attach a verifiable source citation to every claim the product makes |
| G5 | Flag low-confidence interpretations for expert review rather than asserting them |
| G6 | Capture expert agreement and disagreement on every surfaced change |

### Non-goals (v1)

| Non-goal | Rationale |
|---|---|
| Mapping changes to a company's own obligations, projects, and documents | Deliberately sequenced after the trust primitive. A mapping built on unverified change detection inherits every upstream error and hides it behind a second inference layer. Ship the verified change packet first — v2 builds on top |
| Reviewer routing and workflow state | Depends on the mapping above |
| Detecting *that* a new version exists | Agency alerting is a solved, commodity problem. The value is in what happens after the alert |
| State commission proceedings | 50 heterogeneous systems, PDF-native, many without APIs. Real, but an ingestion problem rather than an intelligence problem |
| A general regulatory search tool | Search over a corpus containing superseded versions actively misleads |

---

## 6. Product principles

1. **Never assert without a verifiable citation.** Every claim carries a source anchor, and the anchor
   is checked against the source before the claim is shown. A claim whose citation cannot be verified
   is not displayed.
2. **Escalate rather than guess.** Low confidence is a first-class output. The product is permitted to
   say "this is ambiguous, here is the passage" and is never permitted to resolve ambiguity silently.
3. **Show what was filtered out.** A user cannot trust a filter they cannot inspect. Reducing 1,250
   edits to the 68 that carry legal effect is only credible if the other 1,363 remain one click
   away.
4. **Be deterministic wherever the data allows.** Language models are used for judgment, not for facts
   that can be computed. What changed is computed; what it means is inferred and then verified.
5. **Optimize for time-to-verified, not time-in-product.** Success is the expert closing the tab
   sooner.

---

## 7. Solution overview

### 7.1 The triage funnel

The core product motion is reduction with the reasoning left intact:

```
one published version  (250,331 words)
        │
        ├── regulatory text ──► 1,250 revisions ──────►   48 carrying legal effect
        │                                                858 editorial
        │                                                344 needing expert judgement
        │
        └── reasoning ────────► 31 decision blocks ────► dispositions
                                          │
                     linked by section cross-reference
                                          ▼
                          the briefing: affected provisions,
                          grouped by kind of consequence
```

*Measured on FERC Order No. 2023-A. Deterministic rules decide 69.5% of edits; the remainder is
routed to judgement rather than defaulted to a classification.*

Both branches are required. The regulatory-text branch alone misses every decision with no textual
footprint; the reasoning branch alone loses the precise operative language.

**Coverage varies by document, and the product says so.** Not every published document supports both
branches: marked-up regulatory text appears only where the agency publishes a redline, and decision
blocks exist only in documents that decide (a proposed rule proposes; it does not determine). Strata
detects per document which analyses its structure supports, runs everything that applies, and states
plainly what was and was not available — it never silently returns less, and it never approximates an
analysis whose structural precondition is absent. Every document yields at least the version timeline
and status.

### 7.2 The briefing

The output is a briefing on **the provisions this document changed**, grouped by the kind of
consequence each change carries and ordered so that the costliest thing to miss comes first.

| Group | Contains |
|---|---|
| **Deadlines and time limits** | Provisions whose time requirements changed — how long a step may take, or when the clock starts |
| **Fees, deposits and penalties** | Amounts owed, deposits and security, refundability |
| **Thresholds and eligibility** | Capacity limits, voltage levels, qualifying criteria — the line between covered and not |
| **Who must do what** | Obligations moving between parties |
| **Defined terms** | Changes to a term that carries into every other provision using it |
| **Other changes** | Everything else that changed substantively |

Each group states in a sentence what it contains. A two-word heading that a reader has to guess at
is a defect: "Deadlines and timing" holds *provisions whose time requirements changed*, which is not
the same thing as a list of dates, and nothing on the page had said so.

The unit is the provision, not the edit and not the decision block. A reader tracks "§3.5.2.1
Processing Time changed", not "edit 1,406 was an addition" — and a provision is the level at which
a change can actually be acted on.

**The text comes before the diff.** The first question is what the obligation now is; a list of
redline fragments cannot answer it, because a diff with no document behind it assumes the reader
already knows the text it came from. Each entry opens with the provision as amended and puts the
changes beneath it. Where a provision changed in more places than fit, the entry leads with the
passage carrying the signal that put it in its category — a deadline entry opens on its deadline —
and reports how many further passages it is not showing.

Each entry carries:

| Element | Purpose |
|---|---|
| **What changed** | One sentence in plain language, emitted only if its quoted evidence matches text this document actually added or deleted |
| **The provision as amended** | The regulatory text as it now reads, over the passages that changed — reconstructed from source, not summarised, and labelled *As proposed* or *As adopted* according to status |
| **The redline** | The added and deleted text itself, with repeated substitutions collapsed and counted |
| **Status** | Proposed / adopted / settled / reopened for this provision |
| **Agency reasoning** | The decision blocks that direct a change to this provision, where the document contains them |
| **Source** | Section, paragraph, and character span — opens the passage in place |
| **Priority** | Changes carrying legal effect sort above those awaiting judgement, which sort above clarifying ones |

Where a document publishes no marked-up text, the briefing is built from its decision blocks instead:
a determination that a provision stands as written is a reviewable change in status, and it is
precisely what a redline-only tool shows as an empty page.

Disagreement can be recorded on any entry, but it is a quiet affordance rather than the main action.
The reader is here to review what changed; correcting the system is a byproduct of that.

### 7.3 What makes the citation trustworthy

Claims are generated by a language model. **Citations are verified by code.** Before a claim is shown,
the quoted span is matched against the source document at the stated anchor. A quote that does not
match verbatim is not a low-confidence claim — it is a rejected one.

This makes "citation-grade" a mechanical property of the system rather than a promise about model
quality, and it yields a real trust metric on day one with no labeled data required.

### 7.4 Form factor

Strata is an interactive web workspace, not a report generator or a feed. The interface is load-bearing
for two reasons, both of which are product requirements rather than presentation choices:

**Verification must happen in place.** The expert's core action is checking a claim against its source.
If that requires leaving the product — opening the agency's site in another tab and searching a
several-hundred-page document — the verification loop costs minutes instead of seconds, and the
principle that the product never asks to be believed becomes hollow. The source passage and the claim
must be visible together.

**The filter must be inspectable.** Reducing several hundred edits to roughly twenty is only
trustworthy if the discarded remainder is one interaction away. A static summary cannot offer that;
it can only assert it.

Judgment capture (§7.2) similarly requires a surface: expert disagreement is the product's only source
of labeled data, and it is collected at the moment of review, on the specific entry in dispute.

---

## 8. Key workflows

**W1 — Open a proceeding.** User enters a proceeding identifier. Strata resolves every published
version, ordered chronologically, each labeled proposed / final / amended with its publication date.

**W2 — Review a version.** User selects a version. Where the document directs a compliance filing,
that deadline is stated above everything else — it is the one date in a final rule that binds the
reader's own organisation, and the operative text never states it.

Strata presents the briefing: the provisions this document changed, grouped by kind of
consequence, deadlines first, with the changes carrying legal effect at the head of each group. The
groups collapse, and an index across the top gives their counts, so the shape of the document is
visible before any of its detail. A summary line gives the totals behind it. For a version without
redline markup, the briefing is built from decision blocks rather than text edits, and says so.

**W3 — Verify a claim.** User opens an entry. Strata shows the source passage from the regulatory text
beside the reasoning paragraph that explains the disposition. The user confirms the claim against the
source without leaving the product.

**W4 — Inspect the filter.** User expands the clarifying or editorial groups to audit what was set
aside.

**W5 — Record judgment.** User flags any entry as wrong. Disagreements accumulate as labeled data.

---

## 9. Functional requirements

| # | Requirement |
|---|---|
| FR1 | Resolve a proceeding identifier to all published versions with type, date, and source URL |
| FR2 | Retrieve and parse full document text, preserving section hierarchy, paragraph numbering, and character offsets |
| FR3 | Where the document declares redline markup: extract every discrete edit, anchored to its enclosing section |
| FR4 | Classify each edit as material, clarifying, or editorial |
| FR5 | Where the document contains decision blocks: locate each one and classify its disposition |
| FR6 | Link decision blocks to the provisions they affect via section cross-reference |
| FR7 | Attach a citation — document, section, paragraph, character span — to every claim |
| FR8 | Verify every citation against source before display; suppress claims that fail |
| FR9 | Display the cited source passage alongside the claim, in product, without navigating away |
| FR10 | Group changes by kind of consequence and order them by cost of missing one; sort ambiguous items above clarifying ones within a group |
| FR11 | Present the full triage funnel with filtered groups expandable in place |
| FR12 | Capture per-provision expert feedback and persist it |
| FR13 | Report citation verification rate for every processed version |
| FR15 | Where a final rule directs one, extract the compliance filing deadline and resolve it to a date |
| FR14 | Detect per document which analyses its structure supports; state what was and was not available, and never approximate an unavailable one |

---

## 10. Success metrics

This product is sold to experts whose reputation attaches to its output. Engagement metrics are
actively misleading here: a user spending more time in the product is a user we are failing.

### Trust

| Metric | Definition | Target |
|---|---|---|
| **Citation verification rate** | Share of published claims whose quoted span matches source verbatim | 100% — anything lower is a defect, not a trend |
| **Expert disagreement rate** | Share of entries flagged as wrong | < 10% at steady state |
| **Source-check rate** | Share of entries where the user opens the source passage | High initially, **declining over time** — a falling rate is earned trust |
| **Sign-off rate** | Share of packets an expert will attach their name to | The blunt question, and the one that matters |

### Accuracy

| Metric | Definition | Why |
|---|---|---|
| **Triage recall** | Share of genuinely material changes classified as material | **The metric that kills the product.** A false negative is invisible to the user — they never learn what they missed |
| **Triage precision** | Share of surfaced material changes an expert confirms | Lower stakes; a false positive costs thirty seconds |

Recall and precision are deliberately not weighted equally. Over-surfacing is a nuisance;
under-surfacing is a liability.

### Adoption

| Metric | Definition |
|---|---|
| **Time to first defensible position** | Hours from publication to a written, cited internal position |
| **Portfolio coverage** | Share of a team's owned proceedings run through the product |
| **Unprompted return** | Whether the user opens the next version without being asked |

**Explicitly not tracked as success:** daily active users, session duration, page views.

---

## 11. Risks and open questions

| Risk | Assessment | Mitigation |
|---|---|---|
| **Silent false negatives** | The central product risk. A missed material change is invisible to the user, so the failure never surfaces as a complaint | Show the full funnel with filtered groups inspectable; back-test triage recall against published expert analyses |
| **Redline markup is not universal** | The regulatory-text branch depends on the regulator publishing marked-up amendments. Not all documents carry it | The reasoning branch still yields dispositions where markup is absent, and the product states which analyses were available (FR14). Computing changes by aligning unmarked text across versions is a designed successor capability, not silently attempted |
| **Interpretation is genuinely contested** | Experts disagree with each other on the same text | Surface disagreement rather than resolving it; report competing readings where published analyses conflict |
| **Expert distrust of AI output** | The target user is professionally sceptical, correctly | Verification-first design; the product never asks to be believed |
| **No labeled data at launch** | Accuracy claims are unbacked in v1 | Citation verification needs no labels; expert feedback accumulates the labeled set |

**Open questions**

1. What confidence threshold should suppress a claim entirely rather than flag it?
2. Should a proceeding's cumulative current state be derivable, or is per-version review sufficient?
3. How should conflicting expert feedback from different reviewers be reconciled?

---

## 12. Roadmap

**v1 — Trusted change packet.** Version timeline, triage funnel, citation-verified change briefing,
expert feedback. Scope of this document.

**v2 — Change to action.** Map each change to the company's own obligations, projects, and documents;
recommend an action; route to the right reviewer; maintain auditable project state with rollback. This
is where the product becomes an operations workspace rather than an intelligence tool, and it is
deliberately built on top of a verified change layer rather than beside it.

**v3 — Portfolio and horizontal expansion.** Every US federal agency publishes to a common system of
record, so the ingestion layer generalizes across jurisdictions on day one: drug and device guidance,
healthcare reimbursement rules, telecommunications, banking and consumer finance, chemicals. The
artifact shape is identical everywhere — a docket accumulating successive versions, comment periods,
and compliance deadlines — and so is the persona.

State-level commissions are a separate and harder expansion: fifty heterogeneous systems, PDF-native
records, many without programmatic access. Valuable, but an ingestion investment rather than an
intelligence one.
