# FileTransfer Service

The FileTransfer service enables downloading files from DJ hardware, including Engine databases and album artwork.

## Usage

### Automatic Database Download

```ts
import { StageLinq } from 'stagelinq';

const stagelinq = new StageLinq({
  downloadDbSources: true,  // Auto-download databases
});

stagelinq.devices.on('dbDownloading', (sourceId, dbPath) => {
  console.log(`Downloading database for ${sourceId}...`);
});

stagelinq.devices.on('dbProgress', (sourceId, total, downloaded, percent) => {
  console.log(`${sourceId}: ${percent.toFixed(1)}%`);
});

stagelinq.devices.on('dbDownloaded', (sourceId, dbPath) => {
  console.log(`Database saved to: ${dbPath}`);
});

await stagelinq.connect();
```

### Manual File Download

```ts
stagelinq.devices.on('ready', async (info) => {
  const device = stagelinq.devices.getDevice(info);
  const fileTransfer = await device.connectToService(FileTransfer);

  // Download a specific file
  const data = await fileTransfer.getFile('/Engine Library/m.db');

  // Save to disk
  fs.writeFileSync('m.db', data);
});
```

## Cancellation and resource limits

Existing calls remain compatible. These methods accept an optional final
AbortSignal, except getFile, which accepts it second and a byte limit third:

    getFile(location, signal?, maxBytes = Infinity): Promise<Uint8Array>
    getFileRange(location, offset, length, signal?): Promise<Buffer>
    getFileSize(location, signal?): Promise<number>
    getSources(signal?): Promise<Source[]>
    waitTillAvailable(signal?): Promise<void>

For example, getFile(path, controller.signal, 256 * 1024 * 1024) rejects files
larger than 256 MiB before requesting chunks or allocating their body. The
default remains unlimited for compatibility with database consumers. Range
offset/length values must be nonnegative safe integers. Empty and out-of-range
reads return empty bytes and release the transfer reservation.

Every operation is serialized atomically on the FileTransfer instance, including
full downloads, partial reads, source discovery and file-stat requests. The old
waitTillAvailable method remains available as an observation barrier; callers
do not need it to make getFile/getFileRange mutually exclusive. Progress still
reports percentComplete in the 0–100 range on the FileTransfer instance.

One DOWNLOAD_TIMEOUT deadline covers each active operation, and response waits
also use MESSAGE_TIMEOUT. Success, failure and cancellation remove listeners
and timers; queued cancellation returns promptly without interrupting unrelated
active work. Cancellation during a connection handshake keeps the internal
queue reserved until that bounded TCP attempt settles.

TCP connection establishment has an actual CONNECT_TIMEOUT deadline: the helper
destroys the pending socket and rejects when the deadline expires, and clears
the timer on success or failure. It installs no idle timeout on a successfully
connected service. This also bounds reconnect attempts after transfer cancellation.

Chunk messages do not identify the transfer they belong to. An interrupted or
failed active operation therefore closes its TCP stream and removes its data
listener so late bytes cannot corrupt a later file. The next operation lazily
reconnects the same service at its known address/port and measures its chunk size
again. Explicit disconnect cancels all queued work, closes idempotently and
requires an explicit connect before reuse. It never silently restarts a service
the application deliberately stopped.

Engine OS 5 chunk-size learning, nonzero-offset probing and EOF clamping remain
based on Chris Le's implementation. Synthetic tests cover the lifecycle and
large chunks; live firmware transfer validation remains separate.

## Events

### Database Events

```ts
// New source discovered (USB, SD card, internal)
stagelinq.devices.on('newSource', (source: SourceInfo) => {});

// Database download started
stagelinq.devices.on('dbDownloading', (sourceId: string, dbPath: string) => {});

// Download progress
stagelinq.devices.on('dbProgress', (
  sourceId: string,
  total: number,
  downloaded: number,
  percent: number
) => {});

// Download complete
stagelinq.devices.on('dbDownloaded', (sourceId: string, dbPath: string) => {});
```

### File Transfer Events

```ts
// Raw file message
stagelinq.devices.on('fileMessage', (data: FileTransferData) => {});

// Transfer progress
stagelinq.devices.on('fileTransferProgress', (
  source: string,
  fileName: string,
  txid: number,
  progress: Progress
) => {});

// Transfer complete
stagelinq.devices.on('fileTransferComplete', (
  source: string,
  fileName: string,
  txid: number
) => {});
```

## Database Structure

Downloaded databases are SQLite files containing:

- **Track** - Track metadata (title, artist, BPM, key, etc.)
- **AlbumArt** - Album artwork blobs
- **Playlist** - Playlists and their tracks
- **Crate** - Crates and their tracks
- **History** - Play history

### Querying the Database

```ts
import Database from 'better-sqlite3';

const db = new Database('m.db');

// Get all tracks
const tracks = db.prepare('SELECT * FROM Track').all();

// Search tracks
const results = db.prepare(`
  SELECT * FROM Track
  WHERE title LIKE ? OR artist LIKE ?
`).all('%search%', '%search%');
```

## File Paths

Files are accessed via network paths:

```
/Engine Library/m.db           - Main database
/Engine Library/p.db           - Performance data
/Engine Library/Music/...      - Audio files
```

## Source Names

Common source identifiers:

| Source | Description |
|--------|-------------|
| `(Internal)` | Internal storage |
| `USB 1`, `USB 2` | USB drives |
| `SD Card` | SD card slot |
