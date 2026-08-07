/**
 * Static HTML review report.
 *
 * The CLI's answer to the web app: the same briefing, rendered to a file, so the pipeline
 * is demonstrable without a server, a database, or a model provider. It carries no
 * model-written statements for that reason — the passages and the redline are
 * deterministic, and the report is honest about being the offline view.
 *
 * It renders what the reader triages on, in the order they triage it, and it keeps the
 * filtered remainder one click away: a filter the reader cannot inspect is a filter they
 * cannot trust (PRD §6, principle 3).
 *
 * Self-contained — no external CSS, fonts, or scripts.
 */

import {
  buildBriefing,
  CATEGORY_GLOSS,
  CATEGORY_LABEL,
  type ImpactCategory,
  type Passage,
  type ProvisionChange,
} from "../pipeline/briefing.js";
import { AS_READS_LABEL, PRIORITY_LABEL } from "../pipeline/labels.js";
import { substantiveOutline } from "../pipeline/outline.js";
import type { ClassifiedGroup, MaterialityResult } from "../pipeline/materiality.js";
import type { ComplianceDeadline } from "../pipeline/compliance.js";
import type { Determination, Edit, ParsedDocument } from "../pipeline/types.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/**
 * Collapse identical substitutions, then pair each deletion with what replaced it.
 *
 * Both steps exist because the raw sequence is unreadable: a term renamed throughout a
 * pro forma agreement produces one edit per occurrence, and a substitution prints as two
 * adjacent pieces of markup with nothing saying which replaced which.
 */
function pairedRedline(edits: readonly Edit[], limit = 8): string {
  const collapsed: Array<{ kind: string; text: string; repeats: number }> = [];
  const seen = new Map<string, number>();
  for (const e of edits) {
    const key = `${e.kind}:${e.text.replace(/\s+/g, " ").trim().toLowerCase()}`;
    const at = seen.get(key);
    if (at !== undefined) {
      collapsed[at]!.repeats++;
      continue;
    }
    seen.set(key, collapsed.length);
    collapsed.push({ kind: e.kind, text: clip(e.text, 240), repeats: 1 });
  }

  const shown = collapsed.slice(0, limit);
  const times = (n: number) => (n > 1 ? ` <span class="x">×${n}</span>` : "");

  let html = "";
  for (let i = 0; i < shown.length; i++) {
    const cur = shown[i]!;
    const next = shown[i + 1];
    if (cur.kind === "deletion" && next?.kind === "addition") {
      html += `<div class="row"><del>${esc(cur.text)}${times(cur.repeats)}</del>` +
        `<span class="arrow">→</span><ins>${esc(next.text)}${times(next.repeats)}</ins></div>`;
      i++;
    } else if (cur.kind === "deletion") {
      html += `<div class="row"><del>${esc(cur.text)}${times(cur.repeats)}</del></div>`;
    } else {
      html += `<div class="row"><ins>${esc(cur.text)}${times(cur.repeats)}</ins></div>`;
    }
  }
  return html;
}

function passageHtml(p: Passage): string {
  return (
    `<p class="passage">${p.clippedStart ? '<span class="ctx">… </span>' : ""}` +
    `${esc(p.text.replace(/\s+/g, " ").trim())}` +
    `${p.clippedEnd ? '<span class="ctx"> …</span>' : ""}</p>`
  );
}

const PRIORITY_CLASS: Record<string, string> = {
  material: "mat",
  "needs-review": "und",
  clarifying: "cla",
};

function changeHtml(c: ProvisionChange): string {
  const dets = c.determinations.length;
  return `
  <li>
    <h4 class="${PRIORITY_CLASS[c.priority] ?? ""}">${esc(clip(c.provision, 110))}</h4>
    <div class="meta">
      <span class="badge">${esc(PRIORITY_LABEL[c.priority] ?? c.priority)}</span>
      ${dets > 0 ? `<span>${dets} determination${dets === 1 ? "" : "s"}</span>` : ""}
      <span class="cite">${
        c.revisionCount === 0
          ? "no change to the regulatory text"
          : `${c.revisionCount} revision${c.revisionCount === 1 ? "" : "s"}`
      }</span>
    </div>
    ${
      c.passages.length > 0
        ? `<div class="reads"><div class="lbl">${esc(
            AS_READS_LABEL[c.provisionStatus] ?? "As printed in this document",
          )}</div>${c.passages.map(passageHtml).join("")}${
            c.passageCount > c.passages.length
              ? `<div class="note">${c.passageCount - c.passages.length} further changed passage${
                  c.passageCount - c.passages.length === 1 ? "" : "s"
                } in this provision.</div>`
              : ""
          }</div>`
        : ""
    }
    ${
      c.edits.length > 0
        ? `<div class="rl"><div class="lbl">What changed</div>${pairedRedline(c.edits)}</div>`
        : ""
    }
  </li>`;
}

function categorySection(
  category: ImpactCategory,
  changes: ProvisionChange[],
  open: boolean,
  limit: number,
): string {
  if (changes.length === 0) return "";
  const shown = changes.slice(0, limit);
  const rest = changes.length - shown.length;
  return `
  <details class="grp"${open ? " open" : ""}>
    <summary>${esc(CATEGORY_LABEL[category])} <span class="count">${changes.length} provision${
      changes.length === 1 ? "" : "s"
    }</span></summary>
    <p class="note">${esc(CATEGORY_GLOSS[category])}</p>
    <ul>${shown.map(changeHtml).join("")}</ul>
    ${rest > 0 ? `<p class="note">${rest} further provision${rest === 1 ? "" : "s"} in this group, not shown in the static report.</p>` : ""}
  </details>`;
}

/**
 * What the document proposes, for a document with nothing to brief.
 *
 * A proposed rule decides nothing and publishes no marked-up text, so the briefing is
 * legitimately empty — but the agency's own section structure is the substance, and a page
 * of zeroes would be a worse answer than the outline. Mirrors the workspace.
 */
function outlineSection(doc: ParsedDocument): string {
  const outline = substantiveOutline(doc);
  if (outline.length === 0) {
    return `<div class="panel"><b>Nothing to brief.</b>
  <p class="note" style="margin:.4rem 0 0">This document declares no redline convention and
  contains no determination blocks.</p></div>`;
  }
  const items = outline
    .map(
      (o) =>
        `<li${o.primary ? ' class="primary"' : ""}>${esc(o.title)}${
          o.children.length > 0
            ? `<ul>${o.children.map((c) => `<li>${esc(c.title)}</li>`).join("")}</ul>`
            : ""
        }</li>`,
    )
    .join("");
  return `<details class="grp" open><summary>What this document proposes</summary>
    <ul class="outline">${items}</ul></details>`;
}

/** The filtered remainder, kept inspectable (PRD §6, principle 3). */
function editorialSection(doc: ParsedDocument, groups: ClassifiedGroup[]): string {
  if (groups.length === 0) return "";
  const items = groups
    .slice(0, 60)
    .map((g) => {
      const section = doc.sections.find((s) => s.id === g.group.edits[0]?.sectionId);
      const path = section ? clip(section.headingPath.slice(-2).join(" › "), 80) : "—";
      return `<li>
        <div class="meta"><span class="rule">${esc(g.result.ruleId)}</span> ${esc(path)}
          <span class="cite">chars ${g.group.span[0]}–${g.group.span[1]}</span></div>
        <div class="rl">${pairedRedline(g.group.edits, 4)}</div>
        <div class="why">${esc(g.result.reason)}</div>
      </li>`;
    })
    .join("");
  const rest = groups.length - Math.min(60, groups.length);
  return `
  <details class="grp filtered">
    <summary>Filtered out as editorial <span class="count">${groups.length} revisions</span></summary>
    <p class="note">Equivalence tests showed the before and after readings are the same once a
    legally irrelevant difference is normalised away. Shown so the filter can be inspected.</p>
    <ul>${items}</ul>
    ${rest > 0 ? `<p class="note">… and ${rest} more.</p>` : ""}
  </details>`;
}

function funnelBar(m: MaterialityResult): string {
  const f = m.funnel.revisions;
  const total = f.material + f.clarifying + f.editorial + f.undecided;
  if (total === 0) return "";
  const pct = (n: number) => ((n / total) * 100).toFixed(1);
  const seg = (cls: string, n: number, label: string) =>
    n === 0
      ? ""
      : `<div class="seg ${cls}" style="flex:${n}" title="${label}: ${n} (${pct(n)}%)"></div>`;
  return `
    <div class="bar">
      ${seg("mat", f.material, "Material")}
      ${seg("cla", f.clarifying, "Clarifying")}
      ${seg("edi", f.editorial, "Editorial")}
      ${seg("und", f.undecided, "Undecided")}
    </div>`;
}

export interface ReportInput {
  doc: ParsedDocument;
  materiality: MaterialityResult;
  determinations: Determination[];
  /** Share of citations that verified against source (FR13). */
  verificationRate: number;
  complianceDeadlines?: ComplianceDeadline[];
}

/** How many provisions each category shows before the report stops listing them. */
const PER_CATEGORY = 12;

export function renderReport(input: ReportInput): string {
  const { doc, materiality: m, determinations, verificationRate } = input;
  const f = m.funnel;
  const briefing = buildBriefing(doc, determinations, m);

  const byCategory = new Map<ImpactCategory, ProvisionChange[]>();
  for (const c of briefing.changes) {
    const list = byCategory.get(c.category);
    if (list) list.push(c);
    else byCategory.set(c.category, [c]);
  }

  const caps = doc.capabilityNotes
    .map((n) => `<li class="${n.available ? "on" : "off"}"><b>${n.tier}</b> ${esc(n.reason)}</li>`)
    .join("");

  const deadlines = (input.complianceDeadlines ?? [])
    .map(
      (c) =>
        `<div class="deadline"><b>Compliance filing due ${esc(c.dueOn ?? `${c.count} ${c.unit}`)}</b>
         <div class="note">${esc(clip(c.sentence, 260))}</div></div>`,
    )
    .join("");

  const sections = [...byCategory.entries()]
    .map(([cat, changes], i) => categorySection(cat, changes, i === 0, PER_CATEGORY))
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strata — ${esc(doc.meta.frDocNumber)}</title>
<style>
  :root { --bg:#fff; --fg:#16181d; --mut:#61656e; --line:#e3e5e9; --card:#f7f8fa;
          --mat:#c2410c; --cla:#a16207; --edi:#94a3b8; --und:#4f46e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e6e8ec; --mut:#9aa0aa; --line:#262a31; --card:#161920;
            --mat:#fb923c; --cla:#fbbf24; --edi:#64748b; --und:#a5b4fc; }
  }
  * { box-sizing:border-box }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif; }
  main { max-width:56rem; margin:0 auto }
  h1 { font-size:1.35rem; margin:0 0 .25rem }
  .sub { color:var(--mut); font-size:.85rem; margin-bottom:1.25rem }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px;
           padding:1rem 1.15rem; margin-bottom:1.25rem }
  .stats { display:flex; gap:1.75rem; flex-wrap:wrap; margin:.5rem 0 .9rem }
  .stat b { display:block; font-size:1.5rem; line-height:1.2 }
  .stat span { color:var(--mut); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em }
  .deadline { border-left:3px solid var(--mat); padding:.35rem .75rem; margin:0 0 .8rem;
              background:var(--bg); border-radius:0 6px 6px 0 }
  .deadline b { color:var(--mat) }
  .bar { display:flex; height:12px; border-radius:6px; overflow:hidden; background:var(--line) }
  .seg.mat{background:var(--mat)} .seg.cla{background:var(--cla)}
  .seg.edi{background:var(--edi)} .seg.und{background:var(--und)}
  ul { margin:.5rem 0; padding-left:0; list-style:none }
  .caps li { font-size:.85rem; padding:.15rem 0; color:var(--mut) }
  .caps li.on { color:var(--fg) }
  .caps li.off b { opacity:.5 }
  details.grp { border:1px solid var(--line); border-radius:10px; margin-bottom:.75rem;
                background:var(--card); overflow:hidden }
  summary { cursor:pointer; padding:.7rem 1rem; font-weight:600; display:flex;
            align-items:center; gap:.5rem; list-style:none }
  summary::-webkit-details-marker { display:none }
  .count { margin-left:auto; color:var(--mut); font-weight:400; font-size:.85rem }
  .note { margin:0 1rem .6rem; color:var(--mut); font-size:.8rem }
  details.grp ul { margin:0; padding:0 1rem 1rem }
  details.grp li { border-top:1px solid var(--line); padding:.9rem 0 }
  h4 { margin:0 0 .3rem; font-size:.92rem }
  h4.mat { color:var(--mat) } h4.und { color:var(--und) } h4.cla { color:var(--cla) }
  .meta { font-size:.75rem; color:var(--mut); margin-bottom:.5rem;
          display:flex; gap:.5rem; flex-wrap:wrap; align-items:baseline }
  .badge { border:1px solid var(--line); border-radius:4px; padding:.05rem .35rem;
           background:var(--bg) }
  .rule { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg);
          border:1px solid var(--line); border-radius:4px; padding:.05rem .35rem }
  .cite { margin-left:auto; opacity:.8 }
  .lbl { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em;
         color:var(--mut); margin-bottom:.35rem }
  .reads { border-left:3px solid var(--line); padding:.1rem 0 .1rem .7rem; margin:0 0 .7rem }
  .passage { margin:0 0 .5rem; font-size:.88rem; line-height:1.55 }
  .passage:last-child { margin-bottom:0 }
  .ctx { color:var(--mut) }
  .rl { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.78rem;
        line-height:1.6; background:var(--bg); border:1px solid var(--line);
        border-radius:6px; padding:.6rem .7rem; overflow-x:auto }
  .row { display:flex; gap:.5rem; align-items:baseline; flex-wrap:wrap; margin-bottom:.25rem }
  .row:last-child { margin-bottom:0 }
  .arrow { color:var(--mut) }
  .x { opacity:.7 }
  del { background:rgba(220,38,38,.16); text-decoration:line-through; padding:0 .1rem }
  ins { background:rgba(22,163,74,.18); text-decoration:none; padding:0 .1rem }
  .why { font-size:.78rem; color:var(--mut); margin-top:.4rem }
  .outline { padding:0 1rem 1rem; font-size:.88rem }
  .outline > li { border-top:1px solid var(--line); padding:.5rem 0 }
  .outline li.primary { font-weight:600 }
  .outline ul { margin:.25rem 0 0; padding-left:1rem; font-size:.82rem; color:var(--mut) }
  .outline ul li { border:0; padding:.1rem 0; font-weight:400 }
</style></head><body><main>

<h1>${esc(clip(doc.meta.title, 110))}</h1>
<div class="sub">${esc(doc.meta.frDocNumber)} · ${esc(doc.meta.publicationDate)} ·
  ${esc(doc.meta.status.toUpperCase())} · ${esc(doc.meta.action)} ·
  ${doc.meta.pageLength ?? "?"} pages</div>

<div class="panel">
  ${deadlines}
  <div class="stats">
    <div class="stat"><b>${briefing.changes.length}</b><span>provisions changed</span></div>
    <div class="stat"><b>${determinations.length}</b><span>determinations</span></div>
    <div class="stat"><b>${f.revisions.material + f.revisions.undecided}</b><span>revisions to review</span></div>
    <div class="stat"><b>${(verificationRate * 100).toFixed(1)}%</b><span>citations verified</span></div>
  </div>
  ${funnelBar(m)}
  <ul class="caps">${caps}</ul>
  ${
    briefing.editorialOnlyProvisions > 0
      ? `<p class="note" style="margin:.6rem 0 0">${briefing.editorialOnlyProvisions} further
         provisions changed in editorial ways only and are not listed.</p>`
      : ""
  }
  <p class="note" style="margin:.4rem 0 0">Static report — deterministic output only. The
  workspace adds a one-sentence summary per change, which requires a model provider.</p>
</div>

${
  briefing.changes.length > 0
    ? sections
    : outlineSection(doc)
}

${editorialSection(doc, m.groups.filter((g) => g.result.materiality === "editorial"))}

</main></body></html>`;
}
