import type pg from "pg";
import type { RetrievalStore } from "../../src/lib/rag/types";
import { asUser } from "./pg.mjs";

/** RetrievalStore that executes every query as `userId` under RLS (same SQL as the app). */
export function pgRetrievalStore(client: pg.Client, userId: string): RetrievalStore {
  return {
    async scope(projectId) {
      const p = await asUser(client, userId, "select id from public.projects where id = $1", [projectId]);
      if (p.length === 0) return null;
      const rows = await asUser<{ id: string; title: string | null; original_filename: string; status: string }>(
        client, userId, "select id, title, original_filename, status from public.documents where project_id = $1", [projectId]);
      return rows.map((d) => ({ id: d.id, title: d.title ?? d.original_filename, status: d.status }));
    },
    async dense({ embedding, projectId, model, documentIds, k }) {
      return asUser(client, userId, "select * from public.match_document_chunks($1::extensions.vector, $2, $3, $4, $5)", [embedding, projectId, model, documentIds, k]);
    },
    async lexical({ query, projectId, documentIds, k }) {
      return asUser(client, userId, "select * from public.search_document_chunks_lexical($1, $2, $3, $4)", [query, projectId, documentIds, k]);
    },
    async neighbors(documentId, idx) {
      return asUser(client, userId,
        "select id as chunk_id, document_id, chunk_index, page_start, page_end, section_title, section_kind, content, token_count from public.document_chunks where document_id = $1 and chunk_index = any($2)",
        [documentId, idx.filter((i) => i >= 0)]);
    },
  };
}
