import { readFileSync, writeFileSync } from 'node:fs';
import { APP_URL, artifact, ensureClip, exportEdl, exportLog, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The export, end to end, in a real browser.
 *
 * This is the check the muxer exists for. Unit tests can prove the sample tables say what
 * they should; only a demuxer reading the file back can prove a player agrees — and only
 * decoding the result can prove the export honoured the edit rather than re-encoding the
 * source from end to end.
 *
 * That last part is possible because the generated test clip's background colour is a
 * known function of its own timestamp: `hsl(t/40, …)`. Sampling a pixel out of the
 * exported video and converting it back to a hue recovers *which moment of the source*
 * that output frame came from, to within a few tens of milliseconds. So a cut that the
 * export ignored is not a matter of watching the file — it is a number that does not match.
 *
 * Note on codecs: this Chromium has no H.264 or AAC, so the export falls back to VP9 and
 * Opus. The container, the sample tables, the timing and the frame selection are the same
 * code either way; only the sample entry differs. A phone takes the AVC path.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { report, check, set, finish } = makeReport({});

const clip = await ensureClip(page);

// --- Import and make a cut worth honouring --------------------------------------
await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Seek into the take, cut there, and drop everything before the cut. The export then has
// to start partway into the source — which is exactly what a whole-file re-encode gets
// wrong while still producing a plausible-looking video.
await scrubTo(page, 0.35);
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.locator('.clip-block').first().click();
await page.locator('button[aria-label="Delete clip"]').click();
check('clipsAfterDelete', await page.locator('.clip-block').count(), 1);

const edl = await exportEdl(page, 'export-render.json');
const kept = edl.timeline.tracks[0].clips.filter((c) => c.enabled);
set('keptClips', kept.length);
set('sourceInUs', kept[0]?.sourceIn ?? null);
check('cutIsPartwayIn', (kept[0]?.sourceIn ?? 0) > 2_000_000, true);

const timelineUs = kept.reduce((total, c) => total + Math.round((c.sourceOut - c.sourceIn) / c.speed), 0);
set('timelineUs', timelineUs);

// --- Render ----------------------------------------------------------------------
await page.locator('footer button:has-text("Export video")').click();
await page.locator('.progress').waitFor({ timeout: 15000 });
// Capture runs at playback speed, so the budget is the length of the edit plus room for
// a cold start on a loaded machine.
await page.locator('.export-preview').waitFor({ timeout: Math.round(timelineUs / 1000) + 90_000 });
set('consoleErrorsDuringRender', errors.slice(0, 5));

const summary = await page.locator('.export .lede').first().innerText();
set('summary', summary.replace(/\s+/g, ' '));
// Warnings are the renderer's own account of what it could not do — a silent export, a
// codec it had to fall back from. Surfacing them here means a degraded run reports itself.
set('warnings', await page.locator('.export .warning').allInnerTexts());

// --- What came out ----------------------------------------------------------------
const file = await page.evaluate(async () => {
  const url = document.querySelector('.export-preview').src;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());

  const view = new DataView(bytes.buffer);
  const boxes = [];
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at);
    if (size < 8) break;
    boxes.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += size;
  }
  // Sample entries name the codec of each track. Found by scanning `moov` rather than by
  // walking the box tree, because `stsd` is not a plain container and this only needs the
  // names — and scanning from byte zero would pick up `ftyp`'s compatible-brand list,
  // which mentions avc1 whether or not the file contains any.
  let moovStart = 0;
  let moovEnd = bytes.length;
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at);
    if (size < 8) break;
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'moov') {
      moovStart = at;
      moovEnd = at + size;
      break;
    }
    at += size;
  }
  const contains = (type) => {
    const needle = [...type].map((c) => c.charCodeAt(0));
    for (let at = moovStart; at + 4 <= moovEnd; at += 1) {
      if (needle.every((code, i) => bytes[at + i] === code)) return true;
    }
    return false;
  };
  const sampleEntries = ['avc1', 'vp09', 'mp4a', 'Opus'].filter(contains);

  return { size: bytes.length, boxes, sampleEntries, url };
});
check('topLevelBoxes', file.boxes, ['ftyp', 'moov', 'mdat']);
check('fileHasBytes', file.size > 10_000, true);
set('sizeBytes', file.size);
// The test clip carries a real audio track, and the raw sound of the footage is the only
// sound this tool produces — a silent export would be a silent failure.
set('sampleEntries', file.sampleEntries);
check('hasAVideoTrack', file.sampleEntries.some((type) => type === 'avc1' || type === 'vp09'), true);
check('hasAnAudioTrack', file.sampleEntries.some((type) => type === 'mp4a' || type === 'Opus'), true);

// Saved so a failure can be inspected — or played — rather than only described.
writeFileSync(
  artifact('export.mp4'),
  Buffer.from(
    await page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, file.url),
    'base64',
  ),
);

/**
 * Load the exported file in a fresh element and read frames out of it.
 *
 * A separate element from the preview on purpose: this is the first time anything has
 * demuxed the file from scratch, which is the point of the exercise.
 */
const decoded = await page.evaluate(
  async ({ url, probes }) => {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const settled = (event, ms) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
        video.addEventListener(event, () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        video.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error(`media error ${video.error?.code}: ${video.error?.message ?? ''}`));
        }, { once: true });
      });

    try {
      await settled('loadeddata', 20000);
    } catch (error) {
      return { error: String(error) };
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const g = canvas.getContext('2d', { willReadFrequently: true });

    const samples = [];
    for (const at of probes) {
      video.currentTime = at;
      try {
        await settled('seeked', 10000);
      } catch (error) {
        samples.push({ at, error: String(error) });
        continue;
      }
      g.drawImage(video, 0, 0);
      const [r, gr, b] = g.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;

      // Back out the hue the clip generator used. It advances 25 degrees a second and
      // never wraps inside a 12 second take, so a hue is a timestamp.
      const max = Math.max(r, gr, b) / 255;
      const min = Math.min(r, gr, b) / 255;
      const delta = max - min;
      let hue = 0;
      if (delta > 0) {
        const [rn, gn, bn] = [r / 255, gr / 255, b / 255];
        if (max === rn) hue = ((gn - bn) / delta) % 6;
        else if (max === gn) hue = (bn - rn) / delta + 2;
        else hue = (rn - gn) / delta + 4;
        hue = (hue * 60 + 360) % 360;
      }
      samples.push({ at, rgb: [r, gr, b], sourceMs: Math.round(hue * 40) });
    }

    const result = {
      duration: Number(video.duration.toFixed(3)),
      width: video.videoWidth,
      height: video.videoHeight,
      samples,
    };
    video.remove();
    return result;
  },
  { url: file.url, probes: [0.5, 2, 4] },
);

set('decoded', decoded);
check('exportIsPlayable', decoded.error ?? null, null);
check('sizeMatchesSource', [decoded.width, decoded.height], [360, 640]);
// The muxed duration should be the timeline's, not the source's twelve seconds.
check('durationMatchesTimeline', Math.abs(decoded.duration - timelineUs / 1e6) < 0.4, true);

/**
 * The real assertion: every sampled output frame came from where the EDL says it should.
 *
 * A renderer that ignored the cut would be showing source time `t` at output time `t`, so
 * these would be off by the whole length of the deleted head — seconds, not frames.
 */
const sourceInMs = (kept[0]?.sourceIn ?? 0) / 1000;
const drift = (decoded.samples ?? [])
  .filter((sample) => sample.sourceMs !== undefined)
  .map((sample) => ({
    outputAt: sample.at,
    expectedSourceMs: Math.round(sourceInMs + sample.at * 1000),
    actualSourceMs: sample.sourceMs,
    offBy: Math.round(sample.sourceMs - (sourceInMs + sample.at * 1000)),
  }));
set('frameProvenance', drift);
check('everyFrameCameFromTheRightPlace', drift.every((d) => Math.abs(d.offBy) < 700), true);
check('probesDecoded', drift.length, 3);

await page.screenshot({ path: artifact('export-done.png') });

/**
 * Read the exported file back in, and listen to it.
 *
 * The demuxer cannot be reached from the generated test clip: that is a WebM, and WebM has
 * no `moov` to index, so the signals pass falls back to decoding it whole. Which means the
 * code path that every phone recording actually takes — locate the audio in the container,
 * slice out the frames, run them through `AudioDecoder` — has no browser coverage at all
 * unless something produces an MP4 first. Something just did.
 *
 * So the muxer's output becomes the demuxer's input, and the claim under test is end to
 * end and arithmetical: the burst that was at 7 seconds of the original recording, having
 * been cut, mixed, encoded, muxed, demuxed and decoded, is still where it should be.
 *
 * A fresh context, because the import screen only exists for a session with no project.
 */
const second = await browser.newContext({ acceptDownloads: true });
const reimport = await second.newPage();
const reimportErrors = [];
reimport.on('pageerror', (error) => reimportErrors.push(String(error)));

await reimport.goto(APP_URL);
await reimport.locator('text=Choose a video').waitFor();
await reimport.setInputFiles('input[type=file]', artifact('export.mp4'));
await reimport.locator('.clip-block').first().waitFor({ timeout: 30_000 });
await reimport.waitForFunction(
  () => !document.querySelector('.meta')?.textContent?.includes('listening to the footage'),
  null,
  { timeout: 120_000 },
);

const measured = (await exportLog(reimport, 'reimport-log.jsonl')).events
  .filter((event) => event.type === 'signals.compute')
  .at(-1)?.payload;

set('reimportMeasurement', measured);
check('heardTheExportedFile', measured?.hasAudio, true);
// Not the fallback. `decoded whole` here would mean the demuxer declined and Web Audio
// picked up the slack, which is exactly the outcome this section exists to rule out.
check('readItThroughTheDemuxer', /^opus |^mp4a/.test(measured?.audioNote ?? ''), true);

// The measurement ran only once, on open — not once per edit. This session makes no edits
// at all, so more than one row would mean the pass is re-triggering on its own state.
const computeRows = readFileSync(artifact('reimport-log.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((event) => event.type === 'signals.compute').length;
check('measuredOncePerSource', computeRows, 1);

const reimported = await exportEdl(reimport, 'reimport.json');
const signals = await reimport.evaluate(async () => {
  const open = indexedDB.open('evocut');
  const db = await new Promise((resolve) => (open.onsuccess = () => resolve(open.result)));
  const store = db.transaction('derived').objectStore('derived');
  const all = await new Promise((resolve) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
  });
  return all.find((entry) => entry?.value?.audio)?.value ?? null;
});

// Where the two bursts were in the original recording, less the head the cut removed.
const expectedHits = [7, 9].map((at) => at - sourceInMs / 1000);
const heard = (signals?.audio?.onsets ?? []).map((onset) => onset.t / 1_000_000);
set('expectedHits', expectedHits.map((at) => Number(at.toFixed(2))));
set('hitsHeardInTheReimport', heard.map((at) => Number(at.toFixed(2))));
check(
  'everyHitSurvivedTheRoundTrip',
  expectedHits.every((at) => heard.some((found) => Math.abs(found - at) < 0.5)),
  true,
);
check('durationOfTheReimport', Math.round(reimported.sources[0].duration / 100_000), Math.round(timelineUs / 100_000));

await reimport.screenshot({ path: artifact('reimport.png') });
errors.push(...reimportErrors);

const code = finish(errors.filter((e) => !e.includes('favicon')));
await browser.close();
process.exit(code);
