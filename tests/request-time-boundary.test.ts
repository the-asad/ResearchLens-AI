/**
 * Regression test for the Cache Components "unstable value Date.now() while prerendering" bug.
 *
 * Supabase auth reads Date.now() synchronously when it loads the session. With Partial
 * Prefetching, cookies() resolves during the runtime prerender stages, so the server client must
 * `await io()` after reading cookies and BEFORE constructing the Supabase client or verifying
 * the session. This test pins that ordering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    calls.push("cookies");
    return { getAll: () => [], set: () => {} };
  },
}));
vi.mock("next/cache", () => ({
  io: async () => {
    calls.push("io");
  },
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => {
    calls.push("createServerClient");
    return {
      auth: {
        getClaims: async () => {
          calls.push("getClaims");
          return { data: { claims: { sub: "3f1c2a7e-9b4d-4c1e-8a2b-1d2e3f4a5b6c", email: "a@b.co" } }, error: null };
        },
      },
    };
  },
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";

describe("request-time boundary for Supabase auth", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("awaits io() after cookies() and before any Supabase client work", async () => {
    const { createClient } = await import("@/lib/supabase/server");
    await createClient();
    expect(calls).toEqual(["cookies", "io", "createServerClient"]);
  });

  it("verifies identity only after the io() boundary", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const user = await getCurrentUser();
    expect(user?.id).toBe("3f1c2a7e-9b4d-4c1e-8a2b-1d2e3f4a5b6c");
    expect(calls.indexOf("io")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("io")).toBeLessThan(calls.indexOf("getClaims"));
  });
});
