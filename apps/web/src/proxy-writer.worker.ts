/// <reference lib="webworker" />

/**
 * Writing the proxy, in a worker, with no swap file.
 *
 * ## Why this exists
 *
 * `createWritable()` — the ordinary way to write into the origin-private file system — does
 * not write into the file. It writes into a *swap* alongside it and commits the whole thing
 * on `close()`. For a two-hundred-megabyte proxy on a phone that means the space is needed
 * twice, the commit is a single all-or-nothing operation at the very end, and every write is
 * an async round trip.
 *
 * Three separate runs of a quarter of an hour each ended at that commit with "The I/O read
 * operation failed" — a message about the swap, arriving after every frame had already been
 * encoded. There is nothing to retry: the file was never really being written.
 *
 * A sync access handle writes into the file itself, in place. No swap, no doubling, no
 * commit to fail, and the writes are synchronous — which is also why this has to be a
 * worker, because that is the only place the platform allows them.
 *
 * ## The contract
 *
 * One file per worker, opened once. Every message is acknowledged by id so the main thread
 * can wait for backpressure rather than queueing a proxy's worth of buffers.
 */

interface SyncHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type WriteRequest =
  | { id: number; kind: 'open'; path: string }
  | { id: number; kind: 'write'; bytes: ArrayBuffer }
  | { id: number; kind: 'patch'; position: number; bytes: ArrayBuffer }
  | { id: number; kind: 'close' }
  | { id: number; kind: 'abort'; path: string };

let handle: SyncHandle | null = null;
let at = 0;

async function open(path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);

  let directory = await navigator.storage.getDirectory();
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  const file = await directory.getFileHandle(name, { create: true });
  const withHandle = file as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> };
  if (!withHandle.createSyncAccessHandle) throw new Error('No sync access handles here.');

  handle = await withHandle.createSyncAccessHandle();
  // Starting fresh, so anything a previous attempt left is gone rather than underneath.
  handle.truncate(0);
  at = 0;
}

async function remove(path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  let directory = await navigator.storage.getDirectory();
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
  await directory.removeEntry(name);
}

self.onmessage = async (event: MessageEvent<WriteRequest>) => {
  const message = event.data;
  try {
    switch (message.kind) {
      case 'open':
        await open(message.path);
        break;
      case 'write': {
        if (!handle) throw new Error('Nothing is open to write to.');
        const bytes = new Uint8Array(message.bytes);
        handle.write(bytes, { at });
        at += bytes.byteLength;
        break;
      }
      case 'patch': {
        if (!handle) throw new Error('Nothing is open to write to.');
        handle.write(new Uint8Array(message.bytes), { at: message.position });
        break;
      }
      case 'close':
        handle?.flush();
        handle?.close();
        handle = null;
        break;
      case 'abort':
        try {
          handle?.close();
        } finally {
          handle = null;
          // A half-written proxy is unplayable — it is indexed at the end — so it goes
          // rather than sitting there looking like a file.
          await remove(message.path).catch(() => {});
        }
        break;
    }
    self.postMessage({ id: message.id, ok: true, at });
  } catch (cause) {
    self.postMessage({ id: message.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
