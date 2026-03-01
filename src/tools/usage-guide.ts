/**
 * Usage guide phantom tool + buildUsageGuide helper.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStat } from '../db.js';
import type { DatabaseType } from '../db.js';
import type { ToolContext } from './context.js';

export function buildUsageGuide(db: DatabaseType, version: string): string {
  const sessions = (
    db.prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE deleted_at IS NULL').get() as {
      cnt: number;
    }
  ).cnt;
  const chunks = (
    db.prepare('SELECT COUNT(*) AS cnt FROM conv_chunks WHERE deleted_at IS NULL').get() as {
      cnt: number;
    }
  ).cnt;
  const projects = (
    db
      .prepare('SELECT COUNT(DISTINCT project) AS cnt FROM conv_sessions WHERE deleted_at IS NULL')
      .get() as { cnt: number }
  ).cnt;

  const searchCount = parseInt(getStat(db, 'search_count') ?? '0', 10);
  const tokensServed = parseInt(getStat(db, 'tokens_served') ?? '0', 10);

  const statsLine =
    sessions > 0
      ? `\nCorpus: ${sessions} sessions, ${chunks} chunks across ${projects} projects.`
      : '\nCorpus: empty (no sessions indexed yet).';

  const usageLine =
    searchCount > 0 ? `\nUsage: ${searchCount} searches, ${tokensServed} tokens served.` : '';

  return `melchizedek v${version} — Persistent memory for Claude Code with hybrid search (BM25 + dual embeddings) + reranking.
${statsLine}${usageLine}

Available tools (16):
- m9k_search: Find past conversations (BM25 + text vectors + code vectors, fused via RRF)
- m9k_context: Get a chunk with surrounding conversation context
- m9k_full: Get complete chunk content by IDs
- m9k_sessions: Browse indexed sessions
- m9k_file_history: Find conversations that touched a specific file
- m9k_errors: Find past solutions for error messages
- m9k_save: Store important notes for future recall
- m9k_similar_work: Find past approaches to similar tasks (bonus for complex work)
- m9k_forget: Permanently remove a chunk from memory
- m9k_info: Memory index information, corpus size, search pipeline status, usage metrics, embedding worker state
- m9k_config: View or update plugin configuration
- m9k_delete_session: Remove a session from the index
- m9k_ignore_project: Exclude a project from indexing (optionally purge existing data)
- m9k_unignore_project: Re-enable indexing for a previously ignored project
- m9k_restart: Restart the MCP server to load fresh code after rebuild

RETRIEVAL PATTERN (use this order):
1. m9k_search(query) → compact results, current project and session boosted (use order="date_asc" to find first occurrence)
2. m9k_context(chunkId) → surrounding conversation
3. m9k_full([chunkIds]) → complete content if needed

SPECIALIZED SEARCH:
- m9k_file_history(filePath) → before modifying any file
- m9k_errors(errorMessage) → when you hit an error
- m9k_similar_work(description) → at the start of a complex task

MANAGE:
- m9k_info() → check corpus size, search pipeline, usage metrics
- m9k_config() → view or change plugin configuration
- m9k_delete_session(sessionId) → remove a session from the index
- m9k_ignore_project(project) → exclude a project from indexing
- m9k_unignore_project(project) → re-enable indexing for a project
- m9k_restart() → restart server after npm run build`;
}

export function registerUsageGuide(server: McpServer, ctx: ToolContext): void {
  const usageGuideDescription = buildUsageGuide(ctx.db, ctx.version);

  server.registerTool(
    '__USAGE_GUIDE',
    {
      description: usageGuideDescription,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'This is a phantom tool. Its description above IS the usage guide.',
          },
        ],
      };
    },
  );
}
