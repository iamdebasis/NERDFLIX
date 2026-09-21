/**
 * mpv JSON IPC client.
 *
 * Protocol: newline-delimited JSON over a unix socket.
 *   → {"command":["get_property","duration"],"request_id":7}
 *   ← {"data":8123.4,"request_id":7,"error":"success"}
 *   ← {"event":"property-change","id":3,"name":"time-pos","data":12.5}
 *
 * Three things bite implementations of this, all handled here:
 *  1. The socket does not exist the instant mpv is spawned — connect must retry.
 *  2. TCP-style stream semantics mean a single 'data' event can contain a partial
 *     line, several lines, or both. Never JSON.parse a raw chunk.
 *  3. If mpv dies, every in-flight request must reject rather than hang forever.
 */

import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

export type MpvEvent = {
  event: string;
  [key: string]: unknown;
};

export type MpvPropertyChange = {
  event: 'property-change';
  id: number;
  name: string;
  data: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class MpvIpcError extends Error {
  constructor(
    message: string,
    readonly command?: unknown[],
  ) {
    super(message);
    this.name = 'MpvIpcError';
  }
}

/**
 * Split a byte stream into complete JSON lines.
 * Exported separately so the framing can be tested without a live socket.
 */
export class LineBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The final element is either '' (chunk ended on a newline) or a partial line.
    this.buffer = lines.pop() ?? '';
    return lines.filter((l) => l.trim().length > 0);
  }

  get pending(): string {
    return this.buffer;
  }
}

export class MpvIpc extends EventEmitter {
  private socket?: Socket;
  private readonly lines = new LineBuffer();
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly socketPath: string) {
    super();
  }

  /** Connect, retrying until mpv has created the socket. */
  async connect(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        this.socket = await this.tryConnect();
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new MpvIpcError(
            `Could not connect to mpv IPC at ${this.socketPath} within ${timeoutMs}ms: ${String(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this.onClose());
  }

  private tryConnect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        resolve(sock);
      });
    });
  }

  private onData(chunk: string): void {
    for (const line of this.lines.push(chunk)) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        // mpv occasionally emits non-JSON noise on the socket; ignore rather than crash.
        continue;
      }

      if (typeof msg.request_id === 'number') {
        const req = this.pending.get(msg.request_id);
        if (req) {
          this.pending.delete(msg.request_id);
          if (msg.error === 'success') req.resolve(msg.data);
          else req.reject(new MpvIpcError(String(msg.error ?? 'unknown mpv error')));
        }
        continue;
      }

      if (typeof msg.event === 'string') {
        this.emit('event', msg as MpvEvent);
        if (msg.event === 'property-change') {
          this.emit('property-change', msg as unknown as MpvPropertyChange);
        }
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    const err = new MpvIpcError('mpv IPC connection closed');
    for (const [, req] of this.pending) req.reject(err);
    this.pending.clear();
    this.emit('close');
  }

  /** Send a command and await its result. */
  command<T = unknown>(command: unknown[]): Promise<T> {
    if (this.closed || !this.socket) {
      return Promise.reject(new MpvIpcError('IPC is closed', command));
    }
    const request_id = this.nextRequestId++;
    const payload = JSON.stringify({ command, request_id }) + '\n';

    return new Promise<T>((resolve, reject) => {
      this.pending.set(request_id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.socket!.write(payload, (err) => {
        if (err) {
          this.pending.delete(request_id);
          reject(new MpvIpcError(`write failed: ${err.message}`, command));
        }
      });
    });
  }

  /** Fire and forget — used for high-frequency input where a round trip is wasteful. */
  send(command: unknown[]): void {
    if (this.closed || !this.socket) return;
    this.socket.write(JSON.stringify({ command }) + '\n');
  }

  getProperty<T>(name: string): Promise<T> {
    return this.command<T>(['get_property', name]);
  }

  setProperty(name: string, value: unknown): Promise<unknown> {
    return this.command(['set_property', name, value]);
  }

  observeProperty(observeId: number, name: string): Promise<unknown> {
    return this.command(['observe_property', observeId, name]);
  }

  unobserveProperty(observeId: number): Promise<unknown> {
    return this.command(['unobserve_property', observeId]);
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
