/**
 * JSONL parsing, chunking, and indexation.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type {
  BackfillResult,
  ConvChunk,
  ConvChunkMetadata,
  Embedder,
  JnlMessage,
  OrphanDetectionResult,
} from './models.js';
import { getChunksWithoutEmbeddings, insertVectorsBatch, isProjectIgnored } from './db.js';
import { logger } from './logger.js';
import { CONV_KIND_EXCHANGE } from './constants.js';

export function parseJSONL(content: string): JnlMessage[] {
  const messages: JnlMessage[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === 'user' || parsed.type === 'assistant') {
        messages.push(parsed as unknown as JnlMessage);
      }
    } catch {
      // Skip malformed lines — MUST NOT crash (rule #4)
      logger.warn('indexer', `Skipping malformed JSONL line: ${trimmed.slice(0, 80)}...`);
    }
  }

  return messages;
}

export function stripPrivateTags(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/g, '[REDACTED]');
}

export function extractTextContent(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((block): block is { type: string; text: string } => {
      const b = block as Record<string, unknown>;
      return b.type === 'text' && typeof b.text === 'string';
    })
    .map((block) => block.text)
    .join('\n');
}

export function isToolResultMessage(msg: JnlMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message.content;
  if (typeof content === 'string') return false;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as Record<string, unknown>).type === 'tool_result');
}

export function chunkMessages(messages: JnlMessage[]): Omit<ConvChunk, 'id'>[] {
  const chunks: Omit<ConvChunk, 'id'>[] = [];

  // Find indices of "real" user messages (not tool_result auto-responses)
  const realUserIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'user' && !isToolResultMessage(messages[i])) {
      realUserIndices.push(i);
    }
  }

  for (let u = 0; u < realUserIndices.length; u++) {
    const userIdx = realUserIndices[u];
    const nextUserIdx = u + 1 < realUserIndices.length ? realUserIndices[u + 1] : messages.length;
    const userMsg = messages[userIdx];

    const userText = stripPrivateTags(extractTextContent(userMsg.message.content));

    // Collect ALL assistant messages between this real user and the next
    const assistantTexts: string[] = [];
    const assistantMessages: JnlMessage[] = [];

    for (let j = userIdx + 1; j < nextUserIdx; j++) {
      if (messages[j].type === 'assistant') {
        const text = extractTextContent(messages[j].message.content);
        if (text) assistantTexts.push(text);
        assistantMessages.push(messages[j]);
      }
    }

    const assistantText = stripPrivateTags(assistantTexts.join('\n'));
    const combined = userText + '\n' + assistantText;
    const hash = crypto.createHash('sha256').update(combined).digest('hex');
    const combinedLength = userText.length + assistantText.length;

    chunks.push({
      sessionId: userMsg.sessionId,
      index: chunks.length,
      kind: CONV_KIND_EXCHANGE,
      userContent: userText,
      assistantContent: assistantText,
      hash,
      timestamp: userMsg.timestamp,
      tokenCount: Math.ceil(combinedLength / 4),
      tags: null,
      metadata: extractMetadataFromMessages(assistantMessages),
    });
  }

  return chunks;
}

function extractMetadataFromMessages(assistants: JnlMessage[]): ConvChunkMetadata {
  const toolCalls = new Set<string>();
  const filePaths = new Set<string>();
  const errorMessages = new Set<string>();

  for (const assistant of assistants) {
    if (assistant.type !== 'assistant') continue;
    const content = assistant.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.add(b.name);
        const input = b.input as Record<string, unknown> | undefined;
        if (input) {
          if (typeof input.file_path === 'string') filePaths.add(input.file_path);
          if (typeof input.pattern === 'string') filePaths.add(input.pattern);
        }
      }
    }
  }

  return {
    toolCalls: [...toolCalls],
    filePaths: [...filePaths],
    errorMessages: [...errorMessages],
  };
}

export function indexConvSession(
  db: Database.Database,
  sessionId: string,
  jsonlContent: string,
  project: string,
  jsonlPath: string,
): 'indexed' | 'skipped' {
  const fileHash = crypto.createHash('sha256').update(jsonlContent).digest('hex');

  // Fast-check: skip if tombstoned (soft-deleted) or file_hash unchanged
  const existingSession = db
    .prepare('SELECT id, file_hash, deleted_at FROM conv_sessions WHERE id = ?')
    .get(sessionId) as { id: string; file_hash: string; deleted_at: string | null } | undefined;

  if (existingSession?.deleted_at) {
    return 'skipped';
  }

  if (existingSession && existingSession.file_hash === fileHash) {
    return 'skipped';
  }

  const messages = parseJSONL(jsonlContent);

  // Skip empty sessions (no user/assistant messages) — avoids ghost entries
  if (messages.length === 0) {
    return 'skipped';
  }

  const chunks = chunkMessages(messages);

  const fileSize = Buffer.byteLength(jsonlContent, 'utf8');

  const startedAt = messages.length > 0 ? messages[0].timestamp : new Date().toISOString();
  const endedAt = messages.length > 0 ? messages[messages.length - 1].timestamp : null;

  if (existingSession) {
    // Re-indexing: delete old chunks but preserve soft-deleted ones (forget tombstones)
    db.prepare('DELETE FROM conv_chunks WHERE session_id = ? AND deleted_at IS NULL').run(
      sessionId,
    );
    db.prepare(
      `UPDATE conv_sessions SET project = ?, jsonl_path = ?, file_hash = ?, file_size = ?,
       started_at = ?, ended_at = ?, message_count = ?, chunk_count = ?, indexed_at = datetime('now')
       WHERE id = ?`,
    ).run(
      project,
      jsonlPath,
      fileHash,
      fileSize,
      startedAt,
      endedAt,
      messages.length,
      chunks.length,
      sessionId,
    );
  } else {
    db.prepare(
      `INSERT INTO conv_sessions (id, project, jsonl_path, file_hash, file_size, started_at, ended_at, message_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      project,
      jsonlPath,
      fileHash,
      fileSize,
      startedAt,
      endedAt,
      messages.length,
      chunks.length,
    );
  }

  // Insert chunks with dedup by hash
  const insertChunk = db.prepare(
    `INSERT OR IGNORE INTO conv_chunks (id, session_id, idx, kind, user_content, assistant_content, hash, timestamp, token_count, tags, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertMany = db.transaction(() => {
    for (const chunk of chunks) {
      const chunkId = `${sessionId}:${chunk.index}`;
      insertChunk.run(
        chunkId,
        sessionId,
        chunk.index,
        chunk.kind,
        chunk.userContent,
        chunk.assistantContent,
        chunk.hash,
        chunk.timestamp,
        chunk.tokenCount,
        chunk.tags ? JSON.stringify(chunk.tags) : null,
        JSON.stringify(chunk.metadata),
      );
    }
  });

  insertMany();
  return 'indexed';
}

/**
 * Extract project path (cwd) from the first user message in parsed JSONL messages.
 * Returns the cwd field if present, otherwise undefined.
 */
export function extractProjectFromJsonl(messages: JnlMessage[]): string | undefined {
  for (const msg of messages) {
    if (msg.cwd) return msg.cwd;
  }
  return undefined;
}

/**
 * Scan jsonlDir for existing JSONL files and index them.
 * Directory structure: <encoded-project>/<session-uuid>.jsonl
 */
export function backfillExistingSessions(db: Database.Database, jsonlDir: string): BackfillResult {
  const result: BackfillResult = { scanned: 0, indexed: 0, skipped: 0, errors: 0 };

  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(jsonlDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // Directory doesn't exist or unreadable — not an error, just nothing to do
    return result;
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(jsonlDir, projectDir);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      result.scanned++;
      const jsonlPath = path.join(projectPath, file);
      const sessionId = path.basename(file, '.jsonl');

      try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const messages = parseJSONL(content);
        const project = extractProjectFromJsonl(messages) ?? projectDir;

        // Skip ignored projects
        if (isProjectIgnored(db, project)) {
          result.skipped++;
          continue;
        }

        const status = indexConvSession(db, sessionId, content, project, jsonlPath);
        if (status === 'indexed') {
          result.indexed++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.errors++;
        logger.error('indexer', `Backfill error for ${jsonlPath}`, err);
      }
    }
  }

  // Clean up ghost sessions (message_count=0) from previous backfills
  const deleted = db
    .prepare(
      "DELETE FROM conv_sessions WHERE message_count = 0 AND chunk_count = 0 AND id != '__manual_memories__'",
    )
    .run();
  if (deleted.changes > 0) {
    logger.info('indexer', `Backfill: cleaned up ${deleted.changes} ghost sessions`);
  }

  return result;
}

/**
 * Detect orphaned sessions — indexed sessions whose source JSONL no longer exists.
 * Optionally purge them from the index.
 */
export function detectOrphanedSessions(
  db: Database.Database,
  purge: boolean,
): OrphanDetectionResult {
  const sessions = db
    .prepare(
      "SELECT id, jsonl_path FROM conv_sessions WHERE id != '__manual_memories__' AND deleted_at IS NULL",
    )
    .all() as Array<{ id: string; jsonl_path: string }>;

  let orphanedCount = 0;
  let purgedCount = 0;

  for (const session of sessions) {
    // Skip sessions with synthetic paths (e.g. manual memories)
    if (!session.jsonl_path || session.jsonl_path === '__manual__') continue;

    if (!fs.existsSync(session.jsonl_path)) {
      orphanedCount++;
      if (purge) {
        db.prepare('DELETE FROM conv_sessions WHERE id = ?').run(session.id);
        purgedCount++;
        logger.info('indexer', `Purged orphaned session: ${session.id}`);
      } else {
        logger.debug('indexer', `Orphaned session (kept as archive): ${session.id}`);
      }
    }
  }

  return { orphanedCount, purgedCount };
}

/**
 * Embed chunks that don't have vectors yet.
 * Returns the number of chunks embedded.
 */
export async function embedChunks(
  db: Database.Database,
  embedder: Embedder,
  suffix = '_text',
  batchSize = 50,
  onProgress?: (embedded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  let done = 0;

  // Count total eligible chunks without embeddings upfront
  const firstBatch = getChunksWithoutEmbeddings(db, batchSize, suffix);
  if (firstBatch.length === 0) return 0;

  // Estimate total by counting all remaining eligible chunks
  const totalEligible = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM conv_chunks c
         LEFT JOIN conv_vec_map${suffix} m ON c.id = m.chunk_id
         WHERE m.chunk_id IS NULL
           AND LENGTH(c.user_content) + LENGTH(c.assistant_content) >= 50`,
      )
      .get() as { cnt: number }
  ).cnt;

  // Process first batch
  let missing = firstBatch;

  while (missing.length > 0) {
    if (signal?.aborted) break;

    const texts = missing.map((c) => c.content);
    const lengths = texts.map((t) => t.length);
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);
    const avgLen = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
    logger.debug(
      'indexer',
      `embedChunks${suffix}: batch=${texts.length}, len min=${minLen} max=${maxLen} avg=${avgLen}`,
    );

    let embeddings: Float32Array[];
    try {
      embeddings = await embedder.embedBatch(texts);
    } catch (err) {
      logger.error(
        'indexer',
        `embedBatch failed for ${texts.length} chunks (max ${maxLen} chars), aborting:`,
        err,
      );
      break;
    }

    if (signal?.aborted) break;

    const items = missing.map((c, i) => ({
      chunkId: c.id,
      embedding: embeddings[i],
    }));

    insertVectorsBatch(db, items, suffix);
    done += items.length;

    onProgress?.(done, totalEligible);

    missing = getChunksWithoutEmbeddings(db, batchSize, suffix);
  }
  return done;
}
