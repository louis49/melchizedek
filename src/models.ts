/**
 * Core types and interfaces for melchizedek.
 */

// --- Session ---

export interface ConvSession {
  id: string;
  project: string;
  jsonlPath: string;
  fileHash: string;
  fileSize: number;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  chunkCount: number;
  indexedAt: string;
}

// --- Chunk ---

export type ConvKind = 'exchange' | 'memory';

export interface ConvChunkMetadata {
  toolCalls: string[];
  filePaths: string[];
  errorMessages: string[];
}

export interface ConvChunk {
  id: string;
  sessionId: string;
  index: number;
  kind: ConvKind;
  userContent: string;
  assistantContent: string;
  hash: string;
  timestamp: string;
  tokenCount: number | null;
  tags: string[] | null;
  metadata: ConvChunkMetadata;
}

// --- Search ---

export type MatchType = 'bm25' | 'vector' | 'vector_text' | 'vector_code' | 'hybrid' | 'fuzzy';

export interface SearchResult {
  chunkId: string;
  snippet: string;
  score: number;
  project: string;
  timestamp: string;
  matchType: MatchType;
  sessionId: string;
}

export type SearchOrder = 'score' | 'date_asc' | 'date_desc';

export interface SearchOptions {
  query: string;
  project?: string;
  currentProject?: string;
  currentSession?: string;
  limit: number;
  since?: string;
  until?: string;
  order?: SearchOrder;
}

// --- Search context ---

export interface SearchContext {
  embedderText: Embedder | null;
  embedderCode: Embedder | null;
  reranker: Reranker | null;
  vecTextEnabled: boolean;
  vecCodeEnabled: boolean;
  autoFuzzyThreshold: number;
}

// --- Embedder ---

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Embed a search query with optional instruction prefix (for asymmetric models like Qwen3). */
  embedQuery?(text: string): Promise<Float32Array>;
  dimensions(): number;
  modelId(): string;
  /** Max safe input chars per text (embedder truncates internally). */
  maxInputChars(): number;
}

// --- Reranker ---

export type RerankerBackend = 'transformers-js' | 'node-llama-cpp' | 'llama-server' | 'none';

export interface RerankerResult {
  id: string;
  score: number;
}

export interface Reranker {
  rerank(
    query: string,
    documents: { id: string; content: string }[],
    topN: number,
  ): Promise<RerankerResult[]>;
  backend(): RerankerBackend;
  modelId(): string;
}

// --- Config ---

export type EmbeddingBackend = 'auto' | 'transformers-js' | 'ollama';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MelchizedekConfig {
  dbPath: string;
  jsonlDir: string;
  embeddingsEnabled: boolean;
  embeddingTextBackend: EmbeddingBackend;
  embeddingTextModel: string | null;
  embeddingCodeBackend: EmbeddingBackend;
  embeddingCodeModel: string | null;
  embeddingCodeEnabled: boolean;
  ollamaBaseUrl: string;
  syncPurge: boolean;
  rerankerEnabled: boolean;
  rerankerBackend: 'auto' | RerankerBackend;
  rerankerModel: string | null;
  rerankerModelsDir: string;
  rerankerUrl: string | null;
  autoFuzzyThreshold: number;
  logLevel: LogLevel;
}

export interface OrphanDetectionResult {
  orphanedCount: number;
  purgedCount: number;
}

// --- JSONL parsing ---

export interface JnlUserMessage {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  message: {
    role: 'user';
    content: string | unknown[];
  };
}

export interface JnlAssistantMessage {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  message: {
    role: 'assistant';
    content: unknown[];
  };
}

export type JnlMessage = JnlUserMessage | JnlAssistantMessage;

// --- Backfill ---

export interface BackfillResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: number;
}

// --- Embed worker IPC ---

export interface WorkerStartMessage {
  type: 'start';
  dbPath: string;
  suffix: '_text' | '_code';
  embedderType: 'text' | 'code';
  config: {
    embeddingBackend: EmbeddingBackend;
    embeddingModel: string | null;
    ollamaBaseUrl: string;
  };
  batchSize: number;
  logLevel?: string;
}

export type WorkerInMessage = WorkerStartMessage;

export type WorkerOutMessage =
  | { type: 'ready'; modelId: string; dimensions: number }
  | { type: 'progress'; embedded: number; total: number }
  | { type: 'done'; embedded: number; durationMs: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'memory'; rssMB: number; heapUsedMB: number };

export interface EmbedJobStatus {
  active: boolean;
  suffix: '_text' | '_code' | null;
  embedded: number;
  total: number;
  pid: number | null;
  rssMB: number | null;
  heapUsedMB: number | null;
}

export interface EmbedJobConfig {
  suffix: '_text' | '_code';
  embedderType: 'text' | 'code';
  config: {
    embeddingBackend: EmbeddingBackend;
    embeddingModel: string | null;
    ollamaBaseUrl: string;
  };
  batchSize?: number;
  logLevel?: string;
}

// --- Hook input ---

export interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
}
