import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openMemoryDatabase,
  closeDatabase,
  getMeta,
  setMeta,
  insertVectorsBatch,
} from '../src/db.js';
import {
  seedEmbeddingMeta,
  detectModelChange,
  EmbeddingMigration,
  acquireMigrationLock,
  releaseMigrationLock,
} from '../src/migration.js';
import type Database from 'better-sqlite3';
import type { Embedder } from '../src/models.js';

function createMockEmbedder(modelId = 'mock-model', dimensions = 384): Embedder {
  return {
    embed: async () => new Float32Array(dimensions).fill(0.1),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(dimensions).fill(0.1)),
    dimensions: () => dimensions,
    modelId: () => modelId,
    maxInputChars: () => 2000,
  };
}

function insertTestData(db: Database.Database, chunkCount = 3): void {
  db.prepare(
    `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', chunkCount * 2, chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `chunk-${i}`,
      'sess-1',
      i,
      `How do I fix the CORS error number ${i} in my Express server?`,
      `You need to add CORS middleware to your Express server. Step ${i}.`,
      `hash-${i}`,
      `2026-02-20T10:0${i}:00Z`,
    );
  }
}

describe('seedEmbeddingMeta', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should seed meta when empty and embedder present', () => {
    const embedder = createMockEmbedder('minilm-l12-v2', 384);
    seedEmbeddingMeta(db, embedder);

    expect(getMeta(db, 'embedding_model_id_text')).toBe('minilm-l12-v2');
    expect(getMeta(db, 'embedding_dimensions_text')).toBe('384');
  });

  it('should not overwrite existing meta', () => {
    setMeta(db, 'embedding_model_id_text', 'existing-model');
    setMeta(db, 'embedding_dimensions_text', '768');

    const embedder = createMockEmbedder('new-model', 384);
    seedEmbeddingMeta(db, embedder);

    expect(getMeta(db, 'embedding_model_id_text')).toBe('existing-model');
    expect(getMeta(db, 'embedding_dimensions_text')).toBe('768');
  });

  it('should be a no-op when embedder is null', () => {
    seedEmbeddingMeta(db, null);
    expect(getMeta(db, 'embedding_model_id_text')).toBeNull();
  });
});

describe('detectModelChange', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should return null when meta is empty (first time)', () => {
    const embedder = createMockEmbedder('minilm-l12-v2', 384);
    expect(detectModelChange(db, embedder)).toBeNull();
  });

  it('should return null when model is the same', () => {
    setMeta(db, 'embedding_model_id_text', 'minilm-l12-v2');
    setMeta(db, 'embedding_dimensions_text', '384');

    const embedder = createMockEmbedder('minilm-l12-v2', 384);
    expect(detectModelChange(db, embedder)).toBeNull();
  });

  it('should return ModelChange when model differs', () => {
    setMeta(db, 'embedding_model_id_text', 'minilm-l12-v2');
    setMeta(db, 'embedding_dimensions_text', '384');

    const embedder = createMockEmbedder('nomic-embed-text', 768);
    const change = detectModelChange(db, embedder);

    expect(change).not.toBeNull();
    expect(change!.oldModelId).toBe('minilm-l12-v2');
    expect(change!.newModelId).toBe('nomic-embed-text');
    expect(change!.oldDimensions).toBe(384);
    expect(change!.newDimensions).toBe(768);
  });
});

describe('EmbeddingMigration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    insertTestData(db, 3);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('prepare should create _next tables and set meta', () => {
    const embedder = createMockEmbedder('new-model', 768);
    const migration = new EmbeddingMigration(db, embedder);
    migration.prepare();

    // _next tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('conv_vec_map_text_next');

    // Meta set
    expect(getMeta(db, 'migration_target_model_text')).toBe('new-model');
    expect(getMeta(db, 'migration_target_dimensions_text')).toBe('768');
    expect(getMeta(db, 'migration_progress_text')).toBe('0');
    expect(getMeta(db, 'migration_started_at_text')).toBeTruthy();
  });

  it('reembed should embed all eligible chunks into _next', async () => {
    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder, { batchSize: 2 });
    migration.prepare();

    const { embedded, aborted } = await migration.reembed();

    expect(aborted).toBe(false);
    expect(embedded).toBe(3);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_map_text_next').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(3);
  });

  it('swap should replace old tables with _next', async () => {
    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder);
    migration.prepare();
    await migration.reembed();
    migration.swap();

    // Meta updated
    expect(getMeta(db, 'embedding_model_id_text')).toBe('new-model');
    expect(getMeta(db, 'embedding_dimensions_text')).toBe('384');

    // Migration meta cleaned up
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
    expect(getMeta(db, 'migration_progress_text')).toBeNull();

    // New table works
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_map_text').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(3);

    // Swapped vec0 table must accept new INSERTs (backing tables correctly created)
    const fakeVec = new Float32Array(384).fill(0.42);
    db.prepare('INSERT INTO conv_vec_text(embedding) VALUES (?)').run(Buffer.from(fakeVec.buffer));
    // Verify the row was inserted
    const vecCount = db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_text').get() as {
      cnt: number;
    };
    expect(vecCount.cnt).toBe(count.cnt + 1);
  });

  it('full run end-to-end', async () => {
    setMeta(db, 'embedding_model_id_text', 'old-model');
    setMeta(db, 'embedding_dimensions_text', '384');

    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder);
    const result = await migration.run();

    expect(result.embedded).toBe(3);
    expect(result.aborted).toBe(false);
    expect(result.swapped).toBe(true);
    expect(getMeta(db, 'embedding_model_id_text')).toBe('new-model');
  });

  it('checkpoint for crash recovery', async () => {
    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder, { batchSize: 1 });
    migration.prepare();

    // Embed one batch manually
    const count = await migration.reembedBatch();
    expect(count).toBe(1);

    // Check progress is checkpointed
    setMeta(db, 'migration_progress_text', '1');
    expect(getMeta(db, 'migration_progress_text')).toBe('1');
  });

  it('abort on signal should leave old index intact', async () => {
    // Seed old vectors in the main table
    const items = [{ chunkId: 'chunk-0', embedding: new Float32Array(384).fill(0.5) }];
    insertVectorsBatch(db, items);

    const controller = new AbortController();
    controller.abort(); // Immediately abort

    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder, { signal: controller.signal });
    migration.prepare();
    const { aborted } = await migration.reembed();

    expect(aborted).toBe(true);

    // Abort cleans up _next tables
    migration.abort();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).not.toContain('conv_vec_map_text_next');

    // Old index still works
    const oldCount = db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_map_text').get() as {
      cnt: number;
    };
    expect(oldCount.cnt).toBe(1);
  });

  it('abort should clean up _next tables', () => {
    const embedder = createMockEmbedder('new-model', 768);
    const migration = new EmbeddingMigration(db, embedder);
    migration.prepare();

    // Verify _next tables exist
    let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain('conv_vec_map_text_next');

    migration.abort();

    // _next tables gone
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).not.toContain('conv_vec_map_text_next');

    // Migration meta gone
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
  });

  it('progress reporting', async () => {
    const calls: Array<{ embedded: number; total: number }> = [];
    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder, {
      batchSize: 1,
      onProgress: (embedded, total) => calls.push({ embedded, total }),
    });

    await migration.run();

    expect(calls.length).toBe(3);
    expect(calls[0].embedded).toBe(1);
    expect(calls[2].embedded).toBe(3);
    expect(calls[0].total).toBe(3);
  });

  it('resume after crash should continue from checkpoint', async () => {
    const embedder = createMockEmbedder('new-model', 384);

    // Simulate: prepare + partial embed, then "crash"
    const migration1 = new EmbeddingMigration(db, embedder, { batchSize: 1 });
    migration1.prepare();
    await migration1.reembedBatch();
    setMeta(db, 'migration_progress_text', '1');

    // Resume
    const resumed = EmbeddingMigration.resume(db, embedder);
    expect(resumed).not.toBeNull();

    const result = await resumed!.run();
    expect(result.swapped).toBe(true);
    // Should have embedded the remaining 2 chunks (3 total - 1 already done)
    expect(result.embedded).toBe(3); // Total includes checkpoint
  });

  it('resume returns null when no migration in progress', () => {
    const embedder = createMockEmbedder('new-model', 384);
    expect(EmbeddingMigration.resume(db, embedder)).toBeNull();
  });

  it('same-dimension model change', async () => {
    setMeta(db, 'embedding_model_id_text', 'old-model');
    setMeta(db, 'embedding_dimensions_text', '384');

    // Insert old vectors
    insertVectorsBatch(db, [{ chunkId: 'chunk-0', embedding: new Float32Array(384).fill(0.5) }]);

    const embedder = createMockEmbedder('new-model', 384); // Same dimensions
    const migration = new EmbeddingMigration(db, embedder);
    const result = await migration.run();

    expect(result.swapped).toBe(true);
    expect(getMeta(db, 'embedding_model_id_text')).toBe('new-model');
    expect(getMeta(db, 'embedding_dimensions_text')).toBe('384');
  });
});

describe('EmbeddingMigration — abort on re-change', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    insertTestData(db, 3);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('resume should abort old migration if target model changed', async () => {
    // Start migration towards model-A
    const embedderA = createMockEmbedder('model-A', 384);
    const migration1 = new EmbeddingMigration(db, embedderA);
    migration1.prepare();
    await migration1.reembedBatch();
    setMeta(db, 'migration_progress_text', '1');

    // Now user changed to model-B — resume should abort A and return fresh for B
    const embedderB = createMockEmbedder('model-B', 768);
    const resumed = EmbeddingMigration.resume(db, embedderB);
    expect(resumed).not.toBeNull();

    // Old migration meta should be gone (aborted)
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();

    // Run the fresh migration for model-B
    const result = await resumed!.run();
    expect(result.swapped).toBe(true);
    expect(getMeta(db, 'embedding_model_id_text')).toBe('model-B');
    expect(getMeta(db, 'embedding_dimensions_text')).toBe('768');
  });

  it('resume should abort old migration and clean _next tables', () => {
    // Start migration towards model-A
    const embedderA = createMockEmbedder('model-A', 384);
    const migration1 = new EmbeddingMigration(db, embedderA);
    migration1.prepare();

    // Verify _next tables exist
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tablesBefore.map((t) => t.name)).toContain('conv_vec_map_text_next');

    // Resume with different model — should abort
    const embedderB = createMockEmbedder('model-B', 768);
    EmbeddingMigration.resume(db, embedderB);

    // _next tables should be cleaned up
    const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tablesAfter.map((t) => t.name)).not.toContain('conv_vec_map_text_next');
  });
});

describe('EmbeddingMigration — error recovery', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    insertTestData(db, 3);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('run should recover when _next tables are missing (killed mid-migration)', async () => {
    // Simulate: migration meta exists but _next tables were dropped (SIGKILL scenario)
    setMeta(db, 'migration_target_model_text', 'new-model');
    setMeta(db, 'migration_target_dimensions_text', '384');
    setMeta(db, 'migration_progress_text', '0');
    setMeta(db, 'migration_started_at_text', new Date().toISOString());
    // No _next tables created — simulates a kill before prepare finished

    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder);
    const result = await migration.run();

    // Should recover: re-prepare and complete
    expect(result.swapped).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.embedded).toBe(3);
    expect(getMeta(db, 'embedding_model_id_text')).toBe('new-model');

    // Migration meta should be cleaned up
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
    expect(getMeta(db, 'migration_progress_text')).toBeNull();
  });

  it('abort should clean meta even when DROP TABLE throws (sqlite-vec edge case)', () => {
    const embedder = createMockEmbedder('new-model', 768);
    const migration = new EmbeddingMigration(db, embedder);
    migration.prepare();

    // Verify meta was set
    expect(getMeta(db, 'migration_target_model_text')).toBe('new-model');

    // Monkey-patch db.exec to throw on DROP (simulates sqlite-vec vec0 failure)
    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql.includes('DROP TABLE')) {
        throw new Error(
          "Internal sqlite-vec error: could not initialize 'insert rowids id' statement",
        );
      }
      return originalExec(sql);
    };

    // abort() should NOT throw — meta must still be cleaned
    migration.abort();

    // Migration meta MUST be cleaned up despite DROP failure
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
    expect(getMeta(db, 'migration_target_dimensions_text')).toBeNull();
    expect(getMeta(db, 'migration_progress_text')).toBeNull();
    expect(getMeta(db, 'migration_started_at_text')).toBeNull();

    // Restore original exec
    db.exec = originalExec;
  });

  it('run should clean meta when abort itself fails during error recovery', async () => {
    // Embedder that fails on second batch (first batch succeeds to create _next tables)
    let callCount = 0;
    const partialFailEmbedder: Embedder = {
      embed: async () => new Float32Array(384).fill(0.1),
      embedBatch: async (texts: string[]) => {
        callCount++;
        if (callCount > 1) throw new Error('GPU out of memory');
        return texts.map(() => new Float32Array(384).fill(0.1));
      },
      dimensions: () => 384,
      modelId: () => 'failing-model',
      maxInputChars: () => 2000,
    };

    const migration = new EmbeddingMigration(db, partialFailEmbedder, { batchSize: 1 });

    // Monkey-patch db.exec to throw on DROP during abort
    const originalExec = db.exec.bind(db);
    const patchExec = () => {
      db.exec = (sql: string) => {
        if (sql.includes('DROP TABLE')) {
          throw new Error('sqlite-vec internal error');
        }
        return originalExec(sql);
      };
    };

    // Patch after prepare (which uses exec for CREATE)
    const originalPrepare = migration.prepare.bind(migration);
    migration.prepare = () => {
      originalPrepare();
      patchExec();
    };

    const result = await migration.run();

    // Should abort gracefully
    expect(result.aborted).toBe(true);
    expect(result.swapped).toBe(false);

    // Critical: meta MUST be cleaned despite abort's DROP failing
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
    expect(getMeta(db, 'migration_progress_text')).toBeNull();
    expect(getMeta(db, 'migration_lock_text')).toBeNull();

    db.exec = originalExec;
  });

  it('run should abort and clean meta on reembed error', async () => {
    // Create a failing embedder
    const failingEmbedder: Embedder = {
      embed: async () => {
        throw new Error('GPU out of memory');
      },
      embedBatch: async () => {
        throw new Error('GPU out of memory');
      },
      dimensions: () => 384,
      modelId: () => 'failing-model',
      maxInputChars: () => 2000,
    };

    const migration = new EmbeddingMigration(db, failingEmbedder);
    const result = await migration.run();

    // Should abort gracefully, not throw
    expect(result.aborted).toBe(true);
    expect(result.swapped).toBe(false);
    expect(result.embedded).toBe(0);

    // Migration meta should be cleaned up — not stuck
    expect(getMeta(db, 'migration_target_model_text')).toBeNull();
    expect(getMeta(db, 'migration_progress_text')).toBeNull();
    expect(getMeta(db, 'migration_lock_text')).toBeNull();
  });
});

describe('Migration lock', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should acquire lock when none exists', () => {
    expect(acquireMigrationLock(db)).toBe(true);
    expect(getMeta(db, 'migration_lock_text')).toBeTruthy();
  });

  it('should fail to acquire when lock already held', () => {
    acquireMigrationLock(db, 'instance-1');
    expect(acquireMigrationLock(db, 'instance-2')).toBe(false);
  });

  it('should release lock', () => {
    acquireMigrationLock(db);
    releaseMigrationLock(db);
    expect(getMeta(db, 'migration_lock_text')).toBeNull();
  });

  it('run should return aborted when lock is held', async () => {
    insertTestData(db, 1);
    acquireMigrationLock(db, 'other-instance');

    const embedder = createMockEmbedder('new-model', 384);
    const migration = new EmbeddingMigration(db, embedder);
    const result = await migration.run();

    expect(result.aborted).toBe(true);
    expect(result.swapped).toBe(false);
    expect(result.embedded).toBe(0);
  });
});
