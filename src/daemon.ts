/**
 * Singleton daemon — shares DB, embedders, reranker, and workers across
 * all Claude Code sessions via a Unix socket.
 *
 * Each incoming connection gets its own lightweight McpServer instance
 * that reuses the shared resources.
 */

import net from 'net';
import fs from 'fs';
import { openDatabase, setStat, getMeta, recreateVecTables, getVecTableDimensions } from './db.js';
import { backfillExistingSessions, detectOrphanedSessions } from './indexer.js';
import { createTextEmbedder, createCodeEmbedder } from './embedder.js';
import { detectRerankerBackend } from './reranker.js';
import { getConfig } from './config.js';
import { EmbedOrchestrator } from './embed-orchestrator.js';
import { SocketTransport } from './socket-transport.js';
import { createServer } from './server.js';
import { initLogger, logger } from './logger.js';
import type { Embedder, Reranker, SearchContext } from './models.js';
import {
  DEFAULT_TEXT_DIMENSIONS,
  DAEMON_DIR,
  DAEMON_SOCKET_PATH,
  DAEMON_PID_PATH,
} from './constants.js';

interface RegisterMessage {
  type: 'register';
  project: string;
  sessionId: string;
}

const P = 'daemon';

function logMemory(label: string): void {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  logger.info(P, `RSS=${rss} MB, heap=${heap} MB — ${label}`);
}

function unlinkSocket(): void {
  // Named pipes on Windows are auto-cleaned — only unlink Unix sockets
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(DAEMON_SOCKET_PATH);
    } catch {
      /* ignore */
    }
  }
}

function cleanStaleDaemon(): void {
  // Check PID file first (works on all platforms)
  if (fs.existsSync(DAEMON_PID_PATH)) {
    const pid = parseInt(fs.readFileSync(DAEMON_PID_PATH, 'utf8'), 10);
    try {
      process.kill(pid, 0); // Check if process is alive
      logger.warn(P, `Daemon already running (pid ${pid})`);
      process.exit(1);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // PID dead — stale socket
        logger.info(P, 'Cleaning stale socket');
        unlinkSocket();
        fs.unlinkSync(DAEMON_PID_PATH);
      } else {
        throw err;
      }
    }
  } else if (process.platform !== 'win32' && fs.existsSync(DAEMON_SOCKET_PATH)) {
    // Orphaned Unix socket (no PID file)
    unlinkSocket();
  }
}

// --- Main entry point ---

// NOTE: don't use import.meta.url check — esbuild bundles server.ts into this file,
// and import.meta.url would match in both (causing server main to also run).
const isMainModule =
  (process.argv[1]?.endsWith('/daemon.js') ||
    process.argv[1]?.endsWith('\\daemon.js') ||
    process.argv[1]?.endsWith('/melchizedek-daemon')) ??
  false;

if (isMainModule) {
  (async () => {
    fs.mkdirSync(DAEMON_DIR, { recursive: true });
    cleanStaleDaemon();

    const cfg = getConfig();
    initLogger({ level: cfg.logLevel });

    const { db, vecEnabled } = openDatabase(cfg.dbPath);
    logMemory('daemon startup');

    // Shared text embedder
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

    // Shared reranker
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

    // Shared orchestrator
    const orch = new EmbedOrchestrator(cfg.dbPath, db);

    // Shared search context (mutated when code embedder loads)
    const searchContext: SearchContext = {
      embedderText,
      embedderCode: null,
      reranker,
      vecTextEnabled: vecEnabled,
      vecCodeEnabled: false,
      autoFuzzyThreshold: cfg.autoFuzzyThreshold,
    };

    // Track active connections for cleanup
    const connections = new Set<net.Socket>();

    // Create Unix socket server
    const socketServer = net.createServer((clientSocket) => {
      connections.add(clientSocket);
      let registered = false;
      let buffer = '';

      clientSocket.on('data', async (chunk: Buffer) => {
        if (registered) return; // After register, SocketTransport handles data

        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return;

        const line = buffer.slice(0, newlineIdx);
        const rest = buffer.slice(newlineIdx + 1);

        try {
          const msg = JSON.parse(line) as RegisterMessage;
          if (msg.type !== 'register') {
            clientSocket.write(
              JSON.stringify({ type: 'error', message: 'Expected register' }) + '\n',
            );
            clientSocket.end();
            return;
          }

          registered = true;
          clientSocket.write(JSON.stringify({ type: 'registered' }) + '\n');

          // Remove our 'data' listener — SocketTransport will take over
          clientSocket.removeAllListeners('data');

          // Create per-connection McpServer with shared resources
          const { server, setEmbeddingInProgress } = createServer(cfg, db, {
            embedderText,
            embedderCode: searchContext.embedderCode,
            reranker,
            vecTextEnabled: vecEnabled,
            vecCodeEnabled: searchContext.vecCodeEnabled,
            currentProject: msg.project,
            orchestrator: orch,
            mode: 'daemon',
          });

          orch.onStatusChange((status) => {
            setEmbeddingInProgress(status.active);
          });

          const transport = new SocketTransport(clientSocket);
          await server.connect(transport);

          // If there was data after the register line, push it back
          if (rest.length > 0) {
            clientSocket.emit('data', Buffer.from(rest));
          }

          clientSocket.on('close', () => {
            connections.delete(clientSocket);
          });
        } catch {
          clientSocket.write(
            JSON.stringify({ type: 'error', message: 'Invalid register message' }) + '\n',
          );
          clientSocket.end();
        }
      });

      clientSocket.on('error', () => {
        connections.delete(clientSocket);
      });

      clientSocket.on('close', () => {
        connections.delete(clientSocket);
      });
    });

    socketServer.listen(DAEMON_SOCKET_PATH, () => {
      fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
      logger.info(P, `Listening on ${DAEMON_SOCKET_PATH} (pid ${process.pid})`);
      logMemory('server ready');
    });

    // Cleanup on shutdown
    let shuttingDown = false;
    const shutdown = (signal?: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(P, `Shutting down${signal ? ` (${signal})` : ''}`);

      orch.abort();
      socketServer.close();

      for (const conn of connections) {
        conn.destroy();
      }
      connections.clear();

      unlinkSocket();
      try {
        fs.unlinkSync(DAEMON_PID_PATH);
      } catch {
        /* ignore */
      }

      setTimeout(() => process.exit(0), 500).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('exit', () => {
      unlinkSocket();
      try {
        fs.unlinkSync(DAEMON_PID_PATH);
      } catch {
        /* ignore */
      }
    });

    // Background tasks: backfill + embedding
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

        // Lazy-load code embedder
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
  })().catch((err) => {
    logger.error(P, 'Fatal error:', err);
    process.exit(1);
  });
}
