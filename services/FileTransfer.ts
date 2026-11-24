import { DOWNLOAD_TIMEOUT, MESSAGE_TIMEOUT } from '../types';
import { ReadContext } from '../utils/ReadContext';
import { Service } from './Service';
import { strict as assert } from 'assert';
import { WriteContext } from '../utils/WriteContext';
import type { ServiceMessage, Source } from '../types';

const MAGIC_MARKER = 'fltx';

/**
 * Chunk size assumed before the device tells us otherwise.
 *
 * The firmware picks the real chunk size, not us. Engine OS 5.x uses something
 * larger than this, so treat it strictly as a starting guess: it is only ever
 * used for a read that starts at byte 0 (chunk 0 is chunk 0 at any chunk size),
 * and is replaced by the measured value as soon as a chunk arrives.
 */
export const CHUNK_SIZE = 4096;

// FIXME: Strongly type this for all possible messages?
type FileTransferData = any;

enum MessageId {
  TimeCode = 0x0,
  FileStat = 0x1,
  EndOfMessage = 0x2,
  SourceLocations = 0x3,
  FileTransferId = 0x4,
  FileTransferChunk = 0x5,
  Unknown0 = 0x8,
  ServiceDisconnect = 0x9,
}

interface FileTransferProgress {
  sizeLeft: number;
  total: number;
  bytesDownloaded: number;
  percentComplete: number;
}

export declare interface FileTransfer {
  on(event: 'fileTransferProgress', listener: (progress: FileTransferProgress) => void): this;
}

export class FileTransfer extends Service<FileTransferData> {
  private operationTail: Promise<void> = Promise.resolve();
  private lifecycle = new AbortController();
  private activeOperation: AbortController | null = null;
  private reconnectNeeded = false;
  private pendingOperations = 0;

  /**
   * The device's real chunk size, measured from the wire. Null until a chunk
   * that is provably not a file's final chunk has been seen. The firmware
   * cannot change this mid-connection, so it is cached for the life of the
   * service.
   */
  private deviceChunkSize: number | null = null;

  async init() {
    const connection = this.connection;
    if (!connection) return;
    const closed = () => {
      if (this.connection !== connection) return;
      this.invalidateTransport(new Error('FileTransfer connection closed'));
    };
    connection.socket.once('close', closed);
    connection.socket.once('error', closed);
  }

  override async connect(): Promise<void> {
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController();
    const signal = this.lifecycle.signal;
    await this.operationTail;
    signal.throwIfAborted();
    try {
      await super.connect();
      signal.throwIfAborted();
    } catch (error) {
      this.closeTransport();
      throw error;
    }
    this.reconnectNeeded = false;
  }

  override disconnect(): void {
    const error = new Error('FileTransfer disconnected');
    this.lifecycle.abort(error);
    this.activeOperation?.abort(error);
    this.reconnectNeeded = false;
    this.closeTransport();
  }

  private closeTransport(): void {
    const connection = this.connection;
    this.connection = null;
    this.deviceChunkSize = null;
    if (!connection) return;
    connection.socket.removeAllListeners('data');
    try { connection.destroy(); } catch (error) {
      this.logger.error('Error closing FileTransfer', error);
    }
  }

  private invalidateTransport(error: unknown): void {
    // Chunk messages carry no transfer ID. Closing this stream keeps late
    // bytes from a failed transfer out of the next one.
    if (this.connection && !this.lifecycle.signal.aborted) this.reconnectNeeded = true;
    this.closeTransport();
    this.activeOperation?.abort(error);
  }

  private async runOperation<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lifetime = this.lifecycle.signal;
    const caller = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    caller.throwIfAborted();
    ++this.pendingOperations;
    const next = this.operationTail.then(async () => {
      caller.throwIfAborted();
      const controller = new AbortController();
      this.activeOperation = controller;
      const active = AbortSignal.any([caller, controller.signal]);
      const timeout = setTimeout(() => controller.abort(new Error('FileTransfer download timed out')), DOWNLOAD_TIMEOUT);
      let started = false;
      try {
        if (this.reconnectNeeded) {
          // Retain the queue reservation until a TCP handshake settles.
          started = true;
          await super.connect();
          this.reconnectNeeded = false;
          active.throwIfAborted();
        }
        active.throwIfAborted();
        started = true;
        return await operation(active);
      } catch (error) {
        if (started) this.invalidateTransport(error);
        throw error;
      } finally {
        clearTimeout(timeout);
        if (this.activeOperation === controller) this.activeOperation = null;
      }
    });
    this.operationTail = next.then(() => {}, () => {}).finally(() => { --this.pendingOperations; });
    return this.withAbort(next, caller);
  }

  private withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  private completeTransfer(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return this.withAbort(this.signalTransferComplete(), signal);
  }

  private requestMessage(id: MessageId, request: () => Promise<void>, signal: AbortSignal): Promise<FileTransferData> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown, message?: FileTransferData) => {
        clearTimeout(timer);
        this.off('message', listener);
        signal.removeEventListener('abort', aborted);
        if (error !== undefined) reject(error); else resolve(message);
      };
      const listener = (message: ServiceMessage<FileTransferData>) => {
        if (message.id === id) finish(undefined, message.message);
      };
      const aborted = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error('FileTransfer response timed out: ' + id)), MESSAGE_TIMEOUT);
      this.addListener('message', listener);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      // Register first so immediate device responses cannot race the write.
      void request().catch(error => finish(error));
    });
  }

  private transferInfo(location: string, signal: AbortSignal): Promise<{ size: number; txid: number }> {
    return this.requestMessage(MessageId.FileTransferId, () => this.requestFileTransferId(location), signal).then(info => {
      if (!info || !Number.isSafeInteger(info.size) || info.size < 0 || !Number.isSafeInteger(info.txid) || info.txid < 0) {
        throw new Error('Invalid FileTransfer size or transfer ID');
      }
      return info;
    });
  }

  /**
   * Record the device's chunk size from an observed chunk.
   *
   * Only a chunk that is *not* the last chunk of its file carries the true
   * size — a final chunk is short, and a file smaller than one chunk arrives
   * whole. Those cases teach us nothing and are ignored rather than guessed at.
   */
  private noteChunkSize(byteStart: number, chunkLength: number, fileSize: number): void {
    if (byteStart + chunkLength >= fileSize) return;
    if (this.deviceChunkSize === chunkLength) return;
    this.logger.debug(`Device chunk size measured as ${chunkLength} bytes`);
    this.deviceChunkSize = chunkLength;
  }

  protected parseData(p_ctx: ReadContext): ServiceMessage<FileTransferData> {
    const check = p_ctx.getString(4);
    assert(check === MAGIC_MARKER);
    const code = p_ctx.readUInt32();

    // If first 4 bytes are non-zero, a timecode is sent
    if (code > 0) {
      assert(p_ctx.sizeLeft() === 8);
      const id = p_ctx.readUInt32();
      assert(id === 0x07d2);
      assert(p_ctx.readUInt32() === 0);
      return {
        id: MessageId.TimeCode,
        message: {
          timecode: code,
        },
      };
    }

    // Else
    const messageId: MessageId = p_ctx.readUInt32();
    switch (messageId) {
      case MessageId.SourceLocations: {
        const sources: string[] = [];
        const sourceCount = p_ctx.readUInt32();
        for (let i = 0; i < sourceCount; ++i) {
          // We get a location
          const location = p_ctx.readNetworkStringUTF16();
          sources.push(location);
        }
        // Final three bytes should be 0x1 0x1 0x1
        assert(p_ctx.readUInt8() === 0x1);
        assert(p_ctx.readUInt8() === 0x1);
        assert(p_ctx.readUInt8() === 0x1);
        assert(p_ctx.isEOF());
        return {
          id: messageId,
          message: {
            sources: sources,
          },
        };
      }

      case MessageId.FileStat: {
        assert(p_ctx.sizeLeft() === 53);
        // Last 4 bytes (FAT32) indicate size of file
        p_ctx.seek(49);
        const size = p_ctx.readUInt32();
        return {
          id: messageId,
          message: {
            size: size,
          },
        };
      }

      case MessageId.EndOfMessage: {
        // End of result indication?
        return {
          id: messageId,
          message: null,
        };
      }

      case MessageId.FileTransferId: {
        assert(p_ctx.sizeLeft() === 12);
        assert(p_ctx.readUInt32() === 0x0);
        const filesize = p_ctx.readUInt32();
        const id = p_ctx.readUInt32();

        return {
          id: messageId,
          message: {
            size: filesize,
            txid: id,
          },
        };
      }

      case MessageId.FileTransferChunk: {
        assert(p_ctx.readUInt32() === 0x0);
        const offset = p_ctx.readUInt32();
        const chunksize = p_ctx.readUInt32();
        // The declared size must match what actually arrived. That is the real
        // integrity check; there is deliberately no upper bound on it, because
        // the device chooses the chunk size and Engine OS 5.x exceeds 4096.
        assert(chunksize === p_ctx.sizeLeft());

        return {
          id: messageId,
          message: {
            data: p_ctx.readRemainingAsNewBuffer(),
            offset: offset,
            size: chunksize,
          },
        };
      }

      case MessageId.Unknown0: {
        return {
          id: messageId,
          message: null,
        };
      }

      case MessageId.ServiceDisconnect: {
        //This message is received when the player that FileTransfer is connected to shuts down
        this.disconnect();
        return {
          id: messageId,
          message: null,
        };
      }

      default:
        {
          assert.fail(`File Transfer Unhandled message id '${messageId}'`);
        }
        break;
    }
  }

  protected messageHandler(_data: ServiceMessage<FileTransferData>): void {}

  async getFile(p_location: string, signal?: AbortSignal, maxBytes = Infinity): Promise<Uint8Array> {
    if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new RangeError('maxBytes must be a nonnegative safe integer');
    }
    return this.runOperation(async active => {
      const txinfo = await this.transferInfo(p_location, active);
      active.throwIfAborted();
      if (txinfo.size > maxBytes) {
        await this.completeTransfer(active);
        throw new RangeError('File exceeds download byte limit: ' + txinfo.size + ' > ' + maxBytes);
      }
      if (txinfo.size === 0) {
        await this.completeTransfer(active);
        return new Uint8Array(0);
      }
      const totalChunks = Math.ceil(txinfo.size / (this.deviceChunkSize ?? CHUNK_SIZE));
      const data = await this.receiveChunks(p_location, txinfo.txid, 0, totalChunks - 1, {
        firstByteStart: 0, fileSize: txinfo.size, targetBytes: txinfo.size,
      }, active, true);
      await this.completeTransfer(active);
      return data;
    }, signal);
  }

  async getSources(signal?: AbortSignal): Promise<Source[]> {
    return this.runOperation(async active => {
      const result: Source[] = [];
      const message = await this.requestMessage(MessageId.SourceLocations, () => this.requestSources(), active);
      for (const source of message.sources) {
        const databases = ['/' + source + '/Engine Library/Database2/m.db', '/' + source + '/Engine Library/m.db'];
        for (const database of databases) {
          const stat = await this.requestMessage(MessageId.FileStat, () => this.requestStat(database), active);
          if (stat.size > 0) {
            result.push({ name: source, database: { location: database, size: stat.size } });
            break;
          }
        }
      }
      return result;
    }, signal);
  }

  async getFileSize(p_location: string, signal?: AbortSignal): Promise<number> {
    return this.runOperation(async active => {
      const stat = await this.requestMessage(MessageId.FileStat, () => this.requestStat(p_location), active);
      return stat.size;
    }, signal);
  }

  async getFileRange(p_location: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) {
      throw new RangeError('File range offset and length must be nonnegative safe integers');
    }
    return this.runOperation(async active => {
      if (length === 0) return Buffer.alloc(0);
      if (this.deviceChunkSize === null && offset > 0) await this.learnChunkSize(p_location, active);
      const txinfo = await this.transferInfo(p_location, active);
      const endOffset = Math.min(offset + length, txinfo.size);
      const actualLength = Math.max(0, endOffset - offset);
      if (actualLength === 0) {
        await this.completeTransfer(active);
        return Buffer.alloc(0);
      }
      const chunkSize = this.deviceChunkSize ?? CHUNK_SIZE;
      const startChunk = Math.floor(offset / chunkSize);
      const endChunk = Math.floor((endOffset - 1) / chunkSize);
      const firstByteStart = startChunk * chunkSize;
      const received = await this.receiveChunks(p_location, txinfo.txid, startChunk, endChunk, {
        firstByteStart, fileSize: txinfo.size, targetBytes: endOffset - firstByteStart,
      }, active);
      await this.completeTransfer(active);
      const startInBuffer = offset - firstByteStart;
      return received.subarray(startInBuffer, startInBuffer + actualLength);
    }, signal);
  }

  private async learnChunkSize(p_location: string, signal: AbortSignal): Promise<void> {
    const txinfo = await this.transferInfo(p_location, signal);
    if (txinfo.size > 0) {
      await this.receiveChunks(p_location, txinfo.txid, 0, 0, {
        firstByteStart: 0, fileSize: txinfo.size, targetBytes: 1,
      }, signal);
    }
    await this.completeTransfer(signal);
  }

  private receiveChunks(
    _location: string,
    txid: number,
    startChunk: number,
    endChunk: number,
    range: { firstByteStart: number; fileSize: number; targetBytes: number },
    signal: AbortSignal,
    progress = false,
  ): Promise<Buffer> {
    signal.throwIfAborted();
    // Small range reads retain only their requested bytes, and a device
    // overrun cannot grow a full-download buffer past its announced size.
    const output = Buffer.alloc(range.targetBytes);
    let total = 0;
    let lastProgress = -Infinity;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.off('message', listener);
        signal.removeEventListener('abort', aborted);
        if (error !== undefined) reject(error); else resolve(output);
      };
      const aborted = () => finish(signal.reason);
      const listener = (message: ServiceMessage<FileTransferData>) => {
        if (message.id !== MessageId.FileTransferChunk) return;
        const data: Buffer = message.message.data;
        if (!data.byteLength) return;
        this.noteChunkSize(range.firstByteStart + total, data.byteLength, range.fileSize);
        const copied = Math.min(data.byteLength, output.byteLength - total);
        output.set(data.subarray(0, copied), total);
        total += copied;
        const complete = total === output.byteLength;
        const now = performance.now();
        if (progress && (complete || now - lastProgress >= 200)) {
          lastProgress = now;
          this.emit('fileTransferProgress', {
            sizeLeft: output.byteLength - total, total: output.byteLength,
            bytesDownloaded: total, percentComplete: total / output.byteLength * 100,
          });
        }
        if (complete) finish();
      };
      this.addListener('message', listener);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      void this.requestChunkRange(txid, startChunk, endChunk).catch(error => finish(error));
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // Private methods

  private async requestStat(p_filepath: string): Promise<void> {
    // 0x7d1: seems to request some sort of fstat on a file
    const ctx = new WriteContext();
    ctx.writeFixedSizedString(MAGIC_MARKER);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(0x7d1);
    ctx.writeNetworkStringUTF16(p_filepath);
    await this.writeWithLength(ctx);
  }

  private async requestSources(): Promise<void> {
    // 0x7d2: Request available sources
    const ctx = new WriteContext();
    ctx.writeFixedSizedString(MAGIC_MARKER);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(0x7d2); // Database query
    ctx.writeUInt32(0x0);
    await this.writeWithLength(ctx);
  }

  private async requestFileTransferId(p_filepath: string): Promise<void> {
    // 0x7d4: Request transfer id?
    const ctx = new WriteContext();
    ctx.writeFixedSizedString(MAGIC_MARKER);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(0x7d4);
    ctx.writeNetworkStringUTF16(p_filepath);
    ctx.writeUInt32(0x0); // Not sure why we need 0x0 here
    await this.writeWithLength(ctx);
  }

  private async requestChunkRange(p_txid: number, p_chunkStartId: number, p_chunkEndId: number): Promise<void> {
    // 0x7d5: seems to be the code to request chunk range
    const ctx = new WriteContext();
    ctx.writeFixedSizedString(MAGIC_MARKER);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(0x7d5);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(p_txid); // I assume this is the transferid
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(p_chunkStartId);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(p_chunkEndId);
    await this.writeWithLength(ctx);
  }

  private async signalTransferComplete(): Promise<void> {
    // 0x7d6: seems to be the code to signal transfer completed
    const ctx = new WriteContext();
    ctx.writeFixedSizedString(MAGIC_MARKER);
    ctx.writeUInt32(0x0);
    ctx.writeUInt32(0x7d6);
    await this.writeWithLength(ctx);
  }

  public async waitTillAvailable(signal?: AbortSignal): Promise<void> {
    const lifetime = this.lifecycle.signal;
    const active = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    active.throwIfAborted();
    while (this.pendingOperations > 0) await this.withAbort(this.operationTail, active);
  }
}
