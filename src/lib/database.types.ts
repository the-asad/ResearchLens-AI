/**
 * Hand-maintained to mirror supabase/migrations. Regenerate with
 * `npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts`
 * once the Supabase CLI is linked.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type DocumentStatus = "pending_upload" | "uploaded" | "processing" | "ready" | "failed";
export type ContentType = "text" | "table" | "figure" | "graph" | "equation" | "handwritten_note" | "image_note" | "ocr_text";
export type DocumentKind = "paper" | "note";

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string | null; created_at: string; updated_at: string };
        Insert: { id: string; display_name?: string | null };
        Update: { display_name?: string | null };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: { name: string; description?: string | null };
        Update: { name?: string; description?: string | null };
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          owner_id: string;
          project_id: string;
          original_filename: string;
          storage_path: string;
          mime_type: string;
          file_size_bytes: number;
          status: DocumentStatus;
          title: string | null;
          page_count: number | null;
          error_message: string | null;
          processing_metadata: Json;
          kind: DocumentKind;
          created_at: string;
          updated_at: string;
        };
        Insert: { project_id: string; original_filename: string; file_size_bytes: number; mime_type?: string; kind?: DocumentKind };
        Update: {
          title?: string | null;
          status?: DocumentStatus;
          error_message?: string | null;
          page_count?: number | null;
          processing_metadata?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "documents_project_id_owner_id_fkey";
            columns: ["project_id", "owner_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id", "owner_id"];
          },
        ];
      };
      document_chunks: {
        Row: {
          id: string;
          document_id: string;
          owner_id: string;
          project_id: string;
          chunk_index: number;
          page_start: number | null;
          page_end: number | null;
          section_title: string | null;
          content: string;
          token_count: number | null;
          embedding: string | null;
          embedding_model: string | null;
          content_type: ContentType;
          bbox: Json | null;
          structured: Json | null;
          derivation: "pdf_text" | "layout_model" | "ocr" | "vision" | "table_model";
          source_asset_path: string | null;
          confidence: number | null;
          embedding_modality: "text" | "image" | "multimodal";
          parent_chunk_index: number | null;
          section_kind: "front_matter" | "abstract" | "body" | "references" | "appendix";
          search_vector: unknown;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          document_id: string;
          owner_id: string;
          project_id: string;
          chunk_index: number;
          content: string;
          page_start?: number | null;
          page_end?: number | null;
          section_title?: string | null;
          token_count?: number | null;
          embedding?: string | null;
          metadata?: Json;
        };
        Update: never;
        Relationships: [];
      };
      ingestion_jobs: {
        Row: {
          id: string;
          owner_id: string;
          document_id: string;
          kind: "docintel" | "index";
          status: "queued" | "running" | "done" | "failed";
          attempts: number;
          locked_by: string | null;
          locked_at: string | null;
          error: string | null;
          result: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: { owner_id: string; document_id: string; kind: "docintel" | "index"; result?: Json };
        Update: { status?: "queued" | "running" | "done" | "failed"; error?: string | null; result?: Json };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      match_document_chunks: {
        Args: {
          query_embedding: string;
          p_project_id: string;
          p_embedding_model: string;
          p_document_ids?: string[] | null;
          match_count?: number;
          p_include_references?: boolean;
        };
        Returns: {
          chunk_id: string;
          document_id: string;
          chunk_index: number;
          page_start: number | null;
          page_end: number | null;
          section_title: string | null;
          section_kind: string;
          content: string;
          similarity: number;
        }[];
      };
      search_document_chunks_lexical: {
        Args: {
          query_text: string;
          p_project_id: string;
          p_document_ids?: string[] | null;
          match_count?: number;
          p_include_references?: boolean;
        };
        Returns: {
          chunk_id: string;
          document_id: string;
          chunk_index: number;
          page_start: number | null;
          page_end: number | null;
          section_title: string | null;
          section_kind: string;
          content: string;
          rank: number;
        }[];
      };
      claim_document_for_processing: {
        Args: { p_document_id: string; p_owner_id: string; p_stale_after?: string };
        Returns: Database["public"]["Tables"]["documents"]["Row"][];
      };
      claim_ingestion_job: {
        Args: { p_worker: string; p_kinds: string[]; p_stale_after?: string };
        Returns: Database["public"]["Tables"]["ingestion_jobs"]["Row"][];
      };
      replace_document_chunks: {
        Args: { p_document_id: string; p_owner_id: string; p_chunks: Json; p_document_patch: Json };
        Returns: number;
      };
    };
    Enums: { document_status: DocumentStatus };
    CompositeTypes: { [_ in never]: never };
  };
};
