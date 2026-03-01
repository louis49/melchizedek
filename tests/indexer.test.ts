import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseJSONL,
  stripPrivateTags,
  chunkMessages,
  isToolResultMessage,
  extractTextContent,
  extractProjectFromJsonl,
  indexConvSession,
  backfillExistingSessions,
  embedChunks,
  detectOrphanedSessions,
} from '../src/indexer.js';
import {
  openMemoryDatabase,
  closeDatabase,
  getChunksWithoutEmbeddings,
  ignoreProject,
} from '../src/db.js';
import type Database from 'better-sqlite3';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

describe('parseJSONL', () => {
  it('should parse a normal session', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].type).toBe('user');
  });

  it('should handle empty file', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'empty.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    expect(messages).toEqual([]);
  });

  it('should skip malformed lines without crashing', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'malformed.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    // Should have parsed the valid lines only
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.type === 'user' || m.type === 'assistant')).toBe(true);
  });

  it('should handle truncated session', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'truncated_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('should filter out non-user/assistant types', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    expect(messages.every((m) => m.type === 'user' || m.type === 'assistant')).toBe(true);
  });
});

describe('stripPrivateTags', () => {
  it('should replace private tags with [REDACTED]', () => {
    const input = 'before <private>secret data</private> after';
    expect(stripPrivateTags(input)).toBe('before [REDACTED] after');
  });

  it('should handle multiple private tags', () => {
    const input = '<private>a</private> middle <private>b</private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED] middle [REDACTED]');
  });

  it('should handle multiline private content', () => {
    const input = '<private>line1\nline2\nline3</private>';
    expect(stripPrivateTags(input)).toBe('[REDACTED]');
  });

  it('should return unchanged text without private tags', () => {
    const input = 'no secrets here';
    expect(stripPrivateTags(input)).toBe('no secrets here');
  });
});

describe('extractTextContent', () => {
  it('should extract from plain string', () => {
    expect(extractTextContent('hello')).toBe('hello');
  });

  it('should extract from content array', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      { type: 'text', text: 'second' },
    ];
    expect(extractTextContent(content)).toBe('first\nsecond');
  });
});

describe('chunkMessages', () => {
  it('should create 3 chunks from normal session (grouping tool_result turns)', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const chunks = chunkMessages(messages);
    expect(chunks).toHaveLength(3);

    // Chunk 0: CORS — 4 assistant texts fused
    expect(chunks[0].userContent).toContain('CORS');
    expect(chunks[0].assistantContent).toContain('Express server configuration');
    expect(chunks[0].assistantContent).toContain('missing CORS middleware');
    expect(chunks[0].assistantContent).toContain('install the cors package');
    expect(chunks[0].assistantContent).toContain('CORS middleware is now installed');

    // Chunk 1: rate limiting — 2 assistant texts fused (a-006 has no text)
    expect(chunks[1].userContent).toContain('rate limiting');
    expect(chunks[1].assistantContent).toContain('express-rate-limit');
    expect(chunks[1].assistantContent).toContain('100 requests per 15-minute');

    // Chunk 2: health check — 1 assistant text (a-008 has no text)
    expect(chunks[2].userContent).toContain('health check');
    expect(chunks[2].assistantContent).toContain('GET /health');
  });

  it('should not create chunks for tool_result user messages', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const chunks = chunkMessages(messages);
    // Only real user messages create chunks, not tool_result auto-responses
    for (const chunk of chunks) {
      expect(chunk.userContent).not.toBe('');
    }
    expect(chunks).toHaveLength(3);
  });

  it('should strip private tags in chunks', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const chunks = chunkMessages(messages);
    for (const chunk of chunks) {
      expect(chunk.userContent).not.toContain('<private>');
      expect(chunk.assistantContent).not.toContain('<private>');
    }
  });

  it('should produce deterministic hashes (idempotent)', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const chunks1 = chunkMessages(messages);
    const chunks2 = chunkMessages(messages);
    expect(chunks1.map((c) => c.hash)).toEqual(chunks2.map((c) => c.hash));
  });

  it('should extract and deduplicate metadata from all assistant messages', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const chunks = chunkMessages(messages);
    // Chunk 0: Read (a-001), Edit (a-002), Bash (a-003) — all fused
    expect(chunks[0].metadata.toolCalls).toContain('Read');
    expect(chunks[0].metadata.toolCalls).toContain('Edit');
    expect(chunks[0].metadata.toolCalls).toContain('Bash');
    // filePaths should include src/server.ts (deduplicated)
    expect(chunks[0].metadata.filePaths).toContain('src/server.ts');
    expect(new Set(chunks[0].metadata.filePaths).size).toBe(chunks[0].metadata.filePaths.length);
  });
});

describe('isToolResultMessage', () => {
  it('should return true for tool_result user messages', () => {
    const msg = {
      type: 'user' as const,
      uuid: 'u-1',
      parentUuid: null,
      sessionId: 'sess',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/test',
      message: {
        role: 'user' as const,
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
    };
    expect(isToolResultMessage(msg)).toBe(true);
  });

  it('should return false for real user messages', () => {
    const msg = {
      type: 'user' as const,
      uuid: 'u-1',
      parentUuid: null,
      sessionId: 'sess',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/test',
      message: {
        role: 'user' as const,
        content: 'Hello world',
      },
    };
    expect(isToolResultMessage(msg)).toBe(false);
  });

  it('should return false for assistant messages', () => {
    const msg = {
      type: 'assistant' as const,
      uuid: 'a-1',
      parentUuid: null,
      sessionId: 'sess',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/test',
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text', text: 'Hello' }],
      },
    };
    expect(isToolResultMessage(msg)).toBe(false);
  });
});

describe('indexConvSession', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should index a normal session into the database', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    // Check session was created
    const sessions = db.prepare('SELECT * FROM conv_sessions').all() as Array<
      Record<string, unknown>
    >;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(sessions[0].project).toBe('/Users/test/my-project');

    // Check chunks were created
    const chunks = db.prepare('SELECT * FROM conv_chunks ORDER BY idx').all() as Array<
      Record<string, unknown>
    >;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].session_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(chunks[0].kind).toBe('exchange');
  });

  it('should populate FTS5 index', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    // Search for "CORS" which appears in the fixture
    const results = db
      .prepare(
        `SELECT c.id FROM conv_chunks_fts JOIN conv_chunks c ON conv_chunks_fts.rowid = c.rowid WHERE conv_chunks_fts MATCH ?`,
      )
      .all('CORS') as Array<{ id: string }>;
    expect(results.length).toBeGreaterThan(0);
  });

  it('should be idempotent — re-indexing same content produces same result', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');

    indexConvSession(db, 'sess-1', content, '/test', '/path/sess-1.jsonl');
    const chunksAfterFirst = db.prepare('SELECT * FROM conv_chunks').all();

    // Re-index same session — should not duplicate
    indexConvSession(db, 'sess-1', content, '/test', '/path/sess-1.jsonl');
    const chunksAfterSecond = db.prepare('SELECT * FROM conv_chunks').all();

    expect(chunksAfterSecond).toHaveLength(chunksAfterFirst.length);
  });

  it('should strip private tags before storing', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    indexConvSession(
      db,
      '880e8400-e29b-41d4-a716-446655440003',
      content,
      '/Users/test/secret-project',
      '/path/to/private.jsonl',
    );

    const chunks = db
      .prepare('SELECT user_content, assistant_content FROM conv_chunks')
      .all() as Array<{
      user_content: string;
      assistant_content: string;
    }>;

    for (const chunk of chunks) {
      expect(chunk.user_content).not.toContain('<private>');
      expect(chunk.assistant_content).not.toContain('<private>');
    }
  });

  it('should skip empty JSONL content (no ghost session)', () => {
    const result = indexConvSession(db, 'empty-sess', '', '/test', '/path/empty.jsonl');
    expect(result).toBe('skipped');

    const sessions = db.prepare('SELECT * FROM conv_sessions').all();
    expect(sessions).toHaveLength(0);
  });

  it('should skip JSONL with only non-user/assistant messages (no ghost session)', () => {
    const content = [
      '{"type":"file-history-snapshot","uuid":"a","timestamp":"2026-02-25T10:00:00Z","sessionId":"snap-sess"}',
      '{"type":"file-history-snapshot","uuid":"b","timestamp":"2026-02-25T10:01:00Z","sessionId":"snap-sess"}',
    ].join('\n');

    const result = indexConvSession(db, 'snap-sess', content, '/test', '/path/snap.jsonl');
    expect(result).toBe('skipped');

    const sessions = db.prepare('SELECT * FROM conv_sessions').all();
    expect(sessions).toHaveLength(0);
  });

  it('should skip re-indexing when file content is unchanged', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const result1 = indexConvSession(db, 'sess-1', content, '/test', '/path/sess-1.jsonl');
    expect(result1).toBe('indexed');

    const result2 = indexConvSession(db, 'sess-1', content, '/test', '/path/sess-1.jsonl');
    expect(result2).toBe('skipped');
  });

  it('should re-index when file content changes', () => {
    const content1 = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const result1 = indexConvSession(db, 'sess-1', content1, '/test', '/path/sess-1.jsonl');
    expect(result1).toBe('indexed');

    const content2 = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    const result2 = indexConvSession(db, 'sess-1', content2, '/test', '/path/sess-1.jsonl');
    expect(result2).toBe('indexed');
  });

  it('should skip re-indexing when session has deleted_at tombstone', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const result1 = indexConvSession(
      db,
      'sess-tombstone',
      content,
      '/test',
      '/path/tombstone.jsonl',
    );
    expect(result1).toBe('indexed');

    // Simulate soft delete: set deleted_at, clear chunks
    db.prepare('DELETE FROM conv_chunks WHERE session_id = ?').run('sess-tombstone');
    db.prepare(
      "UPDATE conv_sessions SET deleted_at = datetime('now'), chunk_count = 0 WHERE id = ?",
    ).run('sess-tombstone');

    // Re-index with same content — should be skipped due to tombstone
    const result2 = indexConvSession(
      db,
      'sess-tombstone',
      content,
      '/test',
      '/path/tombstone.jsonl',
    );
    expect(result2).toBe('skipped');

    // Re-index with different content — should STILL be skipped (tombstone takes priority)
    const content2 = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    const result3 = indexConvSession(
      db,
      'sess-tombstone',
      content2,
      '/test',
      '/path/tombstone.jsonl',
    );
    expect(result3).toBe('skipped');

    // Chunks should still be empty
    const chunks = db
      .prepare('SELECT COUNT(*) AS cnt FROM conv_chunks WHERE session_id = ?')
      .get('sess-tombstone') as { cnt: number };
    expect(chunks.cnt).toBe(0);
  });

  it('should preserve soft-deleted chunks on re-index', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'sess-forget', content, '/test', '/path/forget.jsonl');

    const chunksBefore = db
      .prepare('SELECT id FROM conv_chunks WHERE session_id = ?')
      .all('sess-forget') as Array<{ id: string }>;
    expect(chunksBefore.length).toBeGreaterThan(0);

    // Soft-delete the first chunk
    const forgottenId = chunksBefore[0].id;
    db.prepare("UPDATE conv_chunks SET deleted_at = datetime('now') WHERE id = ?").run(forgottenId);

    // Re-index with slightly different content (force re-index via different hash)
    indexConvSession(db, 'sess-forget', content + '\n', '/test', '/path/forget.jsonl');

    // Soft-deleted chunk should still exist with deleted_at set
    const forgotten = db
      .prepare('SELECT deleted_at FROM conv_chunks WHERE id = ?')
      .get(forgottenId) as {
      deleted_at: string | null;
    };
    expect(forgotten.deleted_at).toBeTruthy();

    // Other chunks should still be present (re-indexed)
    const chunksAfter = db
      .prepare('SELECT id FROM conv_chunks WHERE session_id = ? AND deleted_at IS NULL')
      .all('sess-forget') as Array<{ id: string }>;
    // Should have at least some non-deleted chunks (re-indexed ones minus the forgotten one)
    expect(chunksAfter.length).toBeGreaterThan(0);
    expect(chunksAfter.every((c) => c.id !== forgottenId)).toBe(true);
  });

  it('should update session metadata on re-index with different content', () => {
    const content1 = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'sess-1', content1, '/test', '/path/sess-1.jsonl');

    db.prepare('SELECT chunk_count FROM conv_sessions WHERE id = ?').get('sess-1');

    // Re-index with different content (private_tags fixture has a different session but we force the same ID)
    const content2 = readFileSync(join(FIXTURES_DIR, 'private_tags.jsonl'), 'utf8');
    indexConvSession(db, 'sess-1', content2, '/test', '/path/sess-1.jsonl');

    const session2 = db
      .prepare('SELECT chunk_count FROM conv_sessions WHERE id = ?')
      .get('sess-1') as {
      chunk_count: number;
    };
    // Should update, not crash
    expect(session2.chunk_count).toBeGreaterThanOrEqual(0);
    // Chunk count may differ since content changed
    expect(typeof session2.chunk_count).toBe('number');
  });
});

describe('extractProjectFromJsonl', () => {
  it('should extract cwd from first message', () => {
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    const messages = parseJSONL(content);
    const project = extractProjectFromJsonl(messages);
    expect(project).toBeDefined();
    expect(typeof project).toBe('string');
  });

  it('should return undefined for empty messages', () => {
    expect(extractProjectFromJsonl([])).toBeUndefined();
  });
});

describe('backfillExistingSessions', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    tmpDir = join(tmpdir(), `melchizedek-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return zeros for non-existent directory', () => {
    const result = backfillExistingSessions(db, '/tmp/does-not-exist-' + Date.now());
    expect(result).toEqual({ scanned: 0, indexed: 0, skipped: 0, errors: 0 });
  });

  it('should index JSONL files from project directories', () => {
    const projectDir = join(tmpDir, '-Users-test-my-project');
    mkdirSync(projectDir, { recursive: true });

    const fixture = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    writeFileSync(join(projectDir, 'sess-abc.jsonl'), fixture);

    const result = backfillExistingSessions(db, tmpDir);
    expect(result.scanned).toBe(1);
    expect(result.indexed).toBe(1);
    expect(result.errors).toBe(0);

    const sessions = db.prepare('SELECT * FROM conv_sessions').all();
    expect(sessions).toHaveLength(1);
  });

  it('should skip non-JSONL files', () => {
    const projectDir = join(tmpDir, '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, 'README.md'), '# Not a JSONL');
    writeFileSync(join(projectDir, 'notes.txt'), 'Just text');

    const result = backfillExistingSessions(db, tmpDir);
    expect(result.scanned).toBe(0);
  });

  it('should handle malformed JSONL without crashing', () => {
    const projectDir = join(tmpDir, '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, 'bad.jsonl'), 'this is not json\n{broken}');

    const result = backfillExistingSessions(db, tmpDir);
    expect(result.scanned).toBe(1);
    // Indexes with 0 chunks (empty session) — not an error
    expect(result.errors).toBe(0);
  });

  it('should clean up ghost sessions (message_count=0) after backfill', () => {
    // Pre-insert a ghost session (simulates old buggy backfill)
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 0, 0)`,
    ).run('ghost-sess', '-Users-test-encoded-path', '/path/ghost.jsonl', 'deadbeef', 0);

    const beforeCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM conv_sessions').get() as { cnt: number }
    ).cnt;
    expect(beforeCount).toBe(1);

    backfillExistingSessions(db, tmpDir);

    const afterCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM conv_sessions').get() as { cnt: number }
    ).cnt;
    expect(afterCount).toBe(0); // Ghost session cleaned up
  });

  it('should not clean up __manual_memories__ session', () => {
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 0, 0)`,
    ).run('__manual_memories__', '__global__', '__manual__', '', 0);

    backfillExistingSessions(db, tmpDir);

    const session = db
      .prepare('SELECT id FROM conv_sessions WHERE id = ?')
      .get('__manual_memories__');
    expect(session).toBeDefined();
  });

  it('should skip ignored projects during backfill', () => {
    // The fixture normal_session.jsonl has cwd="/Users/test/my-project"
    const projectDir = join(tmpDir, '-Users-test-my-project');
    mkdirSync(projectDir, { recursive: true });

    const fixture = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    writeFileSync(join(projectDir, 'sess-1.jsonl'), fixture);

    // Ignore the project before backfill (matches the cwd in the fixture)
    ignoreProject(db, '/Users/test/my-project');

    const result = backfillExistingSessions(db, tmpDir);
    expect(result.scanned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);

    // No sessions should be indexed
    const sessions = db.prepare('SELECT * FROM conv_sessions').all();
    expect(sessions).toHaveLength(0);
  });

  it('should be idempotent — second run skips already indexed', () => {
    const projectDir = join(tmpDir, '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });

    const fixture = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    writeFileSync(join(projectDir, 'sess-1.jsonl'), fixture);

    const result1 = backfillExistingSessions(db, tmpDir);
    expect(result1.indexed).toBe(1);
    expect(result1.skipped).toBe(0);

    const result2 = backfillExistingSessions(db, tmpDir);
    expect(result2.indexed).toBe(0);
    expect(result2.skipped).toBe(1);
  });
});

describe('detectOrphanedSessions', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    tmpDir = join(tmpdir(), `melchizedek-orphan-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect orphaned sessions (JSONL absent)', () => {
    // Insert a session pointing to a non-existent file
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('orphan-sess', '/test', '/tmp/does-not-exist.jsonl', 'abc123', 100);

    const result = detectOrphanedSessions(db, false);
    expect(result.orphanedCount).toBe(1);
    expect(result.purgedCount).toBe(0);

    // Session should still exist (not purged)
    const session = db.prepare('SELECT id FROM conv_sessions WHERE id = ?').get('orphan-sess');
    expect(session).toBeDefined();
  });

  it('should not count sessions with existing JSONL', () => {
    const jsonlPath = join(tmpDir, 'existing.jsonl');
    writeFileSync(jsonlPath, '');

    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('alive-sess', '/test', jsonlPath, 'abc123', 100);

    const result = detectOrphanedSessions(db, false);
    expect(result.orphanedCount).toBe(0);
    expect(result.purgedCount).toBe(0);
  });

  it('should purge orphaned sessions when purge=true', () => {
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('orphan-sess', '/test', '/tmp/does-not-exist.jsonl', 'abc123', 100);

    const result = detectOrphanedSessions(db, true);
    expect(result.orphanedCount).toBe(1);
    expect(result.purgedCount).toBe(1);

    // Session should be gone
    const session = db.prepare('SELECT id FROM conv_sessions WHERE id = ?').get('orphan-sess');
    expect(session).toBeUndefined();
  });

  it('should never touch __manual_memories__', () => {
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 0, 0)`,
    ).run('__manual_memories__', '__global__', '__manual__', '', 0);

    const result = detectOrphanedSessions(db, true);
    expect(result.orphanedCount).toBe(0);
    expect(result.purgedCount).toBe(0);

    const session = db
      .prepare('SELECT id FROM conv_sessions WHERE id = ?')
      .get('__manual_memories__');
    expect(session).toBeDefined();
  });

  it('should handle mix of orphaned and alive sessions', () => {
    const jsonlPath = join(tmpDir, 'alive.jsonl');
    writeFileSync(jsonlPath, '');

    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('alive-sess', '/test', jsonlPath, 'abc', 100);

    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('orphan-1', '/test', '/tmp/gone1.jsonl', 'def', 100);

    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, datetime('now'), 5, 2)`,
    ).run('orphan-2', '/test', '/tmp/gone2.jsonl', 'ghi', 100);

    const result = detectOrphanedSessions(db, false);
    expect(result.orphanedCount).toBe(2);
    expect(result.purgedCount).toBe(0);

    // All sessions still exist
    const sessions = db.prepare('SELECT COUNT(*) AS cnt FROM conv_sessions').get() as {
      cnt: number;
    };
    expect(sessions.cnt).toBe(3);
  });
});

describe('embedChunks', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'test-sess', content, '/test', '/path.jsonl');
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should embed all chunks without embeddings', async () => {
    const mockEmbedder = {
      embed: async () => new Float32Array(384).fill(0.1),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)),
      dimensions: () => 384,
      modelId: () => 'mock-embedder',
      maxInputChars: () => 2000,
    };

    const missingBefore = getChunksWithoutEmbeddings(db);
    expect(missingBefore.length).toBeGreaterThan(0);

    const count = await embedChunks(db, mockEmbedder);
    expect(count).toBe(missingBefore.length);

    const missingAfter = getChunksWithoutEmbeddings(db);
    expect(missingAfter).toHaveLength(0);
  });

  it('should call onProgress callback with increasing (done, total)', async () => {
    const mockEmbedder = {
      embed: async () => new Float32Array(384).fill(0.1),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)),
      dimensions: () => 384,
      modelId: () => 'mock-embedder',
      maxInputChars: () => 2000,
    };

    const calls: Array<{ done: number; total: number }> = [];
    await embedChunks(db, mockEmbedder, '_text', 2, (done, total) => {
      calls.push({ done, total });
    });

    expect(calls.length).toBeGreaterThan(0);
    // Each call should have done <= total
    for (const call of calls) {
      expect(call.done).toBeLessThanOrEqual(call.total);
      expect(call.total).toBeGreaterThan(0);
    }
    // done should be monotonically increasing
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].done).toBeGreaterThan(calls[i - 1].done);
    }
    // Last call should have done === total
    expect(calls[calls.length - 1].done).toBe(calls[calls.length - 1].total);
  });

  it('should be idempotent — second run embeds 0 chunks', async () => {
    const mockEmbedder = {
      embed: async () => new Float32Array(384).fill(0.1),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)),
      dimensions: () => 384,
      modelId: () => 'mock-embedder',
      maxInputChars: () => 2000,
    };

    await embedChunks(db, mockEmbedder);
    const count = await embedChunks(db, mockEmbedder);
    expect(count).toBe(0);
  });
});
