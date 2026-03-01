/**
 * Memory and config tools: m9k_save, m9k_sessions, m9k_info, m9k_config.
 */

import { z } from 'zod';
import crypto from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  getStat,
  getMeta,
  countEligibleChunks,
  countEmbeddedChunks,
  getIgnoredProjects,
} from '../db.js';
import { detectRerankerBackend } from '../reranker.js';
import { writeConfigFile } from '../config.js';
import type { MelchizedekConfig, EmbedJobStatus } from '../models.js';
import type { ToolContext } from './context.js';
import { CONV_KIND_MEMORY } from '../constants.js';

// Valid config keys that can be updated via m9k_config
const CONFIGURABLE_KEYS = new Set([
  'embeddingsEnabled',
  'embeddingTextBackend',
  'embeddingTextModel',
  'embeddingCodeBackend',
  'embeddingCodeModel',
  'embeddingCodeEnabled',
  'ollamaBaseUrl',
  'syncPurge',
  'rerankerEnabled',
  'rerankerBackend',
  'rerankerModel',
  'rerankerUrl',
  'autoFuzzyThreshold',
  'logLevel',
]);

// Keys that trigger a hot-reload of the reranker when changed
const RERANKER_HOT_RELOAD_KEYS = new Set(['rerankerBackend', 'rerankerUrl']);

// Keys that require a server restart to take effect
const RESTART_REQUIRED_KEYS = new Set([
  'embeddingTextBackend',
  'embeddingTextModel',
  'embeddingCodeBackend',
  'embeddingCodeModel',
]);

export function registerMemoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'm9k_save',
    {
      description:
        'Manually save a memory note for future recall. Use for important decisions, patterns, or context.',
      inputSchema: {
        content: z.string().describe('The memory content to save'),
        tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ content, tags }) => {
      const MANUAL_SESSION_ID = '__manual_memories__';

      // Ensure the manual memories session exists
      const existingSession = ctx.db
        .prepare('SELECT id FROM conv_sessions WHERE id = ?')
        .get(MANUAL_SESSION_ID) as { id: string } | undefined;

      if (!existingSession) {
        ctx.db
          .prepare(
            `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
           VALUES (?, ?, ?, ?, ?, datetime('now'), 0, 0)`,
          )
          .run(MANUAL_SESSION_ID, '__global__', '__manual__', '', 0);
      }

      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const chunkId = `mem:${hash.slice(0, 12)}`;
      const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;

      // INSERT OR IGNORE for dedup by hash
      const result = ctx.db
        .prepare(
          `INSERT OR IGNORE INTO conv_chunks (id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, token_count, tags, metadata_json)
         VALUES (?, ?, 0, ?, ?, '', ?, datetime('now'), ?, ?, '{}')`,
        )
        .run(
          chunkId,
          MANUAL_SESSION_ID,
          CONV_KIND_MEMORY,
          content,
          hash,
          Math.ceil(content.length / 4),
          tagsJson,
        );

      // Update session chunk count
      ctx.db
        .prepare(
          `UPDATE conv_sessions SET chunk_count = (SELECT COUNT(*) FROM conv_chunks WHERE session_id = ?) WHERE id = ?`,
        )
        .run(MANUAL_SESSION_ID, MANUAL_SESSION_ID);

      const saved = result.changes > 0;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ saved, chunkId, duplicate: !saved }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_sessions',
    {
      description: 'List all indexed sessions, optionally filtered by project.',
      inputSchema: {
        project: z.string().optional().describe('Filter by project path'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max sessions'),
        source: z
          .enum(['conversations', 'git', 'files'])
          .optional()
          .describe('Filter by source type. Default: all sources.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, limit }) => {
      let sql = 'SELECT * FROM conv_sessions WHERE deleted_at IS NULL';
      const params: unknown[] = [];
      if (project) {
        sql += ' AND project = ?';
        params.push(project);
      }
      sql += ' ORDER BY started_at DESC LIMIT ?';
      params.push(limit);
      const rows = ctx.db.prepare(sql).all(...params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
      };
    },
  );

  server.registerTool(
    'm9k_info',
    {
      description:
        'Show memory index information: corpus size, search pipeline status, usage metrics, embedding worker state.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sessions = (
        ctx.db
          .prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE deleted_at IS NULL')
          .get() as {
          cnt: number;
        }
      ).cnt;
      const chunks = (
        ctx.db
          .prepare('SELECT COUNT(*) AS cnt FROM conv_chunks WHERE deleted_at IS NULL')
          .get() as {
          cnt: number;
        }
      ).cnt;
      const projects = (
        ctx.db
          .prepare(
            'SELECT COUNT(DISTINCT project) AS cnt FROM conv_sessions WHERE deleted_at IS NULL',
          )
          .get() as { cnt: number }
      ).cnt;

      const oldestSession = (
        ctx.db
          .prepare('SELECT MIN(started_at) AS ts FROM conv_sessions WHERE deleted_at IS NULL')
          .get() as { ts: string | null }
      ).ts;
      const newestSession = (
        ctx.db
          .prepare('SELECT MAX(started_at) AS ts FROM conv_sessions WHERE deleted_at IS NULL')
          .get() as { ts: string | null }
      ).ts;

      // Build span string from oldest/newest dates
      const formatDate = (iso: string | null): string | null => {
        if (!iso) return null;
        return iso.slice(0, 10); // "2026-02-28T..." → "2026-02-28"
      };
      const oldest = formatDate(oldestSession);
      const newest = formatDate(newestSession);
      const span = oldest && newest ? `${oldest} → ${newest}` : null;

      const eligibleChunks = countEligibleChunks(ctx.db);
      let embeddedChunksText = 0;
      let embeddedChunksCode = 0;
      try {
        embeddedChunksText = countEmbeddedChunks(ctx.db, '_text');
      } catch {
        // vec table may not exist yet
      }
      try {
        embeddedChunksCode = countEmbeddedChunks(ctx.db, '_code');
      } catch {
        // vec table may not exist yet
      }

      const ignoredProjects = getIgnoredProjects(ctx.db).length;
      const orphanedSessions = parseInt(getStat(ctx.db, 'orphaned_sessions') ?? '0', 10);

      const searchCount = parseInt(getStat(ctx.db, 'search_count') ?? '0', 10);
      const hitCount = parseInt(getStat(ctx.db, 'hit_count') ?? '0', 10);
      const tokensServed = parseInt(getStat(ctx.db, 'tokens_served') ?? '0', 10);
      const lastSearchAt = getStat(ctx.db, 'last_search_at');

      // --- Search lines: one readable string per embedder ---
      const embeddingModelIdText = getMeta(ctx.db, 'embedding_model_id_text');
      const embeddingDimensionsText = parseInt(
        getMeta(ctx.db, 'embedding_dimensions_text') ?? '0',
        10,
      );
      const embeddingModelIdCode = getMeta(ctx.db, 'embedding_model_id_code');
      const embeddingDimensionsCode = parseInt(
        getMeta(ctx.db, 'embedding_dimensions_code') ?? '0',
        10,
      );

      const buildSearchLine = (
        modelId: string | null,
        dims: number,
        embedded: number,
        eligible: number,
      ): string => {
        if (!modelId) return 'disabled';
        const pct = eligible > 0 ? Math.round((embedded / eligible) * 100) : 0;
        return `${modelId} (${dims}d) — ${embedded}/${eligible} (${pct}%)`;
      };

      const textLine = buildSearchLine(
        embeddingModelIdText,
        embeddingDimensionsText,
        embeddedChunksText,
        eligibleChunks,
      );
      const codeLine = buildSearchLine(
        embeddingModelIdCode,
        embeddingDimensionsCode,
        embeddedChunksCode,
        eligibleChunks,
      );

      // Reranker line
      const rerankerLine = ctx.searchContext.reranker
        ? `${ctx.searchContext.reranker.backend()} (${ctx.searchContext.reranker.modelId()})`
        : 'none';

      // --- Activity: merge worker + migration into one block ---
      const workerStatus: EmbedJobStatus = ctx.orchestrator?.getStatus() ?? {
        active: false,
        suffix: null,
        embedded: 0,
        total: 0,
        pid: null,
        rssMB: null,
        heapUsedMB: null,
      };

      const hasMigrationText = !!getMeta(ctx.db, 'migration_target_model_text');
      const hasMigrationCode = !!getMeta(ctx.db, 'migration_target_model_code');

      let activity: {
        type: string;
        target: string | null;
        progress: string;
        pid: number | null;
        rssMB: number | null;
        heapUsedMB: number | null;
        stuckSince?: string | null;
      } | null = null;

      const buildProgressString = (embedded: number, total: number): string => {
        const pct = total > 0 ? Math.round((embedded / total) * 100) : 0;
        return `${embedded}/${total} (${pct}%)`;
      };

      if (workerStatus.active) {
        // Check if current worker suffix matches a migration
        const suffix = workerStatus.suffix ?? '_text';
        const isMigration =
          (suffix === '_text' && hasMigrationText) || (suffix === '_code' && hasMigrationCode);

        let embedded = workerStatus.embedded;
        let total = workerStatus.total;

        // Worker may not have reported total yet — fall back to migration meta / eligible chunks
        if (isMigration && total === 0) {
          embedded = parseInt(getMeta(ctx.db, `migration_progress${suffix}`) ?? '0', 10);
          total = eligibleChunks;
        }

        activity = {
          type: isMigration ? 'migration' : 'backfill',
          target: workerStatus.suffix,
          progress: buildProgressString(embedded, total),
          pid: workerStatus.pid,
          rssMB: workerStatus.rssMB,
          heapUsedMB: workerStatus.heapUsedMB,
        };
      } else if (hasMigrationText || hasMigrationCode) {
        // Migration meta exists but no worker — stuck
        const suffix = hasMigrationText ? '_text' : '_code';
        const stuckSince = getMeta(ctx.db, `migration_started_at${suffix}`);
        const migrationProgress = parseInt(
          getMeta(ctx.db, `migration_progress${suffix}`) ?? '0',
          10,
        );
        activity = {
          type: 'stuck-migration',
          target: suffix,
          progress: buildProgressString(migrationProgress, eligibleChunks),
          pid: null,
          rssMB: null,
          heapUsedMB: null,
          stuckSince,
        };
      }

      // --- Status emoji ---
      let status: string;
      if (!ctx.cfg.embeddingsEnabled) {
        status = '\u{1F7E2} bm25-only';
      } else if (workerStatus.active) {
        status = '\u{1F535} embedding';
      } else if (activity?.type === 'stuck-migration') {
        status = '\u{1F7E0} degraded';
      } else {
        status = '\u{1F7E2} healthy';
      }

      // --- Uptime ---
      const uptimeSec = Math.round(process.uptime());
      let uptime: string;
      if (uptimeSec < 60) {
        uptime = `${uptimeSec}s`;
      } else if (uptimeSec < 3600) {
        uptime = `${Math.floor(uptimeSec / 60)}m`;
      } else {
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        uptime = m > 0 ? `${h}h${m}m` : `${h}h`;
      }

      // --- Process ---
      const mem = process.memoryUsage();
      const processInfo = {
        pid: process.pid,
        rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        uptimeSeconds: uptimeSec,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status,
              mode: ctx.mode,
              logLevel: ctx.cfg.logLevel,
              uptime,
              corpus: {
                sessions,
                chunks,
                projects,
                ignoredProjects,
                orphanedSessions,
                span,
              },
              search: {
                bm25: 'active',
                text: textLine,
                code: codeLine,
                reranker: rerankerLine,
              },
              activity,
              usage: {
                searches: searchCount,
                hits: hitCount,
                tokensServed,
                lastSearch: lastSearchAt,
              },
              process: processInfo,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_config',
    {
      description:
        'View or update plugin configuration. Changes are saved to ~/.melchizedek/config.json and take effect on next server restart. Without arguments, returns current config.',
      inputSchema: {
        key: z.string().optional().describe("Config key to update (e.g. 'rerankerEnabled')"),
        value: z
          .string()
          .optional()
          .describe("New value (JSON-encoded: 'false', '15', '\"node-llama-cpp\"')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ key, value }) => {
      // Without args: return current config + ignored projects
      if (!key) {
        const ignoredProjects = getIgnoredProjects(ctx.db);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...ctx.cfg, ignoredProjects }),
            },
          ],
        };
      }

      // With key+value: update config
      if (!value) {
        throw new McpError(ErrorCode.InvalidParams, 'Both key and value are required for updates');
      }

      if (!CONFIGURABLE_KEYS.has(key)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown config key: ${key}. Valid keys: ${[...CONFIGURABLE_KEYS].join(', ')}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `Invalid JSON value: ${value}`);
      }

      writeConfigFile({ [key]: parsed } as Partial<MelchizedekConfig>);

      // Update in-memory config
      const updatedCfg = { ...ctx.cfg, [key]: parsed };
      Object.assign(ctx.cfg, updatedCfg);

      // Hot-reload reranker when relevant keys change
      let hotReloadFailed = false;
      if (RERANKER_HOT_RELOAD_KEYS.has(key)) {
        try {
          const detected = await detectRerankerBackend(ctx.cfg);
          if (detected) {
            ctx.searchContext.reranker = detected.reranker;
          } else {
            // New config doesn't yield a reranker — keep old one active
            hotReloadFailed = true;
          }
        } catch {
          hotReloadFailed = true;
        }
      }

      const restartRequired = RESTART_REQUIRED_KEYS.has(key);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              updated: true,
              key,
              config: updatedCfg,
              hotReloadFailed,
              restartRequired,
            }),
          },
        ],
      };
    },
  );
}
