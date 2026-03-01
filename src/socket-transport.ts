/**
 * SocketTransport — MCP Transport implementation over a net.Socket.
 * Uses newline-delimited JSON framing (same as StdioServerTransport).
 */

import type net from 'net';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export class SocketTransport implements Transport {
  private buffer = '';
  private started = false;
  sessionId?: string;

  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private socket: net.Socket) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('SocketTransport already started');
    }
    this.started = true;

    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this.onclose?.();
    });

    this.socket.on('error', (err: Error) => {
      this.onerror?.(err);
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(line));
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('Socket is destroyed'));
        return;
      }
      const data = JSON.stringify(message) + '\n';
      if (this.socket.write(data)) {
        resolve();
      } else {
        this.socket.once('drain', resolve);
      }
    });
  }

  async close(): Promise<void> {
    this.socket.end();
  }
}
