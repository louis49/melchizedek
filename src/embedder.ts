/**
 * Embedder implementations: TransformersJsEmbedder (configurable via MODEL_REGISTRY) + OllamaEmbedder.
 */

import type { Embedder, EmbeddingBackend } from './models.js';
import type { ModelSpec, PoolingStrategy } from './constants.js';
import {
  EMBEDDING_PIPELINE_TASK,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_TEXT_MODEL,
  DEFAULT_OLLAMA_CODE_MODEL,
  DEFAULT_TEXT_MODEL_KEY,
  DEFAULT_CODE_MODEL_KEY,
  lookupModelSpec,
} from './constants.js';
import { logger } from './logger.js';

const P = 'embedder';

/*
 * ONNX session tuning notes (2026-02-27):
 *   - enableCpuMemArena:false → INCREASED RSS (687 MB vs 442 MB), heap fragmentation
 *   - graphOptimizationLevel:'disabled' → same, prevents graph compaction
 *   - intraOpNumThreads:1 → no visible RSS impact
 *   - dtype:'q8' → 442 MB vs 1164 MB for fp32 (MiniLM text), biggest win
 * Conclusion: only q8 quantization matters. Keep ONNX defaults for session options.
 */

function truncateTexts(texts: string[], maxChars: number): string[] {
  return texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t));
}

// --- TransformersJsEmbedder (replaces MiniLMEmbedder + JinaCodeEmbedder) ---

export class TransformersJsEmbedder implements Embedder {
  private pipe: unknown = null;
  private probedDimensions: number | null = null;
  private readonly spec: ModelSpec;

  constructor(spec: ModelSpec) {
    this.spec = spec;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.getPipeline();
    if (!pipe)
      throw new Error(
        `Embeddings not available for ${this.spec.key} — @huggingface/transformers not installed`,
      );

    const truncated = truncateTexts(texts, this.spec.maxInputChars);

    const output = await (pipe as CallableFunction)(truncated, {
      pooling: this.spec.pooling,
      normalize: true,
    });

    const list = output.tolist() as number[][];
    const results = list.map((vec) => new Float32Array(vec));

    // Probe dimensions from first result (for dynamic specs with dimensions=0)
    if (this.probedDimensions === null && results.length > 0) {
      this.probedDimensions = results[0].length;
    }

    return results;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const prefixed = this.spec.queryPrefix ? `${this.spec.queryPrefix} ${text}` : text;
    return (await this.embedBatch([prefixed]))[0];
  }

  dimensions(): number {
    // If spec has known dimensions, use them; otherwise fall back to probed
    if (this.spec.dimensions > 0) return this.spec.dimensions;
    if (this.probedDimensions !== null) return this.probedDimensions;
    throw new Error(`Dimensions not yet known for ${this.spec.key} — call embed() first`);
  }

  modelId(): string {
    return this.spec.key;
  }

  maxInputChars(): number {
    return this.spec.maxInputChars;
  }

  /** Exposed for tests — returns the ModelSpec driving this embedder. */
  getSpec(): ModelSpec {
    return this.spec;
  }

  /**
   * Auto-detect the best pooling strategy for an unknown model.
   * Runs a mini-benchmark: embeds semantically similar vs dissimilar pairs
   * with each pooling strategy and picks the one with the best discrimination.
   * Only useful for models NOT in the registry (dynamic specs).
   */
  async probePooling(): Promise<PoolingStrategy> {
    const pipe = await this.getPipeline();
    if (!pipe) return 'mean';

    // Benchmark pairs: similar texts should have high cosine sim, dissimilar should have low
    const similar = ['fix the authentication error in the login page', 'debug login auth failure'];
    const dissimilar = [
      'fix the authentication error in the login page',
      'install numpy with pip on ubuntu',
    ];

    const strategies: PoolingStrategy[] = ['mean', 'cls', 'last_token'];
    let bestStrategy: PoolingStrategy = 'mean';
    let bestScore = -Infinity;

    for (const pooling of strategies) {
      try {
        const embedPair = async (texts: string[]): Promise<[Float32Array, Float32Array]> => {
          const output = await (pipe as CallableFunction)(texts, { pooling, normalize: true });
          const list = output.tolist() as number[][];
          return [new Float32Array(list[0]), new Float32Array(list[1])];
        };

        const [simA, simB] = await embedPair(similar);
        const [disA, disB] = await embedPair(dissimilar);

        const cosineSim = (a: Float32Array, b: Float32Array): number =>
          a.reduce((sum, v, i) => sum + v * b[i], 0);

        const simScore = cosineSim(simA, simB);
        const disScore = cosineSim(disA, disB);
        // Discrimination = how well this pooling separates similar from dissimilar
        const discrimination = simScore - disScore;

        if (discrimination > bestScore) {
          bestScore = discrimination;
          bestStrategy = pooling;
        }
      } catch {
        logger.debug(P, `Pooling strategy ${pooling} failed for ${this.spec.key}`);
      }
    }

    return bestStrategy;
  }

  private async getPipeline(): Promise<unknown> {
    if (this.pipe) return this.pipe;

    try {
      logger.info(P, `Loading model ${this.spec.key} (${this.spec.hfModelId})...`);
      const { pipeline } = await import('@huggingface/transformers');
      // Try each dtype in order of preference
      for (const dtype of this.spec.dtypePreference) {
        try {
          this.pipe = await pipeline(EMBEDDING_PIPELINE_TASK, this.spec.hfModelId, { dtype });
          logger.info(
            P,
            `Model loaded: ${this.spec.key} (${this.spec.dimensions}d, dtype=${dtype})`,
          );
          return this.pipe;
        } catch {
          logger.debug(P, `dtype ${dtype} not available for ${this.spec.key}, trying next`);
        }
      }
      throw new Error(`All dtype attempts failed for ${this.spec.key}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('All dtype')) throw err;
      logger.warn(P, `@huggingface/transformers not available for ${this.spec.key}`);
      return null;
    }
  }
}

// --- OllamaEmbedder ---

export class OllamaEmbedder implements Embedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private cachedDimensions: number | null = null;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  modelId(): string {
    return `ollama:${this.model}`;
  }

  // Conservative default — Ollama models vary (nomic: 8192, mxbai: 512).
  // Text is also truncated per-request in embedBatch (MAX_CHARS = 2000).
  maxInputChars(): number {
    return 2_000;
  }

  dimensions(): number {
    if (this.cachedDimensions === null) {
      throw new Error('Ollama embedding dimensions not yet known — call embed() first');
    }
    return this.cachedDimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Truncate individual inputs to stay within model context window.
    // nomic-embed-text has 8192 token context. Code/mixed content tokenizes
    // at ~2-4 chars/token, so 2000 chars ≈ 500-1000 tokens (safe margin).
    // Ollama's truncate flag is unreliable across versions.
    const MAX_CHARS = 2_000;
    const truncated = texts.map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t));

    // Embed one text at a time. Ollama's /api/embed batch mode sums all input
    // tokens into a single context window, causing 400 errors on large batches.
    // One-by-one is reliable and fast enough over localhost.
    const results: Float32Array[] = [];
    for (const text of truncated) {
      const vec = await this.embedSingle(text);
      results.push(vec);
    }
    return results;
  }

  private async embedSingle(text: string): Promise<Float32Array> {
    const url = `${this.baseUrl}/api/embed`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text, truncate: true }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    const vec = new Float32Array(data.embeddings[0]);

    // Cache dimensions from first result
    if (this.cachedDimensions === null) {
      this.cachedDimensions = vec.length;
    }

    return vec;
  }
}

// --- Health check + model availability ---

export async function checkOllamaHealth(
  baseUrl: string,
): Promise<{ ok: boolean; models: string[] }> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      return { ok: false, models: [] };
    }
    const data = (await response.json()) as { models: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { ok: true, models };
  } catch {
    logger.debug(P, 'Ollama not reachable (health check failed)');
    return { ok: false, models: [] };
  }
}

export function isModelAvailable(model: string, availableModels: string[]): boolean {
  // Normalize: 'nomic-embed-text' should match 'nomic-embed-text:latest'
  const normalized = model.includes(':') ? model : `${model}:latest`;
  return availableModels.some((m) => {
    const mNormalized = m.includes(':') ? m : `${m}:latest`;
    return mNormalized === normalized;
  });
}

// --- Auto-pull model ---

export async function pullOllamaModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    logger.info(P, `Pulling Ollama model: ${model}...`);
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false }),
    });
    if (!response.ok) {
      logger.warn(P, `Ollama pull failed (${response.status})`);
      return false;
    }
    logger.info(P, `Ollama model pulled: ${model}`);
    return true;
  } catch (err) {
    logger.error(P, 'Ollama pull error', err);
    return false;
  }
}

// --- Factory: create TransformersJs embedder from spec with probe ---

async function createTransformersJsEmbedder(spec: ModelSpec): Promise<Embedder | null> {
  try {
    // For dynamic specs (unknown model), probe the optimal pooling strategy
    let effectiveSpec = spec;
    if (spec.dimensions === 0) {
      const embedder = new TransformersJsEmbedder(spec);
      const bestPooling = await embedder.probePooling();
      if (bestPooling !== spec.pooling) {
        logger.info(
          P,
          `Probed pooling for ${spec.key}: ${bestPooling} (default was ${spec.pooling})`,
        );
        effectiveSpec = { ...spec, pooling: bestPooling };
      }
    }

    const embedder = new TransformersJsEmbedder(effectiveSpec);
    const testVec = await embedder.embed('test');
    // For known specs, verify dimensions match; for dynamic specs (dimensions=0), accept any
    if (effectiveSpec.dimensions > 0 && testVec.length !== effectiveSpec.dimensions) {
      logger.warn(
        P,
        `Dimension mismatch for ${spec.key}: expected ${effectiveSpec.dimensions}, got ${testVec.length}`,
      );
      return null;
    }
    return embedder;
  } catch (err) {
    logger.warn(P, `TransformersJs embedder failed for ${spec.key}`, err);
    return null;
  }
}

async function createOllamaEmbedder(
  baseUrl: string,
  model: string,
  autoPull: boolean,
): Promise<Embedder | null> {
  try {
    const health = await checkOllamaHealth(baseUrl);
    if (!health.ok) return null;

    if (!isModelAvailable(model, health.models)) {
      if (!autoPull) {
        logger.debug(P, `Ollama model ${model} not available, auto-pull disabled`);
        return null;
      }
      const pulled = await pullOllamaModel(baseUrl, model);
      if (!pulled) return null;
    }

    const embedder = new OllamaEmbedder(baseUrl, model);
    // Probe: verify embeddings actually work
    await embedder.embed('test');
    logger.info(P, `Ollama embedder ready: ${model} (${embedder.dimensions()}d)`);
    return embedder;
  } catch (err) {
    logger.warn(P, `Ollama embedder failed for ${model}`, err);
    return null;
  }
}

// --- createTextEmbedder / createCodeEmbedder with backend + model selection ---

export interface TextEmbedderConfig {
  embeddingBackend?: EmbeddingBackend;
  embeddingModel?: string | null;
  ollamaBaseUrl?: string;
}

export interface CodeEmbedderConfig {
  embeddingBackend?: EmbeddingBackend;
  embeddingModel?: string | null;
  ollamaBaseUrl?: string;
}

export async function createTextEmbedder(config?: TextEmbedderConfig): Promise<Embedder | null> {
  const backend = config?.embeddingBackend ?? 'auto';
  const ollamaUrl = config?.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL;
  const ollamaModel = config?.embeddingModel ?? DEFAULT_OLLAMA_TEXT_MODEL;

  if (backend === 'transformers-js' || backend === 'auto') {
    const modelKey = config?.embeddingModel ?? DEFAULT_TEXT_MODEL_KEY;
    const spec = lookupModelSpec(modelKey);
    if (spec) {
      const embedder = await createTransformersJsEmbedder(spec);
      if (embedder) return embedder;
    }
    // If transformers-js was explicitly requested and failed, don't fallback to Ollama
    if (backend === 'transformers-js') {
      logger.warn(
        P,
        `Text embedder failed (backend=transformers-js, model=${config?.embeddingModel})`,
      );
      return null;
    }
  }

  if (backend === 'ollama') {
    return createOllamaEmbedder(ollamaUrl, ollamaModel, true);
  }

  // 'auto' fallback: TransformersJs failed, try Ollama (without pull)
  logger.debug(P, 'Text embedder: TransformersJs unavailable, trying Ollama fallback');
  return createOllamaEmbedder(ollamaUrl, ollamaModel, false);
}

export async function createCodeEmbedder(config?: CodeEmbedderConfig): Promise<Embedder | null> {
  const backend = config?.embeddingBackend ?? 'auto';
  const ollamaUrl = config?.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL;
  const ollamaModel = config?.embeddingModel ?? DEFAULT_OLLAMA_CODE_MODEL;

  if (backend === 'transformers-js' || backend === 'auto') {
    const modelKey = config?.embeddingModel ?? DEFAULT_CODE_MODEL_KEY;
    const spec = lookupModelSpec(modelKey);
    if (spec) {
      const embedder = await createTransformersJsEmbedder(spec);
      if (embedder) return embedder;
    }
    if (backend === 'transformers-js') {
      logger.warn(
        P,
        `Code embedder failed (backend=transformers-js, model=${config?.embeddingModel})`,
      );
      return null;
    }
  }

  if (backend === 'ollama') {
    return createOllamaEmbedder(ollamaUrl, ollamaModel, true);
  }

  // 'auto' fallback: TransformersJs failed, try Ollama (without pull)
  logger.debug(P, 'Code embedder: TransformersJs unavailable, trying Ollama fallback');
  return createOllamaEmbedder(ollamaUrl, ollamaModel, false);
}
