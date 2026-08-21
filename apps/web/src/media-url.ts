import type { Source } from '@evocut/edl';

/**
 * How a stored file reaches the `<video>` element.
 *
 * A `blob:` URL is the obvious answer and the wrong one on iOS: Safari's media loader
 * cannot seek inside one. It reports an empty `seekable`, ignores `currentTime`, and plays
 * the file end to end — which is the whole editor failing at once, since every cut,
 * scrub, and preview frame is a seek.
 *
 * So media is served through a service worker that answers Range requests
 * (`public/sw.js`), and the element is pointed at a same-origin URL instead. Where that is
 * not available — no service worker, an insecure origin, media held in IndexedDB rather
 * than OPFS — it falls back to a blob URL, which is fine everywhere except iOS and is
 * strictly better than nothing.
 */

/** Path prefix the service worker claims. Must match `MEDIA_PREFIX` in `sw.js`. */
const MEDIA_PREFIX = '__media/';
const REGISTRATION_TIMEOUT_MS = 4000;

export type MediaUrlKind = 'range-server' | 'blob';

let ready: Promise<boolean> | null = null;

/**
 * Register the range server and wait for it to control this page.
 *
 * Waited on rather than fired and forgotten: a worker that becomes active *after* the
 * first video is bound leaves that video unseekable for the rest of the session, which
 * looks exactly like the bug it exists to fix.
 */
export function startMediaServer(): Promise<boolean> {
  ready ??= (async () => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !window.isSecureContext) {
      return false;
    }
    try {
      await navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
        // Scoped to the app, so this works from a domain root and from a project path
        // like GitHub Pages' /<repo>/ without either knowing about the other.
        scope: './',
      });
      const controlled = await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REGISTRATION_TIMEOUT_MS)),
      ]);
      // `ready` resolves once a worker is active, but it may not yet *control* this page
      // on a first visit. Without a controller the media URL would 404.
      if (controlled && !navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, REGISTRATION_TIMEOUT_MS)),
        ]);
      }
      return Boolean(navigator.serviceWorker.controller);
    } catch {
      return false;
    }
  })();
  return ready;
}

export function isMediaServerActive(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
}

/**
 * A URL the `<video>` element can seek in.
 *
 * The MIME type rides along in the query string because the worker reads bytes out of a
 * directory that does not record one — media is stored under its fingerprint, with no
 * extension for anything to infer from.
 */
/**
 * `variant: 'proxy'` serves the small copy instead of the recording.
 *
 * Both live under the same fingerprint, in different directories, so the name is the same
 * and only the directory changes — which keeps the worker's allowlist to two entries and
 * means a proxy cannot be confused with an original by anything downstream.
 */
export function mediaUrlFor(
  source: Source,
  file: File,
  options: { variant?: 'source' | 'proxy' } = {},
): { url: string; kind: MediaUrlKind } {
  if (source.locator.kind === 'opfs' && isMediaServerActive()) {
    const name = source.locator.path.split('/').filter(Boolean).at(-1);
    if (name) {
      /*
        A proxy is always an MP4, whatever the recording was.

        It shares the recording's fingerprint, so the store hands it back wearing the
        original's identity — `video/webm` for a WebM source, say. Chromium sniffs the
        container and plays it anyway; **Safari does not**, and a `<video>` pointed at a
        mistyped URL fails with a decode error. That is the same failure `restoreFile`
        exists to prevent, arriving by a different door.
      */
      const type = options.variant === 'proxy' ? 'video/mp4' : file.type || 'video/mp4';
      const url = new URL(`${MEDIA_PREFIX}${encodeURIComponent(name)}`, document.baseURI);
      url.searchParams.set('type', type);
      if (options.variant === 'proxy') url.searchParams.set('from', 'proxy');
      return { url: url.toString(), kind: 'range-server' };
    }
  }
  return { url: URL.createObjectURL(file), kind: 'blob' };
}

/** Only blob URLs hold a reference that has to be released. */
export function releaseMediaUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}
