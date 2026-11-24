import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services', () => ({
  BeatInfo: class {},
  FileTransfer: class {},
  StateMap: class {},
}));

vi.mock('../../Databases', () => ({
  Databases: class {},
}));

const connectMock = vi.fn();
const connectToServiceMock = vi.fn();
const networkDevices: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];

vi.mock('../../network', () => ({
  NetworkDevice: class {
    connect = connectMock;
    connectToService = connectToServiceMock;
    disconnect = vi.fn();

    constructor() {
      networkDevices.push(this);
    }
  },
}));

import { StageLinqDevices } from '../../network/StageLinqDevices';
import { BeatInfo, StateMap } from '../../services';
import type { ConnectionInfo } from '../../types';

const connectionInfo: ConnectionInfo = {
  address: '192.168.1.20',
  port: 51337,
  source: 'prime4plus',
  action: 'DISCOVERER_HOWDY_',
  software: { name: 'JC11', version: '5.0.4' },
  token: new Uint8Array(16),
};

describe('StageLinqDevices lifecycle', () => {
  let devices: StageLinqDevices;
  let stateMap: EventEmitter;
  let beatInfo: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    connectMock.mockReset().mockResolvedValue(undefined);
    connectToServiceMock.mockReset();
    networkDevices.length = 0;
    stateMap = new EventEmitter();
    beatInfo = new EventEmitter();
    connectToServiceMock.mockImplementation(async (service) => {
      return service === StateMap ? stateMap : beatInfo;
    });
    devices = new StageLinqDevices({
      maxRetries: 999,
      enableFileTranfer: false,
      downloadDbSources: false,
    });
  });

  afterEach(() => {
    devices.disconnectAll();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cancels a pending retry immediately on disconnect', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const connecting = (devices as any).connectToDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(0);
    expect(connectMock).toHaveBeenCalledTimes(1);

    devices.disconnectAll();
    await connecting;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight connection that completes after disconnect', async () => {
    let finishConnection: () => void = () => {};
    connectMock.mockReturnValue(new Promise<void>((resolve) => {
      finishConnection = resolve;
    }));
    const connected = vi.fn();
    devices.on('connected', connected);
    const connecting = (devices as any).connectToDevice(connectionInfo);

    devices.disconnectAll();
    finishConnection();
    await connecting;

    expect(connected).not.toHaveBeenCalled();
    expect(connectToServiceMock).not.toHaveBeenCalled();
    expect(networkDevices[0].disconnect).toHaveBeenCalled();
    expect((devices as any).stateMapCallback).toHaveLength(0);
  });

  it('discards FileTransfer setup that completes after disconnect', async () => {
    devices.disconnectAll();
    devices = new StageLinqDevices({
      maxRetries: 999,
      enableFileTranfer: true,
      downloadDbSources: false,
    });
    let finishService: (service: EventEmitter) => void = () => {};
    connectToServiceMock.mockReturnValue(new Promise<EventEmitter>((resolve) => {
      finishService = resolve;
    }));
    const connected = vi.fn();
    devices.on('connected', connected);
    const connecting = (devices as any).connectToDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(0);

    devices.disconnectAll();
    finishService(new EventEmitter());
    await connecting;

    expect(connected).not.toHaveBeenCalled();
    expect(devices.getFileTransferService('net://00000000-0000-0000-0000-000000000000')).toBeNull();
    expect((devices as any).stateMapCallback).toHaveLength(0);
  });

  it('keeps an old connection cancelled after a new session starts', async () => {
    let finishOldConnection: () => void = () => {};
    connectMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishOldConnection = resolve;
    }));
    const connected = vi.fn();
    devices.on('connected', connected);
    const oldConnection = (devices as any).connectToDevice(connectionInfo);
    devices.disconnectAll();

    await devices.handleDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(0);
    finishOldConnection();
    await oldConnection;

    expect(connected).toHaveBeenCalledTimes(1);
    expect((devices as any).stateMapCallback).toHaveLength(1);
    expect(networkDevices[1].disconnect).not.toHaveBeenCalled();
  });

  it('rediscovers after disconnect and forwards each beat exactly once', async () => {
    const beat = { clock: 1n, deckCount: 1, decks: [{ beat: 1, totalBeats: 64, bpm: 120, samples: 48000 }] };
    const onBeat = vi.fn();
    const onMessage = vi.fn();
    const onState = vi.fn();
    devices.on('beatMessage', onBeat);
    devices.on('message', onMessage);
    devices.on('stateChanged', onState);
    await devices.handleDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectToServiceMock.mock.calls.filter(([service]) => service === BeatInfo)).toHaveLength(1);
    beatInfo.emit('beatMessage', beat);
    expect(onBeat).toHaveBeenCalledExactlyOnceWith(connectionInfo, beat);

    // Leave a Player update queued while shutting down the first session.
    stateMap.emit('message', { message: { name: '/Engine/Deck1/Track/SongName', json: { string: 'Old track' } } });
    onMessage.mockClear();
    devices.disconnectAll();
    beatInfo.emit('beatMessage', beat);
    stateMap.emit('message', { message: { name: '/Engine/Deck1/Play', json: { state: true } } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onBeat).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();

    stateMap = new EventEmitter();
    beatInfo = new EventEmitter();
    await devices.handleDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(3000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    beatInfo.emit('beatMessage', beat);
    expect(onBeat).toHaveBeenCalledTimes(2);
  });

  it('ignores StateMap setup that completes after disconnect', async () => {
    let finishStateMap: (service: EventEmitter) => void = () => {};
    connectToServiceMock.mockReturnValue(new Promise<EventEmitter>((resolve) => {
      finishStateMap = resolve;
    }));
    await devices.handleDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(3000);
    devices.disconnectAll();
    finishStateMap(stateMap);
    await vi.advanceTimersByTimeAsync(0);

    expect(stateMap.listenerCount('message')).toBe(0);
    expect(connectToServiceMock).toHaveBeenCalledTimes(1);
  });

  it('keeps StateMap events working when BeatInfo is unavailable', async () => {
    connectToServiceMock.mockImplementation(async (service) => {
      if (service === BeatInfo) throw new Error('BeatInfo unavailable');
      return stateMap;
    });
    const onMessage = vi.fn();
    devices.on('message', onMessage);
    await devices.handleDevice(connectionInfo);
    await vi.advanceTimersByTimeAsync(3000);
    const message = { message: { name: '/Engine/Deck1/Play', json: { state: true } } };
    stateMap.emit('message', message);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(connectionInfo, message);
  });
});
