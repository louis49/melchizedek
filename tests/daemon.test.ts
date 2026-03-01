import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';
import { closeDatabase, openMemoryDatabase } from '../src/db.js';
import { indexConvSession } from '../src/indexer.js';
import { createServer } from '../src/server.js';
import { SocketTransport } from '../src/socket-transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type Database from 'better-sqlite3';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

/**
 * Test the daemon register/handshake protocol and per-connection McpServer
 * using an in-process net.Server that mimics the daemon.
 */
const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('Daemon protocol', () => {
  let db: Database.Database;
  let socketServer: net.Server;
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    db = openMemoryDatabase().db;

    // Index fixture for search tests
    const content = readFileSync(join(FIXTURES_DIR, 'normal_session.jsonl'), 'utf8');
    indexConvSession(
      db,
      '550e8400-e29b-41d4-a716-446655440000',
      content,
      '/Users/test/my-project',
      '/path/to/session.jsonl',
    );

    // Create a temp socket path
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-test-'));
    socketPath = path.join(tmpDir, 'test.sock');

    // Start a mini-daemon that handles register + creates McpServer per connection
    socketServer = net.createServer((clientSocket) => {
      let registered = false;
      let buffer = '';

      clientSocket.on('data', async (chunk: Buffer) => {
        if (registered) return;

        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;

        const line = buffer.slice(0, idx);
        const rest = buffer.slice(idx + 1);

        try {
          const msg = JSON.parse(line) as { type: string; project: string };
          if (msg.type !== 'register') {
            clientSocket.write(
              JSON.stringify({ type: 'error', message: 'Expected register' }) + '\n',
            );
            clientSocket.end();
            return;
          }

          registered = true;
          clientSocket.write(JSON.stringify({ type: 'registered' }) + '\n');
          clientSocket.removeAllListeners('data');

          const { server } = createServer({}, db, {
            currentProject: msg.project,
          });

          const transport = new SocketTransport(clientSocket);
          await server.connect(transport);

          if (rest.length > 0) {
            clientSocket.emit('data', Buffer.from(rest));
          }
        } catch {
          clientSocket.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      socketServer.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    closeDatabase(db);
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  });

  it('should complete register handshake', async () => {
    const sock = net.createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once('connect', resolve));

    sock.write(JSON.stringify({ type: 'register', project: '/test', sessionId: 'abc' }) + '\n');

    const response = await new Promise<string>((resolve) => {
      sock.once('data', (chunk) => resolve(chunk.toString()));
    });

    const parsed = JSON.parse(response.trim());
    expect(parsed.type).toBe('registered');

    sock.destroy();
  });

  it('should forward MCP tool calls through the socket', async () => {
    const sock = net.createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once('connect', resolve));

    // Register handshake
    sock.write(JSON.stringify({ type: 'register', project: '/test', sessionId: 'abc' }) + '\n');
    await new Promise<string>((resolve) => {
      sock.once('data', (chunk) => resolve(chunk.toString()));
    });

    // Now create a Client using SocketTransport on this socket
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SocketTransport(sock);
    await client.connect(transport);

    // Call a tool
    const result = await client.callTool({
      name: 'm9k_search',
      arguments: { query: 'CORS' },
    });

    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].chunkId).toBeDefined();

    await client.close();
  });

  it('should handle multiple concurrent clients', async () => {
    const connect = async (project: string) => {
      const sock = net.createConnection(socketPath);
      await new Promise<void>((resolve) => sock.once('connect', resolve));

      sock.write(
        JSON.stringify({ type: 'register', project, sessionId: `session-${project}` }) + '\n',
      );
      await new Promise<string>((resolve) => {
        sock.once('data', (chunk) => resolve(chunk.toString()));
      });

      const client = new Client({ name: `client-${project}`, version: '1.0.0' });
      const transport = new SocketTransport(sock);
      await client.connect(transport);
      return client;
    };

    const [client1, client2, client3] = await Promise.all([
      connect('/project-a'),
      connect('/project-b'),
      connect('/project-c'),
    ]);

    // All three should be able to call tools concurrently
    const [r1, r2, r3] = await Promise.all([
      client1.callTool({ name: 'm9k_search', arguments: { query: 'test' } }),
      client2.callTool({ name: 'm9k_search', arguments: { query: 'test' } }),
      client3.callTool({ name: 'm9k_search', arguments: { query: 'test' } }),
    ]);

    expect(r1.content).toBeDefined();
    expect(r2.content).toBeDefined();
    expect(r3.content).toBeDefined();

    await Promise.all([client1.close(), client2.close(), client3.close()]);
  });

  it('should reject invalid register message', async () => {
    const sock = net.createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once('connect', resolve));

    sock.write(JSON.stringify({ type: 'invalid' }) + '\n');

    const response = await new Promise<string>((resolve) => {
      sock.once('data', (chunk) => resolve(chunk.toString()));
    });

    const parsed = JSON.parse(response.trim());
    expect(parsed.type).toBe('error');

    sock.destroy();
  });

  it('should list tools after connecting', async () => {
    const sock = net.createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once('connect', resolve));

    sock.write(JSON.stringify({ type: 'register', project: '/test', sessionId: 'abc' }) + '\n');
    await new Promise<string>((resolve) => {
      sock.once('data', (chunk) => resolve(chunk.toString()));
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SocketTransport(sock);
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);

    expect(names).toContain('m9k_search');
    expect(names).toContain('m9k_full');
    expect(names).toContain('m9k_context');
    expect(names).toContain('m9k_sessions');
    expect(names).toContain('m9k_save');

    await client.close();
  });

  it('should continue serving other clients when one disconnects', async () => {
    // Connect two clients
    const connect = async (id: string) => {
      const sock = net.createConnection(socketPath);
      await new Promise<void>((resolve) => sock.once('connect', resolve));
      sock.write(JSON.stringify({ type: 'register', project: '/test', sessionId: id }) + '\n');
      await new Promise<string>((resolve) => {
        sock.once('data', (chunk) => resolve(chunk.toString()));
      });
      const client = new Client({ name: `client-${id}`, version: '1.0.0' });
      const transport = new SocketTransport(sock);
      await client.connect(transport);
      return client;
    };

    const client1 = await connect('1');
    const client2 = await connect('2');

    // Disconnect client1
    await client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // client2 should still work
    const result = await client2.callTool({
      name: 'm9k_search',
      arguments: { query: 'test' },
    });
    expect(result.content).toBeDefined();

    await client2.close();
  });
});
