import { useEffect, useRef, useState } from 'react';
import type { Project } from '@evocut/edl';
import { canDecode, readVideoTrack, videoWeights } from '@evocut/renderer';
import { analyzePicture, type PictureSignals } from '@evocut/signals';
import type { AppStores } from '@evocut/store';
import { proxyPathFor } from './proxy.ts';
import { whenQuiet } from './quiet.ts';

/**
 * What each recording's own index says about it.
 *
 * ## One read, two answers
 *
 * The container's frame table answers two separate questions the editor has, and the point
 * of this file is that it answers them from a single read.
 *
 * - **How much the picture moves, frame by frame.** The encoded size of each frame is a
 *   description of what changed since the last one, which is a motion signal for nothing:
 *   see `analyzePicture`, and `waveform.ts` for the line it draws.
 * - **Whether a proxy can be made the fast way**, by feeding the frames to a decoder
 *   instead of playing them — the difference between five minutes and half an hour, and
 *   the number the offer has to be honest about.
 *
 * A version of this asked each question separately, which meant reading and expanding the
 * same fifty-thousand-frame table two and three times over within a few seconds of opening
 * a project. That build had to come back off a phone. So: one read, both answers, and the
 * table itself is let go the moment they are derived.
 *
 * ## Not cached, deliberately
 *
 * It costs about fifty milliseconds for half an hour of 4K. Caching it would mean a version
 * key, and a version key means that changing the shape of this invalidates the *audio*
 * analysis too and forces a re-measure of the whole recording — which is the exact sequence
 * that killed a tab here. Nothing this cheap should be able to invalidate anything.
 */
export interface FootageIndex {
  /** Per-frame movement, or null where the container could not be read. */
  picture: PictureSignals | null;
  /** How a proxy of this recording would be made. */
  strategy: 'decoder' | 'playback';
}

export function useFootageIndex(
  stores: AppStores,
  project: Project | null,
  enabled: boolean,
  /**
   * Sources with a finished proxy, whose index is read in preference to the recording's.
   *
   * Not only a fallback for containers that cannot be read — though it is that, and it is
   * how a WebM ends up with a motion line at all. It is the better measurement: the proxy
   * is constant frame rate with a keyframe every second, written by one encoder at one
   * setting, where a phone's own recording drops frames and changes its mind about bitrate.
   */
  proxied: Set<string>,
): Map<string, FootageIndex> {
  const [index, setIndex] = useState<Map<string, FootageIndex>>(new Map());
  const heldRef = useRef(new Map<string, FootageIndex>());
  const fromRef = useRef(new Map<string, string>());

  const sources = project?.sources ?? [];
  const identity = enabled
    ? sources.map((source) => `${source.id}:${proxied.has(source.id) ? 'p' : 's'}`).join('|')
    : '';

  useEffect(() => {
    if (!enabled) {
      heldRef.current = new Map();
      fromRef.current = new Map();
      setIndex(new Map());
      return;
    }

    let live = true;
    void (async () => {
      for (const source of sources) {
        if (!live) return;
        if (source.locator.kind !== 'opfs') continue;

        const path = proxied.has(source.id) ? proxyPathFor(source) ?? source.locator.path : source.locator.path;
        // Read again when a proxy lands, because its index is the better of the two.
        if (fromRef.current.get(source.id) === path) continue;

        // A few hundred kilobytes off local storage is still a read, and background reads
        // wait for the person to stop moving. See `quiet.ts`.
        await whenQuiet();
        if (!live) return;

        try {
          const file = await stores.media.get(path);
          if (!file) continue;

          const track = await readVideoTrack(file);
          if (!track || !live) continue;

          const weights = videoWeights(track);
          const entry: FootageIndex = {
            picture: weights ? analyzePicture(weights) : null,
            strategy: (await canDecode(track)) ? 'decoder' : 'playback',
          };
          if (!live) return;

          heldRef.current.set(source.id, entry);
          fromRef.current.set(source.id, path);
          setIndex(new Map(heldRef.current));
        } catch {
          // A container this cannot read is the ordinary case for WebM: no motion line, and
          // a proxy made the slow way. Neither is an error worth surfacing.
        }
      }
    })();

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, enabled, stores]);

  return index;
}
