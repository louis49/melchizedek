/**
 * Management tools: m9k_forget, m9k_delete_session, m9k_ignore_project, m9k_unignore_project, m9k_restart.
 */

import fs from 'fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteVectorsForChunk, ignoreProject, unignoreProject, purgeProjectData } from '../db.js';
import { DAEMON_PID_PATH } from '../constants.js';
import type { ToolContext } from './context.js';

export function registerManageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'm9k_forget',
    {
      description:
        'Permanently remove a specific chunk from the memory index. Does NOT delete the source JSONL. Use m9k_search() first to find the chunk ID to forget.',
      inputSchema: {
        chunkId: z.string().describe('Chunk ID to permanently delete from the index'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ chunkId }) => {
      // Check if chunk exists and is not already deleted
      const chunk = ctx.db
        .prepare('SELECT id, session_id FROM conv_chunks WHERE id = ? AND deleted_at IS NULL')
        .get(chunkId) as { id: string; session_id: string } | undefined;

      if (!chunk) {
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

      // Soft-delete the chunk
      ctx.db
        .prepare("UPDATE conv_chunks SET deleted_at = datetime('now') WHERE id = ?")
        .run(chunkId);

      // Hard-delete associated vectors (no need to keep them)
      if (ctx.searchContext.vecTextEnabled) {
        deleteVectorsForChunk(ctx.db, chunkId, '_text');
      }
      if (ctx.searchContext.vecCodeEnabled) {
        deleteVectorsForChunk(ctx.db, chunkId, '_code');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ forgotten: true, chunkId }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_delete_session',
    {
      description:
        'Delete a session from the index. Removes all chunks and search data. Does NOT delete the source JSONL file.',
      inputSchema: {
        sessionId: z.string().describe('The session ID to delete'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) => {
      // Guard: never delete the manual memories session
      if (sessionId === '__manual_memories__') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error:
                  'Cannot delete __manual_memories__ session. Use m9k_save to manage manual memories.',
              }),
            },
          ],
          isError: true,
        };
      }

      // Check if session exists
      const session = ctx.db
        .prepare('SELECT id, project FROM conv_sessions WHERE id = ?')
        .get(sessionId) as { id: string; project: string } | undefined;

      if (!session) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Session not found', sessionId }),
            },
          ],
          isError: true,
        };
      }

      // Count chunks before deletion
      const chunkCount = (
        ctx.db
          .prepare('SELECT COUNT(*) AS cnt FROM conv_chunks WHERE session_id = ?')
          .get(sessionId) as {
          cnt: number;
        }
      ).cnt;

      // Soft delete: hard-delete chunks (clean search), tombstone session row
      ctx.db.prepare('DELETE FROM conv_chunks WHERE session_id = ?').run(sessionId);
      ctx.db
        .prepare(
          "UPDATE conv_sessions SET deleted_at = datetime('now'), chunk_count = 0 WHERE id = ?",
        )
        .run(sessionId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              deleted: true,
              sessionId,
              project: session.project,
              chunksRemoved: chunkCount,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_ignore_project',
    {
      description:
        "Exclude a project from indexing. Future sessions won't be indexed. " +
        'Optionally purge existing indexed sessions for this project.',
      inputSchema: {
        project: z.string().describe('Project path to ignore (e.g. /Users/foo/my-secret-repo)'),
        purge: z
          .boolean()
          .default(false)
          .describe('Also delete already-indexed sessions for this project'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project, purge }) => {
      ignoreProject(ctx.db, project);

      let sessionsPurged = 0;
      let chunksPurged = 0;

      if (purge) {
        const result = purgeProjectData(ctx.db, project);
        sessionsPurged = result.sessionsPurged;
        chunksPurged = result.chunksPurged;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ignored: true,
              project,
              purged: purge,
              sessionsPurged,
              chunksPurged,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_unignore_project',
    {
      description:
        'Remove a project from the ignore list. Future sessions will be indexed again. ' +
        'Previously purged sessions are NOT restored (requires backfill re-indexation).',
      inputSchema: {
        project: z.string().describe('Project path to unignore'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project }) => {
      unignoreProject(ctx.db, project);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              unignored: true,
              project,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'm9k_restart',
    {
      description:
        'Restart the MCP server. Use after npm run build to load fresh code. ' +
        'The server disconnects; next MCP call auto-reconnects with the new build.',
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe('Use SIGKILL instead of SIGTERM (for stuck processes)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ force }) => {
      // Detect daemon vs local mode
      let mode: 'daemon' | 'local' = 'local';
      try {
        const pidStr = fs.readFileSync(DAEMON_PID_PATH, 'utf8').trim();
        if (parseInt(pidStr, 10) === process.pid) {
          mode = 'daemon';
        }
      } catch {
        // No PID file → local mode
      }

      const signal = force ? 'SIGKILL' : 'SIGTERM';

      // Schedule kill after 200ms to let the MCP response flush
      setTimeout(() => {
        process.kill(process.pid, signal);
      }, 200);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              restarting: true,
              mode,
              graceful: !force,
            }),
          },
        ],
      };
    },
  );
}
