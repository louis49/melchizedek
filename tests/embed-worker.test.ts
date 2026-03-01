import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fork, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import { loadSqliteVec } from '../src/db.js';
import type { WorkerStartMessage, WorkerOutMessage } from '../src/models.js';

// Detect if embeddings actually work (package installed + model loadable)
let hasWorkingEmbedder = false;
try {
  const { TransformersJsEmbedder } = await import('../src/embedder.js');
  const { MODEL_REGISTRY } = await import('../src/constants.js');
  const probe = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
  await probe.embed('test');
  hasWorkingEmbedder = true;
} catch {
  // package missing or model download failed
}

const WORKER_PATH = path.join(import.meta.dirname, '..', 'dist', 'embed-worker.js');

function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-worker-test-'));
  const dbPath = path.join(dir, 'test.db');

  // Create the DB with schema via raw SQL (matching what openDatabase does)
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const vecEnabled = loadSqliteVec(db);

  // Run all migrations inline (simplified for test)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conv_sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      jsonl_path TEXT NOT NULL,
      file_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      UNIQUE(jsonl_path)
    );

    CREATE TABLE IF NOT EXISTS conv_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES conv_sessions(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'exchange',
      user_content TEXT NOT NULL,
      assistant_content TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      tags TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      embedding BLOB,
      deleted_at TEXT,
      UNIQUE(session_id, hash)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_chunks_session ON conv_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_conv_chunks_hash ON conv_chunks(hash);
    CREATE INDEX IF NOT EXISTS idx_conv_chunks_timestamp ON conv_chunks(timestamp);

    CREATE VIRTUAL TABLE IF NOT EXISTS conv_chunks_fts USING fts5(
      user_content, assistant_content,
      content=conv_chunks, content_rowid=rowid,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS conv_chunks_ai AFTER INSERT ON conv_chunks BEGIN
      INSERT INTO conv_chunks_fts(rowid, user_content, assistant_content)
      VALUES (new.rowid, new.user_content, new.assistant_content);
    END;
    CREATE TRIGGER IF NOT EXISTS conv_chunks_ad AFTER DELETE ON conv_chunks BEGIN
      INSERT INTO conv_chunks_fts(conv_chunks_fts, rowid, user_content, assistant_content)
      VALUES ('delete', old.rowid, old.user_content, old.assistant_content);
    END;
    CREATE TRIGGER IF NOT EXISTS conv_chunks_au AFTER UPDATE ON conv_chunks BEGIN
      INSERT INTO conv_chunks_fts(conv_chunks_fts, rowid, user_content, assistant_content)
      VALUES ('delete', old.rowid, old.user_content, old.assistant_content);
      INSERT INTO conv_chunks_fts(rowid, user_content, assistant_content)
      VALUES (new.rowid, new.user_content, new.assistant_content);
    END;

    CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    PRAGMA user_version = 2;
  `);

  if (vecEnabled) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_vec_text USING vec0(embedding float[384]);
      CREATE TABLE IF NOT EXISTS conv_vec_map_text (
        vec_rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE REFERENCES conv_chunks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conv_vec_map_chunk_text ON conv_vec_map_text(chunk_id);
    `);
  }

  db.close();

  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function seedChunks(dbPath: string, count: number): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Create a session
  db.prepare(
    `INSERT OR IGNORE INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, message_count, chunk_count)
     VALUES ('test-sess', '/test', '/test/test.jsonl', 'abc', 100, '2026-01-01T00:00:00Z', 10, ?)`,
  ).run(count);

  // Insert chunks with enough content to be eligible (>= 50 chars)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO conv_chunks (id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, token_count, metadata_json)
     VALUES (?, 'test-sess', ?, 'exchange', ?, ?, ?, '2026-01-01T00:00:00Z', 100, '{}')`,
  );

  for (let i = 0; i < count; i++) {
    const content = `This is test chunk number ${i} with enough content to be eligible for embedding purposes and semantic search functionality`;
    insert.run(
      `test-sess:${i}`,
      i,
      content,
      `Assistant response for chunk ${i} with detailed explanation`,
      `hash-${i}`,
    );
  }

  db.close();
}

function collectMessages(child: ChildProcess): Promise<WorkerOutMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: WorkerOutMessage[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Worker timed out after 60s'));
    }, 60_000);

    child.on('message', (msg: WorkerOutMessage) => {
      messages.push(msg);
    });

    child.on('exit', () => {
      clearTimeout(timeout);
      resolve(messages);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe.skipIf(!hasWorkingEmbedder)('embed-worker integration', () => {
  let dbPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = createTempDb();
    dbPath = tmp.dbPath;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('should embed chunks and send progress + done messages', async () => {
    seedChunks(dbPath, 5);

    const child = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });

    const messagesPromise = collectMessages(child);

    const startMsg: WorkerStartMessage = {
      type: 'start',
      dbPath,
      suffix: '_text',
      embedderType: 'text',
      config: {
        embeddingBackend: 'transformers-js',
        embeddingModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
      },
      batchSize: 50,
    };
    child.send(startMsg);

    const messages = await messagesPromise;

    // Should have at least ready + done
    const types = messages.map((m) => m.type);
    expect(types).toContain('ready');
    expect(types).toContain('done');

    const readyMsg = messages.find((m) => m.type === 'ready')!;
    expect(readyMsg.type === 'ready' && readyMsg.modelId).toBe('minilm-l12-v2');
    expect(readyMsg.type === 'ready' && readyMsg.dimensions).toBe(384);

    const doneMsg = messages.find((m) => m.type === 'done')!;
    expect(doneMsg.type === 'done' && doneMsg.embedded).toBe(5);

    // Verify vectors were actually written
    const db = new Database(dbPath);
    const count = (
      db.prepare('SELECT COUNT(*) AS cnt FROM conv_vec_map_text').get() as { cnt: number }
    ).cnt;
    db.close();
    expect(count).toBe(5);
  }, 30_000);

  it('should send error when embedder is not available', async () => {
    seedChunks(dbPath, 1);

    const child = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });

    const messagesPromise = collectMessages(child);

    // Use ollama backend which won't be available in test
    const startMsg: WorkerStartMessage = {
      type: 'start',
      dbPath,
      suffix: '_text',
      embedderType: 'text',
      config: {
        embeddingBackend: 'ollama',
        embeddingModel: 'nonexistent-model-xyz',
        ollamaBaseUrl: 'http://localhost:99999',
      },
      batchSize: 50,
    };
    child.send(startMsg);

    const messages = await messagesPromise;

    const errorMsg = messages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.type === 'error' && errorMsg!.fatal).toBe(true);
  }, 15_000);

  it('should handle empty DB (no chunks to embed)', async () => {
    // Don't seed any chunks
    const child = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });

    const messagesPromise = collectMessages(child);

    const startMsg: WorkerStartMessage = {
      type: 'start',
      dbPath,
      suffix: '_text',
      embedderType: 'text',
      config: {
        embeddingBackend: 'transformers-js',
        embeddingModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
      },
      batchSize: 50,
    };
    child.send(startMsg);

    const messages = await messagesPromise;

    const doneMsg = messages.find((m) => m.type === 'done');
    expect(doneMsg).toBeDefined();
    expect(doneMsg!.type === 'done' && doneMsg!.embedded).toBe(0);
  }, 30_000);

  it('should be killed gracefully on SIGTERM', async () => {
    seedChunks(dbPath, 100); // Lots of chunks to keep it busy

    const child = fork(WORKER_PATH, [], {
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      child.on('exit', (code) => {
        exitCode = code;
        resolve();
      });
    });

    // Wait for ready message then kill
    child.on('message', (msg: WorkerOutMessage) => {
      if (msg.type === 'ready') {
        setTimeout(() => child.kill('SIGTERM'), 100);
      }
    });

    const startMsg: WorkerStartMessage = {
      type: 'start',
      dbPath,
      suffix: '_text',
      embedderType: 'text',
      config: {
        embeddingBackend: 'transformers-js',
        embeddingModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
      },
      batchSize: 5,
    };
    child.send(startMsg);

    await exitPromise;

    // Should have been terminated (exit code null = killed by signal, or non-zero)
    expect(exitCode === null || exitCode !== 0).toBe(true);
  }, 30_000);
});
