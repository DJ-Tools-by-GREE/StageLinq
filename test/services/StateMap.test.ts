import { describe, it, expect } from 'vitest';
import { States } from '../../services/StateMap';
import { StageLinqValue } from '../../types';

describe('StateMap subscription allowlist', () => {
  const DECKS = [1, 2, 3, 4] as const;

  it('asks every deck for the same states', () => {
    const perDeck = DECKS.map((n) => States.filter((s) => s.startsWith(`/Engine/Deck${n}/`)).length);

    expect(perDeck).toEqual([24, 24, 24, 24]);
  });

  it('preserves the fork telemetry used by WebView on every deck', () => {
    const telemetry = [
      'CurrentBPM',
      'Track/CurrentBPM',
      'ExternalMixerVolume',
      'Play',
      'PlayState',
      'PlayStatePath',
      'Speed',
      'SpeedNeutral',
      'SpeedOffsetDown',
      'SpeedOffsetUp',
      'SpeedRange',
      'SpeedState',
      'Track/ArtistName',
      'Track/CurrentKeyIndex',
      'Track/SampleRate',
      'Track/SongLoaded',
      'Track/SongName',
      'Track/TrackData',
      'Track/TrackLength',
      'Track/TrackName',
      'Track/TrackNetworkPath',
    ];

    for (const deck of DECKS) {
      expect(States).toEqual(
        expect.arrayContaining(telemetry.map((name) => `/Engine/Deck${deck}/${name}`))
      );
    }
  });

  it('preserves client, master and mixer subscriptions', () => {
    expect(States).toEqual(expect.arrayContaining([
      StageLinqValue.ClientPreferencesLayerA,
      StageLinqValue.ClientPreferencesPlayer,
      StageLinqValue.ClientPreferencesPlayerJogColorA,
      StageLinqValue.ClientPreferencesPlayerJogColorB,
      StageLinqValue.EngineMasterMasterTempo,
      StageLinqValue.EngineSyncNetworkMasterStatus,
      StageLinqValue.EngineDeck1DeckIsMaster,
      StageLinqValue.EngineDeck2DeckIsMaster,
      StageLinqValue.EngineDeck3DeckIsMaster,
      StageLinqValue.EngineDeck4DeckIsMaster,
      StageLinqValue.MixerChannelAssignment1,
      StageLinqValue.MixerChannelAssignment2,
      StageLinqValue.MixerChannelAssignment3,
      StageLinqValue.MixerChannelAssignment4,
      StageLinqValue.MixerNumberOfChannels,
      StageLinqValue.MixerCH1faderPosition,
      StageLinqValue.MixerCH2faderPosition,
      StageLinqValue.MixerCH3faderPosition,
      StageLinqValue.MixerCH4faderPosition,
      StageLinqValue.MixerCrossfaderPosition,
    ]));
  });

  it('subscribes to the track metadata that has somewhere to go', () => {
    // Each of these lands in a RawTrack field: genre, key, duration and the
    // streaming source. A state we do not ask for is never sent.
    for (const n of DECKS) {
      expect(States).toContain(StageLinqValue[`EngineDeck${n}TrackGenre`]);
      expect(States).toContain(StageLinqValue[`EngineDeck${n}TrackCurrentKey`]);
      expect(States).toContain(StageLinqValue[`EngineDeck${n}TrackTrackLength`]);
      expect(States).toContain(StageLinqValue[`EngineDeck${n}TrackTrackURI`]);
    }
  });

  it('leaves the high-frequency transport states alone', () => {
    // These fire every few milliseconds while a deck plays and tell a
    // now-playing consumer nothing. Subscribing to them would flood the state
    // channel for no gain.
    const noisy = [
      'PlayPosition',
      'TrackPosition',
      'SongPosition',
      'PlayheadPosition',
      'Scratching',
      'SlipModePosition',
      'CurrentLoopInPosition',
      'CurrentLoopOutPosition',
    ];

    for (const state of States) {
      for (const name of noisy) {
        expect(state.endsWith(`/${name}`)).toBe(false);
      }
    }
  });

  it('has no duplicate subscriptions', () => {
    expect(new Set(States).size).toBe(States.length);
  });
});
