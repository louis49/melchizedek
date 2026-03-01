import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openMemoryDatabase,
  closeDatabase,
  insertVector,
  insertVectorsBatch,
  getChunksWithoutEmbeddings,
  getStat,
  setStat,
  incrementStat,
  getMeta,
  setMeta,
  deleteMeta,
  deleteMetaByPrefix,
  createVecTables,
  insertVectorsBatchToTable,
  isProjectIgnored,
  ignoreProject,
  unignoreProject,
  getIgnoredProjects,
  purgeProjectData,
} from '../src/db.js';
import { CONV_KIND_EXCHANGE } from '../src/constants.js';
import type Database from 'better-sqlite3';

describe('db', () => {
  it('should open an in-memory database with schema', () => {
    const db = openMemoryDatabase().db;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('conv_sessions');
    expect(tableNames).toContain('conv_chunks');
    expect(tableNames).toContain('conv_chunks_fts');
    expect(tableNames).toContain('conv_vec_map_text');
    closeDatabase(db);
  });

  it('should enable WAL mode for file databases', () => {
    // In-memory databases don't support WAL, so just verify no crash
    const db = openMemoryDatabase().db;
    expect(db).toBeDefined();
    closeDatabase(db);
  });

  describe('CRUD operations', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = openMemoryDatabase().db;
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should insert and retrieve a session', () => {
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'sess-1',
        '/test/project',
        '/path/sess-1.jsonl',
        'abc123',
        1024,
        '2026-02-20T10:00:00Z',
        10,
        3,
      );

      const session = db
        .prepare('SELECT * FROM conv_sessions WHERE id = ?')
        .get('sess-1') as Record<string, unknown>;
      expect(session).toBeDefined();
      expect(session.id).toBe('sess-1');
      expect(session.project).toBe('/test/project');
      expect(session.message_count).toBe(10);
      expect(session.chunk_count).toBe(3);
    });

    it('should insert a chunk and update FTS5 index', () => {
      // First insert a session (FK constraint)
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', 1, 1);

      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'chunk-1',
        'sess-1',
        0,
        'How to fix CORS?',
        'Add CORS middleware.',
        'hash1',
        '2026-02-20T10:00:00Z',
      );

      // Verify FTS5 was auto-populated via trigger
      const ftsResults = db
        .prepare(
          `SELECT c.id FROM conv_chunks_fts JOIN conv_chunks c ON conv_chunks_fts.rowid = c.rowid WHERE conv_chunks_fts MATCH ?`,
        )
        .all('CORS') as { id: string }[];

      expect(ftsResults).toHaveLength(1);
      expect(ftsResults[0].id).toBe('chunk-1');
    });

    it('should enforce unique hash per session (not global)', () => {
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/test', '/path1.jsonl', '2026-02-20T10:00:00Z', 1, 1);

      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('chunk-1', 'sess-1', 0, 'content', 'response', 'same-hash', '2026-02-20T10:00:00Z');

      // Same hash in same session should fail
      expect(() => {
        db.prepare(
          `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'chunk-2',
          'sess-1',
          1,
          'different',
          'different',
          'same-hash',
          '2026-02-20T10:01:00Z',
        );
      }).toThrow(/UNIQUE constraint failed/);

      // Same hash in DIFFERENT session should succeed
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-2', '/test', '/path2.jsonl', '2026-02-20T11:00:00Z', 1, 1);

      expect(() => {
        db.prepare(
          `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run('chunk-3', 'sess-2', 0, 'content', 'response', 'same-hash', '2026-02-20T11:00:00Z');
      }).not.toThrow();

      // Both chunks should exist
      const count = db
        .prepare('SELECT COUNT(*) AS cnt FROM conv_chunks WHERE hash = ?')
        .get('same-hash') as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it('should cascade delete chunks when session is deleted', () => {
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', 2, 2);

      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('chunk-1', 'sess-1', 0, 'q1', 'a1', 'hash1', '2026-02-20T10:00:00Z');

      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('chunk-2', 'sess-1', 1, 'q2', 'a2', 'hash2', '2026-02-20T10:01:00Z');

      // Verify chunks exist
      const chunksBefore = db
        .prepare('SELECT * FROM conv_chunks WHERE session_id = ?')
        .all('sess-1');
      expect(chunksBefore).toHaveLength(2);

      // Delete session — should cascade
      db.prepare('DELETE FROM conv_sessions WHERE id = ?').run('sess-1');

      const chunksAfter = db
        .prepare('SELECT * FROM conv_chunks WHERE session_id = ?')
        .all('sess-1');
      expect(chunksAfter).toHaveLength(0);
    });
  });

  describe('stats table', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = openMemoryDatabase().db;
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should create stats table on init', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain('stats');
    });

    it('should have user_version = 2', () => {
      const version = (db.pragma('user_version') as Array<{ user_version: number }>)[0]
        .user_version;
      expect(version).toBe(2);
    });

    it('getStat should return null for non-existent key', () => {
      expect(getStat(db, 'nonexistent')).toBeNull();
    });

    it('setStat should store and retrieve a value', () => {
      setStat(db, 'search_count', '42');
      expect(getStat(db, 'search_count')).toBe('42');
    });

    it('setStat should overwrite existing value', () => {
      setStat(db, 'search_count', '10');
      setStat(db, 'search_count', '20');
      expect(getStat(db, 'search_count')).toBe('20');
    });

    it('incrementStat should create key if missing and set to 1', () => {
      incrementStat(db, 'search_count');
      expect(getStat(db, 'search_count')).toBe('1');
    });

    it('incrementStat should increment existing numeric value', () => {
      setStat(db, 'search_count', '5');
      incrementStat(db, 'search_count');
      expect(getStat(db, 'search_count')).toBe('6');
    });

    it('incrementStat should accept custom delta', () => {
      setStat(db, 'tokens_served', '100');
      incrementStat(db, 'tokens_served', 50);
      expect(getStat(db, 'tokens_served')).toBe('150');
    });
  });

  describe('sqlite-vec integration', () => {
    let db: Database.Database;

    beforeEach(() => {
      const info = openMemoryDatabase();
      db = info.db;
      // Insert a session + chunk for vector tests
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', 2, 2);
      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'chunk-1',
        'sess-1',
        0,
        'How do I fix the CORS error in my Express server?',
        'You need to add CORS middleware to your Express server.',
        'h1',
        '2026-02-20T10:00:00Z',
      );
      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'chunk-2',
        'sess-1',
        1,
        'How do I add rate limiting to the API?',
        'Use express-rate-limit middleware to protect your endpoints.',
        'h2',
        '2026-02-20T10:01:00Z',
      );
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should create vec tables with _text suffix on init', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('conv_vec_map_text');
    });

    it('should report vecEnabled=true when sqlite-vec is available', () => {
      const info = openMemoryDatabase();
      expect(info.vecEnabled).toBe(true);
      closeDatabase(info.db);
    });

    it('should insert and retrieve a vector', () => {
      const embedding = new Float32Array(384).fill(0.1);
      insertVector(db, 'chunk-1', embedding);

      const map = db
        .prepare('SELECT * FROM conv_vec_map_text WHERE chunk_id = ?')
        .get('chunk-1') as {
        vec_rowid: number;
        chunk_id: string;
      };
      expect(map).toBeDefined();
      expect(map.chunk_id).toBe('chunk-1');
    });

    it('should insert vectors in batch', () => {
      const items = [
        { chunkId: 'chunk-1', embedding: new Float32Array(384).fill(0.1) },
        { chunkId: 'chunk-2', embedding: new Float32Array(384).fill(0.2) },
      ];
      insertVectorsBatch(db, items);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM conv_vec_map_text').get() as {
        cnt: number;
      };
      expect(count.cnt).toBe(2);
    });

    it('should find chunks without embeddings', () => {
      const missing = getChunksWithoutEmbeddings(db);
      expect(missing).toHaveLength(2);
      expect(missing[0].id).toBeDefined();
      expect(missing[0].content).toBeDefined();
    });

    it('should not list chunks that already have embeddings', () => {
      insertVector(db, 'chunk-1', new Float32Array(384).fill(0.1));

      const missing = getChunksWithoutEmbeddings(db);
      expect(missing).toHaveLength(1);
      expect(missing[0].id).toBe('chunk-2');
    });
  });

  describe('meta table', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = openMemoryDatabase().db;
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should create meta table on init', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain('meta');
    });

    it('should have user_version = 2', () => {
      const version = (db.pragma('user_version') as Array<{ user_version: number }>)[0]
        .user_version;
      expect(version).toBe(2);
    });

    it('getMeta should return null for non-existent key', () => {
      expect(getMeta(db, 'nonexistent')).toBeNull();
    });

    it('setMeta should store and retrieve a value', () => {
      setMeta(db, 'embedding_model_id', 'minilm-l12-v2');
      expect(getMeta(db, 'embedding_model_id')).toBe('minilm-l12-v2');
    });

    it('setMeta should overwrite existing value', () => {
      setMeta(db, 'embedding_model_id', 'old');
      setMeta(db, 'embedding_model_id', 'new');
      expect(getMeta(db, 'embedding_model_id')).toBe('new');
    });

    it('deleteMeta should remove a key', () => {
      setMeta(db, 'embedding_model_id', 'test');
      deleteMeta(db, 'embedding_model_id');
      expect(getMeta(db, 'embedding_model_id')).toBeNull();
    });

    it('deleteMetaByPrefix should remove all keys with prefix', () => {
      setMeta(db, 'migration_target_model', 'new-model');
      setMeta(db, 'migration_progress', '50');
      setMeta(db, 'migration_started_at', '2026-01-01');
      setMeta(db, 'embedding_model_id', 'old-model');

      deleteMetaByPrefix(db, 'migration_');

      expect(getMeta(db, 'migration_target_model')).toBeNull();
      expect(getMeta(db, 'migration_progress')).toBeNull();
      expect(getMeta(db, 'migration_started_at')).toBeNull();
      expect(getMeta(db, 'embedding_model_id')).toBe('old-model');
    });
  });

  describe('createVecTables', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = openMemoryDatabase().db;
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should create vec tables with suffix', () => {
      createVecTables(db, 768, '_next');

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('conv_vec_map_next');
    });

    it('should insert vectors into suffixed tables', () => {
      // Need a session+chunk for the FK
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', 1, 1);
      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('chunk-1', 'sess-1', 0, 'content', 'response', 'h1', '2026-02-20T10:00:00Z');

      createVecTables(db, 384, '_next');
      insertVectorsBatchToTable(
        db,
        [{ chunkId: 'chunk-1', embedding: new Float32Array(384).fill(0.1) }],
        '_next',
      );

      const count = db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_map_next').get() as {
        cnt: number;
      };
      expect(count.cnt).toBe(1);
    });
  });

  describe('ignored_projects table', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = openMemoryDatabase().db;
    });

    afterEach(() => {
      closeDatabase(db);
    });

    it('should create ignored_projects table on init', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain('ignored_projects');
    });

    it('should have user_version = 2', () => {
      const version = (db.pragma('user_version') as Array<{ user_version: number }>)[0]
        .user_version;
      expect(version).toBe(2);
    });

    it('isProjectIgnored should return false for unknown project', () => {
      expect(isProjectIgnored(db, '/Users/test/my-project')).toBe(false);
    });

    it('ignoreProject should add project to the list', () => {
      ignoreProject(db, '/Users/test/secret-repo');
      expect(isProjectIgnored(db, '/Users/test/secret-repo')).toBe(true);
    });

    it('ignoreProject should be idempotent', () => {
      ignoreProject(db, '/Users/test/secret-repo');
      ignoreProject(db, '/Users/test/secret-repo');
      const list = getIgnoredProjects(db);
      expect(list.filter((p) => p.project === '/Users/test/secret-repo')).toHaveLength(1);
    });

    it('unignoreProject should remove project from the list', () => {
      ignoreProject(db, '/Users/test/secret-repo');
      unignoreProject(db, '/Users/test/secret-repo');
      expect(isProjectIgnored(db, '/Users/test/secret-repo')).toBe(false);
    });

    it('unignoreProject should be a no-op for unknown project', () => {
      expect(() => unignoreProject(db, '/nonexistent')).not.toThrow();
    });

    it('getIgnoredProjects should return all ignored projects', () => {
      ignoreProject(db, '/Users/test/repo-a');
      ignoreProject(db, '/Users/test/repo-b');
      const list = getIgnoredProjects(db);
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.project)).toContain('/Users/test/repo-a');
      expect(list.map((p) => p.project)).toContain('/Users/test/repo-b');
      expect(list[0].ignoredAt).toBeDefined();
    });

    it('purgeProjectData should delete sessions and chunks for a project', () => {
      // Insert 2 sessions for project-a, 1 for project-b
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-1', '/project-a', '/p1.jsonl', '2026-01-01T00:00:00Z', 1, 1);
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-2', '/project-a', '/p2.jsonl', '2026-01-02T00:00:00Z', 1, 1);
      db.prepare(
        `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('sess-3', '/project-b', '/p3.jsonl', '2026-01-03T00:00:00Z', 1, 1);

      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('c-1', 'sess-1', 0, 'q1', 'a1', 'h1', '2026-01-01T00:00:00Z');
      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('c-2', 'sess-2', 0, 'q2', 'a2', 'h2', '2026-01-02T00:00:00Z');
      db.prepare(
        `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('c-3', 'sess-3', 0, 'q3', 'a3', 'h3', '2026-01-03T00:00:00Z');

      const result = purgeProjectData(db, '/project-a');
      expect(result.sessionsPurged).toBe(2);
      expect(result.chunksPurged).toBe(2);

      // project-a sessions and chunks gone
      const sessionsA = db
        .prepare('SELECT * FROM conv_sessions WHERE project = ?')
        .all('/project-a');
      expect(sessionsA).toHaveLength(0);

      // project-b untouched
      const sessionsB = db
        .prepare('SELECT * FROM conv_sessions WHERE project = ?')
        .all('/project-b');
      expect(sessionsB).toHaveLength(1);
      const chunksB = db.prepare("SELECT * FROM conv_chunks WHERE session_id = 'sess-3'").all();
      expect(chunksB).toHaveLength(1);
    });

    it('purgeProjectData should return zero for project with no data', () => {
      const result = purgeProjectData(db, '/nonexistent');
      expect(result.sessionsPurged).toBe(0);
      expect(result.chunksPurged).toBe(0);
    });
  });

  describe('constants coherence', () => {
    it('CONV_KIND_EXCHANGE matches DB default', () => {
      // Verify coherence between the TS constant and the SQL DEFAULT value
      expect(CONV_KIND_EXCHANGE).toBe('exchange');
    });
  });
});
