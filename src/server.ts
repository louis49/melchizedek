/**
 * MCP server entry point — tool registration and STDIO transport.
 * Dual-mode: proxy to singleton daemon (preferred) or local standalone.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, setStat, getMeta, recreateVecTables, getVecTableDimensions } from './db.js';
import { backfillExistingSessions, detectOrphanedSessions } from './indexer.js';
import { createTextEmbedder, createCodeEmbedder } from './embedder.js';
import { detectRerankerBackend } from './reranker.js';
import { getConfig } from './config.js';
import { EmbedOrchestrator } from './embed-orchestrator.js';
import { initLogger, logger } from './logger.js';
import type { Embedder, Reranker, MelchizedekConfig, SearchContext } from './models.js';
import type { DatabaseType, DatabaseInfo } from './db.js';
import {
  registerSearchTools,
  registerSpecializedTools,
  registerMemoryTools,
  registerManageTools,
  registerUsageGuide,
} from './tools/index.js';
import type { ToolContext } from './tools/index.js';

import { DEFAULT_TEXT_DIMENSIONS } from './constants.js';
import net from 'net';
import { spawn } from 'child_process';
import path from 'path';
import { DAEMON_SOCKET_PATH } from './constants.js';

// Re-export buildUsageGuide for backward compatibility (used by session-start hook)
export { buildUsageGuide } from './tools/index.js';

const P = 'server';

function logMemory(label: string): void {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  logger.info(P, `RSS=${rss} MB, heap=${heap} MB — ${label}`);
}

export function createServer(
  config?: Partial<MelchizedekConfig>,
  existingDb?: DatabaseType,
  options?: {
    embedderText?: Embedder | null;
    embedderCode?: Embedder | null;
    reranker?: Reranker | null;
    vecTextEnabled?: boolean;
    vecCodeEnabled?: boolean;
    currentProject?: string;
    orchestrator?: EmbedOrchestrator | null;
    mode?: 'daemon' | 'local';
  },
): {
  server: McpServer;
  db: DatabaseType;
  config: MelchizedekConfig;
  searchContext: SearchContext;
  setEmbeddingInProgress: (v: boolean) => void;
} {
  const cfg = getConfig(config);

  let db: DatabaseType;
  let vecTextEnabled: boolean;
  let vecCodeEnabled: boolean;

  if (existingDb) {
    db = existingDb;
    vecTextEnabled = options?.vecTextEnabled ?? false;
    vecCodeEnabled = options?.vecCodeEnabled ?? false;
  } else {
    const info: DatabaseInfo = openDatabase(cfg.dbPath);
    db = info.db;
    vecTextEnabled = info.vecEnabled;
    vecCodeEnabled = false;
  }

  const VERSION = '1.0.0';
  const embedderText = options?.embedderText ?? null;
  const embedderCode = options?.embedderCode ?? null;
  const reranker = options?.reranker ?? null;
  const currentProject = options?.currentProject;
  let embeddingInProgress = false;
  const orchestrator = options?.orchestrator ?? null;

  const searchContext: SearchContext = {
    embedderText,
    embedderCode,
    reranker,
    vecTextEnabled,
    vecCodeEnabled,
    autoFuzzyThreshold: cfg.autoFuzzyThreshold,
  };

  const server = new McpServer({
    name: 'melchizedek',
    version: VERSION,
  });

  const ctx: ToolContext = {
    db,
    cfg,
    searchContext,
    currentProject,
    orchestrator,
    embeddingState: {
      get: () => embeddingInProgress,
      set: (v: boolean) => {
        embeddingInProgress = v;
      },
    },
    version: VERSION,
    mode: options?.mode ?? 'local',
  };

  registerSearchTools(server, ctx);
  registerSpecializedTools(server, ctx);
  registerMemoryTools(server, ctx);
  registerManageTools(server, ctx);
  registerUsageGuide(server, ctx);

  return {
    server,
    db,
    config: cfg,
    searchContext,
    setEmbeddingInProgress: (v: boolean) => {
      embeddingInProgress = v;
    },
  };
}

// --- Daemon proxy helpers ---

function tryConnectDaemon(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(DAEMON_SOCKET_PATH);
    sock.once('connect', () => resolve(sock));
    sock.once('error', (err) => reject(err));
  });
}

function spawnDaemon(): void {
  const daemonPath = path.join(import.meta.dirname, 'daemon.js');
  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit'], // stderr visible for debug
  });
  child.unref();
}

async function waitForSocket(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const sock = net.createConnection(DAEMON_SOCKET_PATH);
      await new Promise<void>((resolve, reject) => {
        sock.once('connect', () => {
          sock.destroy();
          resolve();
        });
        sock.once('error', reject);
      });
      return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon startup timeout');
}

async function runProxyMode(sock: net.Socket): Promise<void> {
  // Send register message
  const registerMsg = JSON.stringify({
    type: 'register',
    project: process.cwd(),
    sessionId: process.env.SESSION_ID ?? 'unknown',
  });
  sock.write(registerMsg + '\n');

  // Wait for registered response
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      const rest = buf.slice(idx + 1);
      sock.removeListener('data', onData);

      try {
        const resp = JSON.parse(line) as { type: string };
        if (resp.type !== 'registered') {
          reject(new Error(`Unexpected daemon response: ${resp.type}`));
          return;
        }
        // Push back any data that came after the registered line
        if (rest.length > 0) {
          process.stdout.write(rest);
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });

  // Pure byte-level pipe: stdin → socket, socket → stdout
  process.stdin.pipe(sock, { end: false });
  sock.pipe(process.stdout, { end: false });

  sock.on('end', () => process.exit(0));
  sock.on('error', () => process.exit(1));
  process.stdin.on('end', () => sock.end());

  logger.info(P, 'Proxy mode — connected to daemon');
}

// --- Local mode (standalone, backward-compatible) ---

async function runLocalMode(): Promise<void> {
  const cfg = getConfig();
  initLogger({ level: cfg.logLevel });

  const { db, vecEnabled } = openDatabase(cfg.dbPath);
  logMemory('server startup (local mode)');

  // Init text embedder for query-time search only (~100 Mo)
  let embedderText: Embedder | null = null;
  if (cfg.embeddingsEnabled) {
    embedderText = await createTextEmbedder({
      embeddingBackend: cfg.embeddingTextBackend,
      embeddingModel: cfg.embeddingTextModel,
      ollamaBaseUrl: cfg.ollamaBaseUrl,
    });
    if (embedderText) {
      logMemory('after text embedder load');
      logger.info(
        P,
        `Text embedder initialized (${embedderText.modelId()}, ${embedderText.dimensions()}d)`,
      );

      if (vecEnabled) {
        const tableDims = getVecTableDimensions(db, '_text');
        const metaDims = getMeta(db, 'embedding_dimensions_text');
        const expectedDims = embedderText.dimensions();
        if (tableDims && tableDims !== expectedDims) {
          logger.warn(
            P,
            `Vec table dimension mismatch (table=${tableDims} vs embedder=${expectedDims}d) — recreating`,
          );
          recreateVecTables(db, expectedDims);
        } else if (metaDims && parseInt(metaDims, 10) !== expectedDims) {
          logger.warn(
            P,
            `Vec meta dimension mismatch (meta=${metaDims} vs embedder=${expectedDims}d) — recreating`,
          );
          recreateVecTables(db, expectedDims);
        } else if (!tableDims && !metaDims && expectedDims !== DEFAULT_TEXT_DIMENSIONS) {
          logger.info(P, `Recreating vec tables for ${expectedDims}d embeddings`);
          recreateVecTables(db, expectedDims);
        }
      }
    } else {
      logger.info(P, 'Text embedder not available — BM25 only');
    }
  }

  let reranker: Reranker | null = null;
  if (cfg.rerankerEnabled) {
    const detected = await detectRerankerBackend(cfg);
    if (detected) {
      reranker = detected.reranker;
      logMemory('after reranker load');
      logger.info(P, `Reranker initialized (${detected.backend})`);
    } else {
      logger.info(P, 'Reranker not available — search without reranking');
    }
  }

  const orch = new EmbedOrchestrator(cfg.dbPath, db);

  const { server, searchContext, setEmbeddingInProgress } = createServer(cfg, db, {
    embedderText,
    embedderCode: null,
    reranker,
    vecTextEnabled: vecEnabled,
    vecCodeEnabled: false,
    currentProject: process.cwd(),
    orchestrator: orch,
  });

  orch.onStatusChange((status) => {
    setEmbeddingInProgress(status.active);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const cleanup = (signal?: string) => {
    orch.abort();
    if (signal && !shuttingDown) {
      shuttingDown = true;
      setTimeout(() => process.exit(0), 500).unref();
    }
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('exit', () => cleanup());

  setImmediate(async () => {
    try {
      const result = backfillExistingSessions(db, cfg.jsonlDir);
      logger.info(
        P,
        `Backfill complete: ${result.scanned} scanned, ${result.indexed} indexed, ${result.skipped} skipped, ${result.errors} errors`,
      );
      logMemory('after backfill');

      const orphanResult = detectOrphanedSessions(db, cfg.syncPurge);
      setStat(db, 'orphaned_sessions', String(orphanResult.orphanedCount));
      if (orphanResult.orphanedCount > 0) {
        logger.warn(
          P,
          `Orphaned sessions: ${orphanResult.orphanedCount} detected, ${orphanResult.purgedCount} purged`,
        );
      }

      await orch.runAllJobs({
        textEnabled: !!embedderText && vecEnabled,
        codeEnabled: cfg.embeddingsEnabled && cfg.embeddingCodeEnabled && vecEnabled,
        logLevel: cfg.logLevel,
        config: {
          embeddingTextBackend: cfg.embeddingTextBackend,
          embeddingTextModel: cfg.embeddingTextModel,
          embeddingCodeBackend: cfg.embeddingCodeBackend,
          embeddingCodeModel: cfg.embeddingCodeModel,
          ollamaBaseUrl: cfg.ollamaBaseUrl,
        },
      });

      if (cfg.embeddingsEnabled && cfg.embeddingCodeEnabled && vecEnabled) {
        const codeEmb = await createCodeEmbedder({
          embeddingBackend: cfg.embeddingCodeBackend,
          embeddingModel: cfg.embeddingCodeModel,
          ollamaBaseUrl: cfg.ollamaBaseUrl,
        });
        if (codeEmb) {
          searchContext.embedderCode = codeEmb;
          searchContext.vecCodeEnabled = true;
          logMemory('after code embedder load');
          logger.info(
            P,
            `Code vector search enabled (${codeEmb.modelId()}, ${codeEmb.dimensions()}d)`,
          );
        }
      }
    } catch (err) {
      logger.error(P, 'Background task error:', err);
    }
  });
}

// --- Main entry point (only when run directly, not imported) ---

// NOTE: don't use import.meta.url check — esbuild bundles this into daemon.js too,
// and import.meta.url would match there (causing server main to run inside daemon).
const isMainModule =
  (process.argv[1]?.endsWith('/server.js') || process.argv[1]?.endsWith('\\server.js')) ?? false;

if (isMainModule) {
  const noDaemon = process.env.M9K_NO_DAEMON === '1' || process.argv.includes('--no-daemon');

  (async () => {
    if (noDaemon) {
      logger.info(P, 'Daemon disabled — running in local mode');
      await runLocalMode();
      return;
    }

    // Phase 1: Try connecting to existing daemon
    try {
      const sock = await tryConnectDaemon();
      await runProxyMode(sock);
      return;
    } catch {
      // Daemon not running — continue to phase 2
    }

    // Phase 2: Auto-start daemon, then connect
    try {
      logger.info(P, 'Starting daemon...');
      spawnDaemon();
      await waitForSocket();
      const sock = await tryConnectDaemon();
      await runProxyMode(sock);
      return;
    } catch (err) {
      logger.warn(P, `Daemon unavailable: ${err instanceof Error ? err.message : err}`);
    }

    // Phase 3: Fallback to local mode
    logger.info(P, 'Falling back to local mode');
    await runLocalMode();
  })().catch((err) => {
    logger.error(P, 'Fatal error:', err);
    process.exit(1);
  });
}
