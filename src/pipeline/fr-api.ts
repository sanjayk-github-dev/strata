/**
 * Federal Register API client.
 *
 * Public API, no authentication, no scraping, no PDF/OCR. Covers every federal
 * agency, which is why the ingestion layer generalises beyond FERC on day one.
 */

import {
  type DocumentMeta,
  type ResolvedInput,
  type Status,
  UnsupportedSourceError,
} from "./types.js";

const API = "https://www.federalregister.gov/api/v1";

const FIELDS = [
  "document_number",
  "docket_ids",
  "agencies",
  "title",
  "publication_date",
  "type",
  "action",
  "page_length",
  "html_url",
  "full_text_xml_url",
  "abstract",
  "comments_close_on",
  "effective_on",
  "dates",
  "cfr_references",
] as const;

/**
 * Deterministic document-level status. The Federal Register `action` string is
 * authoritative and machine-readable; nothing here is inferred.
 *
 * NOTE: this settles the *document's* status only. Whether a given provision inside
 * it is settled is a separate question — see ProvisionStatus in docs/TDD.md §6.
 */
export function deriveStatus(action: string, type: string): Status {
  // A procedural notice is neither proposed, final, nor amended. Checked first: notices
  // often carry no `action` at all, and the fallbacks below would call them final.
  if (type === "Notice") return "notice";

  const a = action.trim().toLowerCase().replace(/\.$/, "");
  if (a.includes("rehearing")) return "amended";
  if (a.includes("notice of proposed rulemaking") || a.startsWith("proposed rule")) {
    return "proposed";
  }
  if (a.startsWith("final rule") || a.startsWith("final order")) return "final";

  // Fall back to the FR `type` field when `action` is unrecognised, rather than guessing.
  if (type === "Proposed Rule") return "proposed";
  if (type === "Rule") return "final";
  return "final";
}

/** Short agency name where the API provides one, else the full name. */
function primaryAgency(agencies: Array<{ raw_name?: string; name?: string }>): {
  agency: string;
  agencies: string[];
} {
  const names = agencies.map((a) => a.name ?? a.raw_name ?? "").filter(Boolean);
  const first = agencies[0];
  const raw = first?.raw_name ?? first?.name ?? "";
  // "FEDERAL ENERGY REGULATORY COMMISSION" → "FERC" is not provided by the API;
  // keep the full name and let conventions match on it.
  return { agency: raw || (names[0] ?? ""), agencies: names };
}

interface RawDoc {
  document_number: string;
  docket_ids?: string[] | null;
  agencies?: Array<{ raw_name?: string; name?: string }> | null;
  title?: string;
  publication_date?: string;
  type?: string;
  action?: string | null;
  page_length?: number | null;
  html_url?: string;
  full_text_xml_url?: string | null;
  abstract?: string | null;
  comments_close_on?: string | null;
  effective_on?: string | null;
  dates?: string | null;
  cfr_references?: Array<{ title?: number | null; part?: string | null }> | null;
}

function toMeta(d: RawDoc): DocumentMeta {
  const { agency, agencies } = primaryAgency(d.agencies ?? []);
  const type = d.type ?? "";
  const action = d.action ?? "";
  return {
    frDocNumber: d.document_number,
    docketIds: d.docket_ids ?? [],
    agency,
    agencies,
    title: d.title ?? "",
    publicationDate: d.publication_date ?? "",
    type,
    action,
    status: deriveStatus(action, type),
    pageLength: d.page_length ?? null,
    htmlUrl: d.html_url ?? "",
    xmlUrl: d.full_text_xml_url ?? "",
    abstract: d.abstract ?? null,
    commentsCloseOn: d.comments_close_on ?? null,
    effectiveOn: d.effective_on ?? null,
    datesNote: d.dates ?? null,
    cfrReferences: (d.cfr_references ?? [])
      .map((r) => (r.title && r.part ? `${r.title} CFR Part ${r.part}` : null))
      .filter((x): x is string => x !== null),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Federal Register API ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

const fieldQuery = FIELDS.map((f) => `fields[]=${f}`).join("&");

/**
 * Parse user input into a docket or document reference.
 *
 * Accepts Federal Register document URLs, bare FR document numbers (YYYY-NNNNN),
 * and agency docket identifiers. Anything else raises UnsupportedSourceError with a
 * message naming what *is* supported — we never silently attempt an unknown source.
 */
export function resolveInput(input: string): ResolvedInput {
  const raw = input.trim();
  if (!raw) throw new UnsupportedSourceError(input);

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UnsupportedSourceError(input);
    }
    if (!/(^|\.)federalregister\.gov$/i.test(url.hostname)) {
      throw new UnsupportedSourceError(input);
    }
    // …/documents/2024/04/16/2024-06563/slug  or  …/documents/full_text/xml/…/2024-06563.xml
    const m = url.pathname.match(/(\d{4}-\d{4,6})(?:\.xml|\.txt)?(?:\/|$)/);
    if (m?.[1]) return { kind: "document", frDocNumber: m[1] };
    throw new UnsupportedSourceError(input);
  }

  if (/^\d{4}-\d{4,6}$/.test(raw)) return { kind: "document", frDocNumber: raw };

  // Docket identifiers vary by agency; accept a conservative shape and let the API decide.
  if (/^[A-Za-z]{1,6}[-\d][\w-]*$/.test(raw)) {
    return { kind: "docket", docketId: raw.toUpperCase() };
  }

  throw new UnsupportedSourceError(input);
}

/** Fetch metadata for a single document. */
export async function fetchDocumentMeta(frDocNumber: string): Promise<DocumentMeta> {
  const doc = await getJson<RawDoc>(`${API}/documents/${frDocNumber}.json?${fieldQuery}`);
  return toMeta(doc);
}

/**
 * Enumerate every published version under a docket, oldest first.
 * This is capability tier T1 — it works for every federal docket at every agency.
 */
export async function enumerateDocket(docketId: string): Promise<DocumentMeta[]> {
  const url =
    `${API}/documents.json?conditions[docket_id]=${encodeURIComponent(docketId)}` +
    `&per_page=100&order=oldest&${fieldQuery}`;
  const body = await getJson<{ results?: RawDoc[] | null; count?: number }>(url);
  return (body.results ?? []).map(toMeta);
}

/** Fetch a document's full-text XML. */
export async function fetchXml(meta: DocumentMeta): Promise<string> {
  if (!meta.xmlUrl) {
    throw new Error(`No full-text XML available for ${meta.frDocNumber}`);
  }
  const res = await fetch(meta.xmlUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch XML for ${meta.frDocNumber}: ${res.status}`);
  }
  return await res.text();
}
