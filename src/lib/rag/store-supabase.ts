import "server-only";
import type { createClient } from "@/lib/supabase/server";
import type { RetrievalStore } from "./types";

type UserClient = Awaited<ReturnType<typeof createClient>>;

/** RetrievalStore backed by the signed-in user's Supabase client — every call is RLS-scoped. */
export function supabaseRetrievalStore(supabase: UserClient): RetrievalStore {
  return {
    async scope(projectId) {
      const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
      if (!project) return null;
      const { data, error } = await supabase.from("documents").select("id, title, original_filename, status").eq("project_id", projectId);
      if (error) throw new Error("scope query failed");
      return data.map((d) => ({ id: d.id, title: d.title ?? d.original_filename.replace(/\.pdf$/i, ""), status: d.status }));
    },
    async dense({ embedding, projectId, model, documentIds, k }) {
      const { data, error } = await supabase.rpc("match_document_chunks", {
        query_embedding: embedding,
        p_project_id: projectId,
        p_embedding_model: model,
        p_document_ids: documentIds,
        match_count: k,
      });
      if (error) throw new Error("dense retrieval failed");
      return data;
    },
    async lexical({ query, projectId, documentIds, k }) {
      const { data, error } = await supabase.rpc("search_document_chunks_lexical", {
        query_text: query,
        p_project_id: projectId,
        p_document_ids: documentIds,
        match_count: k,
      });
      if (error) throw new Error("lexical retrieval failed");
      return data;
    },
    async neighbors(documentId, chunkIndexes) {
      const { data, error } = await supabase
        .from("document_chunks")
        .select("id, document_id, chunk_index, page_start, page_end, section_title, section_kind, content, token_count")
        .eq("document_id", documentId)
        .in("chunk_index", chunkIndexes.filter((i) => i >= 0));
      if (error) throw new Error("neighbour query failed");
      return data.map(({ id, ...rest }) => ({ chunk_id: id, ...rest }));
    },
    async details(chunkIds) {
      const { data, error } = await supabase
        .from("document_chunks")
        .select("id, content_type, derivation, structured, bbox, source_asset_path, confidence")
        .in("id", chunkIds);
      if (error) throw new Error("details query failed");
      // The asset path itself never leaves the server; the UI asks for it by chunk id.
      return data.map((d) => ({ chunk_id: d.id, content_type: d.content_type, derivation: d.derivation, structured: d.structured, bbox: d.bbox, has_asset: Boolean(d.source_asset_path), confidence: d.confidence }));
    },
  };
}
