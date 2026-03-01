/**
 * Configuration management with sensible defaults.
 * Priority: overrides > env vars > config.json > defaults.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { MelchizedekConfig } from './models.js';
import { DEFAULT_OLLAMA_URL } from './constants.js';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.melchizedek');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memory.db');
const DEFAULT_JSONL_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_MODELS_DIR = path.join(DEFAULT_DB_DIR, 'models');
const CONFIG_FILE_PATH = path.join(DEFAULT_DB_DIR, 'config.json');

export function getConfigFilePath(): string {
  return CONFIG_FILE_PATH;
}

function loadConfigFile(): Partial<MelchizedekConfig> {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
      return JSON.parse(raw) as Partial<MelchizedekConfig>;
    }
  } catch {
    console.error('[melchizedek] Failed to parse config.json — using defaults');
  }
  return {};
}

export function writeConfigFile(partial: Partial<MelchizedekConfig>): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE_PATH), { recursive: true });

  // Merge with existing file content if present
  let existing: Partial<MelchizedekConfig> = {};
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      existing = JSON.parse(
        fs.readFileSync(CONFIG_FILE_PATH, 'utf8'),
      ) as Partial<MelchizedekConfig>;
    }
  } catch {
    // ignore parse error on existing file
  }

  const merged = { ...existing, ...partial };
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(merged, null, 2), 'utf8');
}

export function getConfig(overrides: Partial<MelchizedekConfig> = {}): MelchizedekConfig {
  const file = loadConfigFile();

  // Defaults
  const defaults: MelchizedekConfig = {
    dbPath: DEFAULT_DB_PATH,
    jsonlDir: DEFAULT_JSONL_DIR,
    embeddingsEnabled: true,
    embeddingTextBackend: 'auto',
    embeddingTextModel: null,
    embeddingCodeBackend: 'auto',
    embeddingCodeModel: null,
    embeddingCodeEnabled: true,
    ollamaBaseUrl: DEFAULT_OLLAMA_URL,
    syncPurge: false,
    rerankerEnabled: true,
    rerankerBackend: 'auto',
    rerankerModel: null,
    rerankerModelsDir: DEFAULT_MODELS_DIR,
    rerankerUrl: null,
    autoFuzzyThreshold: 3,
    logLevel: 'warn',
  };

  // Env vars (only set if explicitly defined)
  const env: Partial<MelchizedekConfig> = {};
  if (process.env.M9K_DB_PATH) env.dbPath = process.env.M9K_DB_PATH;
  if (process.env.M9K_JSONL_DIR) env.jsonlDir = process.env.M9K_JSONL_DIR;
  if (process.env.M9K_EMBEDDINGS === 'false') env.embeddingsEnabled = false;
  if (process.env.M9K_EMBEDDING_TEXT_BACKEND)
    env.embeddingTextBackend = process.env
      .M9K_EMBEDDING_TEXT_BACKEND as MelchizedekConfig['embeddingTextBackend'];
  if (process.env.M9K_EMBEDDING_TEXT_MODEL)
    env.embeddingTextModel = process.env.M9K_EMBEDDING_TEXT_MODEL;
  if (process.env.M9K_EMBEDDING_CODE_BACKEND)
    env.embeddingCodeBackend = process.env
      .M9K_EMBEDDING_CODE_BACKEND as MelchizedekConfig['embeddingCodeBackend'];
  if (process.env.M9K_EMBEDDING_CODE_MODEL)
    env.embeddingCodeModel = process.env.M9K_EMBEDDING_CODE_MODEL;
  if (process.env.M9K_EMBEDDING_CODE === 'false') env.embeddingCodeEnabled = false;
  if (process.env.M9K_OLLAMA_BASE_URL) env.ollamaBaseUrl = process.env.M9K_OLLAMA_BASE_URL;
  if (process.env.M9K_SYNC_PURGE === 'true') env.syncPurge = true;
  if (process.env.M9K_RERANKER === 'false') env.rerankerEnabled = false;
  if (process.env.M9K_RERANKER_BACKEND)
    env.rerankerBackend = process.env.M9K_RERANKER_BACKEND as MelchizedekConfig['rerankerBackend'];
  if (process.env.M9K_RERANKER_MODEL) env.rerankerModel = process.env.M9K_RERANKER_MODEL;
  if (process.env.M9K_MODELS_DIR) env.rerankerModelsDir = process.env.M9K_MODELS_DIR;
  if (process.env.M9K_RERANKER_URL) env.rerankerUrl = process.env.M9K_RERANKER_URL;
  if (process.env.M9K_AUTO_FUZZY_THRESHOLD)
    env.autoFuzzyThreshold = parseInt(process.env.M9K_AUTO_FUZZY_THRESHOLD, 10);
  if (process.env.M9K_LOG_LEVEL)
    env.logLevel = process.env.M9K_LOG_LEVEL as MelchizedekConfig['logLevel'];

  // Merge: defaults < config.json < env vars < overrides
  return { ...defaults, ...file, ...env, ...overrides };
}

export function resolveDbPath(config: MelchizedekConfig): string {
  return config.dbPath;
}
