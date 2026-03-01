import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handlePreCompact } from '../../src/hooks/pre-compact.js';

describe('PreCompact hook', () => {
  it('should handle missing transcript gracefully', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = handlePreCompact({
      session_id: 'missing-session',
      cwd: '/nonexistent',
      transcript_path: '',
    });

    expect(result.indexed).toBe(false);
    expect(result.error).toBe('transcript not found');

    spy.mockRestore();
  });

  it('should index session from transcript', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-precompact-'));
    const jsonlPath = path.join(tmpDir, 'test-session.jsonl');
    const jsonlContent = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        sessionId: 'test-session',
        timestamp: '2026-02-25T10:00:00.000Z',
        cwd: '/test',
        message: { role: 'user', content: 'Hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'test-session',
        timestamp: '2026-02-25T10:00:05.000Z',
        cwd: '/test',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      }),
    ].join('\n');
    fs.writeFileSync(jsonlPath, jsonlContent);

    const dbPath = path.join(tmpDir, 'memory.db');
    process.env.M9K_DB_PATH = dbPath;

    try {
      const result = handlePreCompact({
        session_id: 'test-session',
        cwd: '/test',
        transcript_path: jsonlPath,
      });

      expect(result.indexed).toBe(true);
    } finally {
      delete process.env.M9K_DB_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should be idempotent — re-indexing same content is skipped', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-precompact-'));
    const jsonlPath = path.join(tmpDir, 'test-session.jsonl');
    const jsonlContent = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        sessionId: 'idem-session',
        timestamp: '2026-02-25T10:00:00.000Z',
        cwd: '/test',
        message: { role: 'user', content: 'Hello again' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'idem-session',
        timestamp: '2026-02-25T10:00:05.000Z',
        cwd: '/test',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
      }),
    ].join('\n');
    fs.writeFileSync(jsonlPath, jsonlContent);

    const dbPath = path.join(tmpDir, 'memory.db');
    process.env.M9K_DB_PATH = dbPath;

    try {
      // First call indexes
      const result1 = handlePreCompact({
        session_id: 'idem-session',
        cwd: '/test',
        transcript_path: jsonlPath,
      });
      expect(result1.indexed).toBe(true);

      // Second call with same content — skipped (file_hash unchanged)
      const result2 = handlePreCompact({
        session_id: 'idem-session',
        cwd: '/test',
        transcript_path: jsonlPath,
      });
      expect(result2.indexed).toBe(false);
      expect(result2.skipped).toBe(true);
    } finally {
      delete process.env.M9K_DB_PATH;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
