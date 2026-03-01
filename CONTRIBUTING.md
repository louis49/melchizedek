# Contributing to melchizedek

Thank you for your interest in contributing to melchizedek!

## Development Setup

```bash
git clone https://github.com/louis49/melchizedek.git
cd melchizedek
npm install
npm run build
npm test
```

### Requirements

- Node.js >= 20
- npm >= 10

## Development Workflow

We follow **Test-Driven Development (TDD)**:

1. **RED** — Write a failing test
2. **GREEN** — Write the minimum code to make it pass
3. **REFACTOR** — Clean up without breaking tests

### Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint 9 + Prettier check |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run typecheck` | TypeScript type checking |
| `npm run check` | Full check: lint + typecheck + test |
| `npm run build` | Build with esbuild |

### Before Submitting

- [ ] `npm run check` passes (lint + typecheck + tests)
- [ ] `npm run build` produces `dist/` without errors
- [ ] No `console.log()` in `src/` (use `console.error()` — STDIO protocol)
- [ ] No secrets, tokens, or absolute paths in code
- [ ] New files use `.js` extension in imports (ESM)
- [ ] CHANGELOG.md updated if user-visible change

## TypeScript Conventions

- **ESM strict**: `"type": "module"`, imports with `.js` extension
- **Strict mode**: `strict: true`, `noUnusedLocals`, `noUnusedParameters`
- **Interfaces > types** except for unions
- **PascalCase** for interfaces/types, **camelCase** for functions/variables
- **kebab-case** for file names
- No `any` — use `unknown` + type guards
- No classes except for interface implementations

## Testing Conventions

- Framework: Vitest
- Database: always `:memory:` (never disk files in tests)
- MCP tools: test via `InMemoryTransport.createLinkedPair()`
- Fixtures: `tests/fixtures/*.jsonl` (hand-written, not generated)
- Each MCP tool needs at least 1 happy path + 1 edge case test

## Architecture

```
src/
  server.ts            MCP server entry point (16 tools via tools/)
  daemon.ts            Singleton daemon with Unix socket transport
  db.ts                SQLite layer: schema, CRUD, WAL mode
  indexer.ts           JSONL parsing, chunking, SHA-256 dedup
  search.ts            Hybrid search: BM25 + vectors + RRF + reranker
  models.ts            TypeScript interfaces
  constants.ts         Model registry, tuning constants
  config.ts            Configuration, defaults, env var resolution
  embedder.ts          TransformersJsEmbedder + OllamaEmbedder
  reranker.ts          TransformersJsReranker + LlamaServerReranker
  embed-orchestrator.ts  Child process worker management
  embed-worker.ts      Forked embedding worker
  migration.ts         Zero-downtime embedding model migration
  logger.ts            Rotating file logger (stderr + file)
  socket-transport.ts  Unix socket MCP transport
  tools/
    search.ts          m9k_search, m9k_context, m9k_full (3 tools)
    specialized.ts     m9k_errors, m9k_similar_work, m9k_file_history (3)
    memory.ts          m9k_save, m9k_sessions, m9k_info, m9k_config (4)
    manage.ts          m9k_forget, m9k_delete_session, m9k_ignore/unignore (5)
    usage-guide.ts     __USAGE_GUIDE phantom tool (1)
    context.ts         Shared ToolContext interface
    index.ts           Registration barrel
  hooks/
    session-end.ts     Automatic indexation on session close
    session-start.ts   Context injection at session start
    pre-compact.ts     Archive before /compact
```

## Reporting Issues

Use [GitHub Issues](https://github.com/louis49/melchizedek/issues) with the
provided templates (bug report or feature request).

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
