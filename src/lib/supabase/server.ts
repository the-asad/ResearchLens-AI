import "server-only";
import { createServerClient } from "@supabase/ssr";
import { io } from "next/cache";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/database.types";

/**
 * Per-request server client acting as the signed-in user (publishable key + session cookie),
 * so all queries remain subject to RLS. Create a new one per request; never share it.
 *
 * Cache Components / Partial Prefetching: cookies() is available during the runtime prerender
 * stages, so it is NOT a suspension point there. Supabase auth reads the clock synchronously
 * as soon as it touches the session (auth-js __loadSession compares expires_at with Date.now()),
 * which Next.js rejects as unstable sync IO in those stages. `await io()` marks that the code
 * after it is request-time IO: it suspends during prerendering and resolves at request time,
 * so session verification and every RLS query always run per request and are never captured
 * into a prerendered shell.
 */
export async function createClient() {
  const cookieStore = await cookies();
  await io();
  const env = publicEnv();

  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component where cookies are read-only. The proxy refreshes
          // the session, so this is safe to ignore.
        }
      },
    },
  });
}
