import { build } from 'esbuild';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';

// Clean dist/ to avoid stale files from deleted sources
rmSync('dist', { recursive: true, force: true });

const isHooks = process.argv[2] === 'hooks';

const esmShims = [
  'import { createRequire as __createRequire } from "module";',
  'import { fileURLToPath as __fileURLToPath } from "url";',
  'import { dirname as __dirnameFn } from "path";',
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirnameFn(__filename);',
].join('\n');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', 'node-llama-cpp', 'rotating-file-stream'],
  banner: {
    js: esmShims,
  },
};

// Build server (with shebang for npx / bin usage)
await build({
  ...shared,
  entryPoints: ['src/server.ts'],
  outdir: 'dist',
  banner: {
    js: '#!/usr/bin/env node\n' + esmShims,
  },
});

// Build embed worker (no shebang)
await build({
  ...shared,
  entryPoints: ['src/embed-worker.ts'],
  outdir: 'dist',
});

// Build daemon (with shebang for bin usage)
await build({
  ...shared,
  entryPoints: ['src/daemon.ts'],
  outdir: 'dist',
  banner: {
    js: '#!/usr/bin/env node\n' + esmShims,
  },
});

// Build hooks (no shebang needed)
await build({
  ...shared,
  entryPoints: [
    'src/hooks/session-end.ts',
    'src/hooks/session-start.ts',
    'src/hooks/pre-compact.ts',
  ],
  outdir: 'dist/hooks',
});

// Resolve ${CLAUDE_PLUGIN_ROOT} → absolute path (workaround for bug #9427)
// Normalize to forward slashes for cross-platform command compatibility (Windows)
const pluginRoot = resolve('.').replace(/\\/g, '/');

for (const file of ['hooks/hooks.json', '.mcp.json']) {
  const template = readFileSync(`${file}.template`, 'utf8');
  const resolved = template.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  writeFileSync(file, resolved);
}

console.error(`[build] Resolved CLAUDE_PLUGIN_ROOT → ${pluginRoot}`);
