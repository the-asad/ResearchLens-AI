/**
 * Static security checks over the source tree. These guard against regressions that
 * would leak secrets to the browser or weaken storage/authorization boundaries.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const SERVER_SECRETS = ["SUPABASE_SECRET_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "DATABASE_URL"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const srcFiles = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");
const isClient = (src: string) => /^\s*["']use client["']/.test(src);

describe("secret handling", () => {
  it("never exposes server secrets through NEXT_PUBLIC_ variables", () => {
    for (const f of [...srcFiles, path.join(root, ".env.example")]) {
      for (const s of SERVER_SECRETS) expect(read(f), f).not.toContain(`NEXT_PUBLIC_${s}`);
    }
  });

  it("client components never reference server secrets or server-only modules", () => {
    for (const f of srcFiles) {
      const src = read(f);
      if (!isClient(src)) continue;
      for (const s of SERVER_SECRETS) expect(src, f).not.toContain(s);
      expect(src, f).not.toMatch(/@\/lib\/(env\.server|supabase\/admin|supabase\/server|ai)["/]/);
    }
  });

  it("server secret readers and AI providers are marked server-only", () => {
    const mustBeServerOnly = [
      "src/lib/env.server.ts",
      "src/lib/supabase/admin.ts",
      "src/lib/supabase/server.ts",
      "src/lib/ai/index.ts",
      "src/lib/ai/gemini.ts",
      "src/lib/ai/groq.ts",
      "src/lib/documents.ts",
      "src/lib/rag/server.ts",
      "src/lib/rag/ai.ts",
      "src/lib/rag/store-supabase.ts",
      "src/lib/rag/indexer.ts",
    ];
    for (const f of mustBeServerOnly) expect(read(path.join(root, f)), f).toMatch(/import "server-only";/);
  });

  it("secrets are only read in env.server.ts", () => {
    for (const f of srcFiles) {
      if (f.endsWith("env.server.ts")) continue;
      for (const s of SERVER_SECRETS) expect(read(f), f).not.toContain(`process.env.${s}`);
    }
  });

  it("contains no hard-coded credentials", () => {
    const patterns = [/sb_secret_[A-Za-z0-9_-]{10,}/, /AIza[0-9A-Za-z_-]{30,}/, /gsk_[A-Za-z0-9]{20,}/, /eyJhbGciOi[A-Za-z0-9._-]{40,}/];
    const files = [...srcFiles, ...walk(path.join(root, "docs")), ...walk(path.join(root, "supabase")), path.join(root, ".env.example")];
    for (const f of files) for (const p of patterns) expect(read(f), f).not.toMatch(p);
  });

  it(".env.local is git-ignored", () => {
    expect(read(path.join(root, ".gitignore"))).toMatch(/^\.env\*$/m);
    if (existsSync(path.join(root, ".git"))) {
      expect(execSync("git check-ignore .env.local", { cwd: root }).toString().trim()).toBe(".env.local");
    }
  });

  it("the service-role client is used only by the two reviewed server modules", () => {
    const users = srcFiles.filter((f) => read(f).includes("createAdminClient(") && !f.endsWith("supabase/admin.ts"));
    expect(users.map((f) => path.relative(root, f)).sort()).toEqual(["src/lib/documents.ts", "src/lib/rag/indexer.ts", "src/lib/rag/server.ts"]);
  });

  it("every service-role table write in the RAG server is owner-filtered, and ownership is verified first", () => {
    const src = read(path.join(root, "src/lib/rag/server.ts"));
    // Ownership check with the RLS-scoped client precedes any admin client creation.
    expect(src.indexOf("owned.owner_id !== userId")).toBeGreaterThan(-1);
    expect(src.indexOf("owned.owner_id !== userId")).toBeLessThan(src.indexOf("createAdminClient()"));
    const adminFromCalls = src.split("admin\n          .from(").length - 1 + (src.match(/admin\.from\(/g)?.length ?? 0);
    const ownerFilters = src.match(/\.eq\("owner_id", userId\)/g)?.length ?? 0;
    expect(ownerFilters).toBeGreaterThanOrEqual(adminFromCalls);
    for (const m of src.matchAll(/admin\.rpc\("[a-z_]+", \{[^}]*\}/g)) expect(m[0]).toContain("p_owner_id: userId");
  });

  it("the indexer filters every service-role table access by the job's owner", () => {
    const src = read(path.join(root, "src/lib/rag/indexer.ts"));
    const fromCalls = src.match(/admin\s*\.from\("(documents|document_chunks|ingestion_jobs)"\)/g)?.length ?? 0;
    const ownerFilters = src.match(/\.eq\("owner_id", ownerId\)/g)?.length ?? 0;
    expect(fromCalls).toBeGreaterThan(0);
    // every read/update is owner-filtered (the two inserts set owner_id explicitly)
    expect(ownerFilters).toBeGreaterThanOrEqual(fromCalls - 1);
    expect(src).toMatch(/startsWith\(`\$\{ownerId\}\/\$\{doc\.project_id\}\/\$\{documentId\}\/derived\/`\)/);
    for (const m of src.matchAll(/admin\.rpc\("(replace_document_chunks|claim_document_for_processing)", \{[^}]*\}/g)) expect(m[0]).toContain("p_owner_id: ownerId");
  });

  it("never uses getSession() for server-side identity", () => {
    for (const f of srcFiles) expect(read(f), f).not.toMatch(/auth\.getSession\(/);
  });
});

describe("Cache Components request-time safety", () => {
  // Server-rendered modules (not client components, server actions or route handlers).
  const renderFiles = srcFiles.filter((f) => {
    const rel = path.relative(root, f);
    const src = read(f);
    return (
      (rel.startsWith("src/app/") || rel.startsWith("src/components/")) &&
      !isClient(src) &&
      !/^\s*["']use server["']/.test(src) &&
      !rel.endsWith("route.ts")
    );
  });

  it("server-rendered code never reads the clock or randomness synchronously", () => {
    for (const f of renderFiles) {
      const src = read(f);
      expect(src, f).not.toMatch(/Date\.now\(\)|new Date\(\)|Math\.random\(\)|crypto\.randomUUID\(\)/);
    }
  });

  it("the server Supabase client awaits io() before creating the client", () => {
    const src = read(path.join(root, "src/lib/supabase/server.ts"));
    const ioAt = src.indexOf("\n  await io();");
    expect(ioAt).toBeGreaterThan(src.indexOf("const cookieStore = await cookies();"));
    expect(ioAt).toBeLessThan(src.indexOf("createServerClient<"));
  });

  it("only the central server client constructs a cookie-bound Supabase client in render code", () => {
    const users = srcFiles
      .filter((f) => read(f).includes("createServerClient<") || read(f).includes("createServerClient("))
      .map((f) => path.relative(root, f));
    expect(users.sort()).toEqual(["src/lib/supabase/proxy.ts", "src/lib/supabase/server.ts"]);
  });
});

describe("database migrations", () => {
  const sql = walk(path.join(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map(read)
    .join("\n");
  const tables = [...sql.matchAll(/create table public\.(\w+)/g)].map((m) => m[1]);

  it("enables RLS on every public table", () => {
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(sql).toContain(`alter table public.${t} enable row level security`);
  });

  it("scopes every table policy to auth.uid()", () => {
    const policies = [...sql.matchAll(/create policy "[^"]+" on public\.\w+[\s\S]*?;/g)].map((m) => m[0]);
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) expect(p).toMatch(/auth\.uid\(\)/);
    expect(sql).not.toMatch(/using \(true\)/i);
  });

  it("never makes the storage bucket public", () => {
    expect(sql).not.toMatch(/update storage\.buckets/i);
    expect(sql).not.toMatch(/public\s*=\s*true/i);
  });

  it("scopes vector search to the caller and a project", () => {
    const fn = sql.slice(sql.lastIndexOf("function public.match_document_chunks"));
    expect(fn).toMatch(/security invoker/);
    expect(fn).toMatch(/c\.owner_id = \(select auth\.uid\(\)\)/);
    expect(fn).toMatch(/c\.project_id = p_project_id/);
  });

  it("ingestion functions that bypass RLS are executable by service_role only", () => {
    for (const fn of ["claim_document_for_processing", "replace_document_chunks"]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to authenticated`));
    }
  });

  it("lexical search is also scoped to the caller and project", () => {
    const fn = sql.slice(sql.indexOf("function public.search_document_chunks_lexical"));
    expect(fn).toMatch(/security invoker/);
    expect(fn).toMatch(/c\.owner_id = \(select auth\.uid\(\)\)/);
    expect(fn).toMatch(/c\.project_id = p_project_id/);
  });

  it("dense search filters on the embedding model so vectors from different models never mix", () => {
    const fns = sql.split("create or replace function public.match_document_chunks");
    expect(fns[fns.length - 1]).toMatch(/c\.embedding_model = p_embedding_model/);
  });

  it("explicitly grants the service role exactly the table privileges server code needs", () => {
    // Regression: this project's default privileges give service_role no DML on new tables.
    expect(sql).toMatch(/grant select, update on public\.documents to service_role/);
    expect(sql).toMatch(/grant select, insert, delete on public\.document_chunks to service_role/);
    expect(sql).not.toMatch(/grant [^;]* on public\.(projects|profiles) to service_role/);
  });

  it("derives storage paths in the database, not from filenames", () => {
    expect(sql).toMatch(/storage_path text generated always as/);
  });
});
