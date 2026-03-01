# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-03-01

### Fixed

- Add `mcpName` field required by MCP Registry publish

## [1.0.0] - 2026-03-01

### Added

- **16 MCP tools** for persistent conversation memory in Claude Code
- **Hybrid search pipeline**: BM25 (FTS5) + dual vector embeddings (text + code) + Reciprocal Rank Fusion + cross-encoder reranking
- **4-level graceful degradation**: full pipeline > BM25 + vectors > BM25 + reranker > BM25 only
- **Dual embedding models**: MiniLM text (384d) + Jina Code v2 (768d) via `@huggingface/transformers`, with Ollama fallback
- **3 reranker backends**: Transformers.js (CPU), llama-server (GPU), node-llama-cpp (GPU) — auto-detected
- **Child process embed worker**: embedding runs in a forked process, MCP server stays responsive
- **Zero-downtime embedding migration**: model changes trigger dual-index rebuild with checkpoint/resume
- **Automatic indexation**: SessionEnd hook indexes conversations, SessionStart injects context
- **PreCompact hook**: indexes chunks before `/compact` to prevent data loss
- **Privacy**: `<private>` tags stripped and replaced with `[REDACTED]` before storage
- **Project/session affinity**: search results boosted for current project (x1.5) and session (x1.2)
- **Auto-fuzzy fallback**: fewer than 3 results triggers wildcard search
- **Project ignore list**: exclude projects from indexing with optional purge
- **Soft-delete**: `m9k_forget` tombstones individual chunks, `m9k_delete_session` removes full sessions
- **Configurable**: `m9k_config` tool for runtime settings, env vars, config file
- **Structured logging**: rotating file logger with configurable levels
- **Cross-platform**: macOS, Linux, Windows support
- **379 automated tests**
