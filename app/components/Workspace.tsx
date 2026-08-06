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
  status: "proposed" | "final" | "amended";
  pageLength: number | null;
  type: string;
  officialUrl: string;
}

interface CardEdit {
  kind: "addition" | "deletion";
  text: string;
  materiality: string;
  ruleId: string | null;
  span: [number, number];
}

interface Card {
  id: string;
  title: string;
  priority: "material" | "needs-review" | "clarifying";
  escalated: boolean;
  joinKind: string;
  provisionRefs: string[];
  provisionStatus: string;
  effect: string;
  disposition: string | null;
  editCount: number;
  edits: CardEdit[];
  citations: Array<{ span: [number, number]; sectionId: string; paragraphNumber: number | null }>;
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
  outline: Array<{ id: string; depth: number; title: string; span: [number, number] }>;
  funnel: { material: number; editorial: number; undecided: number; totalEdits: number; ruleCoverage: number };
  coverage: {
    determinations: number;
    joinedExplicit: number;
    joinedImplicit: number;
    unjoinedDeterminations: number;
    editOnlyCards: number;
    editorialGroupsFiltered: number;
    totalCards: number;
    byPriority: Record<string, number>;
  };
  redline: { available: boolean; reason: string | null };
  cards: Card[];
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
          <div className="sub" style={{ margin: ".6rem 0 0" }}>
            Select a rule or proposed rule to analyse. Procedural notices carry no
            analysable structure. “Official ↗” opens the document on federalregister.gov.
          </div>
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
  const { funnel, coverage, capabilities, verificationRate, redline } = analysis;
  const shown = analysis.cards.slice(0, visible);

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
            <div className="sub" style={{ margin: "0 0 .25rem" }}>
              Agency summary, as published
            </div>
            {analysis.meta.abstract}
          </div>
        )}

        <div className="stats">
          <div className="stat">
            <b>
              {analysis.claimsChecked > 0
                ? `${(verificationRate * 100).toFixed(1)}%`
                : "—"}
            </b>
            <span>
              {analysis.claimsChecked > 0
                ? `${analysis.claimsChecked.toLocaleString()} source citations checked`
                : "no citations to check"}
            </span>
          </div>
          <div className="stat"><b>{coverage.determinations}</b><span>determinations</span></div>
          <div className="stat"><b>{funnel.totalEdits}</b><span>text changes</span></div>
          <div className="stat"><b>{(funnel.ruleCoverage * 100).toFixed(0)}%</b><span>auto-classified</span></div>
          <div className="stat"><b>{coverage.totalCards}</b><span>changes to review</span></div>
        </div>
        <div className="sub" style={{ margin: ".8rem 0 0" }}>
          {capabilities.map((c) => (
            <div key={c.tier}>
              {c.available ? "✓" : "·"} <b>{c.label}</b> — {c.reason}
            </div>
          ))}
        </div>
        <div className="sub" style={{ margin: ".5rem 0 0" }}>
          {coverage.joinedExplicit + coverage.joinedImplicit} determinations linked to the text
          they change · {coverage.unjoinedDeterminations} decisions that change no text ·{" "}
          {coverage.editOnlyCards} text changes not discussed in the reasoning ·{" "}
          {coverage.editorialGroupsFiltered} editorial-only changes filtered out.
          {!redline.available && redline.reason ? ` ${redline.reason}` : ""}
        </div>
      </div>

      {analysis.cards.length === 0 && analysis.outline.length > 0 && (
        <div className="panel">
          <h3 style={{ margin: "0 0 .3rem", fontSize: ".95rem" }}>What this document proposes</h3>
          <div className="sub" style={{ margin: "0 0 .6rem" }}>
            A proposed rule proposes rather than decides, so there are no determinations to
            analyse and no marked-up text to compare. Its own structure is shown below — this
            is the agency&apos;s outline, not our summary.
          </div>
          <ul className="outline">
            {analysis.outline.map((o) => (
              <li key={o.id} className={o.depth === 1 ? "l1" : "l2"}>
                {o.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {shown.map((card) => (
        <CardView key={card.id} card={card} docNumber={docNumber} />
      ))}

      {visible < analysis.cards.length && (
        <button className="ghost" onClick={onMore}>
          Show more ({analysis.cards.length - visible} remaining)
        </button>
      )}
    </>
  );
}

function CardView({ card, docNumber }: { card: Card; docNumber: string }) {
  const [source, setSource] = useState<null | {
    before: string;
    quote: string;
    after: string;
    sectionPath: string[];
    sourceUrl: string;
  }>(null);
  const [loadingSrc, setLoadingSrc] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const showSource = useCallback(async () => {
    if (source) return setSource(null);
    const cite = card.citations[0];
    if (!cite) return;
    setLoadingSrc(true);
    try {
      const res = await fetch(
        `/api/source?doc=${docNumber}&start=${cite.span[0]}&end=${cite.span[1]}`,
      );
      if (res.ok) setSource(await res.json());
    } finally {
      setLoadingSrc(false);
    }
  }, [card.citations, docNumber, source]);

  const sendFeedback = useCallback(
    async (verdict: string) => {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frDocNumber: docNumber, cardId: card.id, verdict }),
      });
      setSaved(verdict);
    },
    [card.id, docNumber],
  );

  return (
    <div className="card">
      <h3 className={PRIORITY_CLASS[card.priority]}>
        {card.escalated ? "⚠ " : ""}
        {card.title}
      </h3>
      <div className="meta">
        <span className="badge">{PRIORITY_LABEL[card.priority] ?? card.priority}</span>
        {card.disposition && (
          <span className="badge">{DISPOSITION_LABEL[card.disposition] ?? card.disposition}</span>
        )}
        <span className="badge">
          {PROVISION_STATUS_LABEL[card.provisionStatus] ?? card.provisionStatus}
        </span>
        <span className="badge">{JOIN_LABEL[card.joinKind] ?? card.joinKind}</span>
        {card.provisionRefs.length > 0 && (
          <span>amends § {card.provisionRefs.slice(0, 5).join(", ")}</span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {card.editCount} text change{card.editCount === 1 ? "" : "s"}
        </span>
      </div>

      {card.edits.length > 0 && (
        <div className="rl">
          {card.edits.map((e, i) =>
            e.kind === "deletion" ? <del key={i}>{e.text}</del> : <ins key={i}>{e.text}</ins>,
          )}
          {card.editCount > card.edits.length && (
            <span className="ctx"> … {card.editCount - card.edits.length} more</span>
          )}
        </div>
      )}

      <div className="fb">
        <button className="ghost" onClick={showSource} disabled={loadingSrc}>
          {loadingSrc ? "Loading…" : source ? "Hide source" : "Show source"}
        </button>
        <span className="hint">
          {card.editCount > 0
            ? "Source shows the passage this change sits in."
            : "This decision changed no regulatory text; source shows the reasoning."}
        </span>
        <button className="ghost" onClick={() => sendFeedback("agree")}>Agree</button>
        <button className="ghost" onClick={() => sendFeedback("disagree")}>Disagree</button>
        <button className="ghost" onClick={() => sendFeedback("recategorize")}>Recategorise</button>
        {saved && <span className="saved">recorded: {saved}</span>}
      </div>

      {source && (
        <div className="src">
          <div className="sub" style={{ margin: "0 0 .35rem" }}>
            {source.sectionPath.slice(-2).join(" › ")}
          </div>
          <span className="ctx">…{source.before.replace(/\s+/g, " ").slice(-260)}</span>
          <mark>{source.quote.replace(/\s+/g, " ").slice(0, 1200)}</mark>
          <span className="ctx">{source.after.replace(/\s+/g, " ").slice(0, 260)}…</span>
          <div className="sub" style={{ margin: ".4rem 0 0" }}>
            <a href={source.sourceUrl} target="_blank" rel="noreferrer">
              Verify on federalregister.gov ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
