import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock fs before importing config
vi.mock('fs');

describe('config', () => {
  const mockHomedir = '/mock/home';
  const configFilePath = path.join(mockHomedir, '.melchizedek', 'config.json');

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHomedir);
    // Reset all env vars
    delete process.env.M9K_DB_PATH;
    delete process.env.M9K_JSONL_DIR;
    delete process.env.M9K_EMBEDDINGS;
    delete process.env.M9K_EMBEDDING_TEXT_BACKEND;
    delete process.env.M9K_EMBEDDING_TEXT_MODEL;
    delete process.env.M9K_EMBEDDING_CODE_BACKEND;
    delete process.env.M9K_EMBEDDING_CODE_MODEL;
    delete process.env.M9K_EMBEDDING_CODE;
    delete process.env.M9K_RERANKER;
    delete process.env.M9K_RERANKER_BACKEND;
    delete process.env.M9K_RERANKER_MODEL;
    delete process.env.M9K_RERANKER_TOP_N;
    delete process.env.M9K_MODELS_DIR;
    // Reset module cache to re-run getConfig with fresh state
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return defaults when no config.json exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getConfig } = await import('../src/config.js');

    const cfg = getConfig();
    expect(cfg.dbPath).toBe(path.join(mockHomedir, '.melchizedek', 'memory.db'));
    expect(cfg.embeddingsEnabled).toBe(true);
    expect(cfg.rerankerEnabled).toBe(true);
    expect(cfg.autoFuzzyThreshold).toBe(3);
  });

  it('should load config.json when it exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ embeddingsEnabled: false, autoFuzzyThreshold: 5 }),
    );
    const { getConfig } = await import('../src/config.js');

    const cfg = getConfig();
    expect(cfg.embeddingsEnabled).toBe(false);
    expect(cfg.autoFuzzyThreshold).toBe(5);
    // Other defaults still apply
    expect(cfg.rerankerEnabled).toBe(true);
  });

  it('should let env vars override config.json', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ embeddingsEnabled: true }));
    process.env.M9K_EMBEDDINGS = 'false';
    const { getConfig } = await import('../src/config.js');

    const cfg = getConfig();
    // Env var wins over config.json
    expect(cfg.embeddingsEnabled).toBe(false);
  });

  it('should let overrides take highest priority', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ autoFuzzyThreshold: 5 }));
    const { getConfig } = await import('../src/config.js');

    const cfg = getConfig({ autoFuzzyThreshold: 10 });
    expect(cfg.autoFuzzyThreshold).toBe(10);
  });

  it('should handle malformed config.json gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json');
    const { getConfig } = await import('../src/config.js');

    // Should not throw — just use defaults
    const cfg = getConfig();
    expect(cfg.embeddingsEnabled).toBe(true);
  });

  it('getConfigFilePath should return the path', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getConfigFilePath } = await import('../src/config.js');
    expect(getConfigFilePath()).toBe(configFilePath);
  });

  it('writeConfigFile should write JSON to disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const { writeConfigFile } = await import('../src/config.js');

    writeConfigFile({ embeddingsEnabled: false });

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(mockHomedir, '.melchizedek'), {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      configFilePath,
      expect.stringContaining('"embeddingsEnabled": false'),
      'utf8',
    );
  });
});
