/**
 * Specialized search tools: m9k_file_history, m9k_errors, m9k_similar_work.
 */

import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { search } from '../search.js';
import type { ToolContext } from './context.js';

export function registerSpecializedTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'm9k_file_history',
    {
      description:
        'Find past conversations that touched a specific file. Searches metadata (tool_use file_path) and text content.',
      inputSchema: {
        filePath: z.string().describe('File path to search for (e.g. "src/server.ts")'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
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
    async ({ filePath, limit }) => {
      const basename = path.basename(filePath);

      // Strategy 1: LIKE on metadata_json for the file path
      const metadataRows = ctx.db
        .prepare(
          `SELECT c.id, c.session_id, c.idx, c.user_content, c.assistant_content,
                  c.timestamp, c.metadata_json, s.project
           FROM conv_chunks c
           JOIN conv_sessions s ON c.session_id = s.id
           WHERE c.metadata_json LIKE ?
             AND c.deleted_at IS NULL
           ORDER BY c.timestamp DESC
           LIMIT ?`,
        )
        .all(`%${filePath}%`, limit * 2) as Array<{
        id: string;
        session_id: string;
        idx: number;
        user_content: string;
        assistant_content: string;
        timestamp: string;
        metadata_json: string;
        project: string;
      }>;

      // Strategy 2: FTS5 on the basename
      let ftsRows: typeof metadataRows = [];
      try {
        ftsRows = ctx.db
          .prepare(
            `SELECT c.id, c.session_id, c.idx, c.user_content, c.assistant_content,
                    c.timestamp, c.metadata_json, s.project
             FROM conv_chunks_fts
             JOIN conv_chunks c ON conv_chunks_fts.rowid = c.rowid
             JOIN conv_sessions s ON c.session_id = s.id
             WHERE conv_chunks_fts MATCH ?
               AND c.deleted_at IS NULL
             ORDER BY c.timestamp DESC
             LIMIT ?`,
          )
          .all(basename, limit * 2) as typeof metadataRows;
      } catch {
        // FTS5 syntax error — skip
      }

      // Dedup by chunkId, metadata results first (more precise)
      const seen = new Set<string>();
      const combined: Array<{
        chunkId: string;
        sessionId: string;
        project: string;
        timestamp: string;
        snippet: string;
        filePaths: string[];
      }> = [];

      for (const row of [...metadataRows, ...ftsRows]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);

        let filePaths: string[] = [];
        try {
          const meta = JSON.parse(row.metadata_json) as { filePaths?: string[] };
          filePaths = meta.filePaths ?? [];
        } catch {
          // ignore parse error
        }

        combined.push({
          chunkId: row.id,
          sessionId: row.session_id,
          project: row.project,
          timestamp: row.timestamp,
          snippet: (row.user_content + ' ' + row.assistant_content).slice(0, 150),
          filePaths,
        });
      }

      // Sort by timestamp DESC, take top limit
      combined.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(combined.slice(0, limit)) }],
      };
    },
  );

  server.registerTool(
    'm9k_errors',
    {
      description:
        'Find past solutions for an error message. Returns error context + how it was resolved.',
      inputSchema: {
        errorMessage: z.string().describe('The error message or keywords from the error'),
        limit: z.number().int().min(1).max(20).default(5).describe('Max results'),
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
    async ({ errorMessage, limit }) => {
      const results = await search(
        ctx.db,
        { query: errorMessage, limit: limit * 3 },
        ctx.searchContext,
      );

      // Enrich with error/solution extraction, filter by substantial assistant response
      const enriched: Array<{
        chunkId: string;
        sessionId: string;
        project: string;
        timestamp: string;
        error: string;
        solution: string;
        matchType: string;
      }> = [];

      for (const r of results) {
        const chunk = ctx.db
          .prepare('SELECT user_content, assistant_content FROM conv_chunks WHERE id = ?')
          .get(r.chunkId) as { user_content: string; assistant_content: string } | undefined;

        if (!chunk || chunk.assistant_content.length < 20) continue;

        enriched.push({
          chunkId: r.chunkId,
          sessionId: r.sessionId,
          project: r.project,
          timestamp: r.timestamp,
          error: chunk.user_content.slice(0, 200),
          solution: chunk.assistant_content.slice(0, 300),
          matchType: r.matchType,
        });

        if (enriched.length >= limit) break;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(enriched) }],
      };
    },
  );

  server.registerTool(
    'm9k_similar_work',
    {
      description:
        "Find past work similar to what you're about to do. Use at the start of a complex task to see previous approaches. Unlike m9k_search, this prioritizes chunks with rich metadata (multiple tools used, multiple files touched).",
      inputSchema: {
        description: z.string().describe('Description of the current task'),
        limit: z.number().int().min(1).max(20).default(5),
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
    async ({ description, limit }) => {
      // Use the same search pipeline as m9k_search
      const results = await search(
        ctx.db,
        { query: description, limit: limit * 3 },
        ctx.searchContext,
      );

      // Apply metadata bonus scoring
      const enriched = results.map((r) => {
        const chunk = ctx.db
          .prepare('SELECT metadata_json FROM conv_chunks WHERE id = ?')
          .get(r.chunkId) as { metadata_json: string } | undefined;

        let metadataBonus = 0;
        if (chunk?.metadata_json) {
          try {
            const meta = JSON.parse(chunk.metadata_json) as {
              toolCalls?: string[];
              filePaths?: string[];
            };
            if (meta.toolCalls && meta.toolCalls.length >= 3) metadataBonus += 0.2;
            if (meta.filePaths && meta.filePaths.length >= 2) metadataBonus += 0.1;
          } catch {
            // ignore parse error
          }
        }

        return {
          chunkId: r.chunkId,
          snippet: r.snippet,
          score: r.score + metadataBonus,
          metadataBonus,
          project: r.project,
          timestamp: r.timestamp,
          matchType: r.matchType,
          sessionId: r.sessionId,
        };
      });

      // Re-sort by adjusted score, take top limit
      enriched.sort((a, b) => b.score - a.score);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(enriched.slice(0, limit)) }],
      };
    },
  );
}
