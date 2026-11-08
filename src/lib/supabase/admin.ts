import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import type { Database } from "@/lib/database.types";

/**
 * Service-role client. BYPASSES RLS — use only for server-owned state transitions
 * (e.g. document verification status) AFTER ownership has been verified with the
 * user-scoped client, and always filter by owner_id explicitly.
 */
export function createAdminClient() {
  const url = serverEnv().SUPABASE_URL ?? publicEnv().NEXT_PUBLIC_SUPABASE_URL;
  return createClient<Database>(url, serverEnv().SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
