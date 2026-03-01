import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import {
  openMemoryDatabase,
  closeDatabase,
  setMeta,
  setStat,
  ignoreProject,
  isProjectIgnored,
  getIgnoredProjects,
} from '../src/db.js';
import { indexConvSession } from '../src/indexer.js';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchContext } from '../src/models.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

describe('MCP server', () => {
  let db: Database.Database;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    // Index fixture data
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    const result = createServer({}, db);
    server = result.server;

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should register all expected tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    expect(toolNames).toContain('m9k_search');
    expect(toolNames).toContain('m9k_full');
    expect(toolNames).toContain('m9k_sessions');
    expect(toolNames).toContain('m9k_save');
    expect(toolNames).toContain('m9k_context');
    expect(toolNames).toContain('m9k_file_history');
    expect(toolNames).toContain('m9k_errors');
    expect(toolNames).toContain('m9k_info');
    expect(toolNames).toContain('m9k_similar_work');
    expect(toolNames).toContain('m9k_config');
    expect(toolNames).toContain('m9k_forget');
    expect(toolNames).toContain('m9k_delete_session');
    expect(toolNames).toContain('__USAGE_GUIDE');
    // Old names must not exist
    expect(toolNames).not.toContain('recall_status');
    expect(toolNames).not.toContain('recall_search');
    expect(toolNames).toHaveLength(16);
  });

  it('search tool should return results via MCP protocol', async () => {
    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].chunkId).toBeDefined();
    expect(data[0].snippet).toBeDefined();
    expect(data[0].matchType).toBe('bm25');
  });

  it('search tool should return empty array for no match', async () => {
    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'quantumphysicsuniverse', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('m9k_full tool should return chunk content', async () => {
    // First search to get a chunk ID
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 1 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    const chunkId = searchData[0].chunkId;

    // Now get full content
    const result = await client.callTool({
      name: 'm9k_full',
      arguments: { chunkIds: [chunkId] },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(chunkId);
    const combined = (data[0].user_content + ' ' + data[0].assistant_content).toLowerCase();
    expect(combined).toContain('cors');
  });

  it('m9k_full tool should return empty for non-existent IDs', async () => {
    const result = await client.callTool({
      name: 'm9k_full',
      arguments: { chunkIds: ['non-existent-id'] },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('m9k_sessions tool should return sessions', async () => {
    const result = await client.callTool({
      name: 'm9k_sessions',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(data[0].project).toBe('/Users/test/my-project');
  });

  it('m9k_sessions tool should filter by project', async () => {
    const result = await client.callTool({
      name: 'm9k_sessions',
      arguments: { project: '/nonexistent/project' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('m9k_save tool should persist a note', async () => {
    const result = await client.callTool({
      name: 'm9k_save',
      arguments: {
        content: 'Always use pnpm for this project',
        tags: ['preference', 'tooling'],
      },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.saved).toBe(true);
    expect(data.chunkId).toBeDefined();

    // Verify memory is searchable
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'pnpm', limit: 5 },
    });

    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    expect(searchData.length).toBeGreaterThan(0);
  });

  it('m9k_save tool should deduplicate', async () => {
    await client.callTool({
      name: 'm9k_save',
      arguments: { content: 'Same content twice' },
    });

    const result2 = await client.callTool({
      name: 'm9k_save',
      arguments: { content: 'Same content twice' },
    });

    const data = JSON.parse((result2.content as Array<{ text: string }>)[0].text);
    expect(data.duplicate).toBe(true);
    expect(data.saved).toBe(false);
  });

  it('m9k_context tool should return adjacent chunks', async () => {
    // Search for a chunk first
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 1 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    const chunkId = searchData[0].chunkId;

    const result = await client.callTool({
      name: 'm9k_context',
      arguments: { chunkId, window: 2 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.target).toBe(chunkId);
    expect(data.chunks.length).toBeGreaterThanOrEqual(1);
    // The target chunk should be in the results
    expect(data.chunks.some((c: { id: string }) => c.id === chunkId)).toBe(true);
  });

  it('m9k_context tool should return error for non-existent chunk', async () => {
    const result = await client.callTool({
      name: 'm9k_context',
      arguments: { chunkId: 'non-existent-id' },
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBe('Chunk not found');
  });

  it('m9k_context tool should respect session boundaries', async () => {
    // Get the first chunk (idx=0) and ask for window that extends before 0
    const firstChunk = db
      .prepare('SELECT id FROM conv_chunks WHERE session_id = ? ORDER BY idx LIMIT 1')
      .get('550e8400-e29b-41d4-a716-446655440000') as { id: string };

    const result = await client.callTool({
      name: 'm9k_context',
      arguments: { chunkId: firstChunk.id, window: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // All chunks should have idx >= 0
    expect(data.chunks.every((c: { idx: number }) => c.idx >= 0)).toBe(true);
  });

  it('m9k_file_history tool should find chunks referencing a file', async () => {
    // normal_session.jsonl has tool_use blocks referencing "src/server.ts"
    const result = await client.callTool({
      name: 'm9k_file_history',
      arguments: { filePath: 'src/server.ts' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].chunkId).toBeDefined();
    expect(data[0].timestamp).toBeDefined();
  });

  it('m9k_file_history tool should return empty for unknown file', async () => {
    const result = await client.callTool({
      name: 'm9k_file_history',
      arguments: { filePath: 'nonexistent/path/foo.xyz' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('m9k_errors tool should find solutions for known error', async () => {
    // "CORS error" appears in fixture — assistant provided a solution
    const result = await client.callTool({
      name: 'm9k_errors',
      arguments: { errorMessage: 'CORS error' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].error).toBeDefined();
    expect(data[0].solution).toBeDefined();
    expect(data[0].solution.length).toBeGreaterThan(0);
  });

  it('m9k_errors tool should return empty for unknown error', async () => {
    const result = await client.callTool({
      name: 'm9k_errors',
      arguments: { errorMessage: 'QuantumEntanglementException' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('m9k_info should return new structured output', async () => {
    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // Top-level fields
    expect(data.status).toContain('healthy');
    expect(data.mode).toBe('local');
    expect(['debug', 'info', 'warn', 'error']).toContain(data.logLevel);
    expect(typeof data.uptime).toBe('string');
    // Corpus
    expect(data.corpus.sessions).toBeGreaterThan(0);
    expect(data.corpus.chunks).toBeGreaterThan(0);
    expect(typeof data.corpus.projects).toBe('number');
    expect(typeof data.corpus.span).toBe('string');
    expect(data.corpus.span).toContain('→');
    expect(typeof data.corpus.orphanedSessions).toBe('number');
    // Search
    expect(data.search.bm25).toBe('active');
    expect(typeof data.search.text).toBe('string');
    expect(typeof data.search.code).toBe('string');
    expect(data.search.reranker).toBe('none');
    // Activity (null when idle)
    expect(data.activity).toBeNull();
    // Usage
    expect(typeof data.usage.searches).toBe('number');
    expect(typeof data.usage.hits).toBe('number');
    expect(typeof data.usage.tokensServed).toBe('number');
  });

  it('m9k_info search lines should show disabled when no embedder', async () => {
    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // No embedder configured → "disabled"
    expect(data.search.text).toBe('disabled');
    expect(data.search.code).toBe('disabled');
    // No migration → activity null
    expect(data.activity).toBeNull();
  });

  it('m9k_info should show stuck-migration when migration meta set but no worker', async () => {
    // Simulate text migration state in meta (no active worker → stuck)
    setMeta(db, 'migration_target_model_text', 'new-model');
    setMeta(db, 'migration_target_dimensions_text', '768');
    setMeta(db, 'migration_progress_text', '50');
    setMeta(db, 'migration_started_at_text', '2026-02-26T10:00:00Z');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.activity).not.toBeNull();
    expect(data.activity.type).toBe('stuck-migration');
    expect(data.activity.target).toBe('_text');
    expect(data.activity.stuckSince).toBe('2026-02-26T10:00:00Z');
    expect(data.status).toContain('degraded');
  });

  it('m9k_info should show stuck-migration for code when code migration meta set', async () => {
    setMeta(db, 'migration_target_model_code', 'ollama:jina-code-v2');
    setMeta(db, 'migration_target_dimensions_code', '768');
    setMeta(db, 'migration_progress_code', '1500');
    setMeta(db, 'migration_started_at_code', '2026-02-27T09:00:00Z');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.activity).not.toBeNull();
    expect(data.activity.type).toBe('stuck-migration');
    expect(data.activity.target).toBe('_code');
    expect(data.activity.progress).toMatch(/^\d+\/\d+ \(\d+%\)$/);
    expect(data.activity.stuckSince).toBe('2026-02-27T09:00:00Z');
  });

  it('m9k_info should show text embedding model in search line', async () => {
    setMeta(db, 'embedding_model_id_text', 'minilm-l12-v2');
    setMeta(db, 'embedding_dimensions_text', '384');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.search.text).toContain('minilm-l12-v2');
    expect(data.search.text).toContain('384d');
  });

  it('m9k_info without embedder should show disabled search lines', async () => {
    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.search.text).toBe('disabled');
    expect(data.search.code).toBe('disabled');
  });

  it('m9k_info with ollama meta should show model in search line', async () => {
    setMeta(db, 'embedding_model_id_text', 'ollama:nomic-embed-text');
    setMeta(db, 'embedding_dimensions_text', '768');
    setMeta(db, 'embedding_model_id_code', 'ollama:jina-code-v2');
    setMeta(db, 'embedding_dimensions_code', '768');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.search.text).toContain('ollama:nomic-embed-text');
    expect(data.search.text).toContain('768d');
    expect(data.search.code).toContain('ollama:jina-code-v2');
    expect(data.search.code).toContain('768d');
  });

  it('m9k_info with transformers-js meta should show model in search line', async () => {
    setMeta(db, 'embedding_model_id_text', 'minilm-l12-v2');
    setMeta(db, 'embedding_dimensions_text', '384');
    setMeta(db, 'embedding_model_id_code', 'jina-code-v2');
    setMeta(db, 'embedding_dimensions_code', '768');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.search.text).toContain('minilm-l12-v2');
    expect(data.search.code).toContain('jina-code-v2');
  });

  it('m9k_info should show updated search counters after a search', async () => {
    // Perform a search first
    await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.usage.searches).toBeGreaterThanOrEqual(1);
    expect(data.usage.hits).toBeGreaterThanOrEqual(1);
  });

  it('m9k_info should include process memory info', async () => {
    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.process).toBeDefined();
    expect(typeof data.process.pid).toBe('number');
    expect(data.process.pid).toBe(process.pid);
    expect(typeof data.process.rssMB).toBe('number');
    expect(data.process.rssMB).toBeGreaterThan(0);
    expect(typeof data.process.heapUsedMB).toBe('number');
    expect(data.process.heapUsedMB).toBeGreaterThan(0);
    expect(typeof data.process.uptimeSeconds).toBe('number');
    expect(data.process.uptimeSeconds).toBeGreaterThanOrEqual(0);

    // No worker running → activity null
    expect(data.activity).toBeNull();
  });

  // --- m9k_similar_work ---

  it('m9k_similar_work should return results with metadata bonus', async () => {
    // Insert chunks with rich metadata
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('rich-sess', '/test/rich', '/path/rich.jsonl', '2026-02-20T10:00:00Z', 2, 1);

    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rich-chunk',
      'rich-sess',
      0,
      'Refactor the authentication module',
      'I will restructure the auth code across multiple files.',
      'hash-rich',
      '2026-02-20T10:00:00Z',
      JSON.stringify({
        toolCalls: ['Read', 'Edit', 'Write', 'Bash'],
        filePaths: ['src/auth.ts', 'src/middleware.ts', 'tests/auth.test.ts'],
        errorMessages: [],
      }),
    );

    const result = await client.callTool({
      name: 'm9k_similar_work',
      arguments: { description: 'refactor authentication', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].chunkId).toBeDefined();
    expect(data[0].metadataBonus).toBeDefined();
  });

  it('m9k_similar_work should return empty for no match', async () => {
    const result = await client.callTool({
      name: 'm9k_similar_work',
      arguments: { description: 'quantumphysicsuniverse', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  // --- m9k_config ---

  it('m9k_config without args should return current config', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.embeddingsEnabled).toBeDefined();
    expect(data.rerankerEnabled).toBeDefined();
    expect(data.autoFuzzyThreshold).toBeDefined();
  });

  it('m9k_config with key+value should update config', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'autoFuzzyThreshold', value: '5' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.config.autoFuzzyThreshold).toBe(5);
  });

  it('m9k_config should accept embeddingTextBackend key', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'embeddingTextBackend', value: '"transformers-js"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.config.embeddingTextBackend).toBe('transformers-js');
    expect(data.restartRequired).toBe(true);
  });

  it('m9k_config should accept embeddingTextModel key with restartRequired', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'embeddingTextModel', value: '"nomic-embed-text"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.config.embeddingTextModel).toBe('nomic-embed-text');
    expect(data.restartRequired).toBe(true);
  });

  it('m9k_config should accept ollamaBaseUrl key without restartRequired', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'ollamaBaseUrl', value: '"http://localhost:11434"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.config.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(data.restartRequired).toBe(false);
  });

  it('m9k_config should not set restartRequired for non-embedding keys', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'autoFuzzyThreshold', value: '5' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.restartRequired).toBe(false);
  });

  it('m9k_config should reject unknown keys', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'unknownKey', value: '"test"' },
    });

    expect(result.isError).toBe(true);
  });

  // --- delete_session ---

  it('delete_session should remove session and all its chunks', async () => {
    // Verify session exists with chunks
    const statsBefore = await client.callTool({ name: 'm9k_info', arguments: {} });
    const before = JSON.parse((statsBefore.content as Array<{ text: string }>)[0].text);
    expect(before.corpus.sessions).toBeGreaterThan(0);
    expect(before.corpus.chunks).toBeGreaterThan(0);

    // Delete the session
    const result = await client.callTool({
      name: 'm9k_delete_session',
      arguments: { sessionId: '550e8400-e29b-41d4-a716-446655440000' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.deleted).toBe(true);
    expect(data.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(data.chunksRemoved).toBeGreaterThan(0);

    // Verify chunks are gone
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    expect(searchData).toEqual([]);

    // Verify stats updated
    const statsAfter = await client.callTool({ name: 'm9k_info', arguments: {} });
    const after = JSON.parse((statsAfter.content as Array<{ text: string }>)[0].text);
    expect(after.corpus.sessions).toBe(before.corpus.sessions - 1);
  });

  it('delete_session should return error for non-existent session', async () => {
    const result = await client.callTool({
      name: 'm9k_delete_session',
      arguments: { sessionId: 'non-existent-session-id' },
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBe('Session not found');
  });

  it('delete_session should hide session from m9k_sessions', async () => {
    // Delete the session
    await client.callTool({
      name: 'm9k_delete_session',
      arguments: { sessionId: '550e8400-e29b-41d4-a716-446655440000' },
    });

    // m9k_sessions should no longer include it
    const result = await client.callTool({
      name: 'm9k_sessions',
      arguments: {},
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.every((s: { id: string }) => s.id !== '550e8400-e29b-41d4-a716-446655440000')).toBe(
      true,
    );
  });

  it('delete_session tombstone should prevent re-indexation of same JSONL', async () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');

    // Delete the session (soft delete)
    await client.callTool({
      name: 'm9k_delete_session',
      arguments: { sessionId: '550e8400-e29b-41d4-a716-446655440000' },
    });

    // Re-index the same JSONL content — should be skipped due to tombstone
    const status = indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );
    expect(status).toBe('skipped');

    // Search should still return empty (chunks were hard-deleted, not re-indexed)
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    expect(searchData).toEqual([]);
  });

  it('delete_session should reject __manual_memories__', async () => {
    // First create a manual memory so the session exists
    await client.callTool({
      name: 'm9k_save',
      arguments: { content: 'Test memory for delete guard' },
    });

    const result = await client.callTool({
      name: 'm9k_delete_session',
      arguments: { sessionId: '__manual_memories__' },
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toContain('Cannot delete __manual_memories__');
  });

  // --- forget ---

  it('should register forget tool and have 13 tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('m9k_forget');
    expect(toolNames).toHaveLength(16);
  });

  it('forget should soft-delete a chunk', async () => {
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 1 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    const chunkId = searchData[0].chunkId;

    const result = await client.callTool({
      name: 'm9k_forget',
      arguments: { chunkId },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.forgotten).toBe(true);
    expect(data.chunkId).toBe(chunkId);

    // Row should still exist in DB with deleted_at set
    const row = db.prepare('SELECT deleted_at FROM conv_chunks WHERE id = ?').get(chunkId) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).toBeTruthy();
  });

  it('forget should hide chunk from m9k_search', async () => {
    const searchBefore = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 10 },
    });
    const dataBefore = JSON.parse((searchBefore.content as Array<{ text: string }>)[0].text);
    expect(dataBefore.length).toBeGreaterThan(0);
    const chunkId = dataBefore[0].chunkId;

    await client.callTool({ name: 'm9k_forget', arguments: { chunkId } });

    const searchAfter = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 10 },
    });
    const dataAfter = JSON.parse((searchAfter.content as Array<{ text: string }>)[0].text);
    expect(dataAfter.every((r: { chunkId: string }) => r.chunkId !== chunkId)).toBe(true);
  });

  it('forget should hide chunk from m9k_context', async () => {
    const chunks = db
      .prepare('SELECT id, idx FROM conv_chunks WHERE session_id = ? ORDER BY idx')
      .all('550e8400-e29b-41d4-a716-446655440000') as Array<{ id: string; idx: number }>;
    expect(chunks.length).toBeGreaterThan(1);

    const chunkToForget = chunks[1];
    const neighborChunk = chunks[0];

    await client.callTool({ name: 'm9k_forget', arguments: { chunkId: chunkToForget.id } });

    const result = await client.callTool({
      name: 'm9k_context',
      arguments: { chunkId: neighborChunk.id, window: 5 },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.chunks.every((c: { id: string }) => c.id !== chunkToForget.id)).toBe(true);
  });

  it('forget should hide chunk from m9k_full', async () => {
    const chunks = db.prepare('SELECT id FROM conv_chunks LIMIT 1').all() as Array<{ id: string }>;
    const chunkId = chunks[0].id;

    await client.callTool({ name: 'm9k_forget', arguments: { chunkId } });

    const result = await client.callTool({
      name: 'm9k_full',
      arguments: { chunkIds: [chunkId] },
    });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data).toEqual([]);
  });

  it('forget should return error for non-existent chunk', async () => {
    const result = await client.callTool({
      name: 'm9k_forget',
      arguments: { chunkId: 'non-existent-id' },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.error).toBe('Chunk not found');
  });

  it('forget should not resurrect chunk after re-indexation', async () => {
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 1 },
    });
    const searchData = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    const chunkId = searchData[0].chunkId;

    await client.callTool({ name: 'm9k_forget', arguments: { chunkId } });

    // Re-index with slightly different content to force re-index (different hash)
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content + '\n',
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    // The forgotten chunk should still be hidden from search
    const searchAfter = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 10 },
    });
    const dataAfter = JSON.parse((searchAfter.content as Array<{ text: string }>)[0].text);
    expect(dataAfter.every((r: { chunkId: string }) => r.chunkId !== chunkId)).toBe(true);
  });

  it('m9k_info should not count deleted chunks', async () => {
    const statsBefore = await client.callTool({ name: 'm9k_info', arguments: {} });
    const before = JSON.parse((statsBefore.content as Array<{ text: string }>)[0].text);
    const chunksBefore = before.corpus.chunks;

    // Forget one chunk
    const chunks = db.prepare('SELECT id FROM conv_chunks LIMIT 1').all() as Array<{ id: string }>;
    await client.callTool({ name: 'm9k_forget', arguments: { chunkId: chunks[0].id } });

    const statsAfter = await client.callTool({ name: 'm9k_info', arguments: {} });
    const after = JSON.parse((statsAfter.content as Array<{ text: string }>)[0].text);
    expect(after.corpus.chunks).toBe(chunksBefore - 1);
  });

  // --- current project boost ---

  it('m9k_search should boost current project results when server has currentProject', async () => {
    // Add a second session in a different project with similar content
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('other-sess', '/other/project', '/path/other.jsonl', '2026-02-20T10:00:00Z', 2, 1);

    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'other-chunk',
      'other-sess',
      0,
      'Fix the CORS error in Express CORS CORS CORS',
      'Add CORS middleware with app.use(cors()) and configure CORS headers CORS policy CORS',
      'hash-other-cors',
      '2026-02-20T10:00:00Z',
    );

    // Create a new server with currentProject set to the fixture's project
    const result2 = createServer({}, db, { currentProject: '/Users/test/my-project' });
    const client2 = new Client({ name: 'boost-test', version: '1.0.0' });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([result2.server.connect(st2), client2.connect(ct2)]);

    const searchResult = await client2.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 10 },
    });

    const data = JSON.parse((searchResult.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(1);
    // First result should be from current project despite other having more CORS mentions
    expect(data[0].project).toBe('/Users/test/my-project');
  });

  it('__USAGE_GUIDE should have dynamic description with stats and all tools', async () => {
    const result = await client.callTool({
      name: '__USAGE_GUIDE',
      arguments: {},
    });

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('phantom tool');

    const tools = await client.listTools();
    const guide = tools.tools.find((t) => t.name === '__USAGE_GUIDE');
    const desc = guide?.description ?? '';

    // Version
    expect(desc).toContain('v1.0.0');
    // Dynamic stats — should show session/chunk counts
    expect(desc).toContain('sessions');
    expect(desc).toContain('chunks');
    // All tools mentioned
    expect(desc).toContain('m9k_search');
    expect(desc).toContain('m9k_context');
    expect(desc).toContain('m9k_full');
    expect(desc).toContain('m9k_sessions');
    expect(desc).toContain('m9k_file_history');
    expect(desc).toContain('m9k_errors');
    expect(desc).toContain('m9k_save');
    expect(desc).toContain('m9k_similar_work');
    expect(desc).toContain('m9k_info');
    expect(desc).toContain('m9k_config');
    expect(desc).toContain('m9k_delete_session');
    expect(desc).toContain('m9k_ignore_project');
    expect(desc).toContain('m9k_unignore_project');
    expect(desc).toContain('m9k_restart');
  });

  it('__USAGE_GUIDE stats update when server is recreated with more data', async () => {
    // Get initial description
    const tools1 = await client.listTools();
    const desc1 = tools1.tools.find((t) => t.name === '__USAGE_GUIDE')?.description ?? '';
    expect(desc1).toContain('1 sessions'); // 1 session from fixture

    // Add another session directly in DB
    const content2 = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    indexConvSession(db, 'second-session', content2, '/test/other', '/path/second.jsonl');

    // Recreate server with same db — description should update
    const result2 = createServer({}, db);
    const client2 = new Client({ name: 'test-client-2', version: '1.0.0' });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await Promise.all([result2.server.connect(st2), client2.connect(ct2)]);

    const tools2 = await client2.listTools();
    const desc2 = tools2.tools.find((t) => t.name === '__USAGE_GUIDE')?.description ?? '';
    expect(desc2).toContain('2 sessions'); // Now 2 sessions
  });

  it('m9k_search should apply session boost when current_session_id is in stats', async () => {
    // Set the current session to the indexed session
    setStat(db, 'current_session_id', '550e8400-e29b-41d4-a716-446655440000');

    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    // Session should match the current session
    expect(data[0].sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('m9k_search should not crash when no current_session_id in stats', async () => {
    // No setStat call — stats table has no current_session_id
    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
  });

  it('search tools should accept optional source parameter without error', async () => {
    // V1: source is accepted but ignored (all data is conversations)
    const searchResult = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', source: 'conversations' },
    });
    expect(searchResult.isError).toBeFalsy();

    const sessionsResult = await client.callTool({
      name: 'm9k_sessions',
      arguments: { source: 'git' },
    });
    expect(sessionsResult.isError).toBeFalsy();

    const fileResult = await client.callTool({
      name: 'm9k_file_history',
      arguments: { filePath: 'src/server.ts', source: 'files' },
    });
    expect(fileResult.isError).toBeFalsy();

    const errorsResult = await client.callTool({
      name: 'm9k_errors',
      arguments: { errorMessage: 'CORS', source: 'conversations' },
    });
    expect(errorsResult.isError).toBeFalsy();

    const similarResult = await client.callTool({
      name: 'm9k_similar_work',
      arguments: { description: 'fix CORS', source: 'conversations' },
    });
    expect(similarResult.isError).toBeFalsy();
  });
});

describe('MCP server with reranker', () => {
  let db: Database.Database;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    // Index fixture data
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    // Mock reranker that boosts results containing "middleware"
    const mockReranker = {
      rerank: async (
        _query: string,
        documents: { id: string; content: string }[],
        topN: number,
      ) => {
        return documents
          .map((d) => ({
            id: d.id,
            score: d.content.toLowerCase().includes('middleware') ? 10 : 1,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN);
      },
      backend: () => 'transformers-js' as const,
      modelId: () => 'mock/reranker-model',
    };

    const result = createServer({}, db, { reranker: mockReranker });
    server = result.server;

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('m9k_search should apply reranker and reorder results', async () => {
    // Insert extra chunks so reranker has multiple results to reorder
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('rerank-sess', '/test/rerank', '/rerank.jsonl', '2026-02-20T10:00:00Z', 4, 2);
    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rerank-1',
      'rerank-sess',
      0,
      'Fix CORS problem',
      'Check your server config',
      'rh1',
      '2026-02-20T10:00:00Z',
    );
    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rerank-2',
      'rerank-sess',
      1,
      'CORS blocking requests',
      'Add CORS middleware to Express',
      'rh2',
      '2026-02-20T10:01:00Z',
    );

    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS', limit: 5 },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(1);
    // Reranker boosts "middleware" mentions — top result should have score 10
    expect(data[0].score).toBe(10);
  });

  it('m9k_info should show reranker in search section', async () => {
    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.search.reranker).toContain('transformers-js');
    expect(data.search.reranker).toContain('mock/reranker-model');
  });
});

describe('MCP server — hot-reload reranker', () => {
  let db: Database.Database;
  let server: McpServer;
  let client: Client;
  let searchContext: SearchContext;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    const mockReranker = {
      rerank: async (
        _query: string,
        documents: { id: string; content: string }[],
        topN: number,
      ) => {
        return documents.map((d) => ({ id: d.id, score: 1 })).slice(0, topN);
      },
      backend: () => 'transformers-js' as const,
      modelId: () => 'old-model',
    };

    const result = createServer({}, db, { reranker: mockReranker });
    server = result.server;
    searchContext = result.searchContext;

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    closeDatabase(db);
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('m9k_config should accept rerankerUrl key', async () => {
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'rerankerUrl', value: '"http://localhost:8012"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.config.rerankerUrl).toBe('http://localhost:8012');
  });

  it('should hot-swap reranker when rerankerBackend changes to llama-server', async () => {
    // Mock healthy llama-server
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'bge-reranker-v2-m3-q8_0.gguf' }] }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    });

    // Verify old reranker is active
    expect(searchContext.reranker?.modelId()).toBe('old-model');

    // First set the URL
    await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'rerankerUrl', value: '"http://localhost:8012"' },
    });

    // Then switch backend to llama-server — should trigger hot-reload
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'rerankerBackend', value: '"llama-server"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);

    // Verify reranker was hot-swapped
    expect(searchContext.reranker?.backend()).toBe('llama-server');
    expect(searchContext.reranker?.modelId()).toBe('bge-reranker-v2-m3-q8_0.gguf');
  });

  it('should keep old reranker when hot-reload fails', async () => {
    // Mock unreachable llama-server
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // Verify old reranker is active
    expect(searchContext.reranker?.modelId()).toBe('old-model');

    // Set URL + backend — should fail to connect
    await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'rerankerUrl', value: '"http://localhost:9999"' },
    });
    const result = await client.callTool({
      name: 'm9k_config',
      arguments: { key: 'rerankerBackend', value: '"llama-server"' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.updated).toBe(true);
    expect(data.hotReloadFailed).toBe(true);

    // Old reranker should still be active
    expect(searchContext.reranker?.modelId()).toBe('old-model');
    expect(searchContext.reranker?.backend()).toBe('transformers-js');
  });
});

describe('MCP server — ignore project tools', () => {
  let db: Database.Database;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    // Index fixture for project-a
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'sess-a1', content, '/Users/test/project-a', '/path/a1.jsonl');
    indexConvSession(db, 'sess-a2', content, '/Users/test/project-a', '/path/a2.jsonl');

    // Index fixture for project-b
    indexConvSession(db, 'sess-b1', content, '/Users/test/project-b', '/path/b1.jsonl');

    const result = createServer({}, db);
    server = result.server;

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should register m9k_ignore_project and m9k_unignore_project tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('m9k_ignore_project');
    expect(toolNames).toContain('m9k_unignore_project');
  });

  it('m9k_ignore_project should add project to exclusion list', async () => {
    const result = await client.callTool({
      name: 'm9k_ignore_project',
      arguments: { project: '/Users/test/project-a' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.ignored).toBe(true);
    expect(data.project).toBe('/Users/test/project-a');
    expect(data.purged).toBe(false);
    expect(isProjectIgnored(db, '/Users/test/project-a')).toBe(true);
  });

  it('m9k_ignore_project with purge should delete existing data', async () => {
    // Verify data exists before
    const sessionsBefore = db
      .prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE project = ?')
      .get('/Users/test/project-a') as { cnt: number };
    expect(sessionsBefore.cnt).toBe(2);

    const result = await client.callTool({
      name: 'm9k_ignore_project',
      arguments: { project: '/Users/test/project-a', purge: true },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.ignored).toBe(true);
    expect(data.purged).toBe(true);
    expect(data.sessionsPurged).toBe(2);
    expect(data.chunksPurged).toBeGreaterThan(0);

    // project-a data should be gone
    const sessionsAfter = db
      .prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE project = ?')
      .get('/Users/test/project-a') as { cnt: number };
    expect(sessionsAfter.cnt).toBe(0);

    // project-b should be untouched
    const sessionsB = db
      .prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE project = ?')
      .get('/Users/test/project-b') as { cnt: number };
    expect(sessionsB.cnt).toBe(1);
  });

  it('m9k_ignore_project should be idempotent', async () => {
    await client.callTool({
      name: 'm9k_ignore_project',
      arguments: { project: '/Users/test/project-a' },
    });
    const result = await client.callTool({
      name: 'm9k_ignore_project',
      arguments: { project: '/Users/test/project-a' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.ignored).toBe(true);
    const list = getIgnoredProjects(db);
    expect(list.filter((p) => p.project === '/Users/test/project-a')).toHaveLength(1);
  });

  it('m9k_unignore_project should remove project from exclusion list', async () => {
    // First ignore
    await client.callTool({
      name: 'm9k_ignore_project',
      arguments: { project: '/Users/test/project-a' },
    });
    expect(isProjectIgnored(db, '/Users/test/project-a')).toBe(true);

    // Then unignore
    const result = await client.callTool({
      name: 'm9k_unignore_project',
      arguments: { project: '/Users/test/project-a' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.unignored).toBe(true);
    expect(isProjectIgnored(db, '/Users/test/project-a')).toBe(false);
  });

  it('m9k_unignore_project should handle unknown project gracefully', async () => {
    const result = await client.callTool({
      name: 'm9k_unignore_project',
      arguments: { project: '/nonexistent' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.unignored).toBe(true);
  });

  it('m9k_restart should schedule SIGTERM and return restarting response', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await client.callTool({
      name: 'm9k_restart',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.restarting).toBe(true);
    expect(data.mode).toBe('local');
    expect(data.graceful).toBe(true);

    // Kill not called yet (200ms delay)
    expect(killSpy).not.toHaveBeenCalled();

    // Advance timers
    vi.advanceTimersByTime(200);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');

    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('m9k_restart with force should schedule SIGKILL', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await client.callTool({
      name: 'm9k_restart',
      arguments: { force: true },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.restarting).toBe(true);
    expect(data.graceful).toBe(false);

    vi.advanceTimersByTime(200);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');

    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('m9k_info should show ignoredProjects count', async () => {
    ignoreProject(db, '/Users/test/project-a');

    const result = await client.callTool({
      name: 'm9k_info',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.corpus.ignoredProjects).toBe(1);
  });

  it('m9k_config should list ignored projects', async () => {
    ignoreProject(db, '/Users/test/project-a');

    const result = await client.callTool({
      name: 'm9k_config',
      arguments: {},
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.ignoredProjects).toHaveLength(1);
    expect(data.ignoredProjects[0].project).toBe('/Users/test/project-a');
  });
});
