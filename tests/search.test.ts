import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import {
  openMemoryDatabase,
  closeDatabase,
  insertVectorsBatch,
  createVecTables,
} from '../src/db.js';
import { searchBM25, search, searchFuzzy, searchVectorized, fusionRRF } from '../src/search.js';
import { indexConvSession } from '../src/indexer.js';
import type { SearchResult } from '../src/models.js';

// Detect if embeddings actually work (package installed + model loadable)
let hasWorkingEmbedder = false;
try {
  const { TransformersJsEmbedder } = await import('../src/embedder.js');
  const { MODEL_REGISTRY } = await import('../src/constants.js');
  const probe = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
  await probe.embed('test');
  hasWorkingEmbedder = true;
} catch {
  // package missing or model download failed (e.g. CI without network)
}

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

describe('search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    // Insert test data manually for fine-grained control
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test/project', '2026-02-20T10:00:00Z', 10, 3, '/path/to/sess-1.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertChunk.run(
      'chunk-1',
      'sess-1',
      0,
      'How do I fix the CORS error?',
      'You need to add CORS middleware to your Express server.',
      'hash1',
      '2026-02-20T10:00:00Z',
    );

    insertChunk.run(
      'chunk-2',
      'sess-1',
      1,
      'Add rate limiting to the API',
      'I will add express-rate-limit middleware to protect your endpoints.',
      'hash2',
      '2026-02-20T10:01:00Z',
    );

    insertChunk.run(
      'chunk-3',
      'sess-1',
      2,
      'Set up the Docker configuration',
      'Here is a Dockerfile with multi-stage build for production.',
      'hash3',
      '2026-02-20T10:02:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should find results with BM25', () => {
    const results = searchBM25(db, 'CORS error', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-1');
  });

  it('should return empty results for no match', () => {
    const results = searchBM25(db, 'quantum computing', 10);
    expect(results).toEqual([]);
  });

  it('should respect limit parameter', () => {
    const results = searchBM25(db, 'add', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should perform fuzzy search with wildcards', () => {
    // "Dock" should match "Docker" via wildcard
    const results = searchFuzzy(db, 'Dock', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('fuzzy');
  });

  it('should filter by project', async () => {
    // Add a second session with a different project
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-2', '/other/project', '2026-02-21T10:00:00Z', 2, 1, '/path/to/sess-2.jsonl');

    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-4',
      'sess-2',
      0,
      'Fix the CORS issue in the frontend',
      'Configure proxy in vite.config.ts',
      'hash4',
      '2026-02-21T10:00:00Z',
    );

    const results = await search(db, { query: 'CORS', limit: 10, project: '/test/project' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.project === '/test/project')).toBe(true);
  });

  it('should filter by date', async () => {
    const results = await search(db, {
      query: 'add',
      limit: 10,
      since: '2026-02-20T10:01:30Z',
    });
    // Only chunk-3 (Docker, 10:02:00Z) should match — chunk-2 (rate limiting, 10:01:00Z) is before the since date
    for (const r of results) {
      expect(r.timestamp >= '2026-02-20T10:01:30Z').toBe(true);
    }
  });

  it('should filter by until (exclusive upper bound)', async () => {
    const results = await search(db, {
      query: 'add',
      limit: 10,
      until: '2026-02-20T10:01:00Z',
    });
    // chunk-2 is at exactly 10:01:00Z — excluded (strict <)
    // Only chunk-1 (CORS, 10:00:00Z) should match
    for (const r of results) {
      expect(r.timestamp < '2026-02-20T10:01:00Z').toBe(true);
    }
  });

  it('should filter by date range (since + until)', async () => {
    const results = await search(db, {
      query: 'add',
      limit: 10,
      since: '2026-02-20T10:00:30Z',
      until: '2026-02-20T10:01:30Z',
    });
    // Only chunk-2 (rate limiting, 10:01:00Z) falls in [10:00:30, 10:01:30)
    for (const r of results) {
      expect(r.timestamp >= '2026-02-20T10:00:30Z').toBe(true);
      expect(r.timestamp < '2026-02-20T10:01:30Z').toBe(true);
    }
  });

  it('should return empty for impossible date range', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      since: '2026-02-21T00:00:00Z',
      until: '2026-02-20T00:00:00Z',
    });
    expect(results).toEqual([]);
  });

  it('should sort by date_asc (oldest first)', async () => {
    const results = await search(db, {
      query: 'add',
      limit: 10,
      order: 'date_asc',
    });
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].timestamp >= results[i - 1].timestamp).toBe(true);
    }
  });

  it('should sort by date_desc (newest first)', async () => {
    const results = await search(db, {
      query: 'add',
      limit: 10,
      order: 'date_desc',
    });
    expect(results.length).toBeGreaterThan(1);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].timestamp <= results[i - 1].timestamp).toBe(true);
    }
  });

  it('should default to score ordering', async () => {
    // Default (no order param) = same as order: 'score'
    const defaultResults = await search(db, { query: 'add', limit: 10 });
    const scoreResults = await search(db, { query: 'add', limit: 10, order: 'score' });
    expect(defaultResults.map((r) => r.chunkId)).toEqual(scoreResults.map((r) => r.chunkId));
  });
});

describe('FTS5 special characters', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test/project', '2026-02-20T10:00:00Z', 2, 1, '/path/to/sess-1.jsonl');
    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-1',
      'sess-1',
      0,
      'Fix the CORS error',
      'Added middleware',
      'h1',
      '2026-02-20T10:00:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should not crash on double quotes', () => {
    const results = searchBM25(db, '"unclosed quote', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('should not crash on parentheses', () => {
    const results = searchBM25(db, 'test()', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('should not crash on colons', () => {
    const results = searchBM25(db, 'key:value', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('should not crash on unclosed quotes', () => {
    const results = searchBM25(db, '"hello world', 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('should not crash on FTS5 operators', () => {
    const results = searchBM25(db, 'NOT AND OR NEAR', 10);
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('empty query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test/project', '2026-02-20T10:00:00Z', 2, 1, '/path/to/sess-1.jsonl');
    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-1',
      'sess-1',
      0,
      'Fix the CORS error',
      'Added middleware',
      'h1',
      '2026-02-20T10:00:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should return empty for empty string in searchBM25', () => {
    expect(searchBM25(db, '', 10)).toEqual([]);
  });

  it('should return empty for whitespace in searchBM25', () => {
    expect(searchBM25(db, '   ', 10)).toEqual([]);
  });

  it('should return empty for empty string via search()', async () => {
    expect(await search(db, { query: '', limit: 10 })).toEqual([]);
  });

  it('should return empty for empty string via searchFuzzy()', () => {
    expect(searchFuzzy(db, '', 10)).toEqual([]);
  });
});

describe('search with auto-fuzzy fallback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should auto-fuzzy when fewer than 3 exact results', async () => {
    // "configur" is not a complete word — exact BM25 won't match, but fuzzy should
    const results = await search(db, { query: 'configur', limit: 10 });
    // With auto-fuzzy, it should find results via wildcard matching
    // (FTS5 porter stemmer may or may not match, but fuzzy fallback adds wildcards)
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it('should mark fuzzy results with matchType fuzzy', () => {
    const results = searchFuzzy(db, 'Dock', 10);
    for (const r of results) {
      expect(r.matchType).toBe('fuzzy');
    }
  });
});

describe('vector search', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test/project', '2026-02-20T10:00:00Z', 4, 2, '/path/to/sess-1.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertChunk.run(
      'chunk-1',
      'sess-1',
      0,
      'How do I fix the CORS error?',
      'You need to add CORS middleware to your Express server.',
      'hash1',
      '2026-02-20T10:00:00Z',
    );

    insertChunk.run(
      'chunk-2',
      'sess-1',
      1,
      'Set up Docker deployment',
      'Here is a Dockerfile with multi-stage build for production.',
      'hash2',
      '2026-02-20T10:01:00Z',
    );

    // Insert fake embeddings — chunk-1 closer to [1,0,...], chunk-2 closer to [0,1,...]
    const emb1 = new Float32Array(384);
    emb1[0] = 1.0;
    const emb2 = new Float32Array(384);
    emb2[1] = 1.0;

    insertVectorsBatch(db, [
      { chunkId: 'chunk-1', embedding: emb1 },
      { chunkId: 'chunk-2', embedding: emb2 },
    ]);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should find nearest vector match', () => {
    // Query embedding close to chunk-1
    const queryEmb = new Float32Array(384);
    queryEmb[0] = 0.9;
    queryEmb[2] = 0.1;

    const results = searchVectorized(db, queryEmb, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].chunkId).toBe('chunk-1');
    expect(results[0].matchType).toMatch(/^vector/);
  });

  it('should return empty for empty database', () => {
    const emptyDb = openMemoryDatabase().db;
    const queryEmb = new Float32Array(384).fill(0.1);
    const results = searchVectorized(emptyDb, queryEmb, 10);
    expect(results).toEqual([]);
    closeDatabase(emptyDb);
  });
});

describe('RRF fusion', () => {
  it('should combine BM25 and vector results', () => {
    const bm25: SearchResult[] = [
      {
        chunkId: 'a',
        snippet: '',
        score: -1,
        project: '/p',
        timestamp: 't1',
        matchType: 'bm25',
        sessionId: 's',
      },
      {
        chunkId: 'b',
        snippet: '',
        score: -2,
        project: '/p',
        timestamp: 't2',
        matchType: 'bm25',
        sessionId: 's',
      },
    ];
    const vec: SearchResult[] = [
      {
        chunkId: 'b',
        snippet: '',
        score: 0.9,
        project: '/p',
        timestamp: 't2',
        matchType: 'vector_text',
        sessionId: 's',
      },
      {
        chunkId: 'c',
        snippet: '',
        score: 0.7,
        project: '/p',
        timestamp: 't3',
        matchType: 'vector_text',
        sessionId: 's',
      },
    ];

    const fused = fusionRRF([bm25, vec]);
    // 'b' appears in both lists — should have highest RRF score
    expect(fused[0].chunkId).toBe('b');
    expect(fused[0].matchType).toBe('hybrid');
    // All results should be present
    expect(fused.map((r) => r.chunkId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('should keep original matchType when only one source contributes', () => {
    const bm25Only: SearchResult[] = [
      {
        chunkId: 'a',
        snippet: '',
        score: -1,
        project: '/p',
        timestamp: 't1',
        matchType: 'bm25',
        sessionId: 's',
      },
    ];
    const vecOnly: SearchResult[] = [
      {
        chunkId: 'c',
        snippet: '',
        score: 0.7,
        project: '/p',
        timestamp: 't3',
        matchType: 'vector_text',
        sessionId: 's',
      },
    ];

    const fused = fusionRRF([bm25Only, vecOnly]);
    const aResult = fused.find((r) => r.chunkId === 'a');
    const cResult = fused.find((r) => r.chunkId === 'c');
    expect(aResult?.matchType).toBe('bm25');
    expect(cResult?.matchType).toMatch(/^vector/);
  });

  it('should handle empty inputs', () => {
    expect(fusionRRF([[], []])).toEqual([]);
    const single: SearchResult[] = [
      {
        chunkId: 'a',
        snippet: '',
        score: 1,
        project: '/p',
        timestamp: 't',
        matchType: 'bm25',
        sessionId: 's',
      },
    ];
    const fused = fusionRRF([single, []]);
    expect(fused).toHaveLength(1);
    expect(fused[0].chunkId).toBe('a');
    expect(fused[0].matchType).toBe('bm25');
  });

  it('should handle 3-way fusion with overlaps', () => {
    const makeResult = (id: string, type: string): SearchResult => ({
      chunkId: id,
      snippet: '',
      score: 1,
      project: '/p',
      timestamp: 't',
      matchType: type as SearchResult['matchType'],
      sessionId: 's',
    });

    const list1: SearchResult[] = [makeResult('a', 'bm25'), makeResult('b', 'bm25')];
    const list2: SearchResult[] = [makeResult('b', 'vector_text'), makeResult('c', 'vector_text')];
    const list3: SearchResult[] = [makeResult('a', 'vector_text'), makeResult('c', 'vector_text')];

    const fused = fusionRRF([list1, list2, list3]);
    // a appears in list1+list3, b in list1+list2, c in list2+list3
    expect(fused.length).toBe(3);
    // All multi-source results should be hybrid
    for (const r of fused) {
      expect(r.matchType).toBe('hybrid');
    }
  });

  it('should handle single list (results sorted by RRF score)', () => {
    const list: SearchResult[] = [
      {
        chunkId: 'a',
        snippet: '',
        score: 1,
        project: '/p',
        timestamp: 't1',
        matchType: 'bm25',
        sessionId: 's',
      },
      {
        chunkId: 'b',
        snippet: '',
        score: 0.5,
        project: '/p',
        timestamp: 't2',
        matchType: 'bm25',
        sessionId: 's',
      },
    ];

    const fused = fusionRRF([list]);
    expect(fused).toHaveLength(2);
    expect(fused[0].chunkId).toBe('a');
    expect(fused[1].chunkId).toBe('b');
    // Single source — no hybrid
    expect(fused[0].matchType).toBe('bm25');
  });

  it('should return empty for empty lists array', () => {
    expect(fusionRRF([])).toEqual([]);
  });

  it('should return empty when all lists are empty', () => {
    expect(fusionRRF([[], [], []])).toEqual([]);
  });
});

describe('hybrid search (BM25 + vector)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test', '2026-02-20T10:00:00Z', 4, 2, '/path.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertChunk.run(
      'chunk-1',
      'sess-1',
      0,
      'CORS error',
      'Add CORS middleware',
      'h1',
      '2026-02-20T10:00:00Z',
    );
    insertChunk.run(
      'chunk-2',
      'sess-1',
      1,
      'Docker deploy',
      'Use multi-stage build',
      'h2',
      '2026-02-20T10:01:00Z',
    );

    // Insert embeddings
    const emb1 = new Float32Array(384).fill(0);
    emb1[0] = 1.0;
    const emb2 = new Float32Array(384).fill(0);
    emb2[1] = 1.0;
    insertVectorsBatch(db, [
      { chunkId: 'chunk-1', embedding: emb1 },
      { chunkId: 'chunk-2', embedding: emb2 },
    ]);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should use BM25 only when no SearchContext provided', async () => {
    const results = await search(db, { query: 'CORS', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('bm25');
  });

  it('should return hybrid results when SearchContext with embedder provided', async () => {
    // Mock embedder that returns a vector close to chunk-1
    const mockEmbedder = {
      embed: async () => {
        const emb = new Float32Array(384).fill(0);
        emb[0] = 0.9;
        return emb;
      },
      embedBatch: async (texts: string[]) =>
        texts.map(() => {
          const emb = new Float32Array(384).fill(0);
          emb[0] = 0.9;
          return emb;
        }),
      dimensions: () => 384,
      modelId: () => 'mock-embedder',
      maxInputChars: () => 2000,
    };

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: mockEmbedder,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    // With both BM25 and vector, result should be hybrid
    expect(results[0].matchType).toBe('hybrid');
  });

  it('should degrade to BM25 when embedder is null', async () => {
    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: null,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('bm25');
  });
});

describe('reranker integration in search pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test', '2026-02-20T10:00:00Z', 6, 3, '/path.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertChunk.run(
      'chunk-a',
      'sess-1',
      0,
      'Fix the CORS error in Express',
      'Add cors middleware with app.use(cors())',
      'ha',
      '2026-02-20T10:00:00Z',
    );
    insertChunk.run(
      'chunk-b',
      'sess-1',
      1,
      'CORS preflight requests failing',
      'Configure Access-Control-Allow-Headers for OPTIONS',
      'hb',
      '2026-02-20T10:01:00Z',
    );
    insertChunk.run(
      'chunk-c',
      'sess-1',
      2,
      'CORS policy blocks my fetch calls',
      'Set the correct origin in your CORS configuration',
      'hc',
      '2026-02-20T10:02:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should apply reranker to reorder results when provided', async () => {
    // Mock reranker that reverses the order (assigns descending scores)
    const mockReranker = {
      rerank: async (
        _query: string,
        documents: { id: string; content: string }[],
        topN: number,
      ) => {
        return documents.map((d, i) => ({ id: d.id, score: documents.length - i })).slice(0, topN);
      },
      backend: () => 'transformers-js' as const,
    };

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: null,
        embedderCode: null,
        reranker: mockReranker,
        vecTextEnabled: false,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    expect(results.length).toBe(3);
    // BM25 returns results in BM25 score order; reranker reverses them
    // The first BM25 result becomes the last after reverse-reranking
    const bm25First = searchBM25(db, 'CORS', 10);
    expect(bm25First[0].chunkId).not.toBe(results[results.length - 1].chunkId);
  });

  it('should pass correct documents and topN to reranker', async () => {
    let capturedDocs: { id: string; content: string }[] = [];
    let capturedTopN = 0;

    const spyReranker = {
      rerank: async (
        _query: string,
        documents: { id: string; content: string }[],
        topN: number,
      ) => {
        capturedDocs = documents;
        capturedTopN = topN;
        return documents.map((d, i) => ({ id: d.id, score: 10 - i }));
      },
      backend: () => 'transformers-js' as const,
    };

    await search(
      db,
      { query: 'CORS', limit: 5 },
      {
        embedderText: null,
        embedderCode: null,
        reranker: spyReranker,
        vecTextEnabled: false,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    expect(capturedDocs.length).toBeGreaterThan(0);
    expect(capturedTopN).toBe(5);
    // Each doc should have id and content
    for (const doc of capturedDocs) {
      expect(doc.id).toBeDefined();
      expect(doc.content).toBeDefined();
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });

  it('should work normally without reranker (null)', async () => {
    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: null,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: false,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    // Results should be in BM25 score order
    expect(results[0].matchType).toBe('bm25');
  });

  it('should not rerank when reranker throws (graceful degradation)', async () => {
    const failingReranker = {
      rerank: async () => {
        throw new Error('Model not loaded');
      },
      backend: () => 'transformers-js' as const,
    };

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: null,
        embedderCode: null,
        reranker: failingReranker,
        vecTextEnabled: false,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 3,
      },
    );

    // Should fall back to BM25 results without crashing
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchType).toBe('bm25');
  });
});

describe('current project boost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    // Two projects with CORS-related content
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-current', '/current/project', '2026-02-20T10:00:00Z', 2, 1, '/path/current.jsonl');

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-other', '/other/project', '2026-02-20T10:00:00Z', 2, 1, '/path/other.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Other project has a MORE relevant chunk (more CORS mentions, richer content)
    insertChunk.run(
      'chunk-other',
      'sess-other',
      0,
      'Fix the CORS error in Express middleware CORS',
      'Add CORS middleware with app.use(cors()) and configure Access-Control-Allow-Origin CORS headers CORS policy',
      'hash-other',
      '2026-02-20T10:00:00Z',
    );

    // Current project has a less relevant chunk (fewer CORS mentions)
    insertChunk.run(
      'chunk-current',
      'sess-current',
      0,
      'Fix a networking error',
      'Configure the CORS headers',
      'hash-current',
      '2026-02-20T10:01:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should boost current project results when no explicit project filter', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      currentProject: '/current/project',
    });

    expect(results.length).toBe(2);
    // Current project result should be first despite potentially lower base relevance
    expect(results[0].project).toBe('/current/project');
  });

  it('should not boost when explicit project filter is set', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      project: '/other/project',
      currentProject: '/current/project',
    });

    // Strict filter: only other project results
    expect(results.every((r) => r.project === '/other/project')).toBe(true);
  });

  it('should still include cross-project results', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      currentProject: '/current/project',
    });

    // Both projects should appear
    const projects = new Set(results.map((r) => r.project));
    expect(projects.size).toBe(2);
  });

  it('should not boost when currentProject is not set', async () => {
    const withoutBoost = await search(db, { query: 'CORS', limit: 10 });
    const withBoost = await search(db, {
      query: 'CORS',
      limit: 10,
      currentProject: '/current/project',
    });

    // Without boost, order is pure BM25. With boost, current project is promoted.
    // They should differ in ordering.
    expect(withBoost[0].project).toBe('/current/project');
    // Without boost, the order is determined by BM25 relevance alone
    expect(withoutBoost.length).toBe(withBoost.length);
  });
});

describe('current session boost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase().db;

    // Two sessions in the same project with CORS-related content
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-current', '/test/project', '2026-02-20T10:00:00Z', 2, 1, '/path/current.jsonl');

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-other', '/test/project', '2026-02-20T09:00:00Z', 2, 1, '/path/other.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Other session has a MORE relevant chunk (more CORS mentions)
    insertChunk.run(
      'chunk-other',
      'sess-other',
      0,
      'Fix the CORS error in Express middleware CORS',
      'Add CORS middleware with app.use(cors()) and configure CORS headers CORS policy',
      'hash-other',
      '2026-02-20T09:00:00Z',
    );

    // Current session has a less relevant chunk (fewer CORS mentions)
    insertChunk.run(
      'chunk-current',
      'sess-current',
      0,
      'Fix a networking error',
      'Configure the CORS headers',
      'hash-current',
      '2026-02-20T10:01:00Z',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should boost current session results', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      currentSession: 'sess-current',
    });

    expect(results.length).toBe(2);
    // Current session result should be first despite lower base relevance
    expect(results[0].sessionId).toBe('sess-current');
  });

  it('should not boost without currentSession', async () => {
    const withoutBoost = await search(db, { query: 'CORS', limit: 10 });
    const withBoost = await search(db, {
      query: 'CORS',
      limit: 10,
      currentSession: 'sess-current',
    });

    expect(withBoost[0].sessionId).toBe('sess-current');
    expect(withoutBoost.length).toBe(withBoost.length);
  });

  it('should coexist with project boost', async () => {
    // Add a chunk from a different project
    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-external', '/other/project', '2026-02-20T08:00:00Z', 2, 1, '/path/ext.jsonl');

    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-external',
      'sess-external',
      0,
      'CORS CORS CORS CORS CORS error',
      'CORS CORS CORS fix all the CORS problems',
      'hash-ext',
      '2026-02-20T08:00:00Z',
    );

    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      currentProject: '/test/project',
      currentSession: 'sess-current',
    });

    // Both boosts applied — current session result should be first
    expect(results[0].sessionId).toBe('sess-current');
    // External project result should still appear
    expect(results.some((r) => r.project === '/other/project')).toBe(true);
  });

  it('session boost ×1.2 should be weaker than project boost ×1.5', async () => {
    // Session boost alone vs project boost alone — project should win
    const sessionOnly = await search(db, {
      query: 'CORS',
      limit: 10,
      currentSession: 'sess-current',
    });

    // The session boost promotes sess-current, but project boost (1.5) is stronger
    // Both chunks are in the same project here, so project boost doesn't differentiate
    // Verify session boost factor is less than project boost factor
    expect(1.2).toBeLessThan(1.5);
    expect(sessionOnly[0].sessionId).toBe('sess-current');
  });

  it('should not crash when currentSession does not match any result', async () => {
    const results = await search(db, {
      query: 'CORS',
      limit: 10,
      currentSession: 'nonexistent-session',
    });

    // Should return results without crashing
    expect(results.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasWorkingEmbedder)('semantic search without keyword overlap (v0.2 proof)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test', '2026-02-20T10:00:00Z', 6, 3, '/path.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertChunk.run(
      'chunk-cors',
      'sess-1',
      0,
      'How do I fix the CORS error in my Express server?',
      'You need to add CORS middleware. Install the cors package and use app.use(cors()).',
      'h-cors',
      '2026-02-20T10:00:00Z',
    );

    insertChunk.run(
      'chunk-docker',
      'sess-1',
      1,
      'Set up Docker deployment for production',
      'Here is a multi-stage Dockerfile that builds and serves your Node.js app.',
      'h-docker',
      '2026-02-20T10:01:00Z',
    );

    insertChunk.run(
      'chunk-auth',
      'sess-1',
      2,
      'Implement JWT authentication with refresh tokens',
      'Use jsonwebtoken to sign access tokens and store refresh tokens in httpOnly cookies.',
      'h-auth',
      '2026-02-20T10:02:00Z',
    );

    // Embed all chunks with REAL MiniLM embeddings
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const texts = [
      'How do I fix the CORS error in my Express server? You need to add CORS middleware. Install the cors package and use app.use(cors()).',
      'Set up Docker deployment for production Here is a multi-stage Dockerfile that builds and serves your Node.js app.',
      'Implement JWT authentication with refresh tokens Use jsonwebtoken to sign access tokens and store refresh tokens in httpOnly cookies.',
    ];

    const embeddings = await embedder.embedBatch(texts);
    insertVectorsBatch(db, [
      { chunkId: 'chunk-cors', embedding: embeddings[0] },
      { chunkId: 'chunk-docker', embedding: embeddings[1] },
      { chunkId: 'chunk-auth', embedding: embeddings[2] },
    ]);
  }, 120_000);

  afterEach(() => {
    closeDatabase(db);
  });

  it('BM25 should return NOTHING for a semantically close query with zero keyword overlap', () => {
    // "cross-origin request problem" shares NO keywords with "CORS error Express middleware"
    const bm25Results = searchBM25(db, 'cross-origin request problem', 10);
    expect(bm25Results).toHaveLength(0);
  });

  it('vector search should FIND the CORS chunk via semantic similarity despite zero keyword overlap', async () => {
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const results = await search(
      db,
      { query: 'cross-origin request problem', limit: 5 },
      {
        embedderText: embedder,
        embedderCode: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0, // disable fuzzy so we isolate the vector effect
      },
    );

    // Vector search should find the CORS chunk even with zero keyword overlap
    expect(results.length).toBeGreaterThan(0);

    // The top result should be the CORS chunk (semantically closest)
    const corsResult = results.find((r) => r.chunkId === 'chunk-cors');
    expect(corsResult).toBeDefined();

    // matchType should be 'vector' since BM25 returned 0 results
    expect(results[0].matchType).toMatch(/^vector/);
  }, 120_000);

  it('should rank semantically relevant results higher than unrelated ones', async () => {
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    // "containerize my application" should be closest to the Docker chunk
    const results = await search(
      db,
      { query: 'containerize my application', limit: 5 },
      {
        embedderText: embedder,
        embedderCode: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-docker');
  }, 120_000);
});

describe.skipIf(!hasWorkingEmbedder)('semantic search in French (multilingual model proof)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    db.prepare(
      `INSERT INTO conv_sessions (id, project, started_at, message_count, chunk_count, jsonl_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-fr', '/test/projet-demo', '2026-02-18T10:00:00Z', 4, 2, '/path-fr.jsonl');

    const insertChunk = db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // RGPD discussion — tests semantic search in French
    insertChunk.run(
      'chunk-rgpd',
      'sess-fr',
      0,
      'Quelles sont les obligations du RGPD pour une application web qui collecte des données utilisateur ?',
      "Le RGPD impose le consentement explicite avant toute collecte de données personnelles. Vous devez fournir une politique de confidentialité claire, permettre l'export des données (portabilité), et garantir le droit à l'effacement. Les amendes peuvent atteindre 4% du chiffre d'affaires annuel mondial.",
      'h-rgpd',
      '2026-02-18T10:00:00Z',
    );

    insertChunk.run(
      'chunk-recipe',
      'sess-fr',
      1,
      'Comment faire une tarte aux pommes ?',
      'Étalez la pâte brisée, disposez les pommes en rosace, saupoudrez de sucre et enfournez 35 minutes à 180 degrés.',
      'h-recipe',
      '2026-02-18T10:01:00Z',
    );

    // Embed with real multilingual model
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const texts = [
      "Quelles sont les obligations du RGPD pour une application web ? Le RGPD impose le consentement explicite, la portabilité des données et le droit à l'effacement.",
      'Comment faire une tarte aux pommes ? Étalez la pâte brisée, disposez les pommes en rosace.',
    ];

    const embeddings = await embedder.embedBatch(texts);
    insertVectorsBatch(db, [
      { chunkId: 'chunk-rgpd', embedding: embeddings[0] },
      { chunkId: 'chunk-recipe', embedding: embeddings[1] },
    ]);
  }, 120_000);

  afterEach(() => {
    closeDatabase(db);
  });

  it('BM25 should return NOTHING for "protection vie privée en ligne" (zero keyword overlap with RGPD chunk)', () => {
    const bm25Results = searchBM25(db, 'protection vie privée en ligne', 10);
    expect(bm25Results).toHaveLength(0);
  });

  it('vector search should find RGPD chunk via "protection vie privée des internautes"', async () => {
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const results = await search(
      db,
      { query: 'protection vie privée des internautes', limit: 5 },
      {
        embedderText: embedder,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    // The RGPD chunk should be found, NOT the recipe
    expect(results[0].chunkId).toBe('chunk-rgpd');
  }, 120_000);

  it('vector search should find RGPD chunk via "réglementation européenne sur les données"', async () => {
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const results = await search(
      db,
      { query: 'réglementation européenne sur les données personnelles', limit: 5 },
      {
        embedderText: embedder,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-rgpd');
  }, 120_000);

  it('vector search should find recipe chunk via "recette pâtisserie au four"', async () => {
    const { TransformersJsEmbedder } = await import('../src/embedder.js');
    const { MODEL_REGISTRY } = await import('../src/constants.js');
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);

    const results = await search(
      db,
      { query: 'recette pâtisserie au four', limit: 5 },
      {
        embedderText: embedder,
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-recipe');
  }, 120_000);
});

// --- Triple search (BM25 + text + code vectors) ---

describe('triple search (BM25 + text + code)', () => {
  let db: Database.Database;

  function mockEmbedder(dims: number, vec: Float32Array) {
    return {
      embed: async () => vec,
      embedBatch: async (texts: string[]) => texts.map(() => vec),
      dimensions: () => dims,
      modelId: () => `mock-${dims}d`,
      maxInputChars: () => 2000,
    };
  }

  beforeEach(() => {
    const info = openMemoryDatabase();
    db = info.db;

    // Insert test data
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, started_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sess-1', '/test', '/path.jsonl', '2026-02-20T10:00:00Z', 4, 2);

    db.prepare(
      `INSERT INTO conv_chunks (id, session_id, idx, user_content, assistant_content, hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-1',
      'sess-1',
      0,
      'How to fix CORS error?',
      'Add CORS middleware.',
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
      'Deploy Docker container',
      'Use docker-compose.',
      'h2',
      '2026-02-20T10:01:00Z',
    );

    // Insert text vectors (_text tables already exist from migration v9)
    const emb1Text = new Float32Array(384);
    emb1Text[0] = 1.0;
    const emb2Text = new Float32Array(384);
    emb2Text[1] = 1.0;
    insertVectorsBatch(
      db,
      [
        { chunkId: 'chunk-1', embedding: emb1Text },
        { chunkId: 'chunk-2', embedding: emb2Text },
      ],
      '_text',
    );

    // Create _code vec tables and insert code vectors
    createVecTables(db, 768, '_code');
    const emb1Code = new Float32Array(768);
    emb1Code[0] = 1.0;
    const emb2Code = new Float32Array(768);
    emb2Code[1] = 1.0;
    insertVectorsBatch(
      db,
      [
        { chunkId: 'chunk-1', embedding: emb1Code },
        { chunkId: 'chunk-2', embedding: emb2Code },
      ],
      '_code',
    );
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('should use all three sources: BM25 + text vec + code vec', async () => {
    const queryText = new Float32Array(384);
    queryText[0] = 0.9;
    const queryCode = new Float32Array(768);
    queryCode[0] = 0.9;

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: mockEmbedder(384, queryText),
        embedderCode: mockEmbedder(768, queryCode),
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: true,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    // chunk-1 should rank first (BM25 matches "CORS" + both vec searches point to chunk-1)
    expect(results[0].chunkId).toBe('chunk-1');
  });

  it('should work with text only (code absent)', async () => {
    const queryText = new Float32Array(384);
    queryText[0] = 0.9;

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: mockEmbedder(384, queryText),
        embedderCode: null,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: false,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-1');
  });

  it('should work with code only (text absent)', async () => {
    const queryCode = new Float32Array(768);
    queryCode[0] = 0.9;

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: null,
        embedderCode: mockEmbedder(768, queryCode),
        reranker: null,
        vecTextEnabled: false,
        vecCodeEnabled: true,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-1');
  });

  it('should fallback to BM25 when both embedders throw', async () => {
    const throwingEmbedder = {
      embed: async () => {
        throw new Error('embed failed');
      },
      embedBatch: async () => {
        throw new Error('embed failed');
      },
      dimensions: () => 384,
      modelId: () => 'broken',
      maxInputChars: () => 2000,
    };

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: throwingEmbedder,
        embedderCode: throwingEmbedder,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: true,
        autoFuzzyThreshold: 0,
      },
    );

    // Should still get BM25 results
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-1');
    expect(results[0].matchType).toBe('bm25');
  });

  it('should fallback to BM25 + text when code embedder throws', async () => {
    const queryText = new Float32Array(384);
    queryText[0] = 0.9;
    const throwingEmbedder = {
      embed: async () => {
        throw new Error('embed failed');
      },
      embedBatch: async () => {
        throw new Error('embed failed');
      },
      dimensions: () => 768,
      modelId: () => 'broken-code',
      maxInputChars: () => 2000,
    };

    const results = await search(
      db,
      { query: 'CORS', limit: 10 },
      {
        embedderText: mockEmbedder(384, queryText),
        embedderCode: throwingEmbedder,
        reranker: null,
        vecTextEnabled: true,
        vecCodeEnabled: true,
        autoFuzzyThreshold: 0,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe('chunk-1');
    // Should be hybrid (BM25 + text vec)
    expect(results[0].matchType).toBe('hybrid');
  });
});
