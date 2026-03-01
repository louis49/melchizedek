import { describe, it, expect, afterEach } from 'vitest';
import { buildSessionStartMessage } from '../../src/hooks/session-start.js';
import { openMemoryDatabase, closeDatabase, getStat } from '../../src/db.js';
import { indexConvSession } from '../../src/indexer.js';
import { writeSessionStats } from '../../src/hooks/session-start.js';
import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

describe('SessionStart hook', () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) closeDatabase(db);
  });

  it('should return welcome message when DB is empty', () => {
    db = openMemoryDatabase().db;
    const msg = buildSessionStartMessage(db, '/test/project');

    expect(msg).toContain('No sessions indexed yet');
    expect(msg).toContain('automatically');
  });

  it('should return corpus stats when sessions exist', () => {
    db = openMemoryDatabase().db;
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    const msg = buildSessionStartMessage(db, '/Users/test/my-project');

    expect(msg).toContain('session');
    expect(msg).toContain('chunk');
    expect(msg).toContain('m9k_search');
    // Should NOT reference future tools
    expect(msg).not.toContain('reflect');
    expect(msg).not.toContain('detect_conflicts');
    expect(msg).not.toContain('forget');
  });

  it('should mention project-specific stats when project has sessions', () => {
    db = openMemoryDatabase().db;
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'sess-1', content, '/project-a', '/path/a.jsonl');
    indexConvSession(db, 'sess-2', content, '/project-b', '/path/b.jsonl');

    const msg = buildSessionStartMessage(db, '/project-a');

    expect(msg).toContain('project-a');
  });

  it('should be under 200 tokens (~800 chars)', () => {
    db = openMemoryDatabase().db;
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(db, 'sess-1', content, '/test', '/path.jsonl');

    const msg = buildSessionStartMessage(db, '/test');

    // ~4 chars per token — 200 tokens ≈ 800 chars max
    expect(msg.length).toBeLessThan(800);
  });

  describe('writeSessionStats', () => {
    it('should write current_session_id to stats', () => {
      db = openMemoryDatabase().db;
      writeSessionStats(db, 'test-session-123', '/test/project');

      expect(getStat(db, 'current_session_id')).toBe('test-session-123');
    });

    it('should write current_session_cwd to stats', () => {
      db = openMemoryDatabase().db;
      writeSessionStats(db, 'test-session-123', '/test/project');

      expect(getStat(db, 'current_session_cwd')).toBe('/test/project');
    });

    it('should write current_session_at as valid ISO date', () => {
      db = openMemoryDatabase().db;
      writeSessionStats(db, 'test-session-123', '/test/project');

      const at = getStat(db, 'current_session_at');
      expect(at).toBeTruthy();
      expect(new Date(at!).toISOString()).toBe(at);
    });
  });
});
