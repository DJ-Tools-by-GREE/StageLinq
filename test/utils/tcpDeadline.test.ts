import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../../utils/tcp';
import { CONNECT_TIMEOUT } from '../../types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('TCP connection deadline', () => {
  it('rejects and destroys a socket which never connects', async () => {
    vi.useFakeTimers();
    let socket!: Socket;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function () {
      socket = this;
      return this;
    });
    const pending = connect('127.0.0.1', 12345);
    const rejected = expect(pending).rejects.toThrow('TCP connection timed out');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT - 1);
    expect(socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the connection deadline and preserves a healthy idle socket', async () => {
    vi.useFakeTimers();
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (...args: unknown[]) {
      (args[args.length - 1] as () => void)();
      return this;
    });
    const connection = await connect('127.0.0.1', 12345);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT * 3);
    expect(connection.socket.destroyed).toBe(false);
    connection.destroy();
  });

  it('closes and clears the deadline after an immediate connection error', async () => {
    vi.useFakeTimers();
    let socket!: Socket;
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function () {
      socket = this;
      this.emit('error', new Error('ECONNREFUSED'));
      return this;
    });
    await expect(connect('127.0.0.1', 12345)).rejects.toThrow('ECONNREFUSED');
    expect(socket.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
