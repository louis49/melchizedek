# Melchizedek

[![npm version](https://img.shields.io/npm/v/melchizedek)](https://www.npmjs.com/package/melchizedek)
[![npm downloads](https://img.shields.io/npm/dw/melchizedek)](https://www.npmjs.com/package/melchizedek)
[![CI](https://github.com/louis49/melchizedek/actions/workflows/ci.yml/badge.svg)](https://github.com/louis49/melchizedek/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Donate](https://badgen.net/badge/paypal/donate?icon=https://simpleicons.now.sh/paypal/fff)](https://www.paypal.com/donate/?hosted_button_id=B8NGNPFGK69BY)
[![Donate](https://badgen.net/badge/buymeacoffee/donate?icon=https://simpleicons.now.sh/buymeacoffee/fff)](https://www.buymeacoffee.com/louis49github)

**Persistent memory for Claude Code.** Automatically indexes every conversation and provides production-grade hybrid search (BM25 + vectors + reranker) via MCP tools. 100% local, zero config, zero API keys, zero invoice.

---

## Why Melchizedek?

Claude Code forgets everything between sessions - and knows nothing about your other projects. Melchizedek fixes both.

It runs silently in the background - indexing your conversations as you work - then gives Claude the ability to search across your entire history, **across all projects**: past debugging sessions, architectural decisions, error solutions, code patterns.

**No cloud. No API keys. No config.** Plug and ask.

## How it works

```
~/.claude/projects/**/*.jsonl       (your conversation transcripts - read-only)
        |
        v
  SessionEnd hook                   (auto-triggers after each session)
        |
        v
  +-----------------+
  |  Indexer         |    Parse JSONL -> chunk pairs -> SHA-256 dedup
  |  (better-sqlite3)|    FTS5 tokenize -> vector embed (optional)
  +-----------------+
        |
        v
  ~/.melchizedek/memory.db           (single SQLite file, WAL mode)
        |
        v
  +-----------------+
  |  MCP Server      |    16 search & management tools
  |  (stdio)         |    Hybrid: BM25 + vectors + RRF + reranker
  +-----------------+
        |
        v
  Claude Code                       (searches your history via MCP)
```

### Search pipeline - 4 levels of graceful degradation

Every layer is optional. The plugin works with BM25 alone and gets better as more components are available.

| Level | Component | What it adds | Dependency |
|-------|-----------|-------------|------------|
| 1 | **BM25** (FTS5) | Keyword search with stemming | None (always active) |
| 2 | **Dual vectors** (sqlite-vec) | Semantic search - text (MiniLM 384d) + code (Jina 768d) | `@huggingface/transformers` (optional) |
| 3 | **RRF fusion** | Merges BM25 + text vectors + code vectors via Reciprocal Rank Fusion | Vectors enabled |
| 4 | **Reranker** | Cross-encoder re-scoring of top results | Transformers.js or node-llama-cpp (optional) |

## Performance

Measured with `npm run bench` - 100 sessions, 1 000 chunks, on a single SQLite file.

| Metric | Result | Target |
|--------|--------|--------|
| Indexation (100 sessions) | ~80 ms | < 10 s |
| BM25 search (mean) | ~0.2 ms | < 50 ms |
| DB size (100 sessions) | ~1.4 MB | < 30 MB |
| Tokens per search | ~125 | < 2 000 |

## Quick Start

### npm (recommended)

```bash
npm install -g melchizedek
```

Add the MCP server to Claude Code:

```bash
claude mcp add --scope user melchizedek -- melchizedek-server
```

### npx (no install)

```bash
claude mcp add --scope user melchizedek -- npx melchizedek-server
```

### From source

```bash
git clone https://github.com/louis49/melchizedek.git
cd melchizedek && npm install && npm run build
claude --mcp-config .mcp.json
```

### Claude Code plugin marketplace *(coming soon)*

> Plugin review pending. In the meantime, use npm or npx install above.

```bash
claude plugin install melchizedek   # not yet available
```

### Setting up hooks (automatic indexing)

The MCP server provides search tools, but **hooks** trigger automatic indexing. Without hooks, you'd need to manually index sessions.

For **marketplace installs**, hooks are configured automatically. For npm/npx/source installs, add hooks to `~/.claude/settings.json`.

> See [docs/installation.md](docs/installation.md) for the full JSON configuration, hook reference, and troubleshooting.

After setup, restart Claude Code. Indexing starts automatically.

## MCP Tools

### Search (start here)

| Tool | Description |
|------|-------------|
| `m9k_search` | Search indexed conversations. Returns compact snippets. Current project boosted. Supports `since`/`until` date filters and `order` (score, date_asc, date_desc). |
| `m9k_context` | Get a chunk with surrounding context (adjacent chunks in the same session). |
| `m9k_full` | Retrieve full content of chunks by IDs. |

**Progressive retrieval pattern** - search returns ~50 tokens/result, context ~200-300, full ~500-1000. Start with `m9k_search`, drill down only when needed. 4x token savings vs loading everything.

**Context-aware ranking** - results from your current project (×1.5) and current session (×1.2) are automatically promoted. Cross-project results remain visible.

### Specialized search

| Tool | Description |
|------|-------------|
| `m9k_file_history` | Find past conversations that touched a specific file. |
| `m9k_errors` | Find past solutions for an error message. |
| `m9k_similar_work` | Find past approaches to similar tasks. Prioritizes rich metadata. |

### Memory management

| Tool | Description |
|------|-------------|
| `m9k_save` | Manually save a memory note for future recall. |
| `m9k_sessions` | List all indexed sessions, optionally filtered by project. |
| `m9k_info` | Show memory index info: corpus size, search pipeline, embedding worker, usage metrics. |
| `m9k_config` | View or update plugin configuration. |
| `m9k_forget` | Permanently remove a chunk from the index. |
| `m9k_delete_session` | Delete a session from the index. |
| `m9k_ignore_project` | Exclude a project from indexing. Future sessions won't be indexed, existing ones optionally purged. |
| `m9k_unignore_project` | Re-enable indexing for a previously ignored project. Purged data is not restored. |
| `m9k_restart` | Restart the MCP server to load fresh code after `npm run build`. Supports `force: true` for stuck processes. |

### Usage guide

| Tool | Description |
|------|-------------|
| `__USAGE_GUIDE` | Phantom tool. Its description teaches Claude the retrieval pattern and available tools. |

## Configuration

Zero config by default. Everything is tunable via `m9k_config` or environment variables.

| Setting | Default | Env var |
|---------|---------|---------|
| Database path | `~/.melchizedek/memory.db` | `M9K_DB_PATH` |
| Daemon mode | enabled | `M9K_NO_DAEMON=1` to disable |
| Log level | `warn` | `M9K_LOG_LEVEL` |
| Embeddings enabled | `true` | `M9K_EMBEDDINGS=false` to disable |
| Reranker enabled | `true` | `M9K_RERANKER=false` to disable |

> See [docs/configuration.md](docs/configuration.md) for the full settings reference (20+ options, env vars, config file examples).

## Enhanced Search

Melchizedek works **out of the box** with BM25 keyword search. Text embeddings (MiniLM) download automatically on first use for semantic search.

For GPU-accelerated code embeddings (Ollama), cross-encoder reranking (GGUF models), platform-specific setup guides, and the full model reference, see **[Enhanced Search Setup](docs/enhanced-search.md)**.

## How is this different?

| | Melchizedek | [claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp) | [claude-mem](https://github.com/thedotmack/claude-mem) | [episodic-memory](https://github.com/obra/episodic-memory) | [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) |
|---|:---:|:---:|:---:|:---:|:---:|
| | [![GitHub stars](https://img.shields.io/github/stars/louis49/melchizedek?style=flat&label=%E2%AD%90)](https://github.com/louis49/melchizedek) [![npm](https://img.shields.io/npm/dw/melchizedek?style=flat&label=%E2%AC%87)](https://www.npmjs.com/package/melchizedek) | [![GitHub stars](https://img.shields.io/github/stars/Vvkmnn/claude-historian-mcp?style=flat&label=%E2%AD%90)](https://github.com/Vvkmnn/claude-historian-mcp) [![npm](https://img.shields.io/npm/dw/claude-historian-mcp?style=flat&label=%E2%AC%87)](https://www.npmjs.com/package/claude-historian-mcp) | [![GitHub stars](https://img.shields.io/github/stars/thedotmack/claude-mem?style=flat&label=%E2%AD%90)](https://github.com/thedotmack/claude-mem) [![npm](https://img.shields.io/npm/dw/claude-mem?style=flat&label=%E2%AC%87)](https://www.npmjs.com/package/claude-mem) | [![GitHub stars](https://img.shields.io/github/stars/obra/episodic-memory?style=flat&label=%E2%AD%90)](https://github.com/obra/episodic-memory) | [![GitHub stars](https://img.shields.io/github/stars/doobidoo/mcp-memory-service?style=flat&label=%E2%AD%90)](https://github.com/doobidoo/mcp-memory-service) [![PyPI](https://img.shields.io/pypi/dw/mcp-memory-service?style=flat&label=%E2%AC%87)](https://pypi.org/project/mcp-memory-service/) |
| Philosophy | **Search engine** - indexes everything, you search | Search engine - scans JSONL on demand | Notebook - AI compresses & saves | Search engine | Notebook - AI decides what to store |
| Indexes raw conversations | Yes (JSONL transcripts) | Yes (direct JSONL read, no persistent index) | Compressed summaries | Yes (JSONL) | No (manual `store_memory`) |
| Retroactive on install | Yes (backfills all history) | Yes (reads existing files) | No | Yes | No (empty at start) |
| Search | BM25 + vectors + RRF + reranker | TF-IDF + fuzzy matching | FTS5 + ChromaDB | Vectors only | BM25 + vectors |
| Progressive retrieval | 3 layers (search/context/full) | No | No | No | No |
| 100% offline | Yes | Yes | No (needs API for compression) | Yes | Yes |
| Single-file storage | SQLite | None (reads raw JSONL) | SQLite + ChromaDB | SQLite | SQLite-vec |
| Zero config | Yes | Yes | Yes | Yes | Yes |
| MCP tools | 16 | 10 | 4 | 2 | 12 |
| License | **MIT** | MIT | AGPL-3.0 | MIT | Apache-2.0 |
| Dual embedding (text + code) | Yes (MiniLM + Jina Code) | No | No | No | No |
| Configurable models | Yes (Transformers.js or Ollama) | No | No (Chroma internal) | No (hardcoded) | Yes (ONNX, Ollama, OpenAI, Cloudflare) |
| Reranker | Cross-encoder (ONNX, GGUF, or HTTP) | No | No | No | Quality scorer (not search reranker) |
| Privacy | All local, `<private>` tag redaction | All local | Sends data to Anthropic API | All local | All local |
| Multi-instance | **Singleton daemon** - N Claude windows share 1 process (Unix socket / Windows named pipe, local fallback) | N separate processes | Shared HTTP worker (:37777) | N separate processes | Shared HTTP server |

### Inspirations

This project stands on the shoulders of others. Key ideas borrowed from:

| Project | What we took | |
|---------|-------------|---|
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) | RRF hybrid fusion, SHA-256 dedup, auto-fuzzy fallback | [![GitHub stars](https://img.shields.io/github/stars/Dicklesworthstone/coding_agent_session_search?style=flat&label=%E2%AD%90)](https://github.com/Dicklesworthstone/coding_agent_session_search) |
| [claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp) | Specialized MCP tools (file_history, error_solutions) | [![GitHub stars](https://img.shields.io/github/stars/Vvkmnn/claude-historian-mcp?style=flat&label=%E2%AD%90)](https://github.com/Vvkmnn/claude-historian-mcp) [![npm](https://img.shields.io/npm/dw/claude-historian-mcp?style=flat&label=%E2%AC%87)](https://www.npmjs.com/package/claude-historian-mcp) |
| [claude-diary](https://github.com/rlancemartin/claude-diary) | PreCompact hook (archive before `/compact`) | [![GitHub stars](https://img.shields.io/github/stars/rlancemartin/claude-diary?style=flat&label=%E2%AD%90)](https://github.com/rlancemartin/claude-diary) |

## Known issues

- **Session boost inactive** - Claude Code currently sends an empty `session_id` in the [SessionStart hook stdin payload](https://code.claude.com/docs/en/hooks#common-input-fields), preventing the ×1.2 session boost from working. The ×1.5 project boost is unaffected and provides the primary context-aware ranking. Related upstream issues: [#13668](https://github.com/anthropics/claude-code/issues/13668) (empty `transcript_path`), [#9188](https://github.com/anthropics/claude-code/issues/9188) (stale `session_id`). Melchizedek's session boost code is tested and ready, and will activate automatically when the upstream fix lands.


## Privacy

- **Zero telemetry.** No tracking, no analytics, no network calls (except optional lazy model download).
- **Read-only on transcripts.** Never writes to `~/.claude/projects/`. All data in `~/.melchizedek/`.
- **`<private>` tag support.** Content between `<private>...</private>` is replaced with `[REDACTED]` before indexing.
- **Local-only.** Your conversations never leave your machine.

## Requirements

- Node.js >= 20
- Claude Code >= 2.0
- macOS, Linux, or Windows

## License

MIT

---

> *"Without father, without mother, without genealogy, having neither beginning of days nor end of life."*
> - Hebrews 7:3

Built by [@louis49](https://github.com/louis49)
