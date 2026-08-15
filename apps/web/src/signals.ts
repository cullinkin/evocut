import { useEffect, useRef, useState } from 'react';
import type { Project, Source } from '@evocut/edl';
import { decodeAudio } from '@evocut/renderer';
import {
  SIGNALS_VERSION,
  analyzeAudio,
  analyzeMotion,
  toMono,
  type LumaFrame,
  type SourceSignals,
} from '@evocut/signals';
import type { AppStores } from '@evocut/store';
import { loadFilmstrip } from './filmstrip.ts';

/**
 * Measuring the footage, in the background, once per recording ever.
 *
 * Until this existed the refinement pass could see the *edit* and nothing of what was
 * edited: it knew a clip ran from 4.2s to 9.8s and had no idea whether those five seconds
 * were someone talking, a pause, or an impact. Asked for emphasis on the hits, it could
 * only invent them.
 *
 * ## What it costs, and when
 *
 * Two passes, both already half-paid for. Audio comes from decoding the source once with
 * the same decoder the export uses. Motion comes from the filmstrip extraction the
 * timeline is running anyway — this waits on that pass rather than seeking through the
 * recording a second time, which is the difference between a few seconds and a few minutes
 * on a phone.
 *
 * It runs when a project opens rather than when Refine is tapped, because a person who has
 * just finished their coarse pass should not then watch a progress bar. It is deliberately
 * unhurried and entirely optional: every failure path here ends in "no signals for that
 * source", and the refinement pass works exactly as it did before, blind.
 *
 * ## Cached by content, not by project
 *
 * The key is the media fingerprint plus the analysis version. Reimporting the same
 * recording reuses the work; changing how the analysis works invalidates it rather than
 * quietly serving numbers computed by different code.
 */
export interface SignalsState {
  signals: Map<string, SourceSignals>;
  /** Sources still being measured. Empty means everything that can be known is known. */
  pending: string[];
}

export interface SignalsReport {
  sourceId: string;
  fromCache: boolean;
  elapsedMs: number;
  onsets: number;
  quiet: number;
  still: number;
  hasAudio: boolean;
}

const memory = new Map<string, SourceSignals>();

export function useSourceSignals(
  stores: AppStores,
  project: Project | null,
  mediaUrls: Map<string, string>,
  onComputed?: (report: SignalsReport) => void,
): SignalsState {
  const [signals, setSignals] = useState<Map<string, SourceSignals>>(new Map());
  const [pending, setPending] = useState<string[]>([]);
  const reportRef = useRef(onComputed);
  reportRef.current = onComputed;

  useEffect(() => {
    if (!project) return;
    const sources = project.sources.filter((source) => mediaUrls.has(source.id));
    if (sources.length === 0) return;

    let live = true;
    setPending(sources.filter((source) => !memory.has(cacheKey(source))).map((source) => source.id));

    void (async () => {
      for (const source of sources) {
        if (!live) return;
        const url = mediaUrls.get(source.id);
        if (!url) continue;

        const started = Date.now();
        const cached = await read(stores, source);
        const computed = cached ?? (await measure(stores, source, url));
        if (!live) return;

        setPending((previous) => previous.filter((id) => id !== source.id));
        if (!computed) continue;

        memory.set(cacheKey(source), computed);
        setSignals((previous) => new Map(previous).set(source.id, computed));

        if (!cached) await write(stores, source, computed);
        reportRef.current?.({
          sourceId: source.id,
          fromCache: Boolean(cached),
          elapsedMs: Date.now() - started,
          onsets: computed.audio?.onsets.length ?? 0,
          quiet: computed.audio?.quiet.length ?? 0,
          still: computed.motion?.still.length ?? 0,
          hasAudio: computed.audio !== null,
        });
      }
    })();

    return () => {
      live = false;
    };
    // `mediaUrls` is a fresh Map per bind, not per render, so this runs on open and on
    // relink — which is exactly when the media it measures can have changed.
  }, [project, mediaUrls, stores]);

  return { signals, pending };
}

function cacheKey(source: Source): string {
  return `signals:${source.contentHash ?? source.id}:${SIGNALS_VERSION}`;
}

async function read(stores: AppStores, source: Source): Promise<SourceSignals | null> {
  const held = memory.get(cacheKey(source));
  if (held) return held;

  try {
    const stored = await stores.derived.get<SourceSignals>(cacheKey(source));
    // A stored result from an older analysis is not a result; the key carries the version
    // so this only ever fires for something written by hand or by a partial upgrade.
    return stored?.version === SIGNALS_VERSION ? stored : null;
  } catch {
    return null;
  }
}

async function write(stores: AppStores, source: Source, signals: SourceSignals): Promise<void> {
  // Storage being full, or refused, costs a recomputation next time and nothing else.
  await stores.derived.put(cacheKey(source), signals).catch(() => {});
}

async function measure(stores: AppStores, source: Source, url: string): Promise<SourceSignals | null> {
  const [audio, motion] = await Promise.all([
    measureAudio(stores, source),
    measureMotion(source, url),
  ]);

  if (!audio && !motion) return null;
  return {
    version: SIGNALS_VERSION,
    sourceId: source.id,
    ...(source.contentHash ? { contentHash: source.contentHash } : {}),
    durationUs: source.duration,
    audio,
    motion,
    computedAt: new Date().toISOString(),
  };
}

async function measureAudio(stores: AppStores, source: Source): Promise<SourceSignals['audio']> {
  if (source.locator.kind !== 'opfs') return null;
  try {
    const file = await stores.media.get(source.locator.path);
    if (!file) return null;

    const buffer = await decodeAudio(await file.arrayBuffer());
    if (!buffer) return null;

    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    return analyzeAudio(toMono(channels), buffer.sampleRate);
  } catch {
    // A recording with no audio track, or a codec this browser will play but not hand
    // back as samples. Both are ordinary; neither is worth an error on screen.
    return null;
  }
}

async function measureMotion(source: Source, url: string): Promise<SourceSignals['motion']> {
  try {
    const strip = await loadFilmstrip(source.id, url, source.duration);
    const frames: LumaFrame[] = strip.frames
      .filter((frame) => frame.luma.length > 0)
      .map((frame) => ({ t: frame.t, width: frame.lumaWidth, height: frame.lumaHeight, luma: frame.luma }));
    return analyzeMotion(frames);
  } catch {
    return null;
  }
}
