/**
 * Hybrid search engine: BM25 (FTS5) + vectors (sqlite-vec) + RRF + reranker.
 */

import type Database from 'better-sqlite3';
import type { MatchType, SearchContext, SearchOptions, SearchResult } from './models.js';
import { incrementStat, setStat } from './db.js';
import { RRF_K } from './constants.js';
import { logger } from './logger.js';

export function searchBM25(db: Database.Database, query: string, limit: number): SearchResult[] {
  if (!query.trim()) return [];

  const stmt = db.prepare(`
    SELECT c.id, c.session_id, c.timestamp, c.user_content, c.assistant_content,
           s.project, bm25(conv_chunks_fts) AS score
    FROM conv_chunks_fts
    JOIN conv_chunks c ON conv_chunks_fts.rowid = c.rowid
    JOIN conv_sessions s ON c.session_id = s.id
    WHERE conv_chunks_fts MATCH ?
      AND c.deleted_at IS NULL
    ORDER BY score
    LIMIT ?
  `);

  let rows: Array<{
    id: string;
    session_id: string;
    timestamp: string;
    user_content: string;
    assistant_content: string;
    project: string;
    score: number;
  }>;

  try {
    rows = stmt.all(query, limit) as typeof rows;
  } catch {
    // FTS5 syntax error (unbalanced quotes, special chars, etc.) — return empty
    logger.debug('search', `FTS5 syntax error for query: ${query.slice(0, 50)}`);
    return [];
  }

  return rows.map((row) => ({
    chunkId: row.id,
    snippet: (row.user_content + ' ' + row.assistant_content).slice(0, 100),
    score: row.score,
    project: row.project,
    timestamp: row.timestamp,
    matchType: 'bm25' as const,
    sessionId: row.session_id,
  }));
}

/**
 * Max L2 distance for vector results. For unit-normalized vectors:
 * L2 = sqrt(2 - 2*cos_sim), so maxDistance=1.3 ≈ cos_sim > 0.155
 * This filters out clearly irrelevant results at scale.
 */
const MAX_VECTOR_DISTANCE = 1.3;

export function searchVectorized(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number,
  maxDistance = MAX_VECTOR_DISTANCE,
  suffix = '_text',
): SearchResult[] {
  // Two-step approach: sqlite-vec virtual tables are slow when JOINed directly
  // with regular tables (SQLite optimizer can't push down the MATCH efficiently).
  // Step 1: KNN search on the vec table only (~2ms for 5k vectors)
  const vecRows = db
    .prepare(
      `SELECT rowid, distance FROM conv_vec${suffix}
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(queryEmbedding.buffer), limit) as Array<{
    rowid: number;
    distance: number;
  }>;

  if (vecRows.length === 0) return [];

  // Step 2: resolve rowids → chunk_ids via map table, then hydrate from chunks
  const rowids = vecRows.map((r) => r.rowid);
  const distanceByRowid = new Map(vecRows.map((r) => [r.rowid, r.distance]));

  const placeholders = rowids.map(() => '?').join(',');
  const mapRows = db
    .prepare(
      `SELECT vec_rowid, chunk_id FROM conv_vec_map${suffix}
       WHERE vec_rowid IN (${placeholders})`,
    )
    .all(...rowids) as Array<{ vec_rowid: number; chunk_id: string }>;

  if (mapRows.length === 0) return [];

  const chunkIds = mapRows.map((m) => m.chunk_id);
  const distanceByChunkId = new Map(
    mapRows.map((m) => [m.chunk_id, distanceByRowid.get(m.vec_rowid)!]),
  );

  const chunkPlaceholders = chunkIds.map(() => '?').join(',');
  const chunkRows = db
    .prepare(
      `SELECT c.id, c.user_content, c.assistant_content,
              c.session_id, c.timestamp, s.project
       FROM conv_chunks c
       JOIN conv_sessions s ON c.session_id = s.id
       WHERE c.id IN (${chunkPlaceholders})
         AND c.deleted_at IS NULL`,
    )
    .all(...chunkIds) as Array<{
    id: string;
    user_content: string;
    assistant_content: string;
    session_id: string;
    timestamp: string;
    project: string;
  }>;

  return chunkRows
    .map((row) => {
      const distance = distanceByChunkId.get(row.id)!;
      return {
        chunkId: row.id,
        snippet: (row.user_content + ' ' + row.assistant_content).slice(0, 100),
        score: 1 - distance,
        project: row.project,
        timestamp: row.timestamp,
        matchType: (suffix === '_code' ? 'vector_code' : 'vector_text') as MatchType,
        sessionId: row.session_id,
      };
    })
    .filter((r) => 1 - r.score <= maxDistance)
    .sort((a, b) => b.score - a.score);
}

/**
 * Reciprocal Rank Fusion: combines N ranked lists.
 * score(doc) = sum over lists of 1/(K + rank_in_list)
 * matchType is 'hybrid' when a doc appears in 2+ lists.
 */
export function fusionRRF(lists: SearchResult[][], k = RRF_K): SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult; sourceCount: number }>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const rrfScore = 1 / (k + i + 1); // rank is 1-based
      const existing = scores.get(r.chunkId);
      if (existing) {
        existing.score += rrfScore;
        existing.sourceCount++;
        existing.result.matchType = 'hybrid';
      } else {
        scores.set(r.chunkId, {
          score: rrfScore,
          result: { ...r },
          sourceCount: 1,
        });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, result }) => ({ ...result, score }));
}

/**
 * Project boost factor: results from currentProject get a score boost.
 * Applied as multiplier for positive scores, divisor for negative scores (BM25).
 * Moderate enough to promote same-project results without hiding cross-project ones.
 */
const PROJECT_BOOST_FACTOR = 1.5;
const SESSION_BOOST_FACTOR = 1.2;

export async function search(
  db: Database.Database,
  options: SearchOptions,
  ctx?: SearchContext,
): Promise<SearchResult[]> {
  if (!options.query.trim()) return [];

  const t0 = performance.now();
  const autoFuzzyThreshold = ctx?.autoFuzzyThreshold ?? 3;

  // BM25 search (always available)
  const bm25Results = searchBM25(db, options.query, options.limit * 2);
  const t1 = performance.now();
  logger.debug('search', ` BM25: ${(t1 - t0).toFixed(0)}ms (${bm25Results.length} results)`);

  let results: SearchResult[];

  // Triple vector search: BM25 + text vectors + code vectors, fused via RRF
  const vecLists: SearchResult[][] = [bm25Results];

  if (ctx?.vecTextEnabled && ctx.embedderText) {
    try {
      const t2 = performance.now();
      const embedFn = ctx.embedderText.embedQuery ?? ctx.embedderText.embed;
      const emb = await embedFn.call(ctx.embedderText, options.query);
      const t3 = performance.now();
      logger.debug('search', ` text embed: ${(t3 - t2).toFixed(0)}ms`);
      vecLists.push(searchVectorized(db, emb, options.limit * 2, MAX_VECTOR_DISTANCE, '_text'));
      logger.debug('search', ` text vec search: ${(performance.now() - t3).toFixed(0)}ms`);
    } catch (err) {
      logger.warn('search', 'Text vector search failed — degrading gracefully', err);
    }
  }

  if (ctx?.vecCodeEnabled && ctx.embedderCode) {
    try {
      const t4 = performance.now();
      const embedFn = ctx.embedderCode.embedQuery ?? ctx.embedderCode.embed;
      const emb = await embedFn.call(ctx.embedderCode, options.query);
      const t5 = performance.now();
      logger.debug('search', ` code embed: ${(t5 - t4).toFixed(0)}ms`);
      vecLists.push(searchVectorized(db, emb, options.limit * 2, MAX_VECTOR_DISTANCE, '_code'));
      logger.debug('search', ` code vec search: ${(performance.now() - t5).toFixed(0)}ms`);
    } catch (err) {
      logger.warn('search', 'Code vector search failed — degrading gracefully', err);
    }
  }

  results = vecLists.length > 1 ? fusionRRF(vecLists) : bm25Results;
  logger.debug('search', ` RRF: ${(performance.now() - t1).toFixed(0)}ms total`);

  // Filter by project if specified
  if (options.project) {
    results = results.filter((r) => r.project === options.project);
  }

  // Filter by date if specified
  if (options.since) {
    results = results.filter((r) => r.timestamp >= options.since!);
  }
  if (options.until) {
    results = results.filter((r) => r.timestamp < options.until!);
  }

  // Auto-fuzzy fallback: if fewer than threshold results, try wildcard search
  if (results.length < autoFuzzyThreshold) {
    const fuzzyResults = searchFuzzy(db, options.query, options.limit * 2);
    // Merge: add fuzzy results that aren't already in exact results
    const existingIds = new Set(results.map((r) => r.chunkId));
    for (const fr of fuzzyResults) {
      if (!existingIds.has(fr.chunkId)) {
        // Apply same filters
        if (options.project && fr.project !== options.project) continue;
        if (options.since && fr.timestamp < options.since) continue;
        if (options.until && fr.timestamp >= options.until) continue;
        results.push(fr);
        existingIds.add(fr.chunkId);
      }
    }
  }

  // Reranker: cross-encoder reorders pre-limit results by relevance
  const tRerank0 = performance.now();
  if (ctx?.reranker && results.length > 1) {
    try {
      const documents = results.map((r) => {
        const chunk = db
          .prepare('SELECT user_content, assistant_content FROM conv_chunks WHERE id = ?')
          .get(r.chunkId) as { user_content: string; assistant_content: string } | undefined;
        return {
          id: r.chunkId,
          content: chunk
            ? (chunk.user_content + ' ' + chunk.assistant_content).slice(0, 512)
            : r.snippet,
        };
      });

      const reranked = await ctx.reranker.rerank(options.query, documents, options.limit);
      const rerankedMap = new Map(reranked.map((rr, i) => [rr.id, { score: rr.score, rank: i }]));

      results = results
        .filter((r) => rerankedMap.has(r.chunkId))
        .sort((a, b) => {
          const ra = rerankedMap.get(a.chunkId)!;
          const rb = rerankedMap.get(b.chunkId)!;
          return ra.rank - rb.rank;
        })
        .map((r) => ({ ...r, score: rerankedMap.get(r.chunkId)!.score }));
    } catch (err) {
      logger.warn('search', 'Reranker failed — keeping original order', err);
    }
  }
  logger.debug('search', ` reranker: ${(performance.now() - tRerank0).toFixed(0)}ms`);

  // Project affinity boost: promote current project results when no strict project filter
  if (!options.project && options.currentProject) {
    for (const r of results) {
      if (r.project === options.currentProject) {
        // Handle both positive (RRF/reranker) and negative (raw BM25) scores
        r.score = r.score >= 0 ? r.score * PROJECT_BOOST_FACTOR : r.score / PROJECT_BOOST_FACTOR;
      }
    }
    results.sort((a, b) => b.score - a.score);
  }

  // Session affinity boost: promote current session results (weaker than project boost)
  if (options.currentSession) {
    for (const r of results) {
      if (r.sessionId === options.currentSession) {
        r.score = r.score >= 0 ? r.score * SESSION_BOOST_FACTOR : r.score / SESSION_BOOST_FACTOR;
      }
    }
    results.sort((a, b) => b.score - a.score);
  }

  // Re-sort if order is date-based (default is score from BM25/RRF/reranker)
  if (options.order === 'date_asc') {
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } else if (options.order === 'date_desc') {
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  const finalResults = results.slice(0, options.limit);

  // Update usage counters (best-effort, don't fail the search)
  try {
    incrementStat(db, 'search_count');
    if (finalResults.length > 0) {
      incrementStat(db, 'hit_count');
      const tokensServed = finalResults.reduce(
        (sum, r) => sum + Math.ceil(r.snippet.length / 4),
        0,
      );
      incrementStat(db, 'tokens_served', tokensServed);
    }
    setStat(db, 'last_search_at', new Date().toISOString());
  } catch {
    // Non-critical — don't fail searches if stats write fails
  }

  return finalResults;
}

export function searchFuzzy(db: Database.Database, query: string, limit: number): SearchResult[] {
  if (!query.trim()) return [];

  // Add wildcards for fuzzy matching: "term" -> "term*"
  const fuzzyQuery = query
    .split(/\s+/)
    .map((term) => `${term}*`)
    .join(' ');

  const results = searchBM25(db, fuzzyQuery, limit);
  return results.map((r) => ({ ...r, matchType: 'fuzzy' as const }));
}
