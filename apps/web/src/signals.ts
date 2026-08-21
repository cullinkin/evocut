import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Source } from '@evocut/edl';
import {
  MAX_UNINDEXED_AUDIO_BYTES,
  decodeAudio,
  decodeAudioEnvelope,
  describeAudioTrack,
  isAudioDecodeSupported,
  readAudioTrack,
} from '@evocut/renderer';
import {
  SIGNALS_VERSION,
  analyzeAudio,
  analyzeMotion,
  toMono,
  type SourceSignals,
} from '@evocut/signals';
import type { AppStores } from '@evocut/store';
import { loadFilmstrip } from './filmstrip.ts';
import { noteStage } from './recover.ts';

/**
 * Measuring the footage, in the background, once per recording ever.
 *
 * Until this existed the refinement pass could see the *edit* and nothing of what was
 * edited: it knew a clip ran from 4.2s to 9.8s and had no idea whether those five seconds
 * were someone talking, a pause, or an impact. Asked for emphasis on the hits, it could
 * only invent them.
 *
 * ## How the audio is read
 *
 * Through `@evocut/renderer`'s demuxer, not `decodeAudioData`. The first version of this
 * file called `file.arrayBuffer()` and handed the result to the Web Audio decoder, which
 * works on a test clip and fails on everything a phone records: a 27-minute 4K take is
 * 5.2 GB, the allocation does not succeed, and — because the failure was caught and turned
 * into "this source has no audio" — the whole pass reported silence for a recording full
 * of sound. The refinement pass was then asked to find the hits in footage it could not
 * hear, and correctly declined to invent any.
 *
 * So now the audio track is located from the container's index and decoded a slice at a
 * time, at a magnitude-preserving 2 kHz, which is 13 MB for half an hour. Where a
 * container cannot be indexed the old whole-file path is still there for small files, and
 * where neither works the reason is recorded rather than discarded.
 *
 * ## What it costs, and when
 *
 * It runs when a project opens rather than when Refine is tapped, because a person who has
 * just finished their coarse pass should not then watch a progress bar. It is deliberately
 * unhurried and entirely optional: every failure path here ends in "no signals for that
 * source", with a note saying why, and the refinement pass works exactly as it did before,
 * blind.
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
  /** 0..1 through the source currently being measured. */
  progress: number;
}

export interface SignalsReport {
  sourceId: string;
  fromCache: boolean;
  elapsedMs: number;
  onsets: number;
  quiet: number;
  still: number;
  hasAudio: boolean;
  /** How many motion samples the analysis had to work with. */
  motionSamples: number;
  /**
   * What the filmstrip pass managed, or why it managed nothing.
   *
   * Added after a session where motion came back empty and the row said only
   * `motionSamples: 0` — true, useless, and indistinguishable between "the media would not
   * open", "the seeks were too slow" and "this recording is one still frame".
   */
  motionNote: string;
  /** The levels the quiet and hit thresholds are measured against. */
  peakDb: number | null;
  medianDb: number | null;
  /**
   * What was found in the audio, or why nothing was.
   *
   * The single most useful row in the log when the suggestions come back thin. Without it
   * `hasAudio: false` is indistinguishable between "this take is silent", "this browser
   * cannot decode AAC", and "the file was too big to open" — and those want three
   * different fixes.
   */
  audioNote: string;
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
  const [progress, setProgress] = useState(0);
  const reportRef = useRef(onComputed);
  reportRef.current = onComputed;

  const sources = useMemo(
    () => (project?.sources ?? []).filter((source) => mediaUrls.has(source.id)),
    [project?.sources, mediaUrls],
  );

  /**
   * What this pass actually depends on: which recordings, and where their bytes are.
   *
   * The effect used to depend on `project`, which changes on every edit — so on a session
   * with 160 cuts it re-ran 160 times, each one re-reading the whole recording. Signals
   * belong to the *source*, not to the edit; nothing a trim does can change what the
   * footage sounds like. This key says exactly that, and stays identical across every cut.
   */
  const identity = useMemo(
    () => sources.map((source) => `${source.id}:${source.contentHash ?? ''}:${mediaUrls.get(source.id)}`).join('|'),
    [sources, mediaUrls],
  );

  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const urlsRef = useRef(mediaUrls);
  urlsRef.current = mediaUrls;

  useEffect(() => {
    const measuring = sourcesRef.current;
    if (measuring.length === 0) return;

    const controller = new AbortController();
    let live = true;
    setPending(measuring.filter((source) => !memory.has(cacheKey(source))).map((source) => source.id));

    void (async () => {
      for (const source of measuring) {
        if (!live) return;
        const url = urlsRef.current.get(source.id);
        if (!url) continue;

        const started = Date.now();
        setProgress(0);
        // Named before it starts, so a tab that does not come back says which pass it was
        // in. See `recover.ts`.
        noteStage('measure:audio');
        const cached = await read(stores, source);
        const computed: Measurement = cached
          ? { signals: cached, audioNote: 'cached', motionNote: 'cached' }
          : await measure(stores, source, url, controller.signal, (fraction) => {
              if (live) setProgress(fraction);
            });
        if (!live) return;

        setPending((previous) => previous.filter((id) => id !== source.id));
        if (!computed.signals) {
          // Still reported. A source that could not be measured at all is the single most
          // important thing to know when reading back a session, and it is exactly the
          // case the old code logged nothing for.
          reportRef.current?.({
            sourceId: source.id,
            fromCache: false,
            elapsedMs: Date.now() - started,
            onsets: 0,
            quiet: 0,
            still: 0,
            hasAudio: false,
            motionSamples: 0,
            motionNote: computed.motionNote,
            peakDb: null,
            medianDb: null,
            audioNote: computed.audioNote,
          });
          continue;
        }

        memory.set(cacheKey(source), computed.signals);
        setSignals((previous) => new Map(previous).set(source.id, computed.signals!));

        if (!cached) await write(stores, source, computed.signals);
        reportRef.current?.({
          sourceId: source.id,
          fromCache: Boolean(cached),
          elapsedMs: Date.now() - started,
          onsets: computed.signals.audio?.onsets.length ?? 0,
          quiet: computed.signals.audio?.quiet.length ?? 0,
          still: computed.signals.motion?.still.length ?? 0,
          hasAudio: computed.signals.audio !== null,
          motionSamples: computed.signals.motion?.motion.length ?? 0,
          motionNote: computed.motionNote,
          // The two numbers every threshold downstream is relative to. Without them a row
          // reporting no quiet spans could mean silence was never found or that the
          // recording genuinely has no floor, and those want different fixes.
          peakDb: round(computed.signals.audio?.peakDb),
          medianDb: round(computed.signals.audio?.medianDb),
          audioNote: computed.audioNote,
        });
      }
      if (live) setProgress(1);
    })();

    return () => {
      live = false;
      controller.abort();
    };
  }, [identity, stores]);

  return { signals, pending, progress };
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

function round(value: number | undefined): number | null {
  return typeof value === 'number' ? Number(value.toFixed(1)) : null;
}

interface Measurement {
  signals: SourceSignals | null;
  audioNote: string;
  motionNote: string;
}

async function measure(
  stores: AppStores,
  source: Source,
  url: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Measurement> {
  const [audio, motion] = await Promise.all([
    measureAudio(stores, source, signal, onProgress),
    measureMotion(source, url),
  ]);

  if (!audio.signals && !motion.signals) {
    return { signals: null, audioNote: audio.note, motionNote: motion.note };
  }
  return {
    signals: {
      version: SIGNALS_VERSION,
      sourceId: source.id,
      ...(source.contentHash ? { contentHash: source.contentHash } : {}),
      durationUs: source.duration,
      audio: audio.signals,
      motion: motion.signals,
      computedAt: new Date().toISOString(),
    },
    audioNote: audio.note,
    motionNote: motion.note,
  };
}

interface AudioMeasurement {
  signals: SourceSignals['audio'];
  note: string;
}

async function measureAudio(
  stores: AppStores,
  source: Source,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<AudioMeasurement> {
  if (source.locator.kind !== 'opfs') return { signals: null, note: 'media is not stored on this device' };

  try {
    const file = await stores.media.get(source.locator.path);
    if (!file) return { signals: null, note: 'media is missing from storage' };

    const track = isAudioDecodeSupported() ? await readAudioTrack(file) : null;
    if (track) {
      const envelope = await decodeAudioEnvelope(file, track, { signal, onProgress });
      if (!envelope) return { signals: null, note: `indexed ${track.codec}, but this browser would not decode it` };
      return {
        signals: analyzeAudio(envelope.samples, envelope.sampleRate),
        note: describeAudioTrack(track),
      };
    }

    // Not a container this can index. The whole-file decoder is still correct, and still
    // the only option for WebM — it just cannot be pointed at a recording of any size.
    if (file.size > MAX_UNINDEXED_AUDIO_BYTES) {
      return {
        signals: null,
        note: `container has no readable index and the file is ${Math.round(file.size / 1_048_576)}MB — too large to decode whole`,
      };
    }

    const buffer = await decodeAudio(await file.arrayBuffer());
    if (!buffer) return { signals: null, note: 'this browser could not decode the audio' };

    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    return {
      signals: analyzeAudio(toMono(channels), buffer.sampleRate),
      note: `decoded whole, ${buffer.numberOfChannels}ch ${buffer.sampleRate}Hz`,
    };
  } catch (cause) {
    // Named, not swallowed. The version of this that returned a bare null is what made a
    // 5.2 GB recording look like a silent one for a whole session.
    return { signals: null, note: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function measureMotion(
  source: Source,
  url: string,
): Promise<{ signals: SourceSignals['motion']; note: string }> {
  try {
    const strip = await loadFilmstrip(source.id, url, source.duration);
    const usable = strip.luma.filter((sample) => sample.luma.length > 0);
    if (usable.length < 2) {
      return {
        signals: null,
        note: `filmstrip returned ${strip.frames.length} frames and ${usable.length} usable samples`,
      };
    }
    const spacing = (usable.at(-1)!.t - usable[0]!.t) / Math.max(1, usable.length - 1) / 1_000_000;
    return {
      signals: analyzeMotion(usable),
      note: `${usable.length} samples, one every ${spacing.toFixed(1)}s`,
    };
  } catch (cause) {
    return { signals: null, note: cause instanceof Error ? cause.message : String(cause) };
  }
}
