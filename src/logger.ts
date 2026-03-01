/**
 * Rotating file logger — writes to ~/.melchizedek/logs/ with size + time rotation.
 * Always logs to stderr (MCP protocol reserves stdout), optionally to file.
 */

import { createStream, type RotatingFileStream } from 'rotating-file-stream';
import path from 'path';
import os from 'os';
import fs from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'warn';
let fileStream: RotatingFileStream | null = null;

export function initLogger(opts?: { level?: LogLevel; logDir?: string }): void {
  currentLevel = opts?.level ?? 'warn';
  const logDir = opts?.logDir ?? path.join(os.homedir(), '.melchizedek', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  fileStream = createStream('melchizedek.log', {
    path: logDir,
    size: '10M',
    interval: '7d',
    maxFiles: 5,
    compress: 'gzip',
  });
}

export function closeLogger(): void {
  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function log(level: LogLevel, prefix: string, msg: string, ...args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const ts = new Date().toISOString();
  const formatted = `${ts} [${level.toUpperCase()}] [${prefix}] ${msg}`;

  // Always write errors/warnings to stderr; debug/info only when level is low enough
  if (level === 'error' || level === 'warn') {
    console.error(`[${prefix}] ${msg}`, ...args);
  } else if (LEVEL_ORDER[currentLevel] <= LEVEL_ORDER['debug']) {
    console.error(`[${prefix}] ${msg}`, ...args);
  }

  // Write to file if initialized
  if (fileStream) {
    const argsStr =
      args.length > 0
        ? ' ' +
          args
            .map((a) => (a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
            .join(' ')
        : '';
    fileStream.write(formatted + argsStr + '\n');
  }
}

export const logger = {
  debug: (prefix: string, msg: string, ...args: unknown[]) => log('debug', prefix, msg, ...args),
  info: (prefix: string, msg: string, ...args: unknown[]) => log('info', prefix, msg, ...args),
  warn: (prefix: string, msg: string, ...args: unknown[]) => log('warn', prefix, msg, ...args),
  error: (prefix: string, msg: string, ...args: unknown[]) => log('error', prefix, msg, ...args),
};
