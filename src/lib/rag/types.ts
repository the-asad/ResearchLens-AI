export type ChunkHit = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  section_title: string | null;
  section_kind: string;
  content: string;
};

export type ScopedDocument = { id: string; title: string; status: string };

/**
 * Data access used by retrieval. Every implementation MUST execute as the end user so that RLS
 * and the SQL functions' owner filters apply (Supabase user client in the app; an RLS-impersonating
 * Postgres connection in the evaluation harness).
 */
export type RetrievalStore = {
  /** Returns the project's documents visible to the caller, or null if the project is not theirs. */
  scope(projectId: string): Promise<ScopedDocument[] | null>;
  dense(args: { embedding: string; projectId: string; model: string; documentIds: string[] | null; k: number }): Promise<(ChunkHit & { similarity: number })[]>;
  lexical(args: { query: string; projectId: string; documentIds: string[] | null; k: number }): Promise<(ChunkHit & { rank: number })[]>;
  neighbors(documentId: string, chunkIndexes: number[]): Promise<(ChunkHit & { token_count: number | null })[]>;
  /** Multimodal provenance for the final evidence (RLS-scoped). Optional for older stores. */
  details?(chunkIds: string[]): Promise<EvidenceDetails[]>;
};

export type EvidenceDetails = {
  chunk_id: string;
  content_type: string;
  derivation: string;
  structured: unknown;
  bbox: unknown;
  has_asset: boolean;
  confidence: number | null;
};

export type Candidate = ChunkHit & {
  dense?: { rank: number; similarity: number };
  lexical?: { rank: number; score: number };
  rrf: number;
  fusedRank: number;
  rerank?: { grade: number };
};

export type Sufficiency = "SUFFICIENT" | "WEAK" | "INSUFFICIENT";

export type EvidencePassageOut = {
  evidenceId: string; // E1, E2, … — the only ids the generator may cite
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  content: string;
  role: "primary" | "context";
  grade?: number;
  contentType?: string;
  derivation?: string;
  structured?: unknown;
  bbox?: unknown;
  hasAsset?: boolean;
  confidence?: number | null;
};
