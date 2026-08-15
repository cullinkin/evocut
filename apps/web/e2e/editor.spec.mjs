import { APP_URL, artifact, centre, ensureClip, exportEdl, launch, makeReport, touchDrag, scrubTo } from './harness.mjs';

/**
 * The editing gestures, on an iPhone profile, driven by real touch events.
 *
 * Every drag here goes through CDP `Input.dispatchTouchEvent` rather than the mouse, so
 * `touch-action` is genuinely in play: if the timeline's `pan-x` were to swallow a trim
 * gesture, or the playhead's `touch-action: none` were missing, these would fail rather
 * than quietly passing the way a synthetic mouse drag would.
 */
const { browser, context, page, errors, profile } = await launch({ device: 'iPhone 15 Pro' });
const cdp = await context.newCDPSession(page);
const { report, check, set, finish } = makeReport({
  viewport: `${profile.viewport.width}x${profile.viewport.height} @${profile.deviceScaleFactor}x`,
});

const clip = await ensureClip(page);
/** Mirrors AUTOSCROLL_MARGIN in Timeline.tsx. */
const AUTOSCROLL_MARGIN_PX = 44;

// --- Import ---------------------------------------------------------------------
await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
check('clipsAfterImport', await page.locator('.clip-block').count(), 1);

// --- The screen has to behave like an app, not a document -----------------------
check(
  'pageDoesNotScroll',
  await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
  true,
);
const toolbar = await page.locator('.toolbar').boundingBox();
check('toolbarWithinViewport', toolbar.y + toolbar.height <= profile.viewport.height + 1, true);

// Apple's 44px touch-target floor, checked rather than asserted in a comment.
check(
  'targetsBelow44px',
  await page.evaluate(() =>
    [...document.querySelectorAll('.toolbar button, .transport button, .trim-handle')]
      .map((el) => ({ cls: el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter((t) => t.h < 44),
  ),
  [],
);

// --- The media must be seekable, and served by the range server ------------------
// iOS Safari cannot seek inside a `blob:` URL: it loads, reports a duration, plays, and
// ignores every `currentTime` assignment. That one limitation broke cuts, scrubbing and
// the playhead at once, because all three are seeks. Media therefore goes through a
// service worker that answers Range requests, and the element gets an http(s) URL.
await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 20000 });
check(
  'mediaServedOverHttp',
  await page.evaluate(() => (document.querySelector('.player video')?.src ?? '').startsWith('blob:')),
  false,
);
check(
  'rangeServerAnswersPartialContent',
  await page.evaluate(async () => {
    const src = document.querySelector('.player video').src;
    const response = await fetch(src, { headers: { Range: 'bytes=0-99' } });
    return {
      status: response.status,
      hasContentRange: response.headers.has('Content-Range'),
      acceptRanges: response.headers.get('Accept-Ranges'),
    };
  }),
  { status: 206, hasContentRange: true, acceptRanges: 'bytes' },
);
check(
  'mediaIsSeekable',
  await page.evaluate(() => {
    const video = document.querySelector('.player video');
    return video.seekable.length > 0;
  }),
  true,
);

// The blob the player is handed must carry a MIME type. It did not, once: OPFS names a
// file after its extension-less storage path, Chromium sniffed the container out of the
// bytes and played it, and Safari refused — so this passed everywhere except the one
// platform the app is for.
check(
  'mediaIsTyped',
  await page.evaluate(async () => {
    const src = document.querySelector('.player video')?.src;
    if (!src) return 'no video element';
    return (await fetch(src)).headers.get('Content-Type');
  }),
  'video/webm',
);

await page.waitForFunction(() => document.querySelectorAll('.clip-thumbs img').length > 0, null, {
  timeout: 25000,
});
set('thumbnailsRendered', await page.locator('.clip-thumbs img').count());
await page.screenshot({ path: artifact('iphone-editor.png') });

// --- Scroll the lane to move the playhead ---------------------------------------
// The playhead does not move any more; the footage moves under it. A real single-finger
// pan across the lane is the gesture, and `touch-action: pan-x` is what lets the browser
// treat it as a scroll rather than as a tap that went slightly wrong.
const lane = await centre(page.locator('.timeline-scroller'));
await touchDrag(cdp, page, lane, { x: lane.x - lane.box.width * 0.3, y: lane.y });
await page.waitForTimeout(400);

const clock = await page.locator('.timeline-clock').innerText();
set('clockAfterScrub', clock);
check('scrollingMovedThePlayhead', clock !== '0:00.000', true);
// The mark itself stays put: that is the whole design, and a playhead that drifted would
// mean the time under it and the time in `scrollLeft` had come apart.
const playheadX = await page.evaluate(() => {
  const el = document.querySelector('.playhead');
  const track = document.querySelector('.timeline-scroller');
  return Math.round(el.getBoundingClientRect().left - track.getBoundingClientRect().left);
});
const halfLane = Math.round((await page.locator('.timeline-scroller').boundingBox()).width / 2);
set('playheadOffsetFromLaneCentre', playheadX - halfLane);
check('playheadStayedCentred', Math.abs(playheadX - halfLane) <= 2, true);

// --- Cut at the playhead --------------------------------------------------------
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.waitForTimeout(300);
check('clipsAfterCut', await page.locator('.clip-block').count(), 2);

// --- A drifted element must not freeze the playhead ------------------------------
// Constructed rather than hoped for: the element is forced to a position before the
// current clip's in point, which is what a seek that never landed leaves behind.
// `sourceToTimeline` returns null there, and the loop used to read that as "nothing to
// report" — the playhead stopped while the video played on underneath.
{
  await scrubTo(page, 0.8); // land inside clip 2
  const parked = await page.locator('.timeline-clock').innerText();

  await page.evaluate(() => {
    document.querySelector('.player video').currentTime = 0.2; // before clip 2 starts
  });
  await page.waitForTimeout(200);
  await page.locator('button.play').click();
  await page.waitForTimeout(1500);
  const moved = await page.locator('.timeline-clock').innerText();
  await page.locator('button.play').click();
  await page.waitForTimeout(200);

  set('clockWhenDrifted', parked);
  set('clockAfterDriftRecovery', moved);
  check('driftedElementStillAdvancesPlayhead', moved !== parked, true);
}

// --- Select -------------------------------------------------------------------
await page.locator('.clip-block').nth(1).tap();
await page.waitForTimeout(200);
check('selectedBlocks', await page.locator('.clip-block.selected').count(), 1);
check('trimHandlesShown', await page.locator('.trim-handle').count(), 2);
check('headroomShown', (await page.locator('.headroom').count()) > 0, true);
set('selectionHint', await page.locator('.selection-hint').innerText());
await page.screenshot({ path: artifact('iphone-selected.png') });

const blockWidth = (n) =>
  page.evaluate((i) => {
    const el = document.querySelectorAll('.clip-block')[i];
    return el ? Math.round(el.getBoundingClientRect().width) : -1;
  }, n);

// --- Drag the out handle inward: the clip shortens -------------------------------
const widthBefore = await blockWidth(1);
const outHandle = await centre(page.locator('.trim-handle.out'));
await touchDrag(cdp, page, outHandle, { x: outHandle.x - 70, y: outHandle.y });
const widthAfter = await blockWidth(1);
set('widthBefore', widthBefore);
set('widthAfterShorten', widthAfter);
check('outTrimShortens', widthAfter < widthBefore - 20, true);

// --- Holding still must not keep trimming ----------------------------------------
// The bug the user hit: edge auto-scroll changed the time under a *motionless* finger,
// the trim followed it, and that moved the scroll range in turn. A four-second clip
// collapsed to the 0.1s minimum in about a second of holding.
//
// Zoomed in so the content overflows and auto-scroll has room to run, then the lane is
// scrolled so the handle already sits near the right edge — that way a short drag lands
// inside the margin without trimming far enough to hit the clamp, and the hold is the
// only variable left.
{
  await page.locator('button[aria-label="Zoom in"]').click();
  await page.locator('button[aria-label="Zoom in"]').click();
  await page.waitForTimeout(300);

  const box = await page.locator('.timeline-scroller').boundingBox();
  const parkAt = box.x + box.width - 70;
  const handleBefore = await centre(page.locator('.trim-handle.in'));
  await page.evaluate((dx) => {
    document.querySelector('.timeline-scroller').scrollLeft += dx;
  }, handleBefore.x - parkAt);
  await page.waitForTimeout(200);

  const handle = await centre(page.locator('.trim-handle.in'));
  // What matters is where the finger *ends up*: inside the margin, where the old
  // auto-scroll would have started pulling.
  check('fingerEndsInsideAutoscrollMargin', handle.x + 30 > box.x + box.width - AUTOSCROLL_MARGIN_PX, true);

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: handle.x, y: handle.y, id: 1 }],
  });
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: handle.x + (30 * i) / 5, y: handle.y, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);

  const readDrag = () =>
    page.evaluate(() => {
      const block = document.querySelectorAll('.clip-block')[1];
      return {
        width: Math.round(block.getBoundingClientRect().width),
        scrollLeft: Math.round(document.querySelector('.timeline-scroller').scrollLeft),
      };
    });

  const atRest = await readDrag();
  await page.waitForTimeout(1500); // finger perfectly still, inside the margin
  const afterHolding = await readDrag();

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);

  set('widthAtRest', atRest.width);
  set('widthAfterHolding', afterHolding.width);
  check('holdingStillChangesNothing', afterHolding.width, atRest.width);
  check('holdingStillDoesNotScroll', afterHolding.scrollLeft, atRest.scrollLeft);
  // Not vacuous: the clip has to be somewhere other than pinned at its minimum.
  check('trimIsNotAtTheLimit', atRest.width > 40, true);

  await page.locator('button[aria-label="Undo"]').click();
  await page.waitForTimeout(400);
  await page.locator('button[aria-label="Fit timeline"]').click();
  await page.locator('.clip-block').nth(1).tap(); // undo clears the selection
  await page.waitForTimeout(200);
}

// --- Drag the in handle outward: recovers footage the coarse pass cut ------------
const before = await exportEdl(page, 'editor-before.json');
const inBefore = before.timeline.tracks[0].clips[1].sourceIn;

const inHandle = await centre(page.locator('.trim-handle.in'));
await touchDrag(cdp, page, inHandle, { x: inHandle.x - 60, y: inHandle.y });

const after = await exportEdl(page, 'editor-after.json');
const inAfter = after.timeline.tracks[0].clips[1].sourceIn;
set('sourceInBefore', inBefore);
set('sourceInAfter', inAfter);
check('inTrimRecoveredFootage', inAfter < inBefore, true);
check('inTrimStaysInBounds', inAfter >= 0, true);

// A gesture is one decision. Sixty frames of drag must not become sixty ops.
const trims = after.revisions.filter((r) => r.ops.some((op) => op.op === 'trim'));
set('trimRevisionCount', trims.length);
check('oneTrimOpPerDrag', trims.every((r) => r.ops.length === 1), true);

// --- The playhead must advance during playback -----------------------------------
// It stopped: `sourceToTimeline` returns null when the element plays from outside the
// current clip's range, and the loop treated that as "nothing to report" and simply left
// the playhead where it was while the video carried on underneath.
{
  await page.locator('button[aria-label="Back to start"]').click();
  await page.waitForTimeout(200);
  const readClock = () => page.locator('.timeline-clock').innerText();
  const before = await readClock();

  await page.locator('button.play').click();
  await page.waitForTimeout(1500);
  const during = await readClock();
  const videoAdvanced = await page.evaluate(() => document.querySelector('.player video').currentTime);
  await page.locator('button.play').click(); // pause
  await page.waitForTimeout(200);

  set('clockBeforePlay', before);
  set('clockDuringPlay', during);
  check('playheadAdvancesWithPlayback', during !== before, true);
  check('videoActuallyPlayed', videoAdvanced > 0.3, true);
}

// --- Scrubbing must show the frame it lands on, while the finger is still down -----
// Playback used to write the playhead back from the video's own position every frame, so
// a scrub looked like it did nothing at all. The preview has to follow the scroll as it
// happens, not catch up when it stops.
{
  await page.locator('button[aria-label="Back to start"]').click();
  await page.waitForTimeout(300);
  await page.locator('button.play').click(); // start playing
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => document.querySelector('.player video').currentTime);
  const from = await centre(page.locator('.timeline-scroller'));

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x - (from.box.width * 0.35 * i) / 8, y: from.y, id: 1 }],
    });
    await page.waitForTimeout(40);
  }
  const midDrag = await page.evaluate(() => document.querySelector('.player video').currentTime);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(600);

  set('videoTimeMidDrag', Number(midDrag.toFixed(2)));
  check('previewTracksTheFingerMidDrag', Math.abs(midDrag - before) > 0.3, true);

  const after = await page.evaluate(() => ({
    time: document.querySelector('.player video').currentTime,
    paused: document.querySelector('.player video').paused,
  }));
  set('videoTimeBeforeScrub', Number(before.toFixed(2)));
  set('videoTimeAfterScrub', Number(after.time.toFixed(2)));
  check('scrubMovedThePreview', Math.abs(after.time - before) > 0.3, true);
  check('scrubPausedPlayback', after.paused, true);
}

// --- Undo ------------------------------------------------------------------------
await page.locator('button[aria-label="Undo"]').click();
await page.waitForTimeout(400);
const undone = await exportEdl(page, 'editor-undone.json');
check('undoRestoredSourceIn', undone.timeline.tracks[0].clips[1].sourceIn, inBefore);

// --- Delete ----------------------------------------------------------------------
await page.locator('.clip-block').nth(1).tap();
await page.waitForTimeout(150);
await page.locator('button[aria-label="Delete clip"]').click();
await page.waitForTimeout(400);
check('clipsAfterDelete', await page.locator('.clip-block').count(), 1);
check('selectionClearedAfterDelete', await page.locator('.clip-block.selected').count(), 0);

// --- Survives a reload -----------------------------------------------------------
await page.waitForTimeout(600);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
check('clipsAfterReload', await page.locator('.clip-block').count(), 1);

// --- And still reaches the refinement pass ----------------------------------------
// Refine now asks what the video is before it asks a model anything, so the brief sheet
// is the first thing on the path rather than a screen full of proposals.
await page.locator('button:has-text("Done")').click();
await page.waitForTimeout(300);
await page.locator('button:has-text("Refine")').click();
await page.locator('.sheet').waitFor({ timeout: 10000 });
check('briefSheetReachable', (await page.locator('.sheet textarea').count()) > 0, true);
await page.locator('.sheet-actions .primary').click();
await page.waitForTimeout(1500);
// A one-clip edit may honestly have nothing to suggest, so what is asserted is that the
// review opened at all — the header counter is the review's own presence on screen.
check('reviewOpened', /\d+\/\d+ kept/.test(await page.locator('header .primary').innerText()), true);

const exitCode = finish(errors);
await browser.close();
process.exit(exitCode);
