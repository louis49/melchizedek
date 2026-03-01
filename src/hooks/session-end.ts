/**
 * Hook: SessionEnd + Stop — index the completed session.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import type { HookInput } from '../models.js';
import { openDatabase, closeDatabase, setStat, isProjectIgnored } from '../db.js';
import { indexConvSession } from '../indexer.js';
import { getConfig } from '../config.js';

/**
 * Resolve the transcript path from HookInput.
 * Workaround for bug #13668: transcript_path is often empty.
 */
export function resolveTranscriptPath(hookInput: HookInput): string | null {
  if (hookInput.transcript_path) {
    return hookInput.transcript_path;
  }

  // Cannot reconstruct without cwd
  if (!hookInput.cwd) {
    return null;
  }

  // Reconstruct from cwd: /Users/foo/my-project → -Users-foo-my-project
  // On Windows: C:\Users\foo\project → C--Users-foo-project (colon → dash, slashes → dash)
  const encodedProject = hookInput.cwd
    .replace(/:/g, '-') // Replace colons with - (C: → C-)
    .replace(/[\\/]/g, '-'); // Replace both / and \ with -
  const candidatePath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedProject,
    `${hookInput.session_id}.jsonl`,
  );

  if (fs.existsSync(candidatePath)) {
    return candidatePath;
  }

  return null;
}

/**
 * Core logic: index a session from its hook input.
 * Extracted for testability — the hook main() reads stdin and calls this.
 */
export function handleSessionEnd(hookInput: HookInput): { indexed: boolean; error?: string } {
  const config = getConfig();
  const { db, schemaReady } = openDatabase(config.dbPath);

  if (!schemaReady) {
    closeDatabase(db);
    console.error(
      '[melchizedek] SessionEnd: schema migration pending — skipping (restart server to migrate)',
    );
    return { indexed: false };
  }

  try {
    // Always clear session affinity — session is ending regardless of indexing outcome
    setStat(db, 'current_session_id', '');

    // Skip indexation for ignored projects
    if (isProjectIgnored(db, hookInput.cwd)) {
      console.error(`[melchizedek] SessionEnd: skipping ignored project=${hookInput.cwd}`);
      return { indexed: false, error: 'project ignored' };
    }

    const transcriptPath = resolveTranscriptPath(hookInput);

    if (!transcriptPath) {
      console.error(
        `[melchizedek] SessionEnd: transcript not found for session=${hookInput.session_id}`,
      );
      return { indexed: false, error: 'transcript not found' };
    }

    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf8');
    } catch (err) {
      console.error(`[melchizedek] SessionEnd: failed to read ${transcriptPath}:`, err);
      return { indexed: false, error: 'failed to read transcript' };
    }

    indexConvSession(db, hookInput.session_id, content, hookInput.cwd, transcriptPath);
    console.error(
      `[melchizedek] SessionEnd: indexed session=${hookInput.session_id}, path=${transcriptPath}`,
    );
    return { indexed: true };
  } catch (err) {
    console.error(`[melchizedek] SessionEnd: indexation failed:`, err);
    return { indexed: false, error: 'indexation failed' };
  } finally {
    closeDatabase(db);
  }
}

async function main() {
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  let hookInput: HookInput;
  try {
    hookInput = JSON.parse(input) as HookInput;
  } catch {
    console.error('[melchizedek] SessionEnd: invalid JSON on stdin');
    process.exit(0);
  }

  handleSessionEnd(hookInput);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // Timeout to avoid hanging if no stdin
    setTimeout(() => resolve(data), 1000);
  });
}

// Only run when executed directly, not when imported for testing
const isMainModule =
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1]?.endsWith('/session-end.js') ||
  process.argv[1]?.endsWith('\\session-end.js');

if (isMainModule) {
  main().catch((err) => {
    console.error('[melchizedek] SessionEnd hook error:', err);
    process.exit(1);
  });
}
