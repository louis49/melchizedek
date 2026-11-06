import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createV2Database,
  seedSyntheticCorpus,
  archiveCounts,
  tempDbPath,
  FakeEmbedder,
  FakeReranker,
} from './helpers/fixtures.js';

describe('test fixtures', () => {
  let cleanup = (): void => {};
  afterEach(() => cleanup());

  it('builds a 1.0.2-shaped database with the synthetic corpus', () => {
    const tmp = tempDbPath();
    cleanup = tmp.cleanup;
    createV2Database(tmp.dbPath);
    const db = new Database(tmp.dbPath);
    seedSyntheticCorpus(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(archiveCounts(db)).toEqual({
      sessions: 5,
      chunks: 7,
      tombstonedChunks: 1,
      tombstonedSessions: 1,
      memories: 1,
    });
    const fts = db
      .prepare("SELECT COUNT(*) AS n FROM conv_chunks_fts WHERE conv_chunks_fts MATCH 'café'")
      .get() as { n: number };
    expect(fts.n).toBe(1);
    db.close();
  });

  it('fake embedder is deterministic and puts shared words close together', async () => {
    const e = new FakeEmbedder();
    const [a, b, c] = await e.embedBatch(['cors error express', 'express cors fix', 'monitor']);
    const dot = (x: Float32Array, y: Float32Array): number =>
      x.reduce((s, v, i) => s + v * y[i], 0);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    expect(Array.from(await e.embedQuery('cors error express'))).toEqual(Array.from(a));
  });

  it('fake reranker records pool sizes', async () => {
    const r = new FakeReranker();
    const out = await r.rerank(
      'cors',
      [
        { id: 'a', content: 'nothing' },
        { id: 'b', content: 'cors here' },
      ],
      1,
    );
    expect(out.map((x) => x.id)).toEqual(['b']);
    expect(r.poolSizes).toEqual([2]);
  });
});
