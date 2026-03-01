/**
 * Hook: PreCompact — index chunks not yet indexed before /compact.
 * Uses the same indexConvSession() logic as SessionEnd.
 * Dedup via SHA-256 hash ensures no duplicates if both hooks run.
 */

import fs from 'fs';
import { pathToFileURL } from 'url';
import type { HookInput } from '../models.js';
import { resolveTranscriptPath } from './session-end.js';
import { openDatabase, closeDatabase } from '../db.js';
import { indexConvSession } from '../indexer.js';
import { getConfig } from '../config.js';

export function handlePreCompact(hookInput: HookInput): {
  indexed: boolean;
  skipped?: boolean;
  error?: string;
} {
  const transcriptPath = resolveTranscriptPath(hookInput);

  if (!transcriptPath) {
    console.error(
      `[melchizedek] PreCompact: transcript not found for session=${hookInput.session_id}`,
    );
    return { indexed: false, error: 'transcript not found' };
  }

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    console.error(`[melchizedek] PreCompact: failed to read ${transcriptPath}:`, err);
    return { indexed: false, error: 'failed to read transcript' };
  }

  const config = getConfig();
  const { db, schemaReady } = openDatabase(config.dbPath);

  if (!schemaReady) {
    console.error('[melchizedek] PreCompact: schema migration pending — skipping');
    closeDatabase(db);
    return { indexed: false, error: 'schema migration pending' };
  }

  try {
    const status = indexConvSession(
      db,
      hookInput.session_id,
      content,
      hookInput.cwd,
      transcriptPath,
    );
    if (status === 'skipped') {
      console.error(`[melchizedek] PreCompact: session=${hookInput.session_id} unchanged, skipped`);
      return { indexed: false, skipped: true };
    }
    console.error(
      `[melchizedek] PreCompact: indexed session=${hookInput.session_id}, path=${transcriptPath}`,
    );
    return { indexed: true };
  } catch (err) {
    console.error(`[melchizedek] PreCompact: indexation failed:`, err);
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
    console.error('[melchizedek] PreCompact: invalid JSON on stdin');
    process.exit(0);
  }

  handlePreCompact(hookInput);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

const isMainModule =
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1]?.endsWith('/pre-compact.js') ||
  process.argv[1]?.endsWith('\\pre-compact.js');

if (isMainModule) {
  main().catch((err) => {
    console.error('[melchizedek] PreCompact hook error:', err);
    process.exit(1);
  });
}
