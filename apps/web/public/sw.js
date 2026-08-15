/**
 * Media range server.
 *
 * iOS Safari's media loader will not seek inside a `blob:` URL. It loads metadata, it
 * plays, and it ignores every `currentTime` assignment — `seekable` comes back empty.
 * That single limitation is what made the editor look broken on a phone: playback ran
 * straight through deleted sections, scrubbing showed nothing, and the playhead sat still,
 * because none of the seeks the timeline asked for ever happened.
 *
 * A `<video>` pointed at a same-origin URL does seek, provided something answers Range
 * requests. Nothing can, offline — so this worker is that something. It reads the file out
 * of OPFS and answers with `206 Partial Content` and a `Content-Range`, which is all Safari
 * needs to treat the media as random-access.
 *
 * **It intercepts media requests and nothing else.** No app shell, no assets, no caching
 * of any kind. A service worker that caches the page is a service worker that will one day
 * serve a stale build, and this one has no business having an opinion about anything but
 * the bytes of a video file.
 */

const MEDIA_PREFIX = '__media/';
const MEDIA_DIR = 'media';

self.addEventListener('install', () => {
  // Take over immediately: the page that registered this worker is the page that needs
  // it, and waiting for a reload would mean the first import of a session cannot seek.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const at = url.pathname.indexOf(MEDIA_PREFIX);
  if (at === -1) return;

  const name = decodeURIComponent(url.pathname.slice(at + MEDIA_PREFIX.length));
  const type = url.searchParams.get('type') || 'application/octet-stream';
  event.respondWith(serveMedia(name, type, event.request));
});

async function serveMedia(name, type, request) {
  let file;
  try {
    const root = await self.navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(MEDIA_DIR);
    const handle = await directory.getFileHandle(name);
    file = await handle.getFile();
  } catch {
    return new Response('Media not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const range = request.headers.get('Range');
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // The bytes never leave the device and never change under a given name, but caching
    // a partial response is a good way to confuse a media element.
    'Cache-Control': 'no-store',
  };

  if (!range) {
    return new Response(file, {
      status: 200,
      headers: { ...base, 'Content-Length': String(file.size) },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: { ...base, 'Content-Range': `bytes */${file.size}` },
    });
  }

  // An open-ended suffix range (`bytes=-500`) asks for the last N bytes, which is how a
  // media element finds the index at the end of an MP4 or QuickTime file.
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    start = Math.max(0, file.size - suffix);
    end = file.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? file.size - 1 : Math.min(Number(match[2]), file.size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= file.size) {
    return new Response(null, {
      status: 416,
      headers: { ...base, 'Content-Range': `bytes */${file.size}` },
    });
  }

  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
      'Content-Length': String(end - start + 1),
    },
  });
}
