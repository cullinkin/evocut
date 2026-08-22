import type { MediaSink } from '@evocut/store';

/**
 * Somewhere to put a proxy that does not need the space twice.
 *
 * The ordinary route — `createWritable()` — writes into a swap file beside the target and
 * commits the whole thing at `close()`. Three quarter-hour runs died at exactly that commit
 * with "The I/O read operation failed", after every frame had already been encoded, and
 * there is nothing to retry because the file was never really being written.
 *
 * A sync access handle writes into the file in place: no swap, no doubled space, no commit,
 * and no async round trip per block. It only exists inside a worker, which is what
 * `proxy-writer.worker.ts` is for.
 *
 * Null when the platform will not do it, and then the caller falls back to the writable —
 * slower and more fragile, but it is what a browser without sync handles has.
 */
export async function openProxySink(path: string): Promise<MediaSink | null> {
  if (typeof Worker === 'undefined') return null;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./proxy-writer.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }

  let nextId = 1;
  const waiting = new Map<number, { resolve: (at: number) => void; reject: (error: Error) => void }>();

  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; at?: number; error?: string }>) => {
    const held = waiting.get(event.data.id);
    if (!held) return;
    waiting.delete(event.data.id);
    if (event.data.ok) held.resolve(event.data.at ?? 0);
    else held.reject(new Error(event.data.error ?? 'The proxy writer failed.'));
  };
  worker.onerror = () => {
    for (const held of waiting.values()) held.reject(new Error('The proxy writer stopped.'));
    waiting.clear();
  };

  const ask = (message: Record<string, unknown>, transfer: Transferable[] = []): Promise<number> => {
    const id = nextId++;
    return new Promise<number>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  };

  try {
    await ask({ kind: 'open', path });
  } catch {
    worker.terminate();
    return null;
  }

  let at = 0;

  /*
    Failures say what was happening and how far in.

    "The I/O read operation failed" on its own cost three rounds of guessing: it could have
    been the recording, the proxy, a block, or the commit, and the message is the same for
    all four. Whatever this platform says next comes with the operation and the position
    attached to it.
  */
  const named = async (what: string, work: Promise<number>): Promise<number> => {
    try {
      return await work;
    } catch (cause) {
      const where = `${Math.round(at / 1_048_576)}MB`;
      throw new Error(`${what} the proxy at ${where}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  return {
    async write(bytes) {
      // Transferred rather than copied: the caller has already assembled the block and has
      // no use for it afterwards, and a proxy is hundreds of megabytes of these.
      const copy = bytes.slice();
      at = await named('Could not write', ask({ kind: 'write', bytes: copy.buffer }, [copy.buffer]));
    },
    async patch(position, bytes) {
      const copy = bytes.slice();
      await named('Could not correct', ask({ kind: 'patch', position, bytes: copy.buffer }, [copy.buffer]));
    },
    async close() {
      try {
        await named('Could not finish', ask({ kind: 'close' }));
        return at;
      } finally {
        worker.terminate();
      }
    },
    async abort() {
      try {
        await ask({ kind: 'abort', path }).catch(() => {});
      } finally {
        worker.terminate();
      }
    },
  };
}
