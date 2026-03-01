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

### Daemon singleton - multi-instance support

When you open multiple Claude Code windows, Melchizedek shares a **single daemon process** across all of them - 1 database, 1 embedder, 1 reranker loaded once in memory.

The server starts in 3 phases:
1. **Try connecting** to an existing daemon (Unix socket on macOS/Linux, named pipe on Windows)
2. **Auto-start** the daemon if none is running
3. **Fallback** to local standalone mode if the daemon can't start

This is transparent - Claude Code sees a normal stdio MCP server. Set `M9K_NO_DAEMON=1` or `--no-daemon` to disable daemon mode.

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

## Installation

### Claude Code plugin marketplace

```bash
claude plugin install melchizedek
```

### npm (global)

```bash
npm install -g melchizedek
```

Create a file (e.g. `/tmp/melchizedek-mcp.json`):

```json
{
  "mcpServers": {
    "melchizedek": {
      "command": "melchizedek-server"
    }
  }
}
```

```bash
claude --mcp-config /tmp/melchizedek-mcp.json
```

### npx (no install)

Create a file (e.g. `/tmp/melchizedek-mcp.json`):

```json
{
  "mcpServers": {
    "melchizedek": {
      "command": "npx",
      "args": ["melchizedek-server"]
    }
  }
}
```

```bash
claude --mcp-config /tmp/melchizedek-mcp.json
```

### From source (contributors)

```bash
git clone https://github.com/louis49/melchizedek.git
cd melchizedek
npm install && npm run build
```

Then launch Claude Code with the generated `.mcp.json`:

```bash
claude --mcp-config .mcp.json
```

> **Note:** `npm run build` generates `.mcp.json` with absolute paths to `dist/server.js`. The `claude mcp add` command may not work reliably due to known Claude Code plugin bugs - `--mcp-config` is the tested method.

### Setting up hooks (automatic indexing)

The MCP server provides search tools, but **hooks** are what trigger automatic indexing. Without hooks, you'd need to manually index sessions.

For **marketplace installs**, hooks are configured automatically. For npm/npx/source installs, add the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-end.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-end.js"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-start.js"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/pre-compact.js"
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to` with the actual path to your Melchizedek installation (e.g. `$(npm root -g)/melchizedek` for global installs, or your clone directory for source installs).

| Hook | What it does |
|------|-------------|
| **SessionEnd / Stop** | Indexes the conversation transcript after each session |
| **SessionStart** | Injects recent context from past sessions into the new session |
| **PreCompact** | Indexes conversation chunks not yet indexed before `/compact` truncates the transcript |

After installation, restart Claude Code. That's it - indexing starts automatically.

## Enhanced Search (Optional)

Melchizedek works **out of the box** with BM25 keyword search. Text embeddings (MiniLM) download automatically on first use for semantic search. The optional backends below add **GPU-accelerated code embeddings** and **reranking** for maximum search quality.

### Recommended Setup by Platform

#### macOS (Apple Silicon)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | CPU | Zero config, ~100 chunks/s |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | Metal | [Setup Ollama](#setting-up-ollama) |
| Reranker | `llama-server` | BGE Reranker v2 M3 | Metal | [Setup llama-server](#option-a--llama-server-recommended) |

ONNX Runtime has no Metal backend for Node.js - `transformers-js` runs CPU only on macOS. MiniLM is small enough that this isn't a bottleneck. For code embeddings, Ollama provides GPU acceleration via Metal.

#### Linux (NVIDIA)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` | Multilingual-MiniLM-L12-v2 (384d) | CUDA | Install `onnxruntime-node-gpu` for GPU |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | CUDA | [Setup Ollama](#setting-up-ollama) |
| Reranker | `llama-server` | BGE Reranker v2 M3 | CUDA | [Setup llama-server](#option-a--llama-server-recommended) |

To enable CUDA for text embeddings: `npm install onnxruntime-node-gpu` (replaces the CPU-only `onnxruntime-node`, no code changes needed). Requires NVIDIA drivers + CUDA Toolkit 12.4+.

#### Windows (NVIDIA)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | CPU | GPU via `onnxruntime-node-gpu` or DirectML |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | CUDA | [Setup Ollama](#setting-up-ollama) |
| Reranker | `node-llama-cpp` | BGE Reranker v2 M3 | CUDA | [Setup node-llama-cpp](#option-b--node-llama-cpp) (prebuilt) |

Ollama auto-detects NVIDIA GPUs after installation. For reranking, `node-llama-cpp` has prebuilt CUDA binaries - no compilation needed. `llama-server` is also an option but requires Visual Studio Build Tools to compile.

#### CPU-only (any platform)

| Component | Backend | Model | Speed | Notes |
|-----------|---------|-------|-------|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | ~100 chunks/s | Zero config |
| Code embedding | `transformers-js` (default) | jina-embeddings-v2-base-code (768d) | ~0.5 chunk/s | Slow - consider disabling |
| Reranker | `transformers-js` (default) | ms-marco-MiniLM-L-6-v2 | ~200ms/query | Zero config |

Everything works on CPU - BM25 search is unaffected (no GPU needed). Code embedding is slow without GPU; disable it with `"embeddingCodeEnabled": false` if speed is a concern.

### Recommended models reference

| Role | Backend | Model ID | Size | Notes |
|------|---------|----------|------|-------|
| Text embedding | `transformers-js` | [`Xenova/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) | ~120 MB (int8) | Multilingual, auto-downloaded, zero config |
| Text embedding | `ollama` | [`nomic-embed-text`](https://ollama.com/library/nomic-embed-text) | ~275 MB | English-centric - fallback if Transformers.js unavailable |
| Code embedding | `transformers-js` | [`jinaai/jina-embeddings-v2-base-code`](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) | ~160 MB (int8) | Auto-downloaded, slow on CPU |
| Code embedding | `ollama` | [`unclemusclez/jina-embeddings-v2-base-code`](https://ollama.com/unclemusclez/jina-embeddings-v2-base-code) | ~323 MB | `ollama pull`, GPU-accelerated, recommended for code |
| Reranker | `transformers-js` | [`Xenova/ms-marco-MiniLM-L-6-v2`](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2) | ~23 MB (int8) | English-only, CPU ~200ms, zero config fallback |
| Reranker | `llama-server` | [`bge-reranker-v2-m3-Q4_K_M.gguf`](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | **Multilingual**, GPU ~50ms, recommended |
| Reranker | `llama-server` | [`qwen3-reranker-0.6b-q8_0.gguf`](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Multilingual, higher quantization (Q8 vs Q4) |
| Reranker | `node-llama-cpp` | [`bge-reranker-v2-m3-Q4_K_M.gguf`](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | Place in `~/.melchizedek/models/` |
| Reranker | `node-llama-cpp` | [`qwen3-reranker-0.6b-q8_0.gguf`](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Place in `~/.melchizedek/models/` |

All Transformers.js models auto-download from Hugging Face on first use. GGUF models must be downloaded manually.

> **Language note:** The default text embedder (MiniLM) is **multilingual** - it works well for non-English conversations. The default CPU reranker (ms-marco) is **English-only** - for other languages, use a GGUF reranker (BGE m3 or Qwen3, both multilingual). BM25 keyword search works for any language via FTS5 Unicode tokenization.

### Tested embedding models

You can switch embedding models via `m9k_config key="embeddingTextModel" value='"model-key"'`. All models below have been tested end-to-end (load, embed, normalize, dimension check). Any ONNX-compatible HuggingFace model not listed here can also be used - Melchizedek will auto-detect dimensions and pooling from the model cache.

#### Transformers.js (local ONNX, zero config)

| Key | HuggingFace ID | Dims | Pooling | Context | Lang | Notes |
|-----|---------------|------|---------|---------|------|-------|
| `minilm-l12-v2` | [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) | 384 | mean | 512 tok | Multi | **Default text**. Best balance speed/quality for conversations |
| `minilm-l6-v2` | [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) | 384 | mean | 256 tok | EN | Fastest, lightest (~1 MB q8) |
| `multilingual-e5-small` | [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) | 384 | mean | 512 tok | Multi | Good multilingual, queryPrefix "query: " |
| `bge-small-en-v1.5` | [Xenova/bge-small-en-v1.5](https://huggingface.co/Xenova/bge-small-en-v1.5) | 384 | cls | 512 tok | EN | High MTEB scores for size |
| `bge-base-en-v1.5` | [Xenova/bge-base-en-v1.5](https://huggingface.co/Xenova/bge-base-en-v1.5) | 768 | cls | 512 tok | EN | Strong English baseline |
| `bge-m3` | [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3) | 1024 | cls | 8K tok | Multi | Large context, multilingual powerhouse |
| `nomic-embed-text-v1.5` | [nomic-ai/nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | 768 | mean | 8K tok | EN | Long context, open-source leader |
| `mxbai-embed-xsmall-v1` | [mixedbread-ai/mxbai-embed-xsmall-v1](https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1) | 384 | cls | 4K tok | EN | Tiny + long context |
| `mxbai-embed-large-v1` | [mixedbread-ai/mxbai-embed-large-v1](https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1) | 1024 | cls | 512 tok | EN | Top MTEB scores |
| `snowflake-arctic-embed-m-v2` | [Snowflake/snowflake-arctic-embed-m-v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0) | 768 | cls | 8K tok | Multi | Snowflake's multilingual, queryPrefix "query: " |
| `snowflake-arctic-embed-l-v2` | [Snowflake/snowflake-arctic-embed-l-v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-l-v2.0) | 1024 | cls | 8K tok | Multi | Snowflake's large variant |
| `gte-small` | [Xenova/gte-small](https://huggingface.co/Xenova/gte-small) | 384 | mean | 512 tok | EN | Lightweight alternative |
| `gte-multilingual-base` | [onnx-community/gte-multilingual-base](https://huggingface.co/onnx-community/gte-multilingual-base) | 768 | cls | 8K tok | Multi | Alibaba's multilingual |
| `jina-code-v2` | [jinaai/jina-embeddings-v2-base-code](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) | 768 | mean | 8K tok | Code | **Default code**. Code-specialized |
| `jina-v2-small-en` | [Xenova/jina-embeddings-v2-small-en](https://huggingface.co/Xenova/jina-embeddings-v2-small-en) | 512 | mean | 8K tok | EN | Lighter Jina variant |
| `qwen3-embedding-0.6b` | [onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX) | 1024 | last_token | 8K tok | Multi | Instruction-tuned, highest quality, slowest (~9s first embed) |

**Custom models:** Set `embeddingTextModel` to any HuggingFace model ID (e.g. `"org/my-model"`). Melchizedek resolves in order: built-in registry, HF cache metadata (`config.json`), then dynamic fallback (mean pooling, dimensions probed at runtime).

#### Ollama (GPU-accelerated, any model)

Any Ollama embedding model works - no registry needed. Dimensions are auto-detected. Tested models:

| Model | Dims | Type | Discrimination | Pull command | Notes |
|-------|------|------|---------------|-------------|-------|
| [`nomic-embed-text`](https://ollama.com/library/nomic-embed-text) | 768 | text | 0.31 | `ollama pull nomic-embed-text` | Most popular, good default |
| [`unclemusclez/jina-embeddings-v2-base-code`](https://ollama.com/unclemusclez/jina-embeddings-v2-base-code) | 768 | code | 0.61 | `ollama pull unclemusclez/jina-embeddings-v2-base-code` | **Recommended for code** |
| [`qwen3-embedding:0.6b`](https://ollama.com/library/qwen3-embedding:0.6b) | 1024 | text | 0.42 | `ollama pull qwen3-embedding:0.6b` | Best quality, ~9s cold start |

Other popular choices (untested but expected to work):

| Model | Dims | Pull command | Notes |
|-------|------|-------------|-------|
| [`mxbai-embed-large`](https://ollama.com/library/mxbai-embed-large) | 1024 | `ollama pull mxbai-embed-large` | Top MTEB scores |
| [`snowflake-arctic-embed`](https://ollama.com/library/snowflake-arctic-embed) | varies | `ollama pull snowflake-arctic-embed:xs` | xs/s/m/l variants |
| [`all-minilm`](https://ollama.com/library/all-minilm) | 384 | `ollama pull all-minilm` | Lightest |
| [`bge-m3`](https://ollama.com/library/bge-m3) | 1024 | `ollama pull bge-m3` | Multilingual powerhouse |

Browse all: [ollama.com/search?c=embedding](https://ollama.com/search?c=embedding)

#### Reranker models

| Backend | Model | Size | GPU | Notes |
|---------|-------|------|-----|-------|
| `transformers-js` | [Xenova/ms-marco-MiniLM-L-6-v2](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2) | ~23 MB | CPU | **Default**. English-only, ~200ms/query, zero config |
| `llama-server` | [bge-reranker-v2-m3-Q4_K_M.gguf](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | Metal/CUDA | **Recommended**. Multilingual, GPU ~50ms |
| `llama-server` | [qwen3-reranker-0.6b-q8_0.gguf](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Metal/CUDA | Multilingual, higher quality |
| `node-llama-cpp` | [bge-reranker-v2-m3-Q4_K_M.gguf](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | Metal/CUDA | Place in `~/.melchizedek/models/`, auto-detected |
| `node-llama-cpp` | [qwen3-reranker-0.6b-q8_0.gguf](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Metal/CUDA | Place in `~/.melchizedek/models/`, auto-detected |

### Setting up Ollama

[Ollama](https://ollama.com) provides GPU-accelerated code embeddings on all platforms.

```bash
# macOS  - download the .dmg from https://ollama.com/download/mac
# Windows - download installer from https://ollama.com/download
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Then pull the code embedding model
ollama pull unclemusclez/jina-embeddings-v2-base-code
```

Then tell Melchizedek to use Ollama for code embeddings:

```
m9k_config key="embeddingCodeBackend" value='"ollama"'
m9k_config key="embeddingCodeModel" value='"unclemusclez/jina-embeddings-v2-base-code"'
```

### Setting up a GPU reranker

The reranker is a cross-encoder that re-scores results after BM25 + vector fusion. It's optional - search works without it - but it improves precision on ambiguous queries. The default (`transformers-js`, CPU) works out of the box. For GPU acceleration:

#### Option A - llama-server (recommended)

```bash
# 1. Compile llama.cpp
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_METAL=ON    # macOS Metal
# cmake -B build -DGGML_CUDA=ON   # Linux/Windows CUDA
cmake --build build --config Release -j

# 2. Download a GGUF reranker model (pick one)
# BGE Reranker v2 M3 (~440 MB) - recommended
wget https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf
# Or: Qwen3 Reranker 0.6B (~640 MB) - alternative
# wget https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf

# 3. Run the server
./build/bin/llama-server --rerank --pooling rank \
  -m bge-reranker-v2-m3-Q4_K_M.gguf --port 8012
```

Then configure Melchizedek - either edit `~/.melchizedek/config.json` or ask Claude:

```
m9k_config key="rerankerBackend" value='"llama-server"'
m9k_config key="rerankerUrl" value='"http://localhost:8012"'
```

Verify: `curl http://localhost:8012/health` should return `{"status":"ok"}`. Hot-reload works - no need to restart Melchizedek.

#### Option B - node-llama-cpp

```bash
npm install -g node-llama-cpp
mkdir -p ~/.melchizedek/models
cp bge-reranker-v2-m3-Q4_K_M.gguf ~/.melchizedek/models/
```

No config needed - Melchizedek auto-detects GGUF files matching `bge-reranker*` or `qwen*reranker*` in `~/.melchizedek/models/`.

### Backend detection priority

Reranker: `llama-server` (if URL set + healthy) > `node-llama-cpp` (if GGUF found) > `transformers-js` (CPU) > none.

Check active backends: `m9k_info` shows the current pipeline in its output.

### Alternative configurations

| Scenario | Config |
|----------|--------|
| **No Ollama, skip code embedding** | `"embeddingCodeEnabled": false` |
| **Ollama for everything** | Both backends = `"ollama"` (text: `nomic-embed-text`, code: `unclemusclez/jina-embeddings-v2-base-code`) |
| **Offline only (CPU)** | Default - `transformers-js` for both (no network) |
| **Disable reranker** | `"rerankerEnabled": false` |
| **Disable all embeddings** | `"embeddingsEnabled": false` (BM25 only) |

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
| JSONL directory | `~/.claude/projects` | `M9K_JSONL_DIR` |
| Daemon mode | enabled | `M9K_NO_DAEMON=1` to disable (or `--no-daemon`) |
| Log level | `warn` | `M9K_LOG_LEVEL` |
| Embeddings enabled | `true` | `M9K_EMBEDDINGS=false` to disable |
| Text embedding backend | `auto` (Transformers.js, then Ollama) | `M9K_EMBEDDING_TEXT_BACKEND` |
| Text embedding model | Multilingual-MiniLM-L12-v2 (384d) | `M9K_EMBEDDING_TEXT_MODEL` |
| Code embedding backend | `auto` (Jina Code, then Ollama) | `M9K_EMBEDDING_CODE_BACKEND` |
| Code embedding model | jina-embeddings-v2-base-code (768d) | `M9K_EMBEDDING_CODE_MODEL` |
| Code embedding enabled | `true` | `M9K_EMBEDDING_CODE=false` to disable |
| Ollama base URL | `http://localhost:11434` | `M9K_OLLAMA_BASE_URL` |
| Reranker enabled | `true` | `M9K_RERANKER=false` to disable |
| Reranker backend | `auto` (llama-server > node-llama-cpp > Transformers.js) | `M9K_RERANKER_BACKEND` |
| Reranker model | - (auto-detect) | `M9K_RERANKER_MODEL` |
| Reranker URL | - | `M9K_RERANKER_URL` |
| Reranker top N | `10` | `M9K_RERANKER_TOP_N` |
| Models directory | `~/.melchizedek/models` | `M9K_MODELS_DIR` |
| Max chunk tokens | `1000` | - |
| Auto-fuzzy threshold | `3` (retry with wildcards if < 3 results) | - |
| Sync purge | `false` | `M9K_SYNC_PURGE=true` |

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

## Memory usage

Melchizedek loads ML models for embeddings and reranking. Here's what to expect:

| Component | RSS (real) | When |
|-----------|-----------|------|
| Server (BM25 only) | ~70 MB | Always |
| + Text embedder (Multilingual-MiniLM q8) | ~450 MB | At startup |
| + Reranker (ms-marco q8) | ~250 MB | On first search |
| Embed-worker (text) | ~450 MB | During backfill, then exits |
| Embed-worker (code, Jina q8) | ~2.5 GB | During backfill, then exits |

The embed-worker is a child process that runs during initial indexing and exits when done - its memory is fully reclaimed.

**About virtual memory (VSZ):** macOS Activity Monitor may show very large virtual memory numbers (400+ GB per process). This is normal - ONNX Runtime reserves large virtual address ranges via `mmap` without actually using physical RAM. The real consumption is the RSS column above. Only RSS reflects actual memory pressure.

To reduce memory usage:
- `"embeddingCodeEnabled": false` - skip code embeddings (saves ~2.5 GB during backfill)
- `"embeddingsEnabled": false` - BM25 only, ~70 MB total
- Use Ollama for code embeddings - offloads to a separate process with GPU acceleration

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
