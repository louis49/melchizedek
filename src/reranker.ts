/**
 * Reranker interface + dual backend: Transformers.js (CPU) / node-llama-cpp (GPU).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Reranker, RerankerBackend, RerankerResult, MelchizedekConfig } from './models.js';
import { DEFAULT_RERANKER_MODEL, GGUF_RERANKER_PATTERNS } from './constants.js';
import { logger } from './logger.js';

const P = 'reranker';

/*
 * ONNX session tuning: only q8 matters. See embedder.ts for full benchmarks.
 */

/**
 * Cross-encoder reranker using @huggingface/transformers (CPU).
 * Model: Xenova/ms-marco-MiniLM-L-6-v2 (~80 Mo ONNX).
 * Uses AutoModelForSequenceClassification + AutoTokenizer directly
 * (pipeline API returns saturated probabilities, not raw logits).
 * Lazy-loaded on first rerank() call.
 */
export class TransformersJsReranker implements Reranker {
  private model: unknown | null = null;
  private tokenizer: unknown | null = null;
  private readonly _modelId: string;

  constructor(modelId?: string) {
    this._modelId = modelId ?? DEFAULT_RERANKER_MODEL;
  }

  async rerank(
    query: string,
    documents: { id: string; content: string }[],
    topN: number,
  ): Promise<RerankerResult[]> {
    if (documents.length === 0) return [];

    await this.loadModel();

    const tok = this.tokenizer as (
      text: string,
      options: { text_pair: string; padding: boolean; truncation: boolean; max_length: number },
    ) => unknown;
    const mdl = this.model as (inputs: unknown) => Promise<{
      logits: { data: Float32Array };
    }>;

    // Score each (query, document) pair via raw logits
    const scored: RerankerResult[] = [];
    for (const doc of documents) {
      const inputs = tok(query, {
        text_pair: doc.content,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const output = await mdl(inputs);
      scored.push({ id: doc.id, score: output.logits.data[0] });
    }

    // Sort by score descending (higher logit = more relevant), take topN
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  backend(): RerankerBackend {
    return 'transformers-js';
  }

  modelId(): string {
    return this._modelId;
  }

  private async loadModel() {
    if (this.model) return;

    logger.info(P, `Loading reranker model: ${this._modelId}...`);
    const { AutoModelForSequenceClassification, AutoTokenizer } =
      await import('@huggingface/transformers');
    this.tokenizer = await AutoTokenizer.from_pretrained(this._modelId);
    let dtype = 'q8';
    try {
      this.model = await AutoModelForSequenceClassification.from_pretrained(this._modelId, {
        dtype: 'q8',
      });
    } catch {
      logger.debug(P, 'q8 not available for reranker, falling back to fp32');
      this.model = await AutoModelForSequenceClassification.from_pretrained(this._modelId);
      dtype = 'fp32';
    }
    logger.info(P, `Reranker model loaded: ${this._modelId} (dtype=${dtype})`);
  }
}

/**
 * Cross-encoder reranker using a llama-server HTTP backend.
 * The user runs `llama-server --rerank --pooling rank -m <model.gguf> -p <port>`.
 * We connect via POST /v1/rerank.
 */
export class LlamaServerReranker implements Reranker {
  private _modelName: string | null = null;

  constructor(private baseUrl: string) {}

  async rerank(
    query: string,
    documents: { id: string; content: string }[],
    topN: number,
  ): Promise<RerankerResult[]> {
    if (documents.length === 0) return [];

    const resp = await fetch(`${this.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, documents: documents.map((d) => d.content) }),
    });
    if (!resp.ok) throw new Error(`llama-server rerank failed: ${resp.status}`);
    const data = (await resp.json()) as {
      results: Array<{ index: number; score?: number; relevance_score?: number }>;
    };

    return data.results
      .map((r) => ({
        id: documents[r.index].id,
        score: r.relevance_score ?? r.score ?? 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  backend(): RerankerBackend {
    return 'llama-server';
  }

  modelId(): string {
    return this._modelName ?? 'llama-server';
  }

  setModelName(name: string): void {
    this._modelName = name;
  }
}

/**
 * Check if a llama-server is healthy and retrieve the loaded model name.
 * Returns { ok: true, modelName } on success, { ok: false, modelName: null } on failure.
 */
export async function checkLlamaServerHealth(
  baseUrl: string,
): Promise<{ ok: boolean; modelName: string | null }> {
  try {
    const healthResp = await fetch(`${baseUrl}/health`);
    if (!healthResp.ok) return { ok: false, modelName: null };

    let modelName: string | null = null;
    try {
      const modelsResp = await fetch(`${baseUrl}/v1/models`);
      if (modelsResp.ok) {
        const modelsData = (await modelsResp.json()) as {
          data?: Array<{ id: string }>;
        };
        if (modelsData.data && modelsData.data.length > 0) {
          // Extract basename from the full GGUF path
          modelName = path.basename(modelsData.data[0].id);
        }
      }
    } catch {
      // Model name is optional — health is what matters
    }

    return { ok: true, modelName };
  } catch {
    logger.debug(P, 'llama-server not reachable (health check failed)');
    return { ok: false, modelName: null };
  }
}

/** Pattern to match known reranker GGUF files — see constants.ts */

/**
 * Cross-encoder reranker using node-llama-cpp (GPU).
 * Requires a GGUF reranker model in the models directory.
 */
export class LlamaCppReranker implements Reranker {
  private modelPath: string;
  private context: unknown | null = null;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async rerank(
    query: string,
    documents: { id: string; content: string }[],
    topN: number,
  ): Promise<RerankerResult[]> {
    if (documents.length === 0) return [];

    const ctx = await this.getContext();
    const rankingCtx = ctx as {
      rank(query: string, document: string): Promise<number>;
    };

    // node-llama-cpp rank() takes a single document and returns a score number.
    // Score each (query, document) pair individually.
    const scored: RerankerResult[] = [];
    for (const doc of documents) {
      const score = await rankingCtx.rank(query, doc.content);
      scored.push({ id: doc.id, score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topN);
  }

  backend(): RerankerBackend {
    return 'node-llama-cpp';
  }

  modelId(): string {
    return path.basename(this.modelPath);
  }

  private async getContext() {
    if (this.context) return this.context;

    const llamaCpp = await import('node-llama-cpp');
    const llama = await (llamaCpp as unknown as { getLlama(): Promise<unknown> }).getLlama();
    const llamaInst = llama as {
      loadModel(opts: { modelPath: string }): Promise<unknown>;
    };
    const model = await llamaInst.loadModel({ modelPath: this.modelPath });
    const modelInst = model as {
      createRankingContext(): Promise<unknown>;
    };
    this.context = await modelInst.createRankingContext();
    return this.context;
  }
}

/**
 * Find a reranker GGUF model in the models directory.
 * Preference: bge-reranker > qwen3-reranker.
 * Returns null if no suitable GGUF found.
 */
export function findRerankerGGUF(modelsDir: string): string | null {
  if (!fs.existsSync(modelsDir)) return null;

  const files = fs.readdirSync(modelsDir).filter((f) => f.endsWith('.gguf'));
  if (files.length === 0) return null;

  // Score each file by pattern priority
  const candidates: { file: string; priority: number }[] = [];
  for (const file of files) {
    for (const { pattern, priority } of GGUF_RERANKER_PATTERNS) {
      if (pattern.test(file)) {
        candidates.push({ file, priority });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by priority (lower = better)
  candidates.sort((a, b) => a.priority - b.priority);
  return path.join(modelsDir, candidates[0].file);
}

/**
 * Detect the best available reranker backend.
 * Priority: llama-server (HTTP) > node-llama-cpp (GPU) > Transformers.js (CPU) > none.
 */
export async function detectRerankerBackend(
  config?: Pick<
    MelchizedekConfig,
    'rerankerModelsDir' | 'rerankerBackend' | 'rerankerModel' | 'rerankerUrl'
  >,
): Promise<{
  backend: RerankerBackend;
  reranker: Reranker;
} | null> {
  const modelsDir = config?.rerankerModelsDir ?? path.join(os.homedir(), '.melchizedek', 'models');
  const forcedBackend = config?.rerankerBackend;

  // 1. Try llama-server (HTTP) — highest priority if rerankerUrl is set
  if (
    config?.rerankerUrl &&
    (forcedBackend === 'auto' || forcedBackend === 'llama-server' || !forcedBackend)
  ) {
    const health = await checkLlamaServerHealth(config.rerankerUrl);
    if (health.ok) {
      const reranker = new LlamaServerReranker(config.rerankerUrl);
      if (health.modelName) {
        reranker.setModelName(health.modelName);
      }
      return { backend: 'llama-server', reranker };
    }
    // If explicitly set to llama-server but server is down, don't fallback
    if (forcedBackend === 'llama-server') {
      return null;
    }
  }

  // 2. Try node-llama-cpp (GPU) — only if GGUF model available
  if (forcedBackend === 'auto' || forcedBackend === 'node-llama-cpp' || !forcedBackend) {
    try {
      await import('node-llama-cpp');
      const ggufPath = config?.rerankerModel ?? findRerankerGGUF(modelsDir);
      if (ggufPath) {
        logger.info(P, `Using node-llama-cpp reranker: ${path.basename(ggufPath)}`);
        return { backend: 'node-llama-cpp', reranker: new LlamaCppReranker(ggufPath) };
      }
      logger.debug(P, 'node-llama-cpp available but no GGUF reranker model found');
    } catch {
      logger.debug(P, 'node-llama-cpp not available');
    }
  }

  // 3. Try Transformers.js (CPU fallback, same dep as embeddings)
  if (forcedBackend === 'auto' || forcedBackend === 'transformers-js' || !forcedBackend) {
    try {
      await import('@huggingface/transformers');
      // Use configured model for transformers-js (only when not a GGUF path)
      const onnxModel =
        config?.rerankerModel && !config.rerankerModel.endsWith('.gguf')
          ? config.rerankerModel
          : undefined;
      const reranker = new TransformersJsReranker(onnxModel);
      logger.info(P, `Using Transformers.js reranker: ${reranker.modelId()}`);
      return { backend: 'transformers-js', reranker };
    } catch {
      logger.debug(P, '@huggingface/transformers not available for reranking');
    }
  }

  // 4. No reranking — graceful degradation
  logger.info(P, 'No reranker backend available — search will use BM25+vectors only');
  return null;
}

/**
 * List HuggingFace models available in the local cache.
 * Scans ~/.cache/huggingface/hub/ (or $HF_HOME/hub/) for model directories.
 * Returns model IDs like "Xenova/ms-marco-MiniLM-L-6-v2".
 */
export function listLocalHuggingFaceModels(): string[] {
  const hubDir = process.env.HF_HOME
    ? path.join(process.env.HF_HOME, 'hub')
    : path.join(os.homedir(), '.cache', 'huggingface', 'hub');

  try {
    if (!fs.existsSync(hubDir)) return [];
    return fs
      .readdirSync(hubDir)
      .filter((d) => d.startsWith('models--'))
      .map((d) => d.replace('models--', '').replace(/--/g, '/'));
  } catch {
    return [];
  }
}
