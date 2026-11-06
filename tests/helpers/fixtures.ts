/**
 * Synthetic fixtures for lifecycle and search tests: a 1.0.2 (schema v2) database builder,
 * a corpus with the awkward cases real archives contain, and fake embedder/reranker doubles.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { loadSqliteVec } from '../../src/db.js';
import type { Embedder, Reranker, RerankerResult } from '../../src/models.js';

/** The schema exactly as melchizedek 1.0.2 creates it (user_version 2). Frozen: do not edit. */
export const SCHEMA_V2_SQL = `
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
  CREATE INDEX IF NOT EXISTS idx_conv_sessions_project ON conv_sessions(project);
  CREATE INDEX IF NOT EXISTS idx_conv_sessions_started_at ON conv_sessions(started_at);
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
    user_content, assistant_content, content=conv_chunks, content_rowid=rowid,
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
  CREATE TABLE IF NOT EXISTS ignored_projects (
    project TEXT PRIMARY KEY,
    ignored_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  PRAGMA user_version = 2;
`;

export function tempDbPath(prefix = 'm9k-fixture-'): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(dir, 'memory.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Create a file database as 1.0.2 leaves it: schema v2 plus 384d text vector tables. */
export function createV2Database(dbPath: string, dims = 384): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_V2_SQL);
  if (loadSqliteVec(db)) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conv_vec_text USING vec0(embedding float[${dims}]);
      CREATE TABLE IF NOT EXISTS conv_vec_map_text (
        vec_rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE REFERENCES conv_chunks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_conv_vec_map_chunk_text ON conv_vec_map_text(chunk_id);
    `);
  }
  db.close();
}

export interface SyntheticChunk {
  id: string;
  sessionId: string;
  idx: number;
  user: string;
  assistant: string;
  timestamp: string;
  kind?: 'exchange' | 'memory';
  deletedAt?: string | null;
  metadata?: { toolCalls?: string[]; filePaths?: string[]; errorMessages?: string[] };
}

export interface SyntheticSession {
  id: string;
  project: string;
  jsonlPath: string;
  startedAt: string;
  deletedAt?: string | null;
}

export const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The awkward cases real archives hold: a live session, an archive-only session (no
 * transcript on disk), manual memories, a forgotten chunk, a deleted session, the same
 * exchange copied into two sessions, multibyte text and space-separated timestamps.
 */
export const SYNTHETIC_SESSIONS: SyntheticSession[] = [
  {
    id: 'sess-live',
    project: '/proj/alpha',
    jsonlPath: '/tmp/sess-live.jsonl',
    startedAt: '2026-03-01T09:00:00.000Z',
  },
  {
    id: 'sess-archive',
    project: '/proj/alpha',
    jsonlPath: '/nonexistent/archive/sess-archive.jsonl',
    startedAt: '2025-06-01T09:00:00.000Z',
  },
  {
    id: 'sess-copy',
    project: '/proj/beta',
    jsonlPath: '/tmp/sess-copy.jsonl',
    startedAt: '2026-03-02T09:00:00.000Z',
  },
  {
    id: 'sess-deleted',
    project: '/proj/beta',
    jsonlPath: '/tmp/sess-deleted.jsonl',
    startedAt: '2026-01-01T09:00:00.000Z',
    deletedAt: '2026-02-01 00:00:00',
  },
  {
    id: '__manual_memories__',
    project: '__global__',
    jsonlPath: '__manual__',
    startedAt: '2026-01-01T00:00:00.000Z',
  },
];

export const SYNTHETIC_CHUNKS: SyntheticChunk[] = [
  {
    id: 'sess-live:0',
    sessionId: 'sess-live',
    idx: 0,
    user: 'How do I fix the CORS error in the Express server?',
    assistant: 'Add the cors middleware before your routes and allow the client origin.',
    timestamp: '2026-03-01T09:00:00.000Z',
    metadata: { toolCalls: ['Edit'], filePaths: ['/proj/alpha/src/server.ts'] },
  },
  {
    id: 'sess-live:1',
    sessionId: 'sess-live',
    idx: 1,
    user: "ModuleNotFoundError: No module named 'httpx' when running the tests",
    assistant: 'Install it into the active environment with pip install httpx, then rerun.',
    timestamp: '2026-03-01 09:30:00',
    metadata: { toolCalls: ['Bash'], filePaths: ['/proj/alpha/tests/test_config.py'] },
  },
  {
    id: 'sess-live:2',
    sessionId: 'sess-live',
    idx: 2,
    user: 'Le café du coin a changé ses horaires — 日本語のテキスト 🎉',
    assistant: 'Noted: the café opens at 7 now. Multibyte text kept as written.',
    timestamp: '2026-03-01T10:00:00.000Z',
  },
  {
    id: 'sess-archive:0',
    sessionId: 'sess-archive',
    idx: 0,
    user: 'Archive-only exchange about the brightness of external monitors',
    assistant: 'Lunar controls DDC brightness; the transcript for this session is gone.',
    timestamp: '2025-06-01T09:00:00.000Z',
    metadata: { toolCalls: ['Read'], filePaths: ['/proj/alpha/testXconfig.py'] },
  },
  {
    id: 'sess-archive:1',
    sessionId: 'sess-archive',
    idx: 1,
    user: 'This exchange was forgotten by the user',
    assistant: 'It stays as a tombstone so a re-index cannot bring it back.',
    timestamp: '2025-06-01T09:10:00.000Z',
    deletedAt: '2025-07-01 00:00:00',
  },
  {
    id: 'sess-copy:0',
    sessionId: 'sess-copy',
    idx: 0,
    user: 'How do I fix the CORS error in the Express server?',
    assistant: 'Add the cors middleware before your routes and allow the client origin.',
    timestamp: '2026-03-02T09:00:00.000Z',
  },
  {
    id: '__manual_memories__:0',
    sessionId: '__manual_memories__',
    idx: 0,
    user: 'Remember: deploys go out on Tuesdays only',
    assistant: '',
    timestamp: '2026-02-10 12:00:00',
    kind: 'memory',
  },
];

/** Insert the synthetic corpus into an open database (any schema version >= 2). */
export function seedSyntheticCorpus(
  db: Database.Database,
  sessions: SyntheticSession[] = SYNTHETIC_SESSIONS,
  chunks: SyntheticChunk[] = SYNTHETIC_CHUNKS,
): void {
  const insS = db.prepare(
    `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insC = db.prepare(
    `INSERT INTO conv_chunks (id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, metadata_json, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const s of sessions) {
      const n = chunks.filter((c) => c.sessionId === s.id).length;
      insS.run(s.id, s.project, s.jsonlPath, s.startedAt, n * 2, n, s.deletedAt ?? null);
    }
    for (const c of chunks) {
      insC.run(
        c.id,
        c.sessionId,
        c.idx,
        c.kind ?? 'exchange',
        c.user,
        c.assistant,
        sha(c.user + '\n' + c.assistant),
        c.timestamp,
        JSON.stringify({ toolCalls: [], filePaths: [], errorMessages: [], ...c.metadata }),
        c.deletedAt ?? null,
      );
    }
  })();
}

/** Row counts that must survive any upgrade unchanged. */
export function archiveCounts(db: Database.Database): Record<string, number> {
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    sessions: n('SELECT COUNT(*) AS n FROM conv_sessions'),
    chunks: n('SELECT COUNT(*) AS n FROM conv_chunks'),
    tombstonedChunks: n('SELECT COUNT(*) AS n FROM conv_chunks WHERE deleted_at IS NOT NULL'),
    tombstonedSessions: n('SELECT COUNT(*) AS n FROM conv_sessions WHERE deleted_at IS NOT NULL'),
    memories: n("SELECT COUNT(*) AS n FROM conv_chunks WHERE kind = 'memory'"),
  };
}

/**
 * Deterministic bag-of-words embedder. Each lowercase word is hashed into one of `dims`
 * buckets, then the vector is L2-normalised, so texts sharing words are close.
 * `onBatch` runs after inference and before the result is returned, which is where a
 * concurrent writer would act in production.
 */
export class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  onBatch?: (texts: string[]) => void | Promise<void>;

  constructor(
    private readonly id = 'fake-model',
    private readonly dims = 384,
    private readonly delayMs = 0,
  ) {}

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const out = texts.map((t) => this.vector(t));
    await this.onBatch?.(texts);
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.vector(text);
  }

  dimensions(): number {
    return this.dims;
  }

  modelId(): string {
    return this.id;
  }

  maxInputChars(): number {
    return 2_000;
  }

  private vector(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      v[crypto.createHash('md5').update(w).digest().readUInt32LE(0) % this.dims] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

/** Scores a document by how many query words it contains; records every call's pool size. */
export class FakeReranker implements Reranker {
  poolSizes: number[] = [];

  async rerank(
    query: string,
    documents: { id: string; content: string }[],
    topN: number,
  ): Promise<RerankerResult[]> {
    this.poolSizes.push(documents.length);
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return documents
      .map((d) => ({
        id: d.id,
        score: words.filter((w) => d.content.toLowerCase().includes(w)).length - 5,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  backend(): 'transformers-js' {
    return 'transformers-js';
  }

  modelId(): string {
    return 'fake-reranker';
  }
}
