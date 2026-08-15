import type { MediaRecord } from './types.js';

/**
 * Putting a stored blob back together as a usable `File`.
 *
 * This exists because of a real failure on an iPhone. Media is stored at
 * `media/<fingerprint>` — no extension — and OPFS derives a `File`'s name and MIME type
 * from its path, so `getFileHandle(...).getFile()` hands back a file called
 * `000002eeec…` with `type: ""`. Chromium sniffs the container out of the bytes and plays
 * it anyway; **Safari does not**, and a `<video>` pointed at an untyped blob URL fails with
 * a decode error. The app looked broken on the one platform it was built for while passing
 * every test on the other.
 *
 * So the MIME type has to be carried in the index and reapplied on the way out, rather
 * than inferred from a filename we deliberately threw away.
 */

/** Extension → MIME, for the case where a source arrived without a type. */
const BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export function mimeFromFilename(filename: string): string | undefined {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? BY_EXTENSION[extension] : undefined;
}

/**
 * Rebuild a `File` with the identity the store recorded at import.
 *
 * iOS hands `.MOV` files out of the Photos picker, so the fallback matters: a recording
 * whose type the picker did not set still has to reach the `<video>` element with
 * `video/quicktime` on it, or Safari refuses to decode it.
 */
export function restoreFile(bytes: Blob, record: Pick<MediaRecord, 'filename' | 'mimeType'>): File {
  const type = record.mimeType || mimeFromFilename(record.filename) || bytes.type || '';
  return new File([bytes], record.filename, { type });
}

/**
 * The MIME type to record at import: whatever the picker set, else the extension.
 *
 * Deriving it now rather than at playback matters because the storage path drops the
 * extension — by the time the file is read back there is no filename left to derive
 * anything from.
 */
export function mimeOf(file: File): { mimeType?: string } {
  const mimeType = file.type || mimeFromFilename(file.name);
  return mimeType ? { mimeType } : {};
}

/** Media paths are `media/<fingerprint>`, so the index key is recoverable from the path. */
export function fingerprintFromPath(path: string): string | null {
  return path.split('/').filter(Boolean).at(-1) ?? null;
}
