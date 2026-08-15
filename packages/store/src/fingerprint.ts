import type { MediaFingerprint } from './types.js';

/** Bytes sampled from each end of the file. */
const SAMPLE_BYTES = 64 * 1024;

/**
 * Cheap identity for a picked file.
 *
 * **This is a fingerprint, not a content hash.** It reads the size and the first and last
 * 64KB, and does not look at anything in between. Two files that share both ends and a
 * byte count will collide.
 *
 * That trade is deliberate. The alternative is hashing the whole file, and a phone
 * importing a two-minute 4K recording would spend seconds reading 500MB before the editor
 * opened — WebCrypto has no streaming digest, so a real hash also means holding the entire
 * file in memory at once. The job here is only to notice that the user picked the same
 * recording twice, and for that, both ends plus the length is plenty: container headers
 * and the final frames differ between any two real recordings.
 *
 * It is deliberately *not* keyed on filename or mtime, so the same footage re-picked from
 * a different folder, or after a copy that reset its timestamps, still dedupes.
 */
export async function fingerprintFile(file: Blob): Promise<MediaFingerprint> {
  const size = file.size;
  const head = new Uint8Array(await file.slice(0, Math.min(SAMPLE_BYTES, size)).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, size - SAMPLE_BYTES), size).arrayBuffer());

  let high = 0x811c9dc5;
  let low = 0x811c9dc5 ^ (size & 0xffffffff);

  for (const chunk of [head, tail]) {
    for (let i = 0; i < chunk.length; i++) {
      high ^= chunk[i]!;
      high = Math.imul(high, 0x01000193) >>> 0;
      low ^= chunk[i]! + i;
      low = Math.imul(low, 0x01000193) >>> 0;
    }
  }

  const sizePart = size.toString(16).padStart(12, '0');
  return `${sizePart}${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/** Where a fingerprinted file lives in the media store. */
export function mediaPath(fingerprint: MediaFingerprint): string {
  return `media/${fingerprint}`;
}
