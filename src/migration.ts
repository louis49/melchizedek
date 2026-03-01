/**
 * Embedding model migration: dual-index zero-downtime re-embedding.
 *
 * State machine: prepare → reembed → swap | abort
 * Meta keys: embedding_model_id, embedding_dimensions, migration_*
 */

import type Database from 'better-sqlite3';
import type { Embedder } from './models.js';
import { getMeta, setMeta, deleteMeta, createVecTables, insertVectorsBatchToTable } from './db.js';
import { logger } from './logger.js';

const P = 'migration';

// --- Seed + Detect ---

export function seedEmbeddingMeta(
  db: Database.Database,
  embedder: Embedder | null,
  suffix = '_text',
): void {
  if (!embedder) return;
  const existing = getMeta(db, `embedding_model_id${suffix}`);
  if (existing) return; // Already seeded
  setMeta(db, `embedding_model_id${suffix}`, embedder.modelId());
  setMeta(db, `embedding_dimensions${suffix}`, String(embedder.dimensions()));
}

export interface ModelChange {
  oldModelId: string;
  newModelId: string;
  oldDimensions: number;
  newDimensions: number;
}

export function detectModelChange(
  db: Database.Database,
  embedder: Embedder,
  suffix = '_text',
): ModelChange | null {
  const storedModelId = getMeta(db, `embedding_model_id${suffix}`);
  if (!storedModelId) return null; // First time — no change to detect

  if (storedModelId === embedder.modelId()) return null; // Same model

  const storedDimensions = parseInt(getMeta(db, `embedding_dimensions${suffix}`) ?? '0', 10);

  return {
    oldModelId: storedModelId,
    newModelId: embedder.modelId(),
    oldDimensions: storedDimensions,
    newDimensions: embedder.dimensions(),
  };
}

// --- Migration result ---

export interface MigrationResult {
  embedded: number;
  aborted: boolean;
  swapped: boolean;
}

// --- Migration lock ---

export function acquireMigrationLock(
  db: Database.Database,
  instanceId?: string,
  suffix = '_text',
): boolean {
  const existingLock = getMeta(db, `migration_lock${suffix}`);
  if (existingLock) {
    // Check if the lock holder is a dead process (stale lock)
    const pidMatch = existingLock.match(/^pid-(\d+)$/);
    if (pidMatch) {
      const pid = parseInt(pidMatch[1], 10);
      try {
        process.kill(pid, 0); // Throws if process doesn't exist
        return false; // Process alive — lock is valid
      } catch {
        // Process dead — stale lock, clean it up
        logger.warn(P, `Cleaning stale lock from dead process ${pid}`);
        deleteMeta(db, `migration_lock${suffix}`);
      }
    } else {
      return false; // Non-PID lock, respect it
    }
  }
  setMeta(db, `migration_lock${suffix}`, instanceId ?? `pid-${process.pid}`);
  return true;
}

export function releaseMigrationLock(db: Database.Database, suffix = '_text'): void {
  deleteMeta(db, `migration_lock${suffix}`);
}

// --- Migration engine ---

const MIN_EMBED_CONTENT_LENGTH = 50;

export class EmbeddingMigration {
  private db: Database.Database;
  private embedder: Embedder;
  private batchSize: number;
  private signal?: AbortSignal;
  private onProgress?: (embedded: number, total: number) => void;
  private suffix: string;

  constructor(
    db: Database.Database,
    embedder: Embedder,
    options?: {
      batchSize?: number;
      signal?: AbortSignal;
      onProgress?: (embedded: number, total: number) => void;
      suffix?: string;
    },
  ) {
    this.db = db;
    this.embedder = embedder;
    this.batchSize = options?.batchSize ?? 50;
    this.signal = options?.signal;
    this.onProgress = options?.onProgress;
    this.suffix = options?.suffix ?? '_text';
  }

  /** Set onProgress callback (useful when resuming a migration) */
  setOnProgress(cb: (embedded: number, total: number) => void): void {
    this.onProgress = cb;
  }

  /** Phase 1: Create _next tables + set migration meta */
  prepare(): void {
    const targetModel = this.embedder.modelId();
    const targetDimensions = this.embedder.dimensions();

    createVecTables(this.db, targetDimensions, `${this.suffix}_next`);

    setMeta(this.db, `migration_target_model${this.suffix}`, targetModel);
    setMeta(this.db, `migration_target_dimensions${this.suffix}`, String(targetDimensions));
    setMeta(this.db, `migration_progress${this.suffix}`, '0');
    setMeta(this.db, `migration_started_at${this.suffix}`, new Date().toISOString());
  }

  /** Phase 2: Re-embed all eligible chunks into _next tables */
  async reembed(): Promise<{ embedded: number; aborted: boolean }> {
    let totalEmbedded = parseInt(getMeta(this.db, `migration_progress${this.suffix}`) ?? '0', 10);

    const totalEligible = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM conv_chunks
           WHERE deleted_at IS NULL
             AND LENGTH(user_content) + LENGTH(assistant_content) >= ?`,
        )
        .get(MIN_EMBED_CONTENT_LENGTH) as { cnt: number }
    ).cnt;

    logger.debug(
      P,
      `reembed${this.suffix}: ${totalEmbedded} already done, ${totalEligible} eligible`,
    );

    let batch = this.getNextBatch();
    logger.debug(P, `reembed${this.suffix}: first batch size=${batch.length}`);
    while (batch.length > 0) {
      if (this.signal?.aborted) {
        return { embedded: totalEmbedded, aborted: true };
      }

      logger.debug(P, `reembed${this.suffix}: embedding batch of ${batch.length} chunks`);
      const count = await this.reembedBatch(batch);
      totalEmbedded += count;
      logger.debug(P, `reembed${this.suffix}: batch done, total=${totalEmbedded}/${totalEligible}`);

      // Checkpoint
      setMeta(this.db, `migration_progress${this.suffix}`, String(totalEmbedded));
      this.onProgress?.(totalEmbedded, totalEligible);

      batch = this.getNextBatch();
    }

    logger.debug(P, `reembed${this.suffix}: complete, total=${totalEmbedded}`);
    return { embedded: totalEmbedded, aborted: false };
  }

  /** Embed a single batch into _next tables */
  async reembedBatch(batch?: Array<{ id: string; content: string }>): Promise<number> {
    const items = batch ?? this.getNextBatch();
    if (items.length === 0) return 0;

    const texts = items.map((c) => c.content);
    const lengths = texts.map((t) => t.length);
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);
    const avgLen = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
    logger.debug(
      P,
      `reembedBatch${this.suffix}: ${texts.length} texts, len min=${minLen} max=${maxLen} avg=${avgLen}`,
    );
    const embeddings = await this.embedder.embedBatch(texts);

    const vectorItems = items.map((c, i) => ({
      chunkId: c.id,
      embedding: embeddings[i],
    }));

    insertVectorsBatchToTable(this.db, vectorItems, `${this.suffix}_next`);
    return items.length;
  }

  /** Phase 3: Atomic swap — drop old, rename _next, update meta */
  swap(): void {
    const targetModel = getMeta(this.db, `migration_target_model${this.suffix}`)!;
    const targetDimensions = parseInt(
      getMeta(this.db, `migration_target_dimensions${this.suffix}`)!,
      10,
    );

    // Drop old vec + map tables
    this.db.exec(`
      DROP TABLE IF EXISTS conv_vec_map${this.suffix};
      DROP TABLE IF EXISTS conv_vec${this.suffix};
    `);

    // CRITICAL: sqlite-vec virtual tables cannot be safely renamed with
    // ALTER TABLE RENAME — the backing tables (_info, _chunks, _rowids,
    // _vector_chunks00) keep their old names, breaking INSERT/SELECT.
    // Instead: create fresh vec table, copy data, then drop _next.
    createVecTables(this.db, targetDimensions, this.suffix);

    // Copy vectors from _next into the fresh table
    this.db.exec(`
      INSERT INTO conv_vec${this.suffix}(rowid, embedding)
        SELECT rowid, embedding FROM conv_vec${this.suffix}_next;

      INSERT INTO conv_vec_map${this.suffix}(vec_rowid, chunk_id)
        SELECT vec_rowid, chunk_id FROM conv_vec_map${this.suffix}_next;
    `);

    // Drop _next tables
    this.db.exec(`
      DROP TABLE IF EXISTS conv_vec_map${this.suffix}_next;
      DROP TABLE IF EXISTS conv_vec${this.suffix}_next;
      DROP INDEX IF EXISTS idx_conv_vec_map_chunk${this.suffix}_next;
    `);

    setMeta(this.db, `embedding_model_id${this.suffix}`, targetModel);
    setMeta(this.db, `embedding_dimensions${this.suffix}`, String(targetDimensions));
    this.cleanupMigrationMeta();
  }

  /** Abort: drop _next tables, clean up meta */
  abort(): void {
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS conv_vec_map${this.suffix}_next;
        DROP TABLE IF EXISTS conv_vec${this.suffix}_next;
      `);
    } catch (err) {
      // sqlite-vec virtual tables can fail to DROP — don't let that block meta cleanup
      logger.warn(P, `Failed to drop _next tables for ${this.suffix} (non-fatal):`, err);
    }
    this.cleanupMigrationMeta();
  }

  private cleanupMigrationMeta(): void {
    deleteMeta(this.db, `migration_target_model${this.suffix}`);
    deleteMeta(this.db, `migration_target_dimensions${this.suffix}`);
    deleteMeta(this.db, `migration_progress${this.suffix}`);
    deleteMeta(this.db, `migration_started_at${this.suffix}`);
  }

  /** Full lifecycle: prepare → reembed → swap | abort */
  async run(): Promise<MigrationResult> {
    logger.debug(P, `Migration.run() starting for ${this.suffix}`);
    const locked = acquireMigrationLock(this.db, undefined, this.suffix);
    if (!locked) {
      logger.warn(P, `Migration.run() failed to acquire lock for ${this.suffix}`);
      return { embedded: 0, aborted: true, swapped: false };
    }
    logger.debug(P, `Lock acquired for ${this.suffix}`);

    try {
      // Check if prepare is needed (resuming skips prepare)
      if (!getMeta(this.db, `migration_target_model${this.suffix}`)) {
        logger.debug(P, `Preparing migration for ${this.suffix}`);
        this.prepare();
      } else {
        // Verify _next tables still exist — they may have been dropped by a SIGKILL
        const nextTableExists = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(`conv_vec_map${this.suffix}_next`);
        if (!nextTableExists) {
          logger.debug(P, `_next tables missing, re-preparing for ${this.suffix}`);
          this.prepare();
        } else {
          logger.debug(P, `Resuming existing migration for ${this.suffix}`);
        }
      }

      logger.debug(P, `Starting reembed for ${this.suffix}`);
      const { embedded, aborted } = await this.reembed();

      if (aborted) {
        this.abort();
        return { embedded, aborted: true, swapped: false };
      }

      this.swap();
      return { embedded, aborted: false, swapped: true };
    } catch (err) {
      // Clean up on ANY error — don't leave migration meta stuck forever
      logger.error(P, `Error during ${this.suffix} migration, aborting:`, err);
      try {
        this.abort();
      } catch {
        /* ignore cleanup errors */
      }
      return { embedded: 0, aborted: true, swapped: false };
    } finally {
      releaseMigrationLock(this.db, this.suffix);
    }
  }

  /** Resume an in-progress migration or start fresh if target model changed */
  static resume(
    db: Database.Database,
    embedder: Embedder,
    options?: {
      batchSize?: number;
      signal?: AbortSignal;
      onProgress?: (embedded: number, total: number) => void;
      suffix?: string;
    },
  ): EmbeddingMigration | null {
    const suffix = options?.suffix ?? '_text';
    const targetModel = getMeta(db, `migration_target_model${suffix}`);
    if (!targetModel) return null; // No migration in progress

    const migration = new EmbeddingMigration(db, embedder, options);

    if (targetModel !== embedder.modelId()) {
      // Target changed — abort old migration, return fresh instance
      migration.abort();
      return new EmbeddingMigration(db, embedder, options);
    }

    return migration;
  }

  /** Get next batch of chunks not yet in _next tables */
  private getNextBatch(): Array<{ id: string; content: string }> {
    return this.db
      .prepare(
        `SELECT c.id, (c.user_content || ' ' || c.assistant_content) AS content
         FROM conv_chunks c
         LEFT JOIN conv_vec_map${this.suffix}_next m ON c.id = m.chunk_id
         WHERE m.chunk_id IS NULL
           AND c.deleted_at IS NULL
           AND LENGTH(c.user_content) + LENGTH(c.assistant_content) >= ?
         ORDER BY c.timestamp DESC
         LIMIT ?`,
      )
      .all(MIN_EMBED_CONTENT_LENGTH, this.batchSize) as Array<{
      id: string;
      content: string;
    }>;
  }
}
