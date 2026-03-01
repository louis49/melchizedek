import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  TransformersJsReranker,
  LlamaCppReranker,
  LlamaServerReranker,
  listLocalHuggingFaceModels,
  findRerankerGGUF,
  checkLlamaServerHealth,
  detectRerankerBackend,
} from '../src/reranker.js';

describe('TransformersJsReranker', () => {
  it('should use default model ID when no modelId provided', () => {
    const reranker = new TransformersJsReranker();
    expect(reranker.modelId()).toBe('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(reranker.backend()).toBe('transformers-js');
  });

  it('should use custom model ID when provided', () => {
    const reranker = new TransformersJsReranker('custom-org/custom-reranker');
    expect(reranker.modelId()).toBe('custom-org/custom-reranker');
    expect(reranker.backend()).toBe('transformers-js');
  });
});

describe('LlamaCppReranker', () => {
  it('should return basename as modelId', () => {
    const reranker = new LlamaCppReranker('/path/to/models/bge-reranker-v2-q8.gguf');
    expect(reranker.modelId()).toBe('bge-reranker-v2-q8.gguf');
    expect(reranker.backend()).toBe('node-llama-cpp');
  });
});

describe('listLocalHuggingFaceModels', () => {
  let tmpDir: string;
  const originalHfHome = process.env.HF_HOME;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `melchizedek-hf-test-${Date.now()}`);
    mkdirSync(join(tmpDir, 'hub'), { recursive: true });
    process.env.HF_HOME = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalHfHome) {
      process.env.HF_HOME = originalHfHome;
    } else {
      delete process.env.HF_HOME;
    }
  });

  it('should return empty array when no models are cached', () => {
    const models = listLocalHuggingFaceModels();
    expect(models).toEqual([]);
  });

  it('should list models from HuggingFace cache directory', () => {
    mkdirSync(join(tmpDir, 'hub', 'models--Xenova--ms-marco-MiniLM-L-6-v2'));
    mkdirSync(join(tmpDir, 'hub', 'models--Xenova--all-MiniLM-L6-v2'));

    const models = listLocalHuggingFaceModels();
    expect(models).toContain('Xenova/ms-marco-MiniLM-L-6-v2');
    expect(models).toContain('Xenova/all-MiniLM-L6-v2');
    expect(models).toHaveLength(2);
  });

  it('should ignore non-model directories', () => {
    mkdirSync(join(tmpDir, 'hub', 'models--Xenova--test-model'));
    mkdirSync(join(tmpDir, 'hub', 'datasets--some-dataset'));
    mkdirSync(join(tmpDir, 'hub', 'version.txt'), { recursive: true });

    const models = listLocalHuggingFaceModels();
    expect(models).toEqual(['Xenova/test-model']);
  });

  it('should return empty array for non-existent HF_HOME', () => {
    process.env.HF_HOME = '/tmp/does-not-exist-' + Date.now();
    const models = listLocalHuggingFaceModels();
    expect(models).toEqual([]);
  });
});

describe('findRerankerGGUF', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `melchizedek-gguf-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null for non-existent directory', () => {
    expect(findRerankerGGUF('/tmp/does-not-exist-' + Date.now())).toBeNull();
  });

  it('should return null when no GGUF files exist', () => {
    expect(findRerankerGGUF(tmpDir)).toBeNull();
  });
});

describe('LlamaServerReranker', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should return backend llama-server and default modelId', () => {
    const reranker = new LlamaServerReranker('http://localhost:8012');
    expect(reranker.backend()).toBe('llama-server');
    expect(reranker.modelId()).toBe('llama-server');
  });

  it('should rerank documents via /v1/rerank', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 1, relevance_score: 0.9 },
            { index: 2, relevance_score: 0.5 },
          ],
        }),
    });

    const reranker = new LlamaServerReranker('http://localhost:8012');
    const results = await reranker.rerank(
      'test query',
      [
        { id: 'a', content: 'doc A' },
        { id: 'b', content: 'doc B' },
        { id: 'c', content: 'doc C' },
      ],
      2,
    );

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('b'); // highest score
    expect(results[0].score).toBe(0.9);
    expect(results[1].id).toBe('c');
    expect(results[1].score).toBe(0.5);

    // Verify fetch was called correctly
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:8012/v1/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test query',
        documents: ['doc A', 'doc B', 'doc C'],
      }),
    });
  });

  it('should handle score field when relevance_score is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            { index: 0, score: -8.5 },
            { index: 1, score: -2.9 },
          ],
        }),
    });

    const reranker = new LlamaServerReranker('http://localhost:8012');
    const results = await reranker.rerank(
      'query',
      [
        { id: 'a', content: 'doc A' },
        { id: 'b', content: 'doc B' },
      ],
      10,
    );

    expect(results[0].id).toBe('b'); // -2.9 > -8.5
    expect(results[0].score).toBe(-2.9);
  });

  it('should return empty array for empty documents', async () => {
    const reranker = new LlamaServerReranker('http://localhost:8012');
    const results = await reranker.rerank('query', [], 10);
    expect(results).toEqual([]);
  });

  it('should throw on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const reranker = new LlamaServerReranker('http://localhost:8012');
    await expect(reranker.rerank('query', [{ id: 'a', content: 'doc' }], 10)).rejects.toThrow(
      'llama-server rerank failed: 500',
    );
  });
});

describe('checkLlamaServerHealth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should return model name on healthy server', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: '/home/user/.melchizedek/models/bge-reranker-v2-m3-q8_0.gguf' }],
            }),
        });
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const result = await checkLlamaServerHealth('http://localhost:8012');
    expect(result).toEqual({ ok: true, modelName: 'bge-reranker-v2-m3-q8_0.gguf' });
  });

  it('should return ok:false when server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkLlamaServerHealth('http://localhost:8012');
    expect(result).toEqual({ ok: false, modelName: null });
  });

  it('should return ok:false on non-200 health', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await checkLlamaServerHealth('http://localhost:8012');
    expect(result).toEqual({ ok: false, modelName: null });
  });
});

describe('detectRerankerBackend with llama-server', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should prefer llama-server when rerankerUrl is set and server is healthy', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: '/path/to/bge-reranker-v2-m3-q8_0.gguf' }],
            }),
        });
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const result = await detectRerankerBackend({
      rerankerModelsDir: '/tmp/empty-' + Date.now(),
      rerankerBackend: 'auto',
      rerankerModel: null,
      rerankerUrl: 'http://localhost:8012',
    });

    expect(result).not.toBeNull();
    expect(result!.backend).toBe('llama-server');
    expect(result!.reranker.backend()).toBe('llama-server');
    expect(result!.reranker.modelId()).toBe('bge-reranker-v2-m3-q8_0.gguf');
  });

  it('should fallback when llama-server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // No node-llama-cpp, no transformers-js available in test env normally
    const result = await detectRerankerBackend({
      rerankerModelsDir: '/tmp/empty-' + Date.now(),
      rerankerBackend: 'llama-server',
      rerankerModel: null,
      rerankerUrl: 'http://localhost:9999',
    });

    // Should fallback to null since we forced llama-server backend and it's down
    expect(result).toBeNull();
  });

  it('should use llama-server when backend is explicitly set', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok' }) });
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'qwen3-reranker-0.6b-q8_0.gguf' }] }),
        });
      }
      return Promise.reject(new Error('unexpected'));
    });

    const result = await detectRerankerBackend({
      rerankerModelsDir: '/tmp/empty-' + Date.now(),
      rerankerBackend: 'llama-server',
      rerankerModel: null,
      rerankerUrl: 'http://localhost:8012',
    });

    expect(result).not.toBeNull();
    expect(result!.backend).toBe('llama-server');
    expect(result!.reranker.modelId()).toBe('qwen3-reranker-0.6b-q8_0.gguf');
  });
});
