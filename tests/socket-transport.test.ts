import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'net';
import { SocketTransport } from '../src/socket-transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Creates a linked pair of sockets (client ↔ server) for testing.
 * Returns [clientSocket, serverSocket].
 */
function createSocketPair(): Promise<[net.Socket, net.Socket]> {
  return new Promise((resolve) => {
    const server = net.createServer((serverSocket) => {
      server.close();
      resolve([clientSocket!, serverSocket]);
    });
    let clientSocket: net.Socket | null = null;
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      clientSocket = net.createConnection(addr.port, '127.0.0.1');
    });
  });
}

describe('SocketTransport', () => {
  let clientSocket: net.Socket;
  let serverSocket: net.Socket;

  beforeEach(async () => {
    [clientSocket, serverSocket] = await createSocketPair();
  });

  afterEach(() => {
    clientSocket.destroy();
    serverSocket.destroy();
  });

  it('should receive a complete JSON-RPC message', async () => {
    const transport = new SocketTransport(serverSocket);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();

    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'ping', id: 1 };
    clientSocket.write(JSON.stringify(msg) + '\n');

    // Wait for data to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it('should handle multiple messages in one chunk', async () => {
    const transport = new SocketTransport(serverSocket);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();

    const msg1: JSONRPCMessage = { jsonrpc: '2.0', method: 'a', id: 1 };
    const msg2: JSONRPCMessage = { jsonrpc: '2.0', method: 'b', id: 2 };
    clientSocket.write(JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(msg1);
    expect(received[1]).toEqual(msg2);
  });

  it('should handle partial messages across chunks', async () => {
    const transport = new SocketTransport(serverSocket);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();

    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', id: 1 };
    const json = JSON.stringify(msg);
    const half = Math.floor(json.length / 2);

    // Send first half (no newline)
    clientSocket.write(json.slice(0, half));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(0);

    // Send second half + newline
    clientSocket.write(json.slice(half) + '\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it('should send messages as newline-delimited JSON', async () => {
    const transport = new SocketTransport(serverSocket);
    await transport.start();

    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'hello', id: 42 };

    const data = await new Promise<string>((resolve) => {
      clientSocket.once('data', (chunk) => resolve(chunk.toString()));
      transport.send(msg);
    });

    expect(data).toBe(JSON.stringify(msg) + '\n');
  });

  it('should call onclose when socket closes', async () => {
    const transport = new SocketTransport(serverSocket);
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();

    clientSocket.end();
    await new Promise((r) => setTimeout(r, 50));

    expect(closed).toBe(true);
  });

  it('should call onerror on invalid JSON', async () => {
    const transport = new SocketTransport(serverSocket);
    const errors: Error[] = [];
    transport.onerror = (err) => errors.push(err);
    await transport.start();

    clientSocket.write('not valid json\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(errors).toHaveLength(1);
  });

  it('should throw if started twice', async () => {
    const transport = new SocketTransport(serverSocket);
    await transport.start();
    await expect(transport.start()).rejects.toThrow('already started');
  });

  it('should close the socket', async () => {
    const transport = new SocketTransport(serverSocket);
    await transport.start();

    await transport.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(serverSocket.destroyed || serverSocket.writableEnded).toBe(true);
  });

  it('should skip empty lines', async () => {
    const transport = new SocketTransport(serverSocket);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg) => received.push(msg);
    await transport.start();

    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', id: 1 };
    clientSocket.write('\n\n' + JSON.stringify(msg) + '\n\n');

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
  });

  it('should reject send on destroyed socket', async () => {
    const transport = new SocketTransport(serverSocket);
    await transport.start();

    serverSocket.destroy();
    await new Promise((r) => setTimeout(r, 20));

    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', id: 1 };
    await expect(transport.send(msg)).rejects.toThrow('destroyed');
  });
});
