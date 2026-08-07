"use client";

/**
 * The review workspace.
 *
 * Three things here are product requirements rather than presentation choices, per
 * PRD §7.4:
 *   - the cited source is shown *in place* (FR9), because verification that costs a tab
 *     switch and a Ctrl-F is verification nobody does;
 *   - the filtered remainder stays inspectable (FR11), because a filter you cannot audit
 *     is a filter you cannot trust;
 *   - judgement is captured on the specific card in dispute (FR12).
 */

import { useCallback, useState } from "react";

import {
  DISPOSITION_LABEL,
  JOIN_LABEL,
  PRIORITY_LABEL,
  PROVISION_STATUS_LABEL,
} from "@/src/pipeline/labels";

interface StageLine {
  key: string;
  label: string;
  detail: string;
  done: boolean;
}

interface Version {
  frDocNumber: string;
  title: string;
  publicationDate: string;
  status: "proposed" | "final" | "amended" | "notice";
  pageLength: number | null;
  type: string;
  officialUrl: string;
}

/** A run of source text, labelled by what the redline says happened to it. */
interface Segment {
  text: string;
  kind: "unchanged" | "addition" | "deletion";
}

interface CardEdit {
  kind: "addition" | "deletion";
  text: string;
  materiality: string;
  /** How many times this identical substitution occurs in the provision. */
  repeats: number;
}

interface Change {
  id: string;
  provision: string;
  provisionNumber: string | null;
  provisionPath: string[];
  category: string;
  priority: "material" | "needs-review" | "clarifying";
  escalated: boolean;
  provisionStatus: string;
  statement: string | null;
  statementEvidence: string | null;
  disposition: string | null;
  determinationCount: number;
  revisionCount: number;
  asReadsLabel: string;
  passageCount: number;
  passages: Array<{
    text: string;
    leads: boolean;
    clippedStart: boolean;
    clippedEnd: boolean;
    span: [number, number];
  }>;
  edits: CardEdit[];
  citations: Array<{ span: [number, number]; sectionId: string }>;
}

interface Analysis {
  meta: {
    frDocNumber: string;
    title: string;
    status: string;
    action: string;
    officialUrl: string;
    abstract: string | null;
    commentsCloseOn: string | null;
    effectiveOn: string | null;
    datesNote: string | null;
    cfrReferences: string[];
  };
  capabilities: Array<{ tier: string; available: boolean; reason: string; label: string }>;
  verificationRate: number;
  claimsChecked: number;
  outline: Array<{
    id: string;
    title: string;
    size: number;
    children: Array<{ id: string; title: string }>;
    primary: boolean;
  }>;
  funnel: {
    material: number;
    editorial: number;
    undecided: number;
    totalEdits: number;
    ruleCoverage: number;
    /** The same verdicts counted per revision — the unit shown to the reader. */
    revisions: { material: number; clarifying: number; editorial: number; undecided: number };
  };
  determinationCount: number;
  provisionsChanged: number;
  categories: Record<string, string>;
  categoryGloss: Record<string, string>;
  byCategory: Record<string, number>;
  editorialOnlyProvisions: number;
  redline: { available: boolean; reason: string | null };
  changes: Change[];
}

const PRIORITY_CLASS: Record<string, string> = {
  material: "mat",
  "needs-review": "rev",
  clarifying: "cla",
};

export default function Workspace() {
  const [query, setQuery] = useState("RM22-14");
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [stages, setStages] = useState<StageLine[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);

  const lookup = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setVersions(null);
    setAnalysis(null);
    setSelected(null);
    try {
      const res = await fetch(`/api/proceeding?q=${encodeURIComponent(query)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Lookup failed");
      setVersions(body.versions);
      if (body.versions.length === 0) setError(`No Federal Register documents found for "${query}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, [query]);

  const analyze = useCallback(async (docNumber: string) => {
    setSelected(docNumber);
    setAnalysis(null);
    setStages([]);
    setVisible(20);
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/analyze?doc=${encodeURIComponent(docNumber)}`);
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.error) setError(msg.error);
          else if (msg.result) setAnalysis(msg.result as Analysis);
          else if (msg.stage) {
            setStages((prev) => {
              const next = [...prev];
              const at = next.findIndex((s) => s.key === msg.stage);
              const entry = {
                key: msg.stage as string,
                label: (msg.label ?? msg.stage) as string,
                detail: (msg.detail ?? "") as string,
                done: Boolean(msg.done),
              };
              if (at >= 0) next[at] = entry;
              else next.push(entry);
              return next;
            });
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <main>
      <h1>Strata</h1>
      <div className="sub">Citation-grade regulatory change intelligence</div>

      <form onSubmit={lookup}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Docket (RM22-14), document number (2024-06563), or federalregister.gov URL"
          aria-label="Proceeding identifier"
        />
        <button type="submit" disabled={busy}>
          {busy && !selected ? "Looking up…" : "Look up"}
        </button>
      </form>

      <div className="help">
        Enter any of:
        <ul>
          <li>
            a <b>docket number</b> — e.g. <code>RM22-14</code> (interconnection) or{" "}
            <code>RM21-17</code> (transmission planning)
          </li>
          <li>
            a <b>Federal Register document number</b> — e.g. <code>2024-06563</code>
          </li>
          <li>
            a <b>federalregister.gov URL</b> for a specific document
          </li>
        </ul>
        Works for any federal agency that publishes to the Federal Register, not only FERC.
        eLibrary and state commission links are not supported — those are not published there.
      </div>

      {error && (
        <div className="panel err" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}

      {versions && versions.length > 0 && (
        <div className="panel">
          <div className="sub" style={{ margin: "0 0 .6rem" }}>
            Select a document to analyse. Procedural notices — technical conferences,
            extensions of time — carry no analysable content.
          </div>
          <table>
            <thead>
              <tr>
                <th>Published</th>
                <th>Status</th>
                <th>Document</th>
                <th>Pages</th>
                <th>Title</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => {
                const analysable = v.type === "Rule" || v.type === "Proposed Rule";
                return (
                  <tr
                    key={v.frDocNumber}
                    className={`${analysable ? "click" : ""} ${selected === v.frDocNumber ? "sel" : ""}`}
                    onClick={() => analysable && !busy && analyze(v.frDocNumber)}
                  >
                    <td>{v.publicationDate}</td>
                    <td><span className="badge">{v.status}</span></td>
                    <td>{v.frDocNumber}</td>
                    <td>{v.pageLength ?? "—"}</td>
                    <td>{v.title.slice(0, 52)}</td>
                    <td>
                      <a
                        href={v.officialUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Official ↗
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {stages.length > 0 && !analysis && (
        <div className="panel stages">
          {stages.map((s) => (
            <div key={s.key}>
              <span className="tick">{s.done ? "✓" : "…"}</span>
              <b>{s.label}</b>
              {s.detail && <span className="detail"> — {s.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {analysis && <Result analysis={analysis} docNumber={selected!} visible={visible} onMore={() => setVisible((v) => v + 20)} />}
    </main>
  );
}

function Result({
  analysis,
  docNumber,
  visible,
  onMore,
}: {
  analysis: Analysis;
  docNumber: string;
  visible: number;
  onMore: () => void;
}) {
  const { funnel, capabilities, verificationRate, redline } = analysis;
  const shown = analysis.changes.slice(0, visible);

  // Group into the categories the reader triages on, preserving server order.
  const groups: Array<[string, Change[]]> = [];
  for (const c of shown) {
    const last = groups[groups.length - 1];
    if (last && last[0] === c.category) last[1].push(c);
    else groups.push([c.category, [c]]);
  }

  return (
    <>
      <div className="panel">
        <h2 style={{ fontSize: "1rem", margin: "0 0 .2rem" }}>{analysis.meta.title}</h2>
        <div className="sub" style={{ margin: "0 0 .8rem" }}>
          {analysis.meta.frDocNumber} · {analysis.meta.action}{" "}
          <a href={analysis.meta.officialUrl} target="_blank" rel="noreferrer">
            View official document ↗
          </a>
        </div>

        {(analysis.meta.commentsCloseOn || analysis.meta.effectiveOn) && (
          <div className="dates">
            {analysis.meta.commentsCloseOn && (
              <div className="deadline">
                <b>Comments due {analysis.meta.commentsCloseOn}</b>
                {analysis.meta.datesNote && <div className="sub">{analysis.meta.datesNote}</div>}
              </div>
            )}
            {analysis.meta.effectiveOn && <div>Effective {analysis.meta.effectiveOn}</div>}
            {analysis.meta.cfrReferences.length > 0 && (
              <div className="sub">Affects {analysis.meta.cfrReferences.join(", ")}</div>
            )}
          </div>
        )}

        {analysis.meta.abstract && (
          <div className="abstract">
            <div className="sub" style={{ margin: "0 0 .25rem" }}>Agency summary, as published</div>
            {analysis.meta.abstract}
          </div>
        )}

        <div className="stats">
          <div className="stat">
            <b>{analysis.provisionsChanged}</b>
            <span>provisions changed</span>
          </div>
          <div className="stat">
            <b>{analysis.determinationCount}</b>
            <span>determinations</span>
          </div>
          <div className="stat">
            <b>{(funnel.revisions.material + funnel.revisions.undecided).toLocaleString()}</b>
            <span>revisions to review</span>
          </div>
          <div className="stat">
            <b>
              {analysis.claimsChecked > 0 ? `${(verificationRate * 100).toFixed(0)}%` : "—"}
            </b>
            <span>
              {analysis.claimsChecked > 0
                ? `${analysis.claimsChecked.toLocaleString()} citations checked`
                : "no citations to check"}
            </span>
          </div>
        </div>

        <div className="sub" style={{ margin: ".8rem 0 0" }}>
          {(() => {
            const optional = capabilities.filter((c) => c.tier !== "T1");
            const on = optional.filter((c) => c.available);
            const off = optional.filter((c) => !c.available);
            return (
              <>
                {on.length > 0 && <div>Analysis available: {on.map((c) => c.label).join(" · ")}</div>}
                {off.map((c) => (
                  <div key={c.tier}>
                    <b>No {c.label.toLowerCase()}</b> — {c.reason}
                  </div>
                ))}
              </>
            );
          })()}
          {analysis.editorialOnlyProvisions > 0 && (
            <div>
              {analysis.editorialOnlyProvisions} further provisions changed in editorial ways only
              and are not listed.
            </div>
          )}
          {!redline.available && redline.reason && <div>{redline.reason}</div>}
        </div>
      </div>

      {analysis.changes.length === 0 && analysis.outline.length > 0 && (
        <div className="panel">
          <h3 style={{ margin: "0 0 .5rem", fontSize: ".95rem" }}>What this document proposes</h3>
          <ul className="outline">
            {analysis.outline.map((o) => (
              <li key={o.id} className={o.primary ? "primary" : ""}>
                {o.title}
                {o.children.length > 0 && (
                  <ul>
                    {o.children.map((c) => (
                      <li key={c.id}>{c.title}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.map(([category, items]) => (
        <section key={category}>
          <h3 className="cat">
            {analysis.categories[category] ?? category}
            <span className="count">
              {(() => {
                const total = analysis.byCategory[category] ?? items.length;
                const noun = total === 1 ? "provision" : "provisions";
                return items.length < total
                  ? `${items.length} of ${total} ${noun}`
                  : `${total} ${noun}`;
              })()}
            </span>
          </h3>
          <p className="gloss">{analysis.categoryGloss[category]}</p>
          {items.map((c) => (
            <ChangeView key={c.id} change={c} docNumber={docNumber} />
          ))}
        </section>
      ))}

      {visible < analysis.changes.length && (
        <button className="ghost" onClick={onMore}>
          Show more ({analysis.changes.length - visible} remaining)
        </button>
      )}
    </>
  );
}

function ChangeView({ change, docNumber }: { change: Change; docNumber: string }) {
  const [source, setSource] = useState<null | {
    before: Segment[];
    quote: Segment[];
    after: Segment[];
    redlined: boolean;
    sectionPath: string[];
    sourceUrl: string;
  }>(null);
  const [loadingSrc, setLoadingSrc] = useState(false);
  const [flagged, setFlagged] = useState(false);

  const showSource = useCallback(async () => {
    if (source) return setSource(null);
    const cite = change.citations[0];
    if (!cite) return;
    setLoadingSrc(true);
    try {
      const res = await fetch(`/api/source?doc=${docNumber}&start=${cite.span[0]}&end=${cite.span[1]}`);
      if (res.ok) setSource(await res.json());
    } finally {
      setLoadingSrc(false);
    }
  }, [change.citations, docNumber, source]);

  const flag = useCallback(async () => {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frDocNumber: docNumber, cardId: change.id, verdict: "disagree" }),
    });
    setFlagged(true);
  }, [change.id, docNumber]);

  return (
    <div className="card">
      <h4 className={PRIORITY_CLASS[change.priority]}>
        {change.escalated ? "⚠ " : ""}
        {change.provision}
      </h4>

      {change.statement && <p className="statement">{change.statement}</p>}

      <div className="meta">
        <span className="badge">
          {PROVISION_STATUS_LABEL[change.provisionStatus] ?? change.provisionStatus}
        </span>
        {change.disposition && change.disposition !== "unclassified" && (
          <span className="badge">{DISPOSITION_LABEL[change.disposition] ?? change.disposition}</span>
        )}
        {change.determinationCount > 0 && (
          <span>
            {change.determinationCount} determination
            {change.determinationCount === 1 ? "" : "s"}
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {change.revisionCount === 0
            ? "no change to the regulatory text"
            : `${change.revisionCount} revision${change.revisionCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {change.passages.length > 0 && (
        <div className="reads">
          <div className="lbl">{change.asReadsLabel}</div>
          {change.passages.map((p, i) => (
            <p key={i} className="passage">
              {p.clippedStart && <span className="ctx">… </span>}
              {p.text.replace(/\s+/g, " ").trim()}
              {p.clippedEnd && <span className="ctx"> …</span>}
            </p>
          ))}
          {change.passageCount > change.passages.length && (
            <div className="sub">
              {change.passageCount - change.passages.length} further changed passage
              {change.passageCount - change.passages.length === 1 ? "" : "s"} in this provision —
              open the source to read them.
            </div>
          )}
        </div>
      )}

      {change.edits.length > 0 && (
        <div className="rl">
          <div className="lbl">What changed</div>
          {pairEdits(change.edits).map((row, i) => (
            <div key={i} className="rlrow">
              {row.from && (
                <del>
                  {row.from.text}
                  {row.from.repeats > 1 && <span className="ctx"> ×{row.from.repeats}</span>}
                </del>
              )}
              {row.from && row.to && <span className="arrow">→</span>}
              {row.to && (
                <ins>
                  {row.to.text}
                  {row.to.repeats > 1 && <span className="ctx"> ×{row.to.repeats}</span>}
                </ins>
              )}
            </div>
          ))}
          {change.revisionCount > change.edits.length && (
            <div className="sub" style={{ margin: ".4rem 0 0" }}>
              Showing part of {change.revisionCount} revisions in this provision.
            </div>
          )}
        </div>
      )}

      <div className="fb">
        <button className="ghost" onClick={showSource} disabled={loadingSrc}>
          {loadingSrc ? "Loading…" : source ? "Hide source" : "Show source"}
        </button>
        {change.revisionCount === 0 && (
          <span className="hint">The agency decided this without changing the text.</span>
        )}
        <button className="link" onClick={flag} disabled={flagged}>
          {flagged ? "flagged" : "flag as wrong"}
        </button>
      </div>

      {source && (
        <div className="src">
          <div className="sub" style={{ margin: "0 0 .35rem" }}>
            {source.sectionPath.slice(-2).join(" › ")}
          </div>
          {source.redlined && (
            <div className="sub" style={{ margin: "0 0 .5rem" }}>
              The regulatory text as this document prints it — <del>struck through</del> is
              removed, <ins>underlined</ins> is added. The highlighted passage is the one this
              entry cites.
            </div>
          )}
          <Segments segments={source.before} trim="start" limit={340} />
          <mark>
            <Segments segments={source.quote} limit={1400} />
          </mark>
          <Segments segments={source.after} trim="end" limit={340} />
          <div className="sub" style={{ margin: ".5rem 0 0" }}>
            <a href={source.sourceUrl} target="_blank" rel="noreferrer">
              Verify on federalregister.gov ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Render source text with its redline intact.
 *
 * `trim` keeps the window tight around the cited passage: the leading context is shown
 * from its end and the trailing context from its start, so the quote stays adjacent to
 * what surrounds it rather than drifting off the top of a long block.
 */
function Segments({
  segments,
  trim,
  limit,
}: {
  segments: Segment[];
  trim?: "start" | "end";
  limit: number;
}) {
  let budget = limit;
  const kept: Segment[] = [];
  const ordered = trim === "start" ? [...segments].reverse() : segments;
  for (const seg of ordered) {
    if (budget <= 0) break;
    const text = seg.text.replace(/\s+/g, " ");
    const clipped =
      text.length <= budget ? text : trim === "start" ? text.slice(-budget) : text.slice(0, budget);
    budget -= clipped.length;
    kept.push({ ...seg, text: clipped });
  }
  const final = trim === "start" ? kept.reverse() : kept;
  const truncated = budget <= 0;

  return (
    <>
      {trim === "start" && truncated && <span className="ctx">…</span>}
      {final.map((seg, i) =>
        seg.kind === "deletion" ? (
          <del key={i}>{seg.text}</del>
        ) : seg.kind === "addition" ? (
          <ins key={i}>{seg.text}</ins>
        ) : (
          <span key={i} className="ctx">
            {seg.text}
          </span>
        ),
      )}
      {trim === "end" && truncated && <span className="ctx">…</span>}
    </>
  );
}

/**
 * Pair each deletion with the addition that replaces it.
 *
 * A substitution is printed as two adjacent pieces of markup, and rendered in sequence it
 * reads as a run-on: "Feasibility Studies Cluster Study Interconnection Feasibility ×7
 * Cluster ×6 timeline as listed in Transmission Provider's LGIP ×3 …". Nothing tells the
 * reader which new text replaced which old text. One substitution per row does.
 */
function pairEdits(edits: CardEdit[]): Array<{ from?: CardEdit; to?: CardEdit }> {
  const rows: Array<{ from?: CardEdit; to?: CardEdit }> = [];
  for (let i = 0; i < edits.length; i++) {
    const cur = edits[i]!;
    const next = edits[i + 1];
    if (cur.kind === "deletion" && next?.kind === "addition") {
      rows.push({ from: cur, to: next });
      i++;
    } else if (cur.kind === "deletion") {
      rows.push({ from: cur });
    } else {
      rows.push({ to: cur });
    }
  }
  return rows;
}
