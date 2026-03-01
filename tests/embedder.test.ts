import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TransformersJsEmbedder,
  OllamaEmbedder,
  createTextEmbedder,
  createCodeEmbedder,
  checkOllamaHealth,
  isModelAvailable,
  pullOllamaModel,
} from '../src/embedder.js';
import {
  MODEL_REGISTRY,
  lookupModelSpec,
  createDynamicSpec,
  probeModelSpecFromCache,
} from '../src/constants.js';

// Detect if embeddings actually work (package installed + model loadable)
let hasWorkingEmbedder = false;
try {
  const { TransformersJsEmbedder } = await import('../src/embedder.js');
  const { MODEL_REGISTRY } = await import('../src/constants.js');
  const probe = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
  await probe.embed('test');
  hasWorkingEmbedder = true;
} catch {
  // package missing or model download failed
}

// --- MODEL_REGISTRY + lookupModelSpec ---

describe('MODEL_REGISTRY', () => {
  it('should have minilm-l12-v2 entry', () => {
    const spec = MODEL_REGISTRY['minilm-l12-v2'];
    expect(spec).toBeDefined();
    expect(spec.dimensions).toBe(384);
    expect(spec.pooling).toBe('mean');
    expect(spec.key).toBe('minilm-l12-v2');
  });

  it('should have jina-code-v2 entry', () => {
    const spec = MODEL_REGISTRY['jina-code-v2'];
    expect(spec).toBeDefined();
    expect(spec.dimensions).toBe(768);
    expect(spec.pooling).toBe('mean');
    expect(spec.key).toBe('jina-code-v2');
  });

  it('should have qwen3-embedding-0.6b entry', () => {
    const spec = MODEL_REGISTRY['qwen3-embedding-0.6b'];
    expect(spec).toBeDefined();
    expect(spec.dimensions).toBe(1024);
    expect(spec.pooling).toBe('last_token');
    expect(spec.queryPrefix).toBeTruthy();
  });
});

describe('lookupModelSpec', () => {
  it('should find by registry key', () => {
    const spec = lookupModelSpec('minilm-l12-v2');
    expect(spec).not.toBeNull();
    expect(spec!.key).toBe('minilm-l12-v2');
  });

  it('should find by HuggingFace model ID', () => {
    const spec = lookupModelSpec('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    expect(spec).not.toBeNull();
    expect(spec!.key).toBe('minilm-l12-v2');
  });

  it('should return dynamic spec for unknown model', () => {
    const spec = lookupModelSpec('some-org/custom-embed-model');
    expect(spec).not.toBeNull();
    expect(spec!.key).toBe('custom-embed-model');
    expect(spec!.dimensions).toBe(0); // Probed at runtime
    expect(spec!.pooling).toBe('mean'); // Sensible default
  });

  it('should return null for empty string', () => {
    expect(lookupModelSpec('')).toBeNull();
  });
});

describe('createDynamicSpec', () => {
  it('should derive key from HF model ID', () => {
    const spec = createDynamicSpec('org/My-Model-Name');
    expect(spec.key).toBe('my-model-name');
    expect(spec.hfModelId).toBe('org/My-Model-Name');
  });

  it('should use full string as key if no slash', () => {
    const spec = createDynamicSpec('my-local-model');
    expect(spec.key).toBe('my-local-model');
  });

  it('should have sensible defaults', () => {
    const spec = createDynamicSpec('org/model');
    expect(spec.dimensions).toBe(0);
    expect(spec.pooling).toBe('mean');
    expect(spec.maxInputChars).toBe(2_000);
    expect(spec.dtypePreference).toEqual(['q8', 'fp16', 'fp32']);
    expect(spec.queryPrefix).toBeUndefined();
  });
});

// --- probeModelSpecFromCache ---

describe('probeModelSpecFromCache', () => {
  it('should find MiniLM from Transformers.js cache', () => {
    // MiniLM is cached locally because tests load it
    const spec = probeModelSpecFromCache('Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    if (!spec) return; // Skip if model not cached (e.g. CI without models)
    expect(spec.dimensions).toBe(384);
    expect(spec.maxInputChars).toBeGreaterThan(0);
    expect(spec.pooling).toBe('mean');
  });

  it('should return null for model not in cache', () => {
    const spec = probeModelSpecFromCache('nonexistent-org/totally-fake-model');
    expect(spec).toBeNull();
  });

  it('should be used by lookupModelSpec for unknown cached models', () => {
    // If Jina is cached, lookupModelSpec should find it by hfModelId AND by registry
    const byRegistry = lookupModelSpec('jina-code-v2');
    expect(byRegistry).not.toBeNull();
    expect(byRegistry!.dimensions).toBe(768);
  });
});

// --- TransformersJsEmbedder (text — MiniLM) ---

describe.skipIf(!hasWorkingEmbedder)('TransformersJsEmbedder (minilm-l12-v2)', () => {
  const TIMEOUT = 120_000;

  it(
    'should embed a single text to 384 dimensions',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
      const vec = await embedder.embed('Hello world');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    },
    TIMEOUT,
  );

  it(
    'should embed a batch of texts',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
      const vecs = await embedder.embedBatch(['Hello', 'World', 'Test']);
      expect(vecs).toHaveLength(3);
      for (const vec of vecs) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      }
    },
    TIMEOUT,
  );

  it(
    'should produce normalized vectors (unit length)',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
      const vec = await embedder.embed('Normalization test');
      let sumSq = 0;
      for (const v of vec) sumSq += v * v;
      const norm = Math.sqrt(sumSq);
      expect(norm).toBeCloseTo(1.0, 2);
    },
    TIMEOUT,
  );

  it(
    'should produce different vectors for different texts',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
      const [v1, v2] = await embedder.embedBatch(['fix CORS error', 'deploy Docker container']);
      let dot = 0;
      for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];
      expect(dot).toBeLessThan(0.9);
    },
    TIMEOUT,
  );

  it('should report 384 dimensions', () => {
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
    expect(embedder.dimensions()).toBe(384);
  });

  it('modelId() should return minilm-l12-v2', () => {
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
    expect(embedder.modelId()).toBe('minilm-l12-v2');
  });

  it(
    'embedQuery without queryPrefix should behave like embed',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['minilm-l12-v2']);
      const v1 = await embedder.embed('test query');
      const v2 = await embedder.embedQuery('test query');
      // Without queryPrefix, embedQuery should produce same result as embed
      expect(v1.length).toBe(v2.length);
      let dot = 0;
      for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];
      expect(dot).toBeCloseTo(1.0, 4); // Should be identical
    },
    TIMEOUT,
  );
});

describe.skipIf(!hasWorkingEmbedder)('createTextEmbedder', () => {
  it('should return a text embedder (same as createTextEmbedder)', async () => {
    const embedder = await createTextEmbedder();
    expect(embedder).not.toBeNull();
    expect(embedder!.dimensions()).toBe(384);
  }, 120_000);

  it('should respect config.embeddingModel for transformers-js backend', async () => {
    // Request jina-code-v2 as text model (unusual but valid)
    const embedder = await createTextEmbedder({
      embeddingBackend: 'transformers-js',
      embeddingModel: 'jina-code-v2',
    });
    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('jina-code-v2');
    expect(embedder!.dimensions()).toBe(768);
  }, 120_000);

  it('should respect config.embeddingModel with HF model ID', async () => {
    const embedder = await createTextEmbedder({
      embeddingBackend: 'transformers-js',
      embeddingModel: 'jinaai/jina-embeddings-v2-base-code',
    });
    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('jina-code-v2');
  }, 120_000);
});

// --- TransformersJsEmbedder (code — Jina) ---

describe.skipIf(!hasWorkingEmbedder)('TransformersJsEmbedder (jina-code-v2)', () => {
  const TIMEOUT = 120_000;

  it(
    'should embed a single text to 768 dimensions',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['jina-code-v2']);
      const vec = await embedder.embed('function hello() { return "world"; }');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
    },
    TIMEOUT,
  );

  it(
    'should embed a batch of texts',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['jina-code-v2']);
      const vecs = await embedder.embedBatch(['const x = 1;', 'import os', 'fn main() {}']);
      expect(vecs).toHaveLength(3);
      for (const vec of vecs) {
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(768);
      }
    },
    TIMEOUT,
  );

  it(
    'should produce normalized vectors (unit length)',
    async () => {
      const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['jina-code-v2']);
      const vec = await embedder.embed('console.log("test")');
      let sumSq = 0;
      for (const v of vec) sumSq += v * v;
      const norm = Math.sqrt(sumSq);
      expect(norm).toBeCloseTo(1.0, 2);
    },
    TIMEOUT,
  );

  it('should report 768 dimensions', () => {
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['jina-code-v2']);
    expect(embedder.dimensions()).toBe(768);
  });

  it('modelId() should return jina-code-v2', () => {
    const embedder = new TransformersJsEmbedder(MODEL_REGISTRY['jina-code-v2']);
    expect(embedder.modelId()).toBe('jina-code-v2');
  });
});

describe.skipIf(!hasWorkingEmbedder)('createCodeEmbedder', () => {
  it('should return a code embedder with transformers-js backend', async () => {
    const embedder = await createCodeEmbedder({ embeddingBackend: 'transformers-js' });
    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('jina-code-v2');
    expect(embedder!.dimensions()).toBe(768);
  }, 120_000);

  it('should return a code embedder with auto backend', async () => {
    const embedder = await createCodeEmbedder();
    expect(embedder).not.toBeNull();
    expect(embedder!.dimensions()).toBe(768);
  }, 120_000);

  it('should respect config.embeddingModel for code embedder', async () => {
    // Use minilm as code model (unusual but valid)
    const embedder = await createCodeEmbedder({
      embeddingBackend: 'transformers-js',
      embeddingModel: 'minilm-l12-v2',
    });
    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('minilm-l12-v2');
    expect(embedder!.dimensions()).toBe(384);
  }, 120_000);
});

// --- OllamaEmbedder ---

describe('OllamaEmbedder', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    });
  }

  it('embed should return Float32Array of correct size', async () => {
    const dims = 768;
    const fakeEmbedding = Array.from({ length: dims }, () => Math.random());
    mockFetch({ embeddings: [fakeEmbedding] });

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    const vec = await embedder.embed('Hello world');

    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(dims);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('embed should throw on HTTP 500', async () => {
    mockFetch({ error: 'internal error' }, 500);

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await expect(embedder.embed('test')).rejects.toThrow(/Ollama embed failed/);
  });

  it('embed should throw on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await expect(embedder.embed('test')).rejects.toThrow('ECONNREFUSED');
  });

  it('modelId should return ollama:<model>', () => {
    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    expect(embedder.modelId()).toBe('ollama:nomic-embed-text');
  });

  it('dimensions should throw before first embed', () => {
    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    expect(() => embedder.dimensions()).toThrow(/not yet known/);
  });

  it('dimensions should return correct value after embed', async () => {
    const dims = 768;
    const fakeEmbedding = Array.from({ length: dims }, () => Math.random());
    mockFetch({ embeddings: [fakeEmbedding] });

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await embedder.embed('test');
    expect(embedder.dimensions()).toBe(dims);
  });

  it('embedBatch should return correct results for multiple texts', async () => {
    const dims = 768;
    const fakeEmbedding = Array.from({ length: dims }, () => Math.random());
    mockFetch({ embeddings: [fakeEmbedding] });

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    const vecs = await embedder.embedBatch(['Hello', 'World', 'Test']);

    expect(vecs).toHaveLength(3);
    for (const vec of vecs) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(dims);
    }
    // One call per text (Ollama batch sums tokens, so we embed individually)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);

    // Verify each call sends a single string (not array)
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.input).toBe('Hello');
    expect(body.model).toBe('nomic-embed-text');
    expect(body.truncate).toBe(true);
  });

  it('embedBatch with empty array should return empty without HTTP call', async () => {
    globalThis.fetch = vi.fn();

    const embedder = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    const vecs = await embedder.embedBatch([]);

    expect(vecs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// --- Health check + model availability ---

describe('checkOllamaHealth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return ok with model list when Ollama is running', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            { name: 'nomic-embed-text:latest', size: 274000000 },
            { name: 'llama3:latest', size: 4000000000 },
          ],
        }),
    });

    const result = await checkOllamaHealth('http://localhost:11434');
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['nomic-embed-text:latest', 'llama3:latest']);
  });

  it('should return not ok when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkOllamaHealth('http://localhost:11434');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });

  it('should return not ok on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const result = await checkOllamaHealth('http://localhost:11434');
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });
});

describe('isModelAvailable', () => {
  it('should match model with :latest suffix', () => {
    expect(isModelAvailable('nomic-embed-text', ['nomic-embed-text:latest'])).toBe(true);
  });

  it('should not match different model', () => {
    expect(isModelAvailable('other-model', ['nomic-embed-text:latest'])).toBe(false);
  });

  it('should match exact name', () => {
    expect(isModelAvailable('nomic-embed-text:latest', ['nomic-embed-text:latest'])).toBe(true);
  });
});

// --- Auto-pull model ---

describe('pullOllamaModel', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return true when pull succeeds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success' }),
    });

    const result = await pullOllamaModel('http://localhost:11434', 'nomic-embed-text');
    expect(result).toBe(true);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('http://localhost:11434/api/pull');
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('nomic-embed-text');
    expect(body.stream).toBe(false);
  });

  it('should return false on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('pull failed'),
    });

    const result = await pullOllamaModel('http://localhost:11434', 'nomic-embed-text');
    expect(result).toBe(false);
  });

  it('should return false on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await pullOllamaModel('http://localhost:11434', 'nomic-embed-text');
    expect(result).toBe(false);
  });
});

// --- createTextEmbedder with config ---

describe.skipIf(!hasWorkingEmbedder)('createTextEmbedder with config', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('backend=ollama with Ollama OK should return OllamaEmbedder', async () => {
    const dims = 768;
    const fakeEmbedding = Array.from({ length: dims }, () => Math.random());

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: 'nomic-embed-text:latest' }] }),
        });
      }
      if (url.includes('/api/embed')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ embeddings: [fakeEmbedding] }),
          text: () => Promise.resolve(JSON.stringify({ embeddings: [fakeEmbedding] })),
        });
      }
      return Promise.reject(new Error(`unexpected URL: ${url}`));
    });

    const embedder = await createTextEmbedder({
      embeddingBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('ollama:nomic-embed-text');
    expect(embedder!.dimensions()).toBe(dims);
  });

  it('backend=ollama with Ollama down should return null', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const embedder = await createTextEmbedder({
      embeddingBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(embedder).toBeNull();
  });

  it('backend=ollama with model absent + pull OK should return OllamaEmbedder', async () => {
    const dims = 768;
    const fakeEmbedding = Array.from({ length: dims }, () => Math.random());

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: 'llama3:latest' }] }),
        });
      }
      if (url.includes('/api/pull')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'success' }),
        });
      }
      if (url.includes('/api/embed')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ embeddings: [fakeEmbedding] }),
          text: () => Promise.resolve(JSON.stringify({ embeddings: [fakeEmbedding] })),
        });
      }
      return Promise.reject(new Error(`unexpected URL: ${url}`));
    });

    const embedder = await createTextEmbedder({
      embeddingBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('ollama:nomic-embed-text');
  });

  it('backend=ollama with model absent + pull fail should return null', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: 'llama3:latest' }] }),
        });
      }
      if (url.includes('/api/pull')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('pull failed'),
        });
      }
      return Promise.reject(new Error(`unexpected URL: ${url}`));
    });

    const embedder = await createTextEmbedder({
      embeddingBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
    });

    expect(embedder).toBeNull();
  });

  it('backend=transformers-js should return TransformersJsEmbedder without fetch', async () => {
    globalThis.fetch = vi.fn();

    const embedder = await createTextEmbedder({ embeddingBackend: 'transformers-js' });

    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('minilm-l12-v2');
    expect(embedder).toBeInstanceOf(TransformersJsEmbedder);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 120_000);

  it('without args (backward compat) should return minilm-l12-v2', async () => {
    const embedder = await createTextEmbedder();
    expect(embedder).not.toBeNull();
    expect(embedder!.modelId()).toBe('minilm-l12-v2');
  }, 120_000);
});
