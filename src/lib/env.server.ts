import "server-only";
import { z } from "zod";

/**
 * Server-only configuration. Importing this module from a Client Component fails the build
 * (via `server-only`), so secrets can never reach the browser bundle.
 * Error messages name missing variables but never print values.
 */
const serverEnvSchema = z.object({
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("research-papers"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.8-flash"),
  GEMINI_FALLBACK_MODEL: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-20b"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (!cached) {
    const parsed = serverEnvSchema.safeParse({
      SUPABASE_URL: process.env.SUPABASE_URL || undefined,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || undefined,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
      GEMINI_MODEL: process.env.GEMINI_MODEL || undefined,
      GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL || undefined,
      GROQ_API_KEY: process.env.GROQ_API_KEY || undefined,
      GROQ_MODEL: process.env.GROQ_MODEL || undefined,
    });
    if (!parsed.success) {
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Missing or invalid server environment variables: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function storageBucket() {
  return serverEnv().SUPABASE_STORAGE_BUCKET;
}
