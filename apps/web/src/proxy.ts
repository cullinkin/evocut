import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Source } from '@evocut/edl';
import { PROXY_MAX_DIMENSION, isProxySupported, renderProxy, type ProxyProgress } from '@evocut/renderer';
import { proxyDonePath, proxyPath, type AppStores } from '@evocut/store';
import { noteStage } from './recover.ts';

/**
 * The small copy of each recording, and the making of it.
 *
 * ## Why
 *
 * Everything the editor does to the picture it does by seeking a `<video>` element, and
 * against a 4K recording on a phone one seek is most of a second. That is the whole of the
 * lag — not the painting, not the React, not the pacing — because the cost is in the
 * decode, and a decode of a 4K HEVC frame is what it is.
 *
 * Asked for in as many words: "it seems a little silly that we're trying to work directly
 * on the high resolution and huge raw source video." It is. So: transcode once to
 * something a phone can seek instantly, edit against that, export from the original.
 *
 * ## Once, and only when asked
 *
 * Not automatic. It takes about as long as the recording — twenty-seven minutes of footage
 * is twenty-seven minutes — and starting that unbidden on a phone, in the background, is
 * both rude and the exact shape of the work that has got a tab killed here before. The
 * editor offers; the person decides; the result is kept forever after.
 */
export interface ProxyJob extends ProxyProgress {
  sourceId: string;
}

export interface Proxies {
  /** Whether this browser can make one at all. */
  supported: boolean;
  /** Sources that already have a proxy on disk. */
  ready: Set<string>;
  /** The one being made, if any. */
  job: ProxyJob | null;
  error: string | null;
  make(sourceId: string): void;
  cancel(): void;
}

/** A stored source's proxy path, or null for media that is not ours to copy. */
export function proxyPathFor(source: Source): string | null {
  return pathsFor(source)?.proxy ?? null;
}

function pathsFor(source: Source): { proxy: string; done: string } | null {
  if (source.locator.kind !== 'opfs') return null;
  const fingerprint = source.locator.path.split('/').filter(Boolean).at(-1);
  return fingerprint ? { proxy: proxyPath(fingerprint), done: proxyDonePath(fingerprint) } : null;
}

/**
 * The proxy to play for a source, or null.
 *
 * Null both for "there isn't one" and for "there is half of one" — and the second is the
 * case worth having a function for. A proxy is written as it encodes and indexed at the
 * end, so a tab killed part way through leaves a file that exists and cannot be played.
 * Without this check the editor would point at it and show black for the rest of time.
 */
export async function finishedProxy(source: Source, media: AppStores['media']): Promise<string | null> {
  const paths = pathsFor(source);
  if (!paths) return null;
  return (await media.has(paths.done).catch(() => false)) ? paths.proxy : null;
}

/** Write the marker that says this proxy is whole. */
async function markFinished(stores: AppStores, donePath: string): Promise<void> {
  const marker = await stores.media.openWrite(donePath);
  if (!marker) return;
  await marker.write(new Uint8Array([1]));
  await marker.close();
}

export function useProxies(
  stores: AppStores,
  project: Project | null,
  /** URLs of the *originals*. A proxy is made from the recording, never from another proxy. */
  sourceUrls: Map<string, string>,
  onDone: (report: Record<string, unknown>) => void,
): Proxies {
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<ProxyJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlsRef = useRef(sourceUrls);
  urlsRef.current = sourceUrls;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const sources = project?.sources ?? [];
  const identity = sources.map((source) => source.id).join('|');

  // What is already on disk. Cheap — a directory lookup per source — and it has to run on
  // open, because a proxy made in a previous session is the whole point of making one.
  useEffect(() => {
    let live = true;
    void (async () => {
      const found = new Set<string>();
      for (const source of sources) {
        // Named here rather than before the loop: with no project yet there is nothing to
        // look for, and stamping a stage for work that is not happening overwrites the
        // breadcrumb of the open that actually died.
        noteStage('measure:proxies');
        const path = proxyPathFor(source);
        if (path && (await stores.media.has(path).catch(() => false))) found.add(source.id);
      }
      if (live) setReady(found);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, stores]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const make = useCallback(
    (sourceId: string) => {
      const source = project?.sources.find((candidate) => candidate.id === sourceId);
      const paths = source ? pathsFor(source) : null;
      const path = paths?.proxy ?? null;
      const url = urlsRef.current.get(sourceId);
      if (!source || !path || !url || abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setJob({ sourceId, stage: 'preparing', progress: 0, framesEncoded: 0, byteLength: 0 });

      void (async () => {
        const started = Date.now();
        noteStage('proxy');
        let sink: Awaited<ReturnType<typeof stores.media.openWrite>> = null;
        try {
          if (source.locator.kind !== 'opfs') throw new Error('That recording is not stored on this device.');
          const file = await stores.media.get(source.locator.path);
          if (!file) throw new Error('That recording is missing from storage.');

          sink = await stores.media.openWrite(path);
          if (!sink) throw new Error('This browser cannot write a proxy without holding it in memory.');

          const result = await renderProxy(
            { file, url, sink, maxDimension: PROXY_MAX_DIMENSION, signal: controller.signal },
            (progress) => {
              if (!controller.signal.aborted) setJob({ sourceId, ...progress });
            },
          );
          const bytes = await sink.close();
          sink = null;
          if (paths) await markFinished(stores, paths.done);

          setReady((previous) => new Set(previous).add(sourceId));
          doneRef.current({
            sourceId,
            elapsedMs: Date.now() - started,
            width: result.width,
            height: result.height,
            framesEncoded: result.framesEncoded,
            bytes,
            videoCodec: result.videoCodec,
            audio: result.audio,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          });
        } catch (cause) {
          await sink?.abort().catch(() => {});
          const message = cause instanceof Error ? cause.message : String(cause);
          // A cancel is not a failure, and saying so would be the app arguing with the
          // person who pressed the button.
          if (!controller.signal.aborted) setError(message);
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
          setJob(null);
        }
      })();
    },
    [project, stores],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  return { supported: isProxySupported(), ready, job, error, make, cancel };
}
