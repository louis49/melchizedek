# Enhanced Search Setup

Melchizedek works **out of the box** with BM25 keyword search. Text embeddings (MiniLM) download automatically on first use for semantic search. This guide covers optional GPU-accelerated backends for maximum search quality.

## Daemon singleton - multi-instance support

When you open multiple Claude Code windows, Melchizedek shares a **single daemon process** across all of them - 1 database, 1 embedder, 1 reranker loaded once in memory.

The server starts in 3 phases:
1. **Try connecting** to an existing daemon (Unix socket on macOS/Linux, named pipe on Windows)
2. **Auto-start** the daemon if none is running
3. **Fallback** to local standalone mode if the daemon can't start

This is transparent - Claude Code sees a normal stdio MCP server. Set `M9K_NO_DAEMON=1` or `--no-daemon` to disable daemon mode.

## Recommended Setup by Platform

### macOS (Apple Silicon)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | CPU | Zero config, ~100 chunks/s |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | Metal | [Setup Ollama](#setting-up-ollama) |
| Reranker | `llama-server` | BGE Reranker v2 M3 | Metal | [Setup llama-server](#option-a---llama-server-recommended) |

ONNX Runtime has no Metal backend for Node.js - `transformers-js` runs CPU only on macOS. MiniLM is small enough that this isn't a bottleneck. For code embeddings, Ollama provides GPU acceleration via Metal.

### Linux (NVIDIA)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` | Multilingual-MiniLM-L12-v2 (384d) | CUDA | Install `onnxruntime-node-gpu` for GPU |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | CUDA | [Setup Ollama](#setting-up-ollama) |
| Reranker | `llama-server` | BGE Reranker v2 M3 | CUDA | [Setup llama-server](#option-a---llama-server-recommended) |

To enable CUDA for text embeddings: `npm install onnxruntime-node-gpu` (replaces the CPU-only `onnxruntime-node`, no code changes needed). Requires NVIDIA drivers + CUDA Toolkit 12.4+.

### Windows (NVIDIA)

| Component | Backend | Model | GPU | Notes |
|-----------|---------|-------|-----|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | CPU | GPU via `onnxruntime-node-gpu` or DirectML |
| Code embedding | `ollama` | unclemusclez/jina-embeddings-v2-base-code (768d) | CUDA | [Setup Ollama](#setting-up-ollama) |
| Reranker | `node-llama-cpp` | BGE Reranker v2 M3 | CUDA | [Setup node-llama-cpp](#option-b---node-llama-cpp) (prebuilt) |

Ollama auto-detects NVIDIA GPUs after installation. For reranking, `node-llama-cpp` has prebuilt CUDA binaries - no compilation needed. `llama-server` is also an option but requires Visual Studio Build Tools to compile.

### CPU-only (any platform)

| Component | Backend | Model | Speed | Notes |
|-----------|---------|-------|-------|-------|
| Text embedding | `transformers-js` (default) | Multilingual-MiniLM-L12-v2 (384d) | ~100 chunks/s | Zero config |
| Code embedding | `transformers-js` (default) | jina-embeddings-v2-base-code (768d) | ~0.5 chunk/s | Slow - consider disabling |
| Reranker | `transformers-js` (default) | ms-marco-MiniLM-L-6-v2 | ~200ms/query | Zero config |

Everything works on CPU - BM25 search is unaffected (no GPU needed). Code embedding is slow without GPU; disable it with `"embeddingCodeEnabled": false` if speed is a concern.

## Recommended models reference

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

## Tested embedding models

You can switch embedding models via `m9k_config key="embeddingTextModel" value='"model-key"'`. All models below have been tested end-to-end (load, embed, normalize, dimension check). Any ONNX-compatible HuggingFace model not listed here can also be used - Melchizedek will auto-detect dimensions and pooling from the model cache.

### Transformers.js (local ONNX, zero config)

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

### Ollama (GPU-accelerated, any model)

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

### Reranker models

| Backend | Model | Size | GPU | Notes |
|---------|-------|------|-----|-------|
| `transformers-js` | [Xenova/ms-marco-MiniLM-L-6-v2](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2) | ~23 MB | CPU | **Default**. English-only, ~200ms/query, zero config |
| `llama-server` | [bge-reranker-v2-m3-Q4_K_M.gguf](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | Metal/CUDA | **Recommended**. Multilingual, GPU ~50ms |
| `llama-server` | [qwen3-reranker-0.6b-q8_0.gguf](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Metal/CUDA | Multilingual, higher quality |
| `node-llama-cpp` | [bge-reranker-v2-m3-Q4_K_M.gguf](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | ~440 MB | Metal/CUDA | Place in `~/.melchizedek/models/`, auto-detected |
| `node-llama-cpp` | [qwen3-reranker-0.6b-q8_0.gguf](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) | ~640 MB | Metal/CUDA | Place in `~/.melchizedek/models/`, auto-detected |

## Setting up Ollama

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

## Setting up a GPU reranker

The reranker is a cross-encoder that re-scores results after BM25 + vector fusion. It's optional - search works without it - but it improves precision on ambiguous queries. The default (`transformers-js`, CPU) works out of the box. For GPU acceleration:

### Option A - llama-server (recommended)

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

### Option B - node-llama-cpp

```bash
npm install -g node-llama-cpp
mkdir -p ~/.melchizedek/models
cp bge-reranker-v2-m3-Q4_K_M.gguf ~/.melchizedek/models/
```

No config needed - Melchizedek auto-detects GGUF files matching `bge-reranker*` or `qwen*reranker*` in `~/.melchizedek/models/`.

## Backend detection priority

Reranker: `llama-server` (if URL set + healthy) > `node-llama-cpp` (if GGUF found) > `transformers-js` (CPU) > none.

Check active backends: `m9k_info` shows the current pipeline in its output.

## Alternative configurations

| Scenario | Config |
|----------|--------|
| **No Ollama, skip code embedding** | `"embeddingCodeEnabled": false` |
| **Ollama for everything** | Both backends = `"ollama"` (text: `nomic-embed-text`, code: `unclemusclez/jina-embeddings-v2-base-code`) |
| **Offline only (CPU)** | Default - `transformers-js` for both (no network) |
| **Disable reranker** | `"rerankerEnabled": false` |
| **Disable all embeddings** | `"embeddingsEnabled": false` (BM25 only) |

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
