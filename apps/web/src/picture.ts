import { useEffect, useRef, useState } from 'react';
import type { Project } from '@evocut/edl';
import { readVideoWeights } from '@evocut/renderer';
import { analyzePicture, type PictureSignals } from '@evocut/signals';
import type { AppStores } from '@evocut/store';
import { proxyPathFor } from './proxy.ts';
import { whenQuiet } from './quiet.ts';

/**
 * What the picture is doing, per frame, for every recording in the project.
 *
 * ## Why it is not part of the signals pass
 *
 * Because it is not expensive, and everything about that pass is built around work that is.
 * Measured against a real recording's index — forty-eight thousand frames, half an hour of
 * 4K — this takes **fifty-six milliseconds** and eight megabytes, and produces about two
 * hundred kilobytes of numbers.
 *
 * Nothing that cheap should be cached, and caching it would cost more than it saves: the
 * signals cache is keyed by a version, so adding a field to it invalidates every stored
 * result and forces a full re-measure of the audio — decoding half an hour of AAC on a
 * phone, while three decoders are live. That is precisely the work that killed a tab here,
 * and it was triggered by a version bump made for exactly this reason. So this is computed
 * on open, every time, and belongs to nothing.
 *
 * ## Where it comes from
 *
 * `readVideoWeights` — the encoded size of every frame, out of the container's own index.
 * An inter-coded frame is a description of what changed since the last one, so its length
 * is a measure of how much moved. See `analyzePicture` for what is done with it, and
 * `waveform.ts` for how it is drawn.
 */
export function useSourcePictures(
  stores: AppStores,
  project: Project | null,
  enabled: boolean,
  /**
   * Sources with a proxy, whose index is read in preference to the recording's.
   *
   * Not a fallback for unreadable containers — though it is that too, and it is how a WebM
   * ends up with a motion line at all. It is the better measurement: the proxy is constant
   * frame rate with a keyframe every second, written by one encoder at one setting, where a
   * phone's own recording drops frames and changes its mind about bitrate.
   */
  proxied: Set<string>,
): Map<string, PictureSignals> {
  const [pictures, setPictures] = useState<Map<string, PictureSignals>>(new Map());
  const heldRef = useRef(new Map<string, PictureSignals>());
  const fromRef = useRef(new Map<string, string>());

  const sources = project?.sources ?? [];
  const identity = enabled
    ? sources.map((source) => `${source.id}:${proxied.has(source.id) ? 'p' : 's'}`).join('|')
    : '';

  useEffect(() => {
    if (!enabled) {
      setPictures(new Map());
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

        // The index is a few hundred kilobytes off local storage, but it is still a read,
        // and the whole point of this project's last few days is that background reads
        // wait for the person to stop moving.
        await whenQuiet();
        if (!live) return;

        try {
          const file = await stores.media.get(path);
          if (!file) continue;
          const weights = await readVideoWeights(file);
          const picture = weights ? analyzePicture(weights) : null;
          if (!picture || !live) continue;
          heldRef.current.set(source.id, picture);
          fromRef.current.set(source.id, path);
          setPictures(new Map(heldRef.current));
        } catch {
          // A container this cannot read is the ordinary case for WebM, and the lane simply
          // does without a motion line. Nothing else depends on it.
        }
      }
    })();

    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, enabled, stores]);

  return pictures;
}
