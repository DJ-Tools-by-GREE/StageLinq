import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { FileTransfer } from '../../services/FileTransfer';
import { Service } from '../../services/Service';
import { CONNECT_TIMEOUT, DOWNLOAD_TIMEOUT, MESSAGE_TIMEOUT } from '../../types';
import type { NetworkDevice } from '../../network/NetworkDevice';

const infoId = 4;
const chunkId = 5;

function fixture() {
  const service = new FileTransfer('127.0.0.1', 1234, {} as NetworkDevice);
  const patch = service as any;
  let content = Buffer.from('valid audio data');
  const calls: string[] = [];
  patch.requestFileTransferId = vi.fn(async (location: string) => {
    calls.push('id:' + location);
    service.emit('message', { id: infoId, message: { size: content.length, txid: 1 } });
  });
  patch.requestChunkRange = vi.fn(async () => {
    calls.push('chunks');
    service.emit('message', { id: chunkId, message: { data: content, offset: 0, size: content.length } });
  });
  patch.signalTransferComplete = vi.fn(async () => { calls.push('complete'); });
  return { service, patch, calls, setContent: (value: Buffer) => { content = value; } };
}

function attachConnection(service: FileTransfer) {
  const socket = new EventEmitter();
  const connection = { socket, destroy: vi.fn(() => { socket.emit('close'); }) };
  (service as any).connection = connection;
  void service.init();
  return connection;
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('FileTransfer lifecycle integrity', () => {
  it('cleans empty files and completes a following full download with no timers or listeners', async () => {
    vi.useFakeTimers();
    const { service, setContent, calls } = fixture();
    setContent(Buffer.alloc(0));
    expect(await service.getFile('/empty')).toHaveLength(0);
    setContent(Buffer.from('next'));
    expect(Buffer.from(await service.getFile('/next')).toString()).toBe('next');
    await service.waitTillAvailable();
    expect(calls).toEqual(['id:/empty', 'complete', 'id:/next', 'chunks', 'complete']);
    expect(service.listenerCount('message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves the protocol atomically for full, range, and full calls', async () => {
    const { service, calls } = fixture();
    const results = await Promise.all([
      service.getFile('/first'), service.getFileRange('/range', 0, 5), service.getFile('/last'),
    ]);
    expect(Buffer.from(results[0]).toString()).toBe('valid audio data');
    expect(Buffer.from(results[1]).toString()).toBe('valid');
    expect(Buffer.from(results[2]).toString()).toBe('valid audio data');
    expect(calls).toEqual(['id:/first', 'chunks', 'complete', 'id:/range', 'chunks', 'complete', 'id:/last', 'chunks', 'complete']);
  });

  it('aborts queued work promptly without interrupting the active transfer', async () => {
    const { service, patch, calls } = fixture();
    let finish!: () => void;
    patch.requestChunkRange.mockImplementationOnce(async () => {
      finish = () => service.emit('message', { id: chunkId, message: { data: Buffer.from('valid audio data') } });
    });
    const active = service.getFile('/active');
    const abort = new AbortController();
    const queued = service.getFile('/obsolete', abort.signal);
    const rejected = expect(queued).rejects.toThrow('obsolete');
    await flush();
    abort.abort(new Error('obsolete'));
    await rejected;
    expect(calls).toEqual(['id:/active']);
    finish();
    await active;
    expect(Buffer.from(await service.getFile('/current')).toString()).toBe('valid audio data');
    expect(calls).not.toContain('id:/obsolete');
  });

  it('closes an aborted stream and reconnects before the next transfer', async () => {
    const { service, patch } = fixture();
    const connection = attachConnection(service);
    connection.socket.on('data', vi.fn());
    patch.requestChunkRange.mockImplementationOnce(async () => {});
    const connect = vi.spyOn(Service.prototype, 'connect').mockImplementation(async function () {
      attachConnection(this as FileTransfer);
    });
    const abort = new AbortController();
    const first = service.getFile('/stale', abort.signal);
    const rejected = expect(first).rejects.toThrow('changed');
    await flush();
    abort.abort(new Error('changed'));
    await rejected;
    expect(Buffer.from(await service.getFile('/fresh')).toString()).toBe('valid audio data');
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.socket.listenerCount('data')).toBe(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(service.listenerCount('message')).toBe(0);
  });

  it.each(['requestFileTransferId', 'requestChunkRange', 'signalTransferComplete'])('cleans a rejected %s and permits a later transfer', async phase => {
    vi.useFakeTimers();
    const { service, patch } = fixture();
    patch[phase].mockRejectedValueOnce(new Error('write failed'));
    await expect(service.getFile('/broken')).rejects.toThrow('write failed');
    expect(service.listenerCount('message')).toBe(0);
    expect(Buffer.from(await service.getFile('/valid')).toString()).toBe('valid audio data');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['request', 'chunks', 'completion'])('cleans a %s timeout and prevents a zombie loop', async phase => {
    vi.useFakeTimers();
    const { service, patch } = fixture();
    const method = phase === 'request' ? 'requestFileTransferId' : phase === 'chunks' ? 'requestChunkRange' : 'signalTransferComplete';
    patch[method].mockImplementationOnce(() => phase === 'completion' ? new Promise(() => {}) : Promise.resolve());
    const timed = service.getFile('/timeout');
    const rejected = expect(timed).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(phase === 'request' ? MESSAGE_TIMEOUT : DOWNLOAD_TIMEOUT);
    await rejected;
    expect(service.listenerCount('message')).toBe(0);
    expect(Buffer.from(await service.getFile('/valid')).toString()).toBe('valid audio data');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects pending range and full requests on disconnect without reconnecting', async () => {
    const { service, patch } = fixture();
    const connection = attachConnection(service);
    patch.requestChunkRange.mockImplementationOnce(async () => {});
    const first = service.getFileRange('/range', 0, 10);
    const next = service.getFile('/full');
    const firstRejected = expect(first).rejects.toThrow('disconnected');
    const nextRejected = expect(next).rejects.toThrow('disconnected');
    await flush();
    service.disconnect();
    service.disconnect();
    await Promise.all([firstRejected, nextRejected]);
    await flush();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(service.listenerCount('message')).toBe(0);
    await expect(service.getFile('/later')).rejects.toThrow('disconnected');
  });

  it('rejects an oversized file before requesting or allocating its body', async () => {
    const { service, patch } = fixture();
    patch.requestFileTransferId.mockImplementationOnce(async () => {
      service.emit('message', { id: infoId, message: { size: 0xffffffff, txid: 1 } });
    });
    await expect(service.getFile('/huge', undefined, 256 * 1024 * 1024)).rejects.toThrow('byte limit');
    expect(patch.requestChunkRange).not.toHaveBeenCalled();
    expect(patch.signalTransferComplete).toHaveBeenCalledOnce();
    expect(Buffer.from(await service.getFile('/valid')).toString()).toBe('valid audio data');
  });

  it('rejects promptly when the socket closes mid-range, then uses a fresh connection', async () => {
    const { service, patch } = fixture();
    const connection = attachConnection(service);
    patch.requestChunkRange.mockImplementationOnce(async () => {});
    const connect = vi.spyOn(Service.prototype, 'connect').mockImplementation(async function () {
      attachConnection(this as FileTransfer);
    });
    const first = service.getFileRange('/lost', 0, 5);
    const rejected = expect(first).rejects.toThrow('connection closed');
    await flush();
    connection.socket.emit('close');
    await rejected;
    expect(Buffer.from(await service.getFile('/current')).toString()).toBe('valid audio data');
    expect(connect).toHaveBeenCalledOnce();
    expect(service.listenerCount('message')).toBe(0);
  });

  it('does not send a request for pre-aborted or invalid range work', async () => {
    const { service, patch } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(service.getFile('/cancelled', controller.signal)).rejects.toThrow('cancelled');
    await expect(service.getFileRange('/invalid', -1, 5)).rejects.toThrow('nonnegative');
    expect(patch.requestFileTransferId).not.toHaveBeenCalled();
  });

  it('holds the queue through a cancelled reconnect and closes its late connection', async () => {
    const { service, patch, calls } = fixture();
    const original = attachConnection(service);
    original.socket.emit('close');
    let finishConnect!: () => void;
    let lateConnection!: ReturnType<typeof attachConnection>;
    const connect = vi.spyOn(Service.prototype, 'connect');
    connect.mockImplementationOnce(function () {
      return new Promise<void>(resolve => {
        finishConnect = () => {
          lateConnection = attachConnection(this as FileTransfer);
          resolve();
        };
      });
    });
    connect.mockImplementation(async function () { attachConnection(this as FileTransfer); });
    const controller = new AbortController();
    const obsolete = service.getFile('/obsolete', controller.signal);
    const rejected = expect(obsolete).rejects.toThrow('track changed');
    await flush();
    controller.abort(new Error('track changed'));
    await rejected;
    const current = service.getFile('/current');
    await flush();
    expect(patch.requestFileTransferId).not.toHaveBeenCalled();
    finishConnect();
    expect(Buffer.from(await current).toString()).toBe('valid audio data');
    expect(lateConnection.destroy).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(calls).not.toContain('id:/obsolete');
  });

  it('releases a cancelled reconnect reservation when the actual TCP helper reaches its deadline', async () => {
    vi.useFakeTimers();
    const { service, patch, calls } = fixture();
    attachConnection(service).socket.emit('close');
    patch.write = async () => 0;
    const sockets: Socket[] = [];
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (...args: unknown[]) {
      sockets.push(this);
      if (sockets.length > 1) (args[args.length - 1] as () => void)();
      return this;
    });
    const controller = new AbortController();
    const obsolete = service.getFile('/obsolete', controller.signal);
    const rejected = expect(obsolete).rejects.toThrow('cancelled');
    await flush();
    controller.abort(new Error('cancelled'));
    await rejected;
    const current = service.getFile('/current');
    await flush();
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);
    expect(Buffer.from(await current).toString()).toBe('valid audio data');
    expect(sockets).toHaveLength(2);
    expect(sockets[0].destroyed).toBe(true);
    expect(sockets[1].destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    service.disconnect();
  });
});
