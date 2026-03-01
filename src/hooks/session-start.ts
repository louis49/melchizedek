/**
 * Hook: SessionStart — inject intelligent context from past sessions.
 * Outputs hookSpecificOutput with additionalContext on stdout.
 */

import { pathToFileURL } from 'url';
import type Database from 'better-sqlite3';
import type { HookInput } from '../models.js';
import { openDatabase, closeDatabase, setStat } from '../db.js';
import { getConfig } from '../config.js';

/**
 * Build the context message to inject at session start.
 * Must be < 200 tokens (~800 chars). Only references existing tools.
 */
export function buildSessionStartMessage(db: Database.Database, project: string): string {
  const sessionCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM conv_sessions').get() as { cnt: number }
  ).cnt;

  if (sessionCount === 0) {
    return (
      'melchizedek: No sessions indexed yet. ' +
      'Sessions will be indexed automatically when you close Claude Code.'
    );
  }

  const chunkCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM conv_chunks').get() as { cnt: number }
  ).cnt;
  const projectCount = (
    db.prepare('SELECT COUNT(DISTINCT project) AS cnt FROM conv_sessions').get() as { cnt: number }
  ).cnt;

  // Project-specific info
  const projectSessions = (
    db.prepare('SELECT COUNT(*) AS cnt FROM conv_sessions WHERE project = ?').get(project) as {
      cnt: number;
    }
  ).cnt;

  const recentSession = db
    .prepare(
      'SELECT started_at FROM conv_sessions WHERE project = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(project) as { started_at: string } | undefined;

  let msg = `melchizedek: ${sessionCount} sessions, ${chunkCount} chunks across ${projectCount} projects.`;

  if (projectSessions > 0) {
    msg += ` This project (${project}): ${projectSessions} sessions.`;
    if (recentSession) {
      const ago = formatTimeAgo(recentSession.started_at);
      msg += ` Last: ${ago}.`;
    }
  }

  msg +=
    ' Use m9k_search(query) to find past context, m9k_errors(msg) for solutions, m9k_file_history(path) before editing files.';

  return msg;
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/**
 * Write current session info to stats table for session affinity boost.
 */
export function writeSessionStats(db: Database.Database, sessionId: string, cwd: string): void {
  setStat(db, 'current_session_id', sessionId);
  setStat(db, 'current_session_cwd', cwd);
  setStat(db, 'current_session_at', new Date().toISOString());
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
    console.error('[melchizedek] SessionStart: invalid JSON on stdin');
    process.exit(0);
  }

  const config = getConfig();
  const { db, schemaReady } = openDatabase(config.dbPath);

  if (!schemaReady) {
    console.error('[melchizedek] SessionStart: schema migration pending — skipping');
    closeDatabase(db);
    process.exit(0);
  }

  try {
    writeSessionStats(db, hookInput.session_id, hookInput.cwd);
    const message = buildSessionStartMessage(db, hookInput.cwd);
    // additionalContext: injected as invisible context for Claude
    // Note: no way to display a visible banner at startup (feature request #11120 closed "Not Planned")
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: message,
        },
      }),
    );
  } catch (err) {
    console.error('[melchizedek] SessionStart: error building message:', err);
  } finally {
    closeDatabase(db);
  }
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
  process.argv[1]?.endsWith('/session-start.js') ||
  process.argv[1]?.endsWith('\\session-start.js');

if (isMainModule) {
  main().catch((err) => {
    console.error('[melchizedek] SessionStart hook error:', err);
    process.exit(1);
  });
}
