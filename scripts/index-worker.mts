/**
 * Node indexer worker: consumes `index` jobs produced by the Python docintel worker.
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/index-worker.mts [--once]
 */
import { hostname } from "node:os";
import { runIndexJobOnce } from "../src/lib/rag/indexer";
const once = process.argv.includes("--once");
const id = `indexer-${hostname()}`.slice(0, 100);
for (;;) {
  const r = await runIndexJobOnce(id);
  if (r === "idle") {
    if (once) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
}
