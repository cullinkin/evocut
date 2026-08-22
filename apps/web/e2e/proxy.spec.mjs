import { writeFileSync } from 'node:fs';
import { APP_URL, artifact, ensureClip, exportEdl, exportLog, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The small copy, and what is allowed to use it.
 *
 * Asked for outright: "it seems a little silly that we're trying to work directly on the
 * high resolution and huge raw source video… The proxy would only be for displaying the
 * editing decisions in the editing timeline and scrubbing through the video. Then when we
 * export the video, it would apply to the original raw source, not the proxy."
 *
 * That last sentence is the one with teeth, and it is what most of this spec is about. A
 * proxy that quietly leaked into the export would be invisible in every screenshot and
 * obvious only in the finished film, months of footage later.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

const before = await exportEdl(page, 'proxy-before.json');
const sourceUrlBefore = await page.locator('.player video.live').getAttribute('src');
set('urlBeforeProxy', sourceUrlBefore);
check('theEditorStartsOnTheRecording', /from=proxy/.test(sourceUrlBefore ?? ''), false);

// --- Offered, not imposed ----------------------------------------------------------------
/*
  Making one takes about as long as the recording. Work of that size is not something to
  start on a phone without being asked, so the app offers and waits.
*/
const banner = page.locator('.banner.proxy');
await banner.waitFor({ timeout: 20000 });
set('offer', await banner.innerText());
check('itSaysWhatItWouldCost', /minute|under a minute/.test(await banner.innerText()), true);

await page.locator('.banner.proxy button:has-text("Make one")').click();
await page.locator('.banner.proxy.running').waitFor({ timeout: 20000 });

// The fixture is twelve seconds, so this is about twelve seconds of encoding.
await page.waitForFunction(() => !document.querySelector('.banner.proxy'), null, { timeout: 180_000 });
await page.waitForTimeout(1500);

const log = await exportLog(page, 'proxy-log.jsonl');
const made = log.events.filter((event) => event.type === 'proxy.complete').at(-1)?.payload;
set('proxy', made);
check('itFinished', Boolean(made), true);
check('andIsSmallerThanTheRecording', (made?.width ?? 9999) <= 1080 && (made?.height ?? 9999) <= 1080, true);
check('andHasFramesInIt', (made?.framesEncoded ?? 0) > 100, true);

// --- The editor switched to it -----------------------------------------------------------
const liveUrl = await page.locator('.player video.live').getAttribute('src');
set('urlAfterProxy', liveUrl);
check('thePreviewPlaysTheProxy', /from=proxy/.test(liveUrl ?? ''), true);
/*
  And typed as an MP4, whatever the recording was. The proxy shares the recording's
  fingerprint, so the store hands it back wearing the original's identity — and Safari
  refuses to decode a mistyped blob, which is a failure that never shows up in Chromium.
*/
check('andIsServedAsWhatItIs', /type=video%2Fmp4/.test(liveUrl ?? ''), true);

/*
  And it is a real, seekable video rather than a file that merely exists: the whole point is
  that a scrub against it lands.
*/
await scrubTo(page, 0.6);
await page.waitForTimeout(2500);
const decoded = await page.evaluate(() => {
  const video = document.querySelector('.player video.live');
  return { readyState: video?.readyState ?? 0, at: video?.currentTime ?? 0, seekable: (video?.seekable?.length ?? 0) > 0 };
});
set('afterScrubbingTheProxy', decoded);
check('theProxySeeks', decoded.seekable, true);
check('andHasAFrameDecodedThere', decoded.readyState >= 2, true);
check('andLandedWhereItWasPut', decoded.at > 5, true);

// --- The edit is unchanged ---------------------------------------------------------------
const after = await exportEdl(page, 'proxy-after.json');
// A proxy is not an edit. The EDL still points at the recording, at the same duration, so
// nothing about the cut has been quietly rewritten to suit a smaller file.
check('theEdlStillPointsAtTheRecording', after.sources[0].locator.path, before.sources[0].locator.path);
check('andTheDurationIsUnchanged', after.sources[0].duration, before.sources[0].duration);
check('andTheResolutionIsUnchanged', after.timeline.resolution, before.timeline.resolution);

// --- The export does not use it ----------------------------------------------------------
/*
  The assertion this spec exists for. The export renders from the original: same
  resolution as the recording, not the proxy's.
*/
await page.locator('footer button:has-text("Export video")').click();
await page.locator('.progress').waitFor({ timeout: 15000 });
await page.locator('.export-preview').waitFor({ timeout: 240_000 });
// Back to the editor, because the log is exported from the metadata screen and the export
// screen owns the whole window while it is up.
await page.locator('.export button:has-text("Back to editing")').click();
await page.locator('.timeline-scroller').waitFor({ timeout: 15000 });

const exported = (await exportLog(page, 'proxy-export-log.jsonl')).events
  .filter((event) => event.type === 'render.complete')
  .at(-1)?.payload;
set('exported', exported);
set('recordingSize', before.timeline.resolution);
/*
  The export caps its longest edge, so this is not "the same numbers as the recording" — it
  is "the shape the recording would give", which a 1080-capped proxy would not. The proxy
  here is 1080 on the long edge; a recording of 360x640 is under that, so an export drawn
  from the proxy would come out the proxy's size and this would catch it.
*/
check(
  'theExportCameFromTheRecording',
  exported?.resolution,
  `${before.timeline.resolution.width}x${before.timeline.resolution.height}`,
);

// --- The fast way, on a container this can read ------------------------------------------
/**
 * Fed straight to a `VideoDecoder`, a proxy is made several times faster than the recording
 * is long — because a media element presents frames when a screen would show them, and a
 * decoder does not wait for anything.
 *
 * The fixture is a WebM, which cannot be demuxed here, so the run above took the slow path.
 * The *proxy* it produced is an MP4 this app wrote — so re-importing it and making a proxy
 * of that exercises the fast path, and proves in passing that what we write is a file our
 * own demuxer and the platform's decoder both accept.
 */
const proxyFile = artifact('proxy-of-proxy-input.mp4');
writeFileSync(
  proxyFile,
  Buffer.from(
    await page.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, liveUrl),
    'base64',
  ),
);

const second = await browser.newContext({ acceptDownloads: true });
const fast = await second.newPage();
const fastErrors = [];
fast.on('pageerror', (error) => fastErrors.push(String(error)));

await fast.goto(APP_URL);
await fast.locator('text=Choose a video').waitFor();
await fast.setInputFiles('input[type=file]', proxyFile);
await fast.locator('.clip-block').first().waitFor({ timeout: 30000 });

const secondBanner = fast.locator('.banner.proxy');
await secondBanner.waitFor({ timeout: 20000 });
set('offerForADecodableFile', await secondBanner.innerText());

const startedAt = Date.now();
await fast.locator('.banner.proxy button:has-text("Make one")').click();
await fast.waitForFunction(() => !document.querySelector('.banner.proxy'), null, { timeout: 180_000 });
const tookMs = Date.now() - startedAt;
await fast.waitForTimeout(1000);

const fastMade = (await exportLog(fast, 'proxy-fast-log.jsonl')).events
  .filter((event) => event.type === 'proxy.complete')
  .at(-1)?.payload;
set('fastProxy', { ...fastMade, tookMs, recordingMs: Math.round(before.sources[0].duration / 1000) });

check('itWentThroughTheDecoder', fastMade?.from, 'decoder');
// Every frame of the input, and none of them placed at a time it could not hold. A decoder
// hands over what the file contains, where a media element hands over what a screen had
// time to show.
check('andGotEveryFrameOfIt', fastMade?.framesEncoded, made?.framesEncoded);
check('andPlacedThemAll', fastMade?.framesSkipped, 0);
/*
  The point of the exercise. Playing the recording takes at least as long as the recording;
  this has to be plainly faster than that, or the decoder path is not earning its keep.
*/
check('andBeatPlayingItThrough', tookMs < Math.round(before.sources[0].duration / 1000), true);

errors.push(...fastErrors);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
