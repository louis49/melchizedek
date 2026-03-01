import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { EmbedOrchestrator } from '../src/embed-orchestrator.js';
import { openMemoryDatabase } from '../src/db.js';
import type { DatabaseType } from '../src/db.js';
import type { WorkerOutMessage, EmbedJobConfig } from '../src/models.js';

// --- Fake worker to simulate child_process.fork ---

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  killed = false;
  sentMessages: unknown[] = [];

  send(msg: unknown): boolean {
    this.sentMessages.push(msg);
    return true;
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', signal === 'SIGTERM' ? null : 1, signal);
    return true;
  }
}

// We'll mock child_process.fork to return our FakeChildProcess
let fakeChild: FakeChildProcess;

vi.mock('child_process', () => ({
  fork: vi.fn(() => {
    fakeChild = new FakeChildProcess();
    return fakeChild;
  }),
}));

function makeJob(suffix: '_text' | '_code' = '_text'): EmbedJobConfig {
  return {
    suffix,
    embedderType: suffix === '_text' ? 'text' : 'code',
    config: {
      embeddingBackend: 'auto',
      embeddingModel: null,
      ollamaBaseUrl: 'http://localhost:11434',
    },
  };
}

describe('EmbedOrchestrator', () => {
  let db: DatabaseType;
  let orchestrator: EmbedOrchestrator;

  beforeEach(() => {
    const info = openMemoryDatabase();
    db = info.db;
    orchestrator = new EmbedOrchestrator('/tmp/test.db', db, {
      workerPath: '/fake/embed-worker.js',
    });
  });

  afterEach(() => {
    orchestrator.abort();
    db.close();
  });

  it('should start with inactive status', () => {
    const status = orchestrator.getStatus();
    expect(status.active).toBe(false);
    expect(status.suffix).toBeNull();
    expect(status.pid).toBeNull();
  });

  it('should resolve with embedded count on successful worker', async () => {
    const promise = orchestrator.runJob(makeJob());

    // Wait for fork + send
    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    // Simulate worker lifecycle
    const msg = (m: WorkerOutMessage) => fakeChild.emit('message', m);
    msg({ type: 'ready', modelId: 'minilm-l12-v2', dimensions: 384 });
    msg({ type: 'progress', embedded: 25, total: 50 });
    msg({ type: 'progress', embedded: 50, total: 50 });
    msg({ type: 'done', embedded: 50, durationMs: 1234 });
    fakeChild.emit('exit', 0);

    const result = await promise;
    expect(result.embedded).toBe(50);
    expect(result.error).toBeUndefined();
  });

  it('should track progress via status', async () => {
    const statuses: Array<{ active: boolean; embedded: number; total: number }> = [];
    orchestrator.onStatusChange((s) =>
      statuses.push({ active: s.active, embedded: s.embedded, total: s.total }),
    );

    const promise = orchestrator.runJob(makeJob());

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    fakeChild.emit('message', {
      type: 'ready',
      modelId: 'test',
      dimensions: 384,
    } satisfies WorkerOutMessage);
    fakeChild.emit('message', {
      type: 'progress',
      embedded: 10,
      total: 100,
    } satisfies WorkerOutMessage);

    // Check intermediate status
    const status = orchestrator.getStatus();
    expect(status.active).toBe(true);
    expect(status.embedded).toBe(10);
    expect(status.total).toBe(100);
    expect(status.suffix).toBe('_text');

    fakeChild.emit('message', {
      type: 'done',
      embedded: 100,
      durationMs: 5000,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 0);

    await promise;

    // After completion, status should be reset
    const finalStatus = orchestrator.getStatus();
    expect(finalStatus.active).toBe(false);
  });

  it('should handle worker crash (non-zero exit)', async () => {
    const promise = orchestrator.runJob(makeJob());

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    fakeChild.emit('message', {
      type: 'progress',
      embedded: 5,
      total: 50,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 1);

    const result = await promise;
    expect(result.embedded).toBe(5);
    expect(result.error).toContain('exited with code 1');
  });

  it('should handle worker fatal error message', async () => {
    const promise = orchestrator.runJob(makeJob());

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    fakeChild.emit('message', {
      type: 'error',
      message: 'OOM',
      fatal: true,
    } satisfies WorkerOutMessage);

    const result = await promise;
    expect(result.error).toBe('OOM');
  });

  it('should handle fork error', async () => {
    const { fork } = await import('child_process');
    (fork as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });

    const result = await orchestrator.runJob(makeJob());
    expect(result.embedded).toBe(0);
    expect(result.error).toBe('spawn ENOENT');
  });

  it('should send correct start message', async () => {
    const job = makeJob('_code');
    job.batchSize = 20;
    const promise = orchestrator.runJob(job);

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    const startMsg = fakeChild.sentMessages[0] as Record<string, unknown>;
    expect(startMsg.type).toBe('start');
    expect(startMsg.suffix).toBe('_code');
    expect(startMsg.embedderType).toBe('code');
    expect(startMsg.batchSize).toBe(20);

    // Clean up
    fakeChild.emit('message', {
      type: 'done',
      embedded: 0,
      durationMs: 0,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 0);
    await promise;
  });

  it('should abort running worker', async () => {
    const promise = orchestrator.runJob(makeJob());

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    orchestrator.abort();
    expect(fakeChild.killed).toBe(true);

    const result = await promise;
    // After kill, exit event fires and resolves the promise
    expect(result).toBeDefined();
  });

  it('should track worker memory via IPC memory messages', async () => {
    const promise = orchestrator.runJob(makeJob());

    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));

    // Simulate worker sending memory stats
    fakeChild.emit('message', {
      type: 'ready',
      modelId: 'test',
      dimensions: 384,
    } satisfies WorkerOutMessage);
    fakeChild.emit('message', {
      type: 'memory',
      rssMB: 486.2,
      heapUsedMB: 312.5,
    } satisfies WorkerOutMessage);

    // Check memory is tracked in status
    const status = orchestrator.getStatus();
    expect(status.rssMB).toBe(486.2);
    expect(status.heapUsedMB).toBe(312.5);

    // Complete the worker
    fakeChild.emit('message', {
      type: 'done',
      embedded: 10,
      durationMs: 100,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 0);

    await promise;

    // After completion, memory stats should be reset to null
    const finalStatus = orchestrator.getStatus();
    expect(finalStatus.rssMB).toBeNull();
    expect(finalStatus.heapUsedMB).toBeNull();
  });

  it('should initialize memory stats as null', () => {
    const status = orchestrator.getStatus();
    expect(status.rssMB).toBeNull();
    expect(status.heapUsedMB).toBeNull();
  });

  it('should run jobs sequentially via runAllJobs', async () => {
    const jobOrder: string[] = [];
    let forkCount = 0;

    // Track which suffix each job uses
    orchestrator.onStatusChange((s) => {
      if (s.active && s.suffix && !jobOrder.includes(s.suffix)) {
        jobOrder.push(s.suffix);
      }
    });

    const promise = orchestrator.runAllJobs({
      textEnabled: true,
      codeEnabled: true,
      config: {
        embeddingTextBackend: 'auto',
        embeddingTextModel: null,
        embeddingCodeBackend: 'auto',
        embeddingCodeModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
      },
    });

    // First worker (text)
    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));
    forkCount++;
    const firstChild = fakeChild;
    firstChild.emit('message', {
      type: 'done',
      embedded: 10,
      durationMs: 100,
    } satisfies WorkerOutMessage);
    firstChild.emit('exit', 0);

    // Second worker (code) — wait for the new fakeChild to be created
    await vi.waitFor(() => expect(fakeChild).not.toBe(firstChild));
    forkCount++;
    fakeChild.emit('message', {
      type: 'done',
      embedded: 5,
      durationMs: 200,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 0);

    await promise;

    expect(forkCount).toBe(2);
    expect(jobOrder).toEqual(['_text', '_code']);
  });

  it('should skip code job when codeEnabled is false', async () => {
    const jobOrder: string[] = [];
    orchestrator.onStatusChange((s) => {
      if (s.active && s.suffix && !jobOrder.includes(s.suffix)) {
        jobOrder.push(s.suffix);
      }
    });

    const promise = orchestrator.runAllJobs({
      textEnabled: true,
      codeEnabled: false,
      config: {
        embeddingTextBackend: 'auto',
        embeddingTextModel: null,
        embeddingCodeBackend: 'auto',
        embeddingCodeModel: null,
        ollamaBaseUrl: 'http://localhost:11434',
      },
    });

    // Only text worker should start
    await vi.waitFor(() => expect(fakeChild.sentMessages).toHaveLength(1));
    const startMsg = fakeChild.sentMessages[0] as { suffix: string };
    expect(startMsg.suffix).toBe('_text');

    fakeChild.emit('message', {
      type: 'done',
      embedded: 10,
      durationMs: 100,
    } satisfies WorkerOutMessage);
    fakeChild.emit('exit', 0);

    await promise;

    // Only text job should have run — no code job
    expect(jobOrder).toEqual(['_text']);
  });
});
