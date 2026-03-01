/**
 * Centralized constants — model IDs, dimensions, URLs, timeouts.
 * Extracted from across the codebase for maintainability (v0.8.3).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

// --- Embedding model registry ---

export type PoolingStrategy = 'mean' | 'cls' | 'last_token';

export interface ModelSpec {
  /** HuggingFace model ID (e.g. 'onnx-community/Qwen3-Embedding-0.6B-ONNX') */
  hfModelId: string;
  /** Stable key used in DB meta, migration detection, etc. */
  key: string;
  /** Output dimensions */
  dimensions: number;
  /** Pooling strategy passed to Transformers.js pipeline */
  pooling: PoolingStrategy;
  /** Max safe input chars (text is truncated beyond this) */
  maxInputChars: number;
  /** Instruction prefix for asymmetric models (e.g. Qwen3) — prepended to queries */
  queryPrefix?: string;
  /** Preferred dtype in order of attempt — first success wins */
  dtypePreference: Array<'q8' | 'fp16' | 'fp32'>;
}

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  // --- Multilingual text ---
  'minilm-l12-v2': {
    hfModelId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    key: 'minilm-l12-v2',
    dimensions: 384,
    pooling: 'mean',
    maxInputChars: 2_000, // 512 tokens × ~4 chars/token
    dtypePreference: ['q8', 'fp32'],
  },
  'minilm-l6-v2': {
    hfModelId: 'Xenova/all-MiniLM-L6-v2',
    key: 'minilm-l6-v2',
    dimensions: 384,
    pooling: 'mean',
    maxInputChars: 1_000, // 256 tokens
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'multilingual-e5-small': {
    hfModelId: 'Xenova/multilingual-e5-small',
    key: 'multilingual-e5-small',
    dimensions: 384,
    pooling: 'mean',
    maxInputChars: 2_000, // 512 tokens
    queryPrefix: 'query: ',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'bge-small-en-v1.5': {
    hfModelId: 'Xenova/bge-small-en-v1.5',
    key: 'bge-small-en-v1.5',
    dimensions: 384,
    pooling: 'cls',
    maxInputChars: 2_000, // 512 tokens
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'bge-base-en-v1.5': {
    hfModelId: 'Xenova/bge-base-en-v1.5',
    key: 'bge-base-en-v1.5',
    dimensions: 768,
    pooling: 'cls',
    maxInputChars: 2_000, // 512 tokens
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'bge-m3': {
    hfModelId: 'Xenova/bge-m3',
    key: 'bge-m3',
    dimensions: 1024,
    pooling: 'cls',
    maxInputChars: 32_000, // 8192 tokens
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'nomic-embed-text-v1.5': {
    hfModelId: 'nomic-ai/nomic-embed-text-v1.5',
    key: 'nomic-embed-text-v1.5',
    dimensions: 768,
    pooling: 'mean',
    maxInputChars: 32_000, // 8192 tokens
    queryPrefix: 'search_query: ',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'mxbai-embed-xsmall-v1': {
    hfModelId: 'mixedbread-ai/mxbai-embed-xsmall-v1',
    key: 'mxbai-embed-xsmall-v1',
    dimensions: 384,
    pooling: 'cls',
    maxInputChars: 16_000, // 4096 tokens
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'mxbai-embed-large-v1': {
    hfModelId: 'mixedbread-ai/mxbai-embed-large-v1',
    key: 'mxbai-embed-large-v1',
    dimensions: 1024,
    pooling: 'cls',
    maxInputChars: 2_000, // 512 tokens
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'snowflake-arctic-embed-m-v2': {
    hfModelId: 'Snowflake/snowflake-arctic-embed-m-v2.0',
    key: 'snowflake-arctic-embed-m-v2',
    dimensions: 768,
    pooling: 'cls',
    maxInputChars: 32_000, // 8192 tokens
    queryPrefix: 'query: ',
    dtypePreference: ['q8', 'fp32'],
  },
  'snowflake-arctic-embed-l-v2': {
    hfModelId: 'Snowflake/snowflake-arctic-embed-l-v2.0',
    key: 'snowflake-arctic-embed-l-v2',
    dimensions: 1024,
    pooling: 'cls',
    maxInputChars: 32_000, // 8192 tokens
    queryPrefix: 'query: ',
    dtypePreference: ['q8', 'fp32'],
  },
  'gte-small': {
    hfModelId: 'Xenova/gte-small',
    key: 'gte-small',
    dimensions: 384,
    pooling: 'mean',
    maxInputChars: 2_000, // 512 tokens
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  'gte-multilingual-base': {
    hfModelId: 'onnx-community/gte-multilingual-base',
    key: 'gte-multilingual-base',
    dimensions: 768,
    pooling: 'cls',
    maxInputChars: 32_000, // 8192 tokens
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
  // --- Code ---
  'jina-code-v2': {
    hfModelId: 'jinaai/jina-embeddings-v2-base-code',
    key: 'jina-code-v2',
    dimensions: 768,
    pooling: 'mean',
    maxInputChars: 8_000, // 8192 tokens, code ~1 char/token
    dtypePreference: ['q8', 'fp32'],
  },
  'jina-v2-small-en': {
    hfModelId: 'Xenova/jina-embeddings-v2-small-en',
    key: 'jina-v2-small-en',
    dimensions: 512,
    pooling: 'mean',
    maxInputChars: 8_000, // 8192 tokens
    dtypePreference: ['q8', 'fp32'],
  },
  // --- Instruction-tuned / large ---
  'qwen3-embedding-0.6b': {
    hfModelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    key: 'qwen3-embedding-0.6b',
    dimensions: 1024,
    pooling: 'last_token',
    maxInputChars: 32_000, // 8192 tokens
    queryPrefix: 'Instruct: Given a search query, retrieve relevant conversation excerpts\nQuery:',
    dtypePreference: ['q8', 'fp16', 'fp32'],
  },
};

/**
 * Resolve a model key to a ModelSpec. Resolution order:
 * 1. MODEL_REGISTRY by key
 * 2. MODEL_REGISTRY by hfModelId
 * 3. Transformers.js cache (config.json → hidden_size, pooling, etc.)
 * 4. createDynamicSpec fallback (mean pooling, dimensions probed at runtime)
 */
export function lookupModelSpec(keyOrHfId: string): ModelSpec | null {
  if (!keyOrHfId) return null;
  // 1. Direct key match
  if (MODEL_REGISTRY[keyOrHfId]) return MODEL_REGISTRY[keyOrHfId];
  // 2. Match by hfModelId
  for (const spec of Object.values(MODEL_REGISTRY)) {
    if (spec.hfModelId === keyOrHfId) return spec;
  }
  // 3. Try reading metadata from Transformers.js cache
  const cached = probeModelSpecFromCache(keyOrHfId);
  if (cached) return cached;
  // 4. Fallback — sensible defaults, dimensions probed at runtime
  return createDynamicSpec(keyOrHfId);
}

/**
 * Create a ModelSpec for a model not in the registry.
 * Uses sensible defaults: mean pooling, q8→fp32, dimensions=0 (probed at load time).
 */
export function createDynamicSpec(hfModelId: string): ModelSpec {
  // Derive a stable key from the HF model ID: 'org/model-name' → 'model-name'
  const key = hfModelId.includes('/') ? hfModelId.split('/').pop()!.toLowerCase() : hfModelId;
  return {
    hfModelId,
    key,
    dimensions: 0, // Probed after first embed
    pooling: 'mean',
    maxInputChars: 2_000,
    dtypePreference: ['q8', 'fp16', 'fp32'],
  };
}

// --- Pooling detection from HuggingFace config.json ---

/**
 * Known architecture → pooling mapping for models not in the registry.
 * Only decoder-based / causal LM models need explicit hints (last_token pooling).
 * Encoder models (BertModel, XLMRobertaModel, etc.) default to 'mean' — correct
 * for most but not all (BGE/MxBAI use CLS). For those, the registry is authoritative.
 */
const ARCHITECTURE_POOLING_HINTS: Record<string, PoolingStrategy> = {
  // Decoder-based models use last_token pooling
  Qwen2ForCausalLM: 'last_token',
  Qwen2Model: 'last_token',
  Qwen3ForCausalLM: 'last_token',
  LlamaModel: 'last_token',
  LlamaForCausalLM: 'last_token',
  MistralModel: 'last_token',
  MistralForCausalLM: 'last_token',
  GemmaModel: 'last_token',
  Gemma2Model: 'last_token',
};

interface HfConfigJson {
  hidden_size?: number;
  max_position_embeddings?: number;
  model_max_length?: number;
  emb_pooler?: string;
  architectures?: string[];
}

interface HfTokenizerConfigJson {
  model_max_length?: number;
}

/**
 * Try to build a ModelSpec from Transformers.js cache files.
 * Reads config.json + tokenizer_config.json from the local cache.
 * Returns null if the model isn't cached yet.
 */
export function probeModelSpecFromCache(hfModelId: string): ModelSpec | null {
  const cacheDirs = getTransformersJsCacheDirs();

  for (const cacheDir of cacheDirs) {
    const modelDir = path.join(cacheDir, hfModelId);
    const configPath = path.join(modelDir, 'config.json');

    if (!fs.existsSync(configPath)) continue;

    try {
      const config: HfConfigJson = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Extract dimensions from hidden_size
      const dimensions = config.hidden_size ?? 0;

      // Extract max input chars from various sources
      let maxTokens = config.max_position_embeddings ?? config.model_max_length ?? 512;

      // Check tokenizer_config.json for model_max_length (more authoritative)
      const tokConfigPath = path.join(modelDir, 'tokenizer_config.json');
      if (fs.existsSync(tokConfigPath)) {
        try {
          const tokConfig: HfTokenizerConfigJson = JSON.parse(
            fs.readFileSync(tokConfigPath, 'utf8'),
          );
          if (tokConfig.model_max_length && tokConfig.model_max_length < 1_000_000) {
            maxTokens = tokConfig.model_max_length;
          }
        } catch {
          // Ignore tokenizer config parse errors
        }
      }

      // ~4 chars/token for typical text
      const maxInputChars = Math.min(maxTokens * 4, 128_000);

      // Detect pooling
      let pooling: PoolingStrategy = 'mean'; // Default for most models
      if (config.emb_pooler === 'mean' || config.emb_pooler === 'cls') {
        pooling = config.emb_pooler;
      } else if (config.architectures?.length) {
        // Check architecture hints for decoder-based models
        for (const arch of config.architectures) {
          if (ARCHITECTURE_POOLING_HINTS[arch]) {
            pooling = ARCHITECTURE_POOLING_HINTS[arch];
            break;
          }
        }
      }

      const key = hfModelId.includes('/') ? hfModelId.split('/').pop()!.toLowerCase() : hfModelId;

      return {
        hfModelId,
        key,
        dimensions,
        pooling,
        maxInputChars,
        dtypePreference: ['q8', 'fp16', 'fp32'],
      };
    } catch {
      // Parse error — skip this cache dir
    }
  }

  return null;
}

/** Get possible Transformers.js cache directories (in priority order). */
function getTransformersJsCacheDirs(): string[] {
  const dirs: string[] = [];

  // 1. Default Transformers.js cache: node_modules/@huggingface/transformers/.cache/
  // Note: can't resolve 'package.json' directly — not exported in their package.json "exports".
  // Instead resolve the main entry point and walk up to the package root.
  try {
    const esmRequire = createRequire(import.meta.url);
    const tjsMain = esmRequire.resolve('@huggingface/transformers');
    let dir = path.dirname(tjsMain);
    while (dir !== path.dirname(dir)) {
      if (path.basename(dir) === 'transformers' && dir.includes('node_modules')) {
        dirs.push(path.join(dir, '.cache'));
        break;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Package not installed
  }

  // 2. HuggingFace hub cache: $HF_HOME/hub/ or ~/.cache/huggingface/hub/
  // (Transformers.js doesn't use this by default, but users can override env.cacheDir)
  const hfHome = process.env.HF_HOME ?? path.join(os.homedir(), '.cache', 'huggingface');
  dirs.push(path.join(hfHome, 'hub'));

  return dirs;
}

export const DEFAULT_TEXT_MODEL_KEY = 'minilm-l12-v2';
export const DEFAULT_CODE_MODEL_KEY = 'jina-code-v2';

// --- Legacy aliases (backward compat) ---
export const DEFAULT_TEXT_MODEL_ID = MODEL_REGISTRY[DEFAULT_TEXT_MODEL_KEY].hfModelId;
export const DEFAULT_TEXT_DIMENSIONS = MODEL_REGISTRY[DEFAULT_TEXT_MODEL_KEY].dimensions;
export const DEFAULT_CODE_MODEL_ID = MODEL_REGISTRY[DEFAULT_CODE_MODEL_KEY].hfModelId;
export const DEFAULT_CODE_DIMENSIONS = MODEL_REGISTRY[DEFAULT_CODE_MODEL_KEY].dimensions;
export const EMBEDDING_PIPELINE_TASK = 'feature-extraction' as const;

// --- Ollama ---
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_TEXT_MODEL = 'nomic-embed-text';
export const DEFAULT_OLLAMA_CODE_MODEL = 'nomic-embed-text';

// --- Reranker ---
export const DEFAULT_RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const GGUF_RERANKER_PATTERNS = [
  { pattern: /bge-reranker/i, priority: 1 },
  { pattern: /qwen.*reranker|reranker.*qwen/i, priority: 2 },
] as const;

// --- Search ---
export const RRF_K = 60;

// --- Conversation chunk kinds ---
export const CONV_KIND_EXCHANGE = 'exchange' as const;
export const CONV_KIND_MEMORY = 'memory' as const;

// --- Timeouts ---
export const EMBED_ORCHESTRATOR_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

// --- Daemon ---
export const DAEMON_DIR = path.join(os.homedir(), '.melchizedek');
// Windows: named pipes (\\.\pipe\), Unix: socket file
export const DAEMON_SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\melchizedek-daemon'
    : path.join(DAEMON_DIR, 'daemon.sock');
export const DAEMON_PID_PATH = path.join(DAEMON_DIR, 'daemon.pid');
