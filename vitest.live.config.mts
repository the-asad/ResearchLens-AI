import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the React server runtime; stub it for node-side tests.
      "server-only": fileURLToPath(new URL("./tests/live/server-only-stub.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/live/**/*.live.test.ts"], environment: "node", env: loadEnv("development", process.cwd(), "") },
});
