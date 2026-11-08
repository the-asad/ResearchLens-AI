"use client";

import { Fragment, useState, useTransition } from "react";
import { AlertTriangle, BookOpen, ChevronDown, ExternalLink, Loader2, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { askResearchQuestion, type AskResponse } from "../actions";

export type ChatProject = { id: string; name: string; documents: { id: string; title: string; pages: number | null }[] };
type Turn = { id: number; question: string; scope: string; response?: AskResponse };

export function ResearchChat({ projects }: { projects: ChatProject[] }) {
  const [projectId, setProjectId] = useState(projects[0].id);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, start] = useTransition();
  const project = projects.find((p) => p.id === projectId)!;

  function submit() {
    const q = question.trim();
    if (q.length < 3 || pending) return;
    const id = Date.now();
    const scope = selectedDocs.length ? `${selectedDocs.length} selected paper(s)` : `all ${project.documents.length} paper(s) in ${project.name}`;
    setTurns((t) => [{ id, question: q, scope }, ...t]);
    setQuestion("");
    start(async () => {
      const response = await askResearchQuestion({ projectId, documentIds: selectedDocs, question: q });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, response } : x)));
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
        <div className="grid gap-4 md:grid-cols-[240px_1fr]">
          <div>
            <label htmlFor="project" className="mb-1.5 block text-[13px] font-medium">Project</label>
            <select
              id="project"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSelectedDocs([]);
              }}
              className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Papers <span className="font-normal text-subtle">(none selected = whole project)</span></p>
            <div className="flex flex-wrap gap-1.5">
              {project.documents.map((d) => {
                const on = selectedDocs.includes(d.id);
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelectedDocs((s) => (on ? s.filter((x) => x !== d.id) : [...s, d.id]))}
                    className={cn(
                      "max-w-72 truncate rounded-md border px-2.5 py-1 text-[13px]",
                      on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:border-border-strong",
                    )}
                    title={d.title}
                  >
                    {d.title}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={1000}
            rows={2}
            placeholder="e.g. How many attention heads does the base model use, and why?"
            aria-label="Research question"
            className="min-h-11 flex-1 resize-y"
          />
          <Button type="submit" size="lg" disabled={pending || question.trim().length < 3} className="sm:self-end">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            Ask
          </Button>
        </form>
      </div>

      {turns.length === 0 && (
        <p className="text-center text-sm text-subtle">Answers cite the exact passages and pages they rely on. Click a citation to inspect the evidence.</p>
      )}
      {turns.map((t) => (
        <TurnView key={t.id} turn={t} />
      ))}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const [active, setActive] = useState<string | null>(null);
  const r = turn.response;
  return (
    <section className="rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
      <header className="border-b border-border px-5 py-3">
        <p className="font-medium">{turn.question}</p>
        <p className="text-[12px] text-subtle">Scope: {turn.scope}</p>
      </header>
      <div className="px-5 py-4">
        {!r && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Retrieving evidence, grading relevance and composing a grounded answer…
          </p>
        )}
        {r && !r.ok && (
          <p className="flex items-center gap-2 text-sm text-danger">
            <AlertTriangle className="size-4" /> {r.message}
          </p>
        )}
        {r?.ok && (
          <>
            {r.result.status === "answered" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge tone={r.result.sufficiency === "SUFFICIENT" ? "success" : "warning"}>
                    Evidence: {r.result.sufficiency === "SUFFICIENT" ? "sufficient" : "partial"}
                  </Badge>
                </div>
                <AnswerText text={r.result.answer} onCite={setActive} />
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-warning">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">{r.result.answer}</p>
                  {r.result.status === "unavailable" && (
                    <p className="mt-1 text-[13px] opacity-90">No answer was generated, so nothing is claimed. You can inspect the retrieved passages or retry shortly.</p>
                  )}
                  {r.result.status === "insufficient" && (
                    <p className="mt-1 text-[13px] opacity-90">The engine abstains rather than answering from general knowledge. Try rephrasing or selecting other papers.</p>
                  )}
                </div>
              </div>
            )}

            {r.result.citations.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-subtle">Sources</h3>
                <ul className="space-y-1.5">
                  {r.result.citations.map((c) => (
                    <li key={c.evidenceId}>
                      <button type="button" onClick={() => setActive(c.evidenceId)} className="flex items-start gap-2 text-left text-sm hover:text-accent">
                        <span className="rounded bg-accent-soft px-1.5 text-[12px] font-medium text-accent">{c.evidenceId}</span>
                        <span>[{c.label}]</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {r.result.evidence.length > 0 && (
              <details className="mt-5 group" open={active !== null}>
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide text-subtle">
                  <BookOpen className="size-3.5" /> Evidence passages ({r.result.evidence.length})
                  <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-3 space-y-3">
                  {r.result.evidence.map((e) => (
                    <article
                      key={e.evidenceId}
                      id={`${turn.id}-${e.evidenceId}`}
                      className={cn("rounded-lg border p-3 text-sm", active === e.evidenceId ? "border-accent bg-accent-soft/40" : "border-border")}
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                        <span className="rounded bg-surface-muted px-1.5 font-medium text-foreground">{e.evidenceId}</span>
                        <span className="font-medium">{e.documentTitle}</span>
                        <span>· p. {e.pageStart === e.pageEnd ? e.pageStart : `${e.pageStart}–${e.pageEnd}`}</span>
                        {e.section && <span>· {e.section}</span>}
                        {e.role === "context" && <Badge>context</Badge>}
                        <SourceTypeBadge type={e.contentType} confidence={e.confidence} />
                        {e.grade != null && <Badge tone={e.grade >= 3 ? "success" : "neutral"}>relevance {e.grade}/3</Badge>}
                        <a
                          href={`/documents/${e.documentId}/file#page=${e.pageStart ?? 1}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                        >
                          Open PDF <ExternalLink className="size-3" />
                        </a>
                      </div>
                      <EvidenceBody e={e} answer={r.result.answer} />
                    </article>
                  ))}
                </div>
              </details>
            )}

            <DebugPanel debug={r.result.debug} />
          </>
        )}
      </div>
    </section>
  );
}

function AnswerText({ text, onCite }: { text: string; onCite: (id: string) => void }) {
  const parts = text.split(/(\[E\d+(?:,\s*E\d+)*\])/g);
  return (
    <div className="whitespace-pre-line text-[15px] leading-relaxed">
      {parts.map((part, i) => {
        const m = /^\[(E\d+(?:,\s*E\d+)*)\]$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        return (
          <span key={i} className="whitespace-nowrap">
            {m[1].split(/,\s*/).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onCite(id)}
                className="mx-0.5 rounded bg-accent-soft px-1 align-baseline text-[12px] font-medium text-accent hover:bg-accent hover:text-accent-foreground"
              >
                {id}
              </button>
            ))}
          </span>
        );
      })}
    </div>
  );
}

type Debug = Extract<AskResponse, { ok: true }>["result"]["debug"];

function DebugPanel({ debug }: { debug: Debug }) {
  return (
    <details className="mt-5 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[12px]">
      <summary className="cursor-pointer font-medium text-muted">Why this answer? (retrieval details)</summary>
      <div className="mt-3 space-y-3 font-mono text-[11.5px] text-muted">
        <p>
          embedding={debug.embeddingModel} dense={debug.denseStatus} rerank={debug.rerankMode} sufficiency={debug.sufficiency ?? "—"} candidates=
          {debug.fused.length} final={debug.final.length}
        </p>
        <p>
          timings: {Object.entries(debug.timings).map(([k, v]) => `${k}=${v}`).join(" ")}
        </p>
        {Object.entries(debug.providers).map(([stage, p]) => (
          <p key={stage}>
            {stage}: {p.provider}/{p.model} fallback={String(p.fallbackUsed)} latency={p.latencyMs}ms
          </p>
        ))}
        {debug.invalidCitations.length > 0 && <p className="text-danger">rejected citations: {debug.invalidCitations.join(", ")}</p>}
        {debug.usage && (
          <p>
            api usage: embedding calls={debug.usage.embeddingCalls} (cache hits {debug.usage.embeddingCacheHits}) · rerank calls={debug.usage.rerankCalls} (cache hits {debug.usage.rerankCacheHits}) · llm requests={debug.usage.llmRequests} (skipped {debug.usage.llmSkipped}) · fallbacks={debug.usage.fallbacks}
          </p>
        )}
        {debug.queryAnalysis && (
          <p>
            query type={debug.queryAnalysis.kind}
            {debug.queryAnalysis.multiPaper ? ` · cross-paper (evidence from ${debug.queryAnalysis.evidenceDocuments ?? "?"} paper(s))` : ""}
          </p>
        )}
        {debug.generation?.numericViolations ? <p className="text-danger">sentences dropped for unsupported numbers: {debug.generation.numericViolations}</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-subtle">
                <th className="pr-3">fused</th><th className="pr-3">rrf</th><th className="pr-3">dense</th><th className="pr-3">lexical</th><th className="pr-3">grade</th><th className="pr-3">page</th><th>section</th>
              </tr>
            </thead>
            <tbody>
              {debug.fused.slice(0, 20).map((f) => (
                <tr key={f.chunkId} className={debug.final.some((x) => x.chunkId === f.chunkId) ? "text-foreground" : ""}>
                  <td className="pr-3">{f.fusedRank}</td>
                  <td className="pr-3">{f.rrf}</td>
                  <td className="pr-3">{f.denseRank ? `#${f.denseRank} (${debug.dense.find((d) => d.chunkId === f.chunkId)?.similarity})` : "—"}</td>
                  <td className="pr-3">{f.lexicalRank ? `#${f.lexicalRank}` : "—"}</td>
                  <td className="pr-3">{f.grade ?? "—"}</td>
                  <td className="pr-3">{f.page ?? "—"}</td>
                  <td className="truncate">{f.section ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

type Evidence = Extract<AskResponse, { ok: true }>["result"]["evidence"][number];

const TYPE_LABEL: Record<string, string> = {
  text: "Text",
  table: "Table",
  figure: "Figure",
  graph: "Graph",
  equation: "Equation",
  ocr_text: "Scanned page (OCR)",
  handwritten_note: "Handwritten note (OCR)",
  image_note: "Image note",
};

/** Plain-language source type; OCR-derived evidence shows its recognition confidence. */
function SourceTypeBadge({ type, confidence }: { type?: string; confidence?: number | null }) {
  if (!type || type === "text") return null;
  const ocr = type === "ocr_text" || type === "handwritten_note";
  return (
    <Badge tone={ocr ? "warning" : "accent"} title={ocr ? "Recognised from an image; may contain recognition errors" : undefined}>
      {TYPE_LABEL[type] ?? type}
      {ocr && confidence != null ? ` · ${Math.round(confidence * 100)}% confidence` : ""}
    </Badge>
  );
}

/** Numbers that appear in the answer, used to highlight the table cells the answer relies on. */
function answerNumbers(answer: string) {
  return new Set((answer.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.length > 1 || n.includes(".")));
}

function EvidenceBody({ e, answer }: { e: Evidence; answer: string }) {
  const s = e.structured as { rows?: string[][]; headerRows?: number; caption?: string | null } | null | undefined;
  if (e.contentType === "table" && s?.rows?.length) {
    const nums = answerNumbers(answer);
    const header = Math.max(0, Math.min(s.headerRows ?? 1, s.rows.length - 1));
    return (
      <div>
        {s.caption && <p className="mb-2 text-[13px] text-muted">{s.caption}</p>}
        <div className="max-h-72 overflow-auto rounded border border-border">
          <table className="w-full text-[12px]">
            <tbody>
              {s.rows.slice(0, 40).map((row, i) => (
                <tr key={i} className={i < header ? "bg-surface-muted font-medium" : "border-t border-border"}>
                  {row.map((cell, j) => {
                    const hit = i >= header && [...(cell.match(/\d+(?:\.\d+)?/g) ?? [])].some((n) => nums.has(n));
                    return (
                      <td key={j} className={cn("px-2 py-1 align-top", hit && "bg-accent-soft font-semibold text-accent")}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (e.contentType === "figure" && e.hasAsset) {
    return (
      <div className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL via owner-checked route */}
        <img src={`/documents/${e.documentId}/asset?chunk=${e.chunkId}`} alt={e.content.slice(0, 120)} className="max-h-72 rounded border border-border bg-white" loading="lazy" />
        <p className="leading-relaxed text-foreground/90">{e.content}</p>
      </div>
    );
  }
  return <p className="whitespace-pre-line leading-relaxed text-foreground/90">{e.content}</p>;
}
