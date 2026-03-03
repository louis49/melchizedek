# Configuration

Melchizedek is zero-config by default. Everything is tunable via `m9k_config` or environment variables. Settings are stored in `~/.melchizedek/config.json`.

## Settings reference

| Setting | Default | Env var | Description |
|---------|---------|---------|-------------|
| Database path | `~/.melchizedek/memory.db` | `M9K_DB_PATH` | SQLite database location |
| JSONL directory | `~/.claude/projects` | `M9K_JSONL_DIR` | Directory containing conversation transcripts |
| Daemon mode | enabled | `M9K_NO_DAEMON=1` to disable (or `--no-daemon`) | Share a single process across Claude Code windows |
| Log level | `warn` | `M9K_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| Embeddings enabled | `true` | `M9K_EMBEDDINGS=false` to disable | Enable/disable vector embeddings (BM25 always active) |
| Text embedding backend | `auto` | `M9K_EMBEDDING_TEXT_BACKEND` | `auto` (Transformers.js, then Ollama), `transformers-js`, or `ollama` |
| Text embedding model | Multilingual-MiniLM-L12-v2 (384d) | `M9K_EMBEDDING_TEXT_MODEL` | Model key or HuggingFace ID |
| Code embedding backend | `auto` | `M9K_EMBEDDING_CODE_BACKEND` | `auto` (Jina Code, then Ollama), `transformers-js`, or `ollama` |
| Code embedding model | jina-embeddings-v2-base-code (768d) | `M9K_EMBEDDING_CODE_MODEL` | Model key or HuggingFace ID |
| Code embedding enabled | `true` | `M9K_EMBEDDING_CODE=false` to disable | Enable/disable code-specific embeddings |
| Ollama base URL | `http://localhost:11434` | `M9K_OLLAMA_BASE_URL` | Ollama server endpoint |
| Reranker enabled | `true` | `M9K_RERANKER=false` to disable | Enable/disable cross-encoder reranking |
| Reranker backend | `auto` | `M9K_RERANKER_BACKEND` | `auto` (llama-server > node-llama-cpp > Transformers.js), or explicit |
| Reranker model | - (auto-detect) | `M9K_RERANKER_MODEL` | GGUF model path or name |
| Reranker URL | - | `M9K_RERANKER_URL` | llama-server endpoint (e.g. `http://localhost:8012`) |
| Reranker top N | `10` | `M9K_RERANKER_TOP_N` | Number of results to re-score |
| Models directory | `~/.melchizedek/models` | `M9K_MODELS_DIR` | Directory for GGUF model files |
| Max chunk tokens | `1000` | - | Maximum tokens per indexed chunk |
| Auto-fuzzy threshold | `3` | - | Retry with wildcards if fewer than N results |
| Sync purge | `false` | `M9K_SYNC_PURGE=true` | Remove deleted sessions from index on sync |

## Using `m9k_config`

View all settings:

```
m9k_config
```

Update a setting (values must be JSON-encoded):

```
m9k_config key="rerankerEnabled" value="false"
m9k_config key="embeddingCodeBackend" value='"ollama"'
m9k_config key="logLevel" value='"debug"'
```

Changes take effect after `m9k_restart`.

## Config file

Settings are persisted to `~/.melchizedek/config.json`:

```json
{
  "embeddingCodeBackend": "ollama",
  "embeddingCodeModel": "unclemusclez/jina-embeddings-v2-base-code",
  "rerankerBackend": "llama-server",
  "rerankerUrl": "http://localhost:8012",
  "logLevel": "warn"
}
```

## Environment variables

Environment variables override config file settings. Useful for CI or temporary changes:

```bash
M9K_LOG_LEVEL=debug M9K_EMBEDDINGS=false claude --mcp-config .mcp.json
```

## Priority order

1. Environment variables (highest)
2. `~/.melchizedek/config.json`
3. Built-in defaults (lowest)
