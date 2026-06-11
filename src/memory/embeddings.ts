/**
 * embeddings.ts — IMP-07 semantic-memory embeddings, three backends:
 *
 *   1. OpenAI  (text-embedding-3-small, 256 dims) — when an OpenAI key exists.
 *   2. Google  (text-embedding-004, 256 dims)     — when a Google key exists.
 *   3. LOCAL   (transformers.js all-MiniLM-L6-v2, 384 dims) — no key needed;
 *      runs on WASM/ONNX in-process, model (~25 MB) downloaded once into the
 *      app folder's .model-cache/ (kept off the nearly-full system drive).
 *
 * API backends are preferred (better quality, no model download); the local
 * model makes semantic memory work for keyless setups (e.g. CLI providers).
 * There is deliberately NO LanceDB: brute-force cosine over a personal-scale
 * corpus is exact and faster than maintaining an ANN index. Vectors are
 * BACKEND-TAGGED (see {@link embeddingBackendTag}) so vectors produced by
 * different models are never compared with each other.
 *
 * When no backend works — or anything goes wrong (network, auth, malformed
 * response, timeout, missing optional package) — embedding returns null and
 * callers fall back to keyword-only (BM25) recall. This module NEVER throws.
 */

import path from "node:path";
import { getConfig } from "../config/index.js";
import { INSTALL_ROOT } from "../paths.js";

/**
 * Dimensionality requested from the embedding API. 256 keeps stored vectors
 * compact (both OpenAI text-embedding-3-small and Google text-embedding-004
 * support Matryoshka truncation to this size) while preserving good recall.
 */
export const EMBEDDING_DIMENSIONS = 256;

/** Hard cap on input length sent per text (characters), to bound request size. */
const MAX_INPUT_CHARS = 6000;

/** Per-request timeout for an embedding call. */
const EMBED_TIMEOUT_MS = 10_000;

/** LRU cache capacity (entries) keyed by exact input text. */
const CACHE_CAP = 64;

/**
 * Module-level LRU cache so repeated queries (e.g. the same recall string typed
 * twice, or a note embedded then immediately recalled) don't re-hit the API.
 * A Map preserves insertion order, which we exploit for cheap LRU eviction.
 */
const cache = new Map<string, number[]>();

/** Read one cached vector, refreshing its recency (move-to-end). */
function cacheGet(key: string): number[] | undefined {
  const hit = cache.get(key);
  if (hit === undefined) {
    return undefined;
  }
  // Refresh recency: delete + re-set moves the entry to the end.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/** Store a vector, evicting the least-recently-used entry when over capacity. */
function cacheSet(key: string, vec: number[]): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, vec);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

/** Dimensionality of the local all-MiniLM-L6-v2 model. */
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

/**
 * Which embedding backend is available: an API key (config, then environment)
 * wins; otherwise the keyless LOCAL transformers.js model. "local" is always
 * offered — if the optional package or model turns out to be unusable at
 * embed time, embedTexts simply returns null.
 */
export function detectEmbeddingBackend():
  | { provider: "openai" | "google" | "local"; apiKey: string }
  | null {
  // Config first: only honor a provider's key if that provider is selected.
  try {
    const config = getConfig();
    if (config.apiProvider === "openai" && config.apiKey.trim().length > 0) {
      return { provider: "openai", apiKey: config.apiKey.trim() };
    }
    if (config.apiProvider === "google" && config.apiKey.trim().length > 0) {
      return { provider: "google", apiKey: config.apiKey.trim() };
    }
  } catch {
    // getConfig should never throw, but never let it break detection.
  }

  // Environment fallback (lets embeddings work even with a CLI/other provider).
  const openaiEnv = process.env.OPENAI_API_KEY;
  if (typeof openaiEnv === "string" && openaiEnv.trim().length > 0) {
    return { provider: "openai", apiKey: openaiEnv.trim() };
  }
  const googleEnv = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (typeof googleEnv === "string" && googleEnv.trim().length > 0) {
    return { provider: "google", apiKey: googleEnv.trim() };
  }

  return { provider: "local", apiKey: "" };
}

/**
 * The tag stored alongside every vector, identifying the model that produced
 * it ("openai-256" | "google-256" | "local-384"). Vectors are only ever
 * cosine-compared when their tags match — different models embed into
 * unrelated spaces, so cross-model similarity would be meaningless.
 */
export function embeddingBackendTag(): string | null {
  const backend = detectEmbeddingBackend();
  if (backend === null) {
    return null;
  }
  return backend.provider === "local"
    ? `local-${LOCAL_EMBEDDING_DIMENSIONS}`
    : `${backend.provider}-${EMBEDDING_DIMENSIONS}`;
}

// ---- Local (transformers.js) backend -----------------------------------------

/** The minimal surface of @huggingface/transformers that we use. */
interface TransformersModule {
  env: { cacheDir?: string };
  pipeline: (
    task: string,
    model?: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractor>;
}
type FeatureExtractor = (
  input: string[],
  options?: Record<string, unknown>,
) => Promise<{ tolist: () => unknown }>;

/** The lazily-created local pipeline; null after a failed load (don't retry
 *  a missing package or failed download on every call). */
let localPipeline: Promise<FeatureExtractor | null> | null = null;

/**
 * Load the local embedding pipeline once. Dynamic import so the package is
 * OPTIONAL — when it isn't installed (or the one-time ~25 MB model download
 * fails) this resolves null and callers fall back to keyword-only recall.
 */
function getLocalPipeline(): Promise<FeatureExtractor | null> {
  if (localPipeline === null) {
    localPipeline = (async () => {
      try {
        const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
        // Keep the model cache next to the app (on the same drive), never in
        // the user profile on the (historically tight) system drive.
        mod.env.cacheDir = path.join(INSTALL_ROOT, ".model-cache");
        return await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "q8",
        });
      } catch {
        return null;
      }
    })();
  }
  return localPipeline;
}

/** Embed via the local model; null when it can't load or output is malformed. */
async function embedLocal(texts: string[]): Promise<number[][] | null> {
  const extractor = await getLocalPipeline();
  if (extractor === null) {
    return null;
  }
  try {
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const listed: unknown = output.tolist();
    if (!Array.isArray(listed) || listed.length !== texts.length) {
      return null;
    }
    const vectors: number[][] = [];
    for (const row of listed) {
      const vec = toVector(row);
      if (vec === null || vec.length !== LOCAL_EMBEDDING_DIMENSIONS) {
        return null;
      }
      vectors.push(vec);
    }
    return vectors;
  } catch {
    return null;
  }
}

/**
 * Embed `texts` (batched in a single request). Returns one vector per input in
 * the SAME order, or null when no backend is available or ANY error/timeout
 * occurs. Never throws. Repeated identical texts are served from an LRU cache.
 */
export async function embedTexts(
  texts: string[],
): Promise<number[][] | null> {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const backend = detectEmbeddingBackend();
  if (backend === null) {
    return null;
  }
  const tag = embeddingBackendTag() ?? "none";

  // Truncate inputs up front so cache keys and requests agree. Cache keys are
  // backend-tagged so switching backends never serves another model's vectors.
  const inputs = texts.map((t) =>
    (typeof t === "string" ? t : String(t)).slice(0, MAX_INPUT_CHARS),
  );
  const keys = inputs.map((t) => `${tag}:${t}`);

  // Serve fully-cached batches without any network call.
  const cached: Array<number[] | undefined> = keys.map((k) => cacheGet(k));
  const missingIdx: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    if (cached[i] === undefined) {
      missingIdx.push(i);
    }
  }
  if (missingIdx.length === 0) {
    return cached.map((v) => (v ?? []).slice());
  }

  // Embed only the cache-misses, preserving their order.
  const toEmbed = missingIdx.map((i) => inputs[i]);
  let fetched: number[][] | null;
  try {
    fetched =
      backend.provider === "openai"
        ? await embedOpenAI(toEmbed, backend.apiKey)
        : backend.provider === "google"
          ? await embedGoogle(toEmbed, backend.apiKey)
          : await embedLocal(toEmbed);
  } catch {
    return null;
  }
  if (fetched === null || fetched.length !== toEmbed.length) {
    return null;
  }

  // Merge fetched vectors back into the full result and warm the cache.
  const result: number[][] = new Array<number[]>(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    const c = cached[i];
    if (c !== undefined) {
      result[i] = c.slice();
    }
  }
  for (let j = 0; j < missingIdx.length; j++) {
    const idx = missingIdx[j];
    const vec = fetched[j];
    cacheSet(keys[idx], vec.slice());
    result[idx] = vec;
  }
  return result;
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty/zero/mismatched. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length === 0 ||
    b.length === 0 ||
    a.length !== b.length
  ) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return 0;
    }
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  if (!Number.isFinite(sim)) {
    return 0;
  }
  // Guard against tiny floating-point overshoot beyond [-1, 1].
  return Math.max(-1, Math.min(1, sim));
}

// ---- Provider request wiring -----------------------------------------------

/** A fetch with a hard abort timeout; resolves to the Response or throws. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Narrow an unknown value to a finite-number vector of the right length. */
function toVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const vec: number[] = [];
  for (const n of value) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return null;
    }
    vec.push(n);
  }
  return vec;
}

/** OpenAI embeddings: POST /v1/embeddings, vectors under data[i].embedding. */
async function embedOpenAI(
  texts: string[],
  apiKey: string,
): Promise<number[][] | null> {
  const res = await fetchWithTimeout("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });
  if (!res.ok) {
    return null;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }

  if (typeof json !== "object" || json === null) {
    return null;
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    return null;
  }

  // Each entry carries its position in an `index` field; sort by it so the
  // returned order always matches the input order.
  const entries: Array<{ index: number; embedding: number[] }> = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const vec = toVector((item as { embedding?: unknown }).embedding);
    if (vec === null) {
      return null;
    }
    const rawIndex = (item as { index?: unknown }).index;
    const index = typeof rawIndex === "number" && Number.isFinite(rawIndex)
      ? rawIndex
      : i;
    entries.push({ index, embedding: vec });
  }
  entries.sort((a, b) => a.index - b.index);
  return entries.map((e) => e.embedding);
}

/** Google embeddings: batchEmbedContents, vectors under embeddings[i].values. */
async function embedGoogle(
  texts: string[],
  apiKey: string,
): Promise<number[][] | null> {
  const res = await fetchWithTimeout(
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: "models/text-embedding-004",
          content: { parts: [{ text: t }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
  );
  if (!res.ok) {
    return null;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }

  if (typeof json !== "object" || json === null) {
    return null;
  }
  const embeddings = (json as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    return null;
  }

  // Google returns embeddings in request order (no index field).
  const out: number[][] = [];
  for (const item of embeddings) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const vec = toVector((item as { values?: unknown }).values);
    if (vec === null) {
      return null;
    }
    out.push(vec);
  }
  return out;
}
