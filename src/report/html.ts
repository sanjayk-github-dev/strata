/**
 * Static HTML review report.
 *
 * Emitted from Phase 5 onward so every phase is visually demonstrable without waiting
 * for the web app. It renders the triage funnel and the change groups behind it,
 * deliberately including the filtered remainder: a filter the reader cannot inspect is a
 * filter they cannot trust (PRD §6, principle 3).
 *
 * Self-contained — no external CSS, fonts, or scripts.
 */

import type { ClassifiedGroup, MaterialityResult } from "../pipeline/materiality.js";
import type { Determination, ParsedDocument } from "../pipeline/types.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/**
 * Render a group's source window with its markup made visible: deletions struck
 * through, additions highlighted. Context on either side is shown unstyled so the reader
 * can see the change in situ rather than as a bare fragment.
 */
function renderRedline(doc: ParsedDocument, g: ClassifiedGroup): string {
  const edits = [...g.group.edits].sort((a, b) => a.citation.span[0] - b.citation.span[0]);
  const pad = 90;
  const start = Math.max(0, g.group.span[0] - pad);
  const end = Math.min(doc.text.length, g.group.span[1] + pad);

  let html = "";
  let cursor = start;
  for (const e of edits) {
    const [a, b] = e.citation.span;
    if (a < cursor) continue;
    html += esc(doc.text.slice(cursor, a).replace(/\s+/g, " "));
    const tag = e.kind === "deletion" ? "del" : "ins";
    html += `<${tag}>${esc(e.text.replace(/\s+/g, " "))}</${tag}>`;
    cursor = b;
  }
  html += esc(doc.text.slice(cursor, end).replace(/\s+/g, " "));
  return html;
}

function funnelBar(m: MaterialityResult): string {
  // Drawn in revisions, the unit a reader counts. An edit is one bracket or one italic
  // run, so a substitution is two of them and the edit total runs to roughly double.
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

function groupSection(
  doc: ParsedDocument,
  title: string,
  cls: string,
  groups: ClassifiedGroup[],
  open: boolean,
  note: string,
): string {
  if (groups.length === 0) return "";
  const items = groups
    .map((g) => {
      const section = doc.sections.find((s) => s.id === g.group.edits[0]?.sectionId);
      const path = section ? clip(section.headingPath.slice(-2).join(" › "), 80) : "—";
      return `
      <li>
        <div class="meta"><span class="rule">${esc(g.result.ruleId)}</span> ${esc(path)}
          <span class="cite">§${esc(g.group.edits[0]?.sectionId ?? "")} · chars ${g.group.span[0]}–${g.group.span[1]}</span>
        </div>
        <div class="rl">${renderRedline(doc, g)}</div>
        <div class="why">${esc(g.result.reason)}</div>
      </li>`;
    })
    .join("");

  return `
  <details class="grp ${cls}"${open ? " open" : ""}>
    <summary><span class="dot"></span>${esc(title)} <span class="count">${groups.length}</span></summary>
    <p class="note">${esc(note)}</p>
    <ul>${items}</ul>
  </details>`;
}

export interface ReportInput {
  doc: ParsedDocument;
  materiality: MaterialityResult;
  determinations: Determination[];
  /** Share of citations that verified against source (FR13). */
  verificationRate: number;
}

export function renderReport(input: ReportInput): string {
  const { doc, materiality: m, determinations, verificationRate } = input;
  const f = m.funnel;
  const by = (k: string) => m.groups.filter((g) => g.result.materiality === k);

  const caps = doc.capabilityNotes
    .map(
      (n) =>
        `<li class="${n.available ? "on" : "off"}"><b>${n.tier}</b> ${esc(n.reason)}</li>`,
    )
    .join("");

  const dets = determinations
    .slice(0, 40)
    .map(
      (d) => `<li><span class="cite">§${esc(d.id)}</span> ${esc(clip(d.headingPath.slice(-2).join(" › "), 90))}
        <span class="refs">${d.crossRefs.length ? esc(d.crossRefs.slice(0, 6).join(", ")) : "no provision refs"}</span></li>`,
    )
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
  .sub { color:var(--mut); font-size:.85rem; margin-bottom:1.5rem }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px;
           padding:1rem 1.15rem; margin-bottom:1.25rem }
  .stats { display:flex; gap:1.75rem; flex-wrap:wrap; margin:.5rem 0 .9rem }
  .stat b { display:block; font-size:1.5rem; line-height:1.2 }
  .stat span { color:var(--mut); font-size:.75rem; text-transform:uppercase; letter-spacing:.04em }
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
  .dot { width:9px; height:9px; border-radius:50% }
  .material .dot{background:var(--mat)} .clarifying .dot{background:var(--cla)}
  .editorial .dot{background:var(--edi)} .undecided .dot{background:var(--und)}
  .count { margin-left:auto; color:var(--mut); font-weight:400; font-size:.85rem }
  .note { margin:0 1rem .5rem; color:var(--mut); font-size:.8rem }
  details.grp ul { margin:0; padding:0 1rem 1rem }
  details.grp li { border-top:1px solid var(--line); padding:.8rem 0 }
  .meta { font-size:.75rem; color:var(--mut); margin-bottom:.4rem;
          display:flex; gap:.5rem; flex-wrap:wrap; align-items:baseline }
  .rule { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg);
          border:1px solid var(--line); border-radius:4px; padding:.05rem .35rem }
  .cite { margin-left:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.75 }
  .rl { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem;
        line-height:1.7; background:var(--bg); border:1px solid var(--line);
        border-radius:6px; padding:.6rem .7rem; overflow-x:auto }
  del { background:rgba(220,38,38,.16); text-decoration:line-through; padding:0 .1rem }
  ins { background:rgba(22,163,74,.18); text-decoration:none; padding:0 .1rem }
  .why { font-size:.78rem; color:var(--mut); margin-top:.4rem }
  .refs { color:var(--mut); font-size:.72rem; margin-left:.4rem }
  .dets li { font-size:.8rem; padding:.2rem 0; border-top:1px solid var(--line) }
</style></head><body><main>

<h1>${esc(clip(doc.meta.title, 110))}</h1>
<div class="sub">${esc(doc.meta.frDocNumber)} · ${esc(doc.meta.publicationDate)} ·
  ${esc(doc.meta.status.toUpperCase())} · ${esc(doc.meta.action)} ·
  ${doc.meta.pageLength ?? "?"} pages</div>

<div class="panel">
  <div class="stats">
    <div class="stat"><b>${doc.text.length.toLocaleString()}</b><span>characters</span></div>
    <div class="stat"><b>${doc.paragraphs.filter((p) => !p.isSeparateOpinion).length}</b><span>paragraphs</span></div>
    <div class="stat"><b>${determinations.length}</b><span>determinations</span></div>
    <div class="stat"><b>${f.totalGroups}</b><span>revisions</span></div>
    <div class="stat"><b>${(verificationRate * 100).toFixed(1)}%</b><span>citations verified</span></div>
  </div>
  <ul class="caps">${caps}</ul>
</div>

${
  f.totalEdits > 0
    ? `<div class="panel">
  <div class="stats">
    <div class="stat"><b style="color:var(--mat)">${f.revisions.material}</b><span>material</span></div>
    <div class="stat"><b style="color:var(--edi)">${f.revisions.editorial}</b><span>editorial</span></div>
    <div class="stat"><b style="color:var(--und)">${f.revisions.undecided}</b><span>undecided</span></div>
    <div class="stat"><b>${(f.ruleCoverage * 100).toFixed(1)}%</b><span>decided by rule</span></div>
  </div>
  ${funnelBar(m)}
</div>

${groupSection(doc, "Material", "material", by("material"), true, "Rules fired on a change that cannot be anything but substantive: a negation, a modal verb, or a number that is not a cross-reference.")}
${groupSection(doc, "Needs expert review", "undecided", by("undecided"), false, "No deterministic rule applies. These require judgement and are the model tier's input — they are not defaulted to any classification.")}
${groupSection(doc, "Editorial", "editorial", by("editorial"), false, "Equivalence tests showed the before and after readings are the same once a legally irrelevant difference is normalised away. Shown so the filter can be inspected.")}`
    : `<div class="panel"><b>No redline available.</b>
  <p class="note" style="margin:.4rem 0 0">This document does not declare a redline convention, so
  italics and brackets are not interpreted as additions or deletions. Determination analysis below is
  unaffected.</p></div>`
}

${
  determinations.length > 0
    ? `<details class="grp" open><summary>Determinations <span class="count">${determinations.length}</span></summary>
  <p class="note">Decision blocks located structurally. Dispositions are classified in Phase 6; these are unclassified.</p>
  <ul class="dets">${dets}</ul></details>`
    : ""
}

</main></body></html>`;
}
