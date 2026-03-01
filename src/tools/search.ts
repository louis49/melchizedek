/**
 * Progressive retrieval tools: m9k_search, m9k_context, m9k_full.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStat } from '../db.js';
import { search } from '../search.js';
import type { ToolContext } from './context.js';

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'm9k_search',
    {
      description:
        'Search indexed past conversations. Returns compact results with snippets. Results from the current project and session are boosted by default. Use m9k_context or m9k_full to drill down.',
      inputSchema: {
        query: z.string().describe('Search query (keywords or natural language)'),
        project: z
          .string()
          .optional()
          .describe('Filter by project path. Omit for cross-project search.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
        since: z.string().optional().describe('ISO-8601 date. Only results after this date.'),
        until: z
          .string()
          .optional()
          .describe('ISO-8601 date. Only results before this date (exclusive).'),
        order: z
          .enum(['score', 'date_asc', 'date_desc'])
          .default('score')
          .describe(
            'Sort order: score (relevance), date_asc (oldest first), date_desc (newest first)',
          ),
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
    async ({ query, project, limit, since, until, order }) => {
      const currentSession = getStat(ctx.db, 'current_session_id') || undefined;
      const results = await search(
        ctx.db,
        {
          query,
          project,
          currentProject: ctx.currentProject,
          currentSession,
          limit,
          since,
          until,
          order,
        },
        ctx.searchContext,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results) }],
      };
    },
  );

  server.registerTool(
    'm9k_context',
    {
      description:
        'Get a chunk with surrounding context (adjacent chunks in the same session). Use after m9k_search to understand the conversation flow.',
      inputSchema: {
        chunkId: z.string().describe('The chunk ID to get context for'),
        window: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe('Number of chunks before/after to include'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ chunkId, window }) => {
      const target = ctx.db
        .prepare('SELECT session_id, idx FROM conv_chunks WHERE id = ? AND deleted_at IS NULL')
        .get(chunkId) as { session_id: string; idx: number } | undefined;

      if (!target) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Chunk not found', chunkId }),
            },
          ],
          isError: true,
        };
      }

      const minIdx = Math.max(0, target.idx - window);
      const maxIdx = target.idx + window;

      const rows = ctx.db
        .prepare(
          `SELECT id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, token_count, tags, metadata_json
           FROM conv_chunks WHERE session_id = ? AND idx BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY idx`,
        )
        .all(target.session_id, minIdx, maxIdx);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ target: chunkId, chunks: rows }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_full',
    {
      description:
        'Retrieve full content of chunks by IDs. Use after m9k_search to get complete context.',
      inputSchema: {
        chunkIds: z.array(z.string()).min(1).max(20).describe('Chunk IDs to retrieve in full'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ chunkIds }) => {
      const placeholders = chunkIds.map(() => '?').join(',');
      const stmt = ctx.db.prepare(
        `SELECT id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, token_count, tags, metadata_json
         FROM conv_chunks WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      );
      const rows = stmt.all(...chunkIds);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
