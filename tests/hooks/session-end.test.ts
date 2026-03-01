import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveTranscriptPath, handleSessionEnd } from '../../src/hooks/session-end.js';
import {
  openDatabase as openTestDatabase,
  closeDatabase as closeTestDb,
  ignoreProject as ignoreTestProject,
} from '../../src/db.js';
import type { HookInput } from '../../src/models.js';

describe('SessionEnd hook', () => {
  describe('resolveTranscriptPath', () => {
    it('should return transcript_path when provided', () => {
      const input: HookInput = {
        session_id: 'abc-123',
        cwd: '/Users/test/my-project',
        transcript_path: '/explicit/path/to/session.jsonl',
      };

      const result = resolveTranscriptPath(input);
      expect(result).toBe('/explicit/path/to/session.jsonl');
    });

    it('should reconstruct path from cwd when transcript_path is empty', () => {
      const sessionId = 'test-session-id';
      const cwd = '/Users/test/my-project';
      const encodedProject = cwd.replace(/\//g, '-');
      const expectedPath = path.join(
        os.homedir(),
        '.claude',
        'projects',
        encodedProject,
        `${sessionId}.jsonl`,
      );

      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const input: HookInput = {
        session_id: sessionId,
        cwd,
        transcript_path: '',
      };

      const result = resolveTranscriptPath(input);
      expect(result).toBe(expectedPath);

      spy.mockRestore();
    });

    it('should reconstruct path from Windows cwd (backslashes + drive letter)', () => {
      const sessionId = 'win-session-id';
      const cwd = 'C:\\Users\\test\\my-project';
      // Windows: colon → dash, slashes → dash (C:\Users\test → C--Users-test)
      const encodedProject = 'C--Users-test-my-project';
      const expectedPath = path.join(
        os.homedir(),
        '.claude',
        'projects',
        encodedProject,
        `${sessionId}.jsonl`,
      );

      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const input: HookInput = {
        session_id: sessionId,
        cwd,
        transcript_path: '',
      };

      const result = resolveTranscriptPath(input);
      expect(result).toBe(expectedPath);

      spy.mockRestore();
    });

    it('should return null when cwd is undefined', () => {
      const input = {
        session_id: 'test-session',
        transcript_path: '',
      } as unknown as HookInput;

      const result = resolveTranscriptPath(input);
      expect(result).toBeNull();
    });

    it('should return null when transcript cannot be found', () => {
      const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const input: HookInput = {
        session_id: 'unknown-session',
        cwd: '/Users/test/no-project',
        transcript_path: '',
      };

      const result = resolveTranscriptPath(input);
      expect(result).toBeNull();

      spy.mockRestore();
    });
  });

  describe('handleSessionEnd', () => {
    it('should handle missing transcript_path gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-test-'));
      process.env.M9K_DB_PATH = path.join(tmpDir, 'memory.db');

      try {
        const result = handleSessionEnd({
          session_id: 'missing-session',
          cwd: '/nonexistent',
          transcript_path: '',
        });

        expect(result.indexed).toBe(false);
        expect(result.error).toBe('transcript not found');
      } finally {
        delete process.env.M9K_DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should index when transcript file exists', () => {
      // Create a temporary JSONL file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-test-'));
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

      // Set DB path to temp dir
      const dbPath = path.join(tmpDir, 'memory.db');
      process.env.M9K_DB_PATH = dbPath;

      try {
        const result = handleSessionEnd({
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

    it('should skip indexation for ignored projects', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-test-'));
      const dbPath = path.join(tmpDir, 'memory.db');
      process.env.M9K_DB_PATH = dbPath;

      try {
        // Create a JSONL file for the session
        const jsonlPath = path.join(tmpDir, 'test-session.jsonl');
        const jsonlContent = [
          JSON.stringify({
            type: 'user',
            uuid: 'u-1',
            sessionId: 'test-session',
            timestamp: '2026-02-25T10:00:00.000Z',
            cwd: '/test/secret-repo',
            message: { role: 'user', content: 'Hello' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a-1',
            parentUuid: 'u-1',
            sessionId: 'test-session',
            timestamp: '2026-02-25T10:00:05.000Z',
            cwd: '/test/secret-repo',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
          }),
        ].join('\n');
        fs.writeFileSync(jsonlPath, jsonlContent);

        // Add the project to the ignore list via direct DB manipulation
        const { db } = openTestDatabase(dbPath);
        ignoreTestProject(db, '/test/secret-repo');
        closeTestDb(db);

        const result = handleSessionEnd({
          session_id: 'test-session',
          cwd: '/test/secret-repo',
          transcript_path: jsonlPath,
        });

        expect(result.indexed).toBe(false);
        expect(result.error).toBe('project ignored');
      } finally {
        delete process.env.M9K_DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should exit 0 equivalent on empty input', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melchizedek-test-'));
      process.env.M9K_DB_PATH = path.join(tmpDir, 'memory.db');

      try {
        const result = handleSessionEnd({
          session_id: '',
          cwd: '',
          transcript_path: '',
        });
        expect(result.indexed).toBe(false);
      } finally {
        delete process.env.M9K_DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
