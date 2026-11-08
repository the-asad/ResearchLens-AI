/** Rerankers under test: local cross-encoders (joint query+passage scoring) via ONNX. */
import { env, AutoTokenizer, AutoModelForSequenceClassification, type PreTrainedTokenizer, type PreTrainedModel } from "@huggingface/transformers";
env.cacheDir = "eval/cache/hf";

export type Reranker = { id: string; license: string; sizeMB: number; score(query: string, passages: string[]): Promise<number[]> };

function crossEncoder(id: string, model: string, license: string, sizeMB: number, maxLength = 512): Reranker {
  let tok: PreTrainedTokenizer | undefined;
  let m: PreTrainedModel | undefined;
  return {
    id, license, sizeMB,
    async score(query, passages) {
      tok ??= await AutoTokenizer.from_pretrained(model);
      m ??= await AutoModelForSequenceClassification.from_pretrained(model, { dtype: "q8" });
      const out: number[] = [];
      for (let i = 0; i < passages.length; i += 8) {
        const batch = passages.slice(i, i + 8);
        const inputs = tok(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true, max_length: maxLength });
        const { logits } = await m(inputs);
        out.push(...(logits.tolist() as number[][]).map((r) => r[0]));
      }
      return out;
    },
  };
}

export const RERANKERS: Reranker[] = [
  crossEncoder("ms-marco-MiniLM-L-6-v2", "Xenova/ms-marco-MiniLM-L-6-v2", "Apache-2.0", 23),
  crossEncoder("bge-reranker-base", "Xenova/bge-reranker-base", "MIT", 279),
  crossEncoder("bge-reranker-v2-m3", "onnx-community/bge-reranker-v2-m3-ONNX", "Apache-2.0", 571, 512),
];
