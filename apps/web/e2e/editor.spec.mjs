import { APP_URL, artifact, centre, ensureClip, exportEdl, launch, makeReport, touchDrag } from './harness.mjs';

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
    [...document.querySelectorAll('.toolbar button, .transport button, .playhead-grip, .trim-handle')]
      .map((el) => ({ cls: el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter((t) => t.h < 44),
  ),
  [],
);

// The blob the player is handed must carry a MIME type. It did not, once: OPFS names a
// file after its extension-less storage path, Chromium sniffed the container out of the
// bytes and played it, and Safari refused — so this passed everywhere except the one
// platform the app is for.
check(
  'mediaBlobIsTyped',
  await page.evaluate(async () => {
    const src = document.querySelector('.player video')?.src;
    if (!src) return 'no video element';
    return (await (await fetch(src)).blob()).type;
  }),
  'video/webm',
);

await page.waitForFunction(() => document.querySelectorAll('.clip-thumbs img').length > 0, null, {
  timeout: 25000,
});
set('thumbnailsRendered', await page.locator('.clip-thumbs img').count());
await page.screenshot({ path: artifact('iphone-editor.png') });

// --- Drag the playhead ----------------------------------------------------------
const grip = await centre(page.locator('.playhead-grip'));
const scroller = await page.locator('.timeline-scroller').boundingBox();
await touchDrag(cdp, page, grip, { x: scroller.x + scroller.width * 0.5, y: grip.y });

const clock = await page.locator('.timeline-clock').innerText();
set('clockAfterPlayheadDrag', clock);
check('playheadMoved', clock !== '0:00.000', true);

// --- Cut at the playhead --------------------------------------------------------
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.waitForTimeout(300);
check('clipsAfterCut', await page.locator('.clip-block').count(), 2);

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

// --- Dragging the playhead must show the frame it lands on -----------------------
// It did not: playback kept writing the playhead back from the video's own position
// every frame, so a drag looked like it did nothing at all.
{
  await page.locator('button.play').click(); // start playing
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => document.querySelector('.player video').currentTime);
  const gripNow = await centre(page.locator('.playhead-grip'));
  const box = await page.locator('.timeline-scroller').boundingBox();
  await touchDrag(cdp, page, gripNow, { x: box.x + box.width * 0.85, y: gripNow.y });
  await page.waitForTimeout(500);

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

// --- And still reaches the refinement review -------------------------------------
await page.locator('button:has-text("Done")').click();
await page.waitForTimeout(300);
await page.locator('button:has-text("Refine")').click();
await page.waitForTimeout(500);
check('reviewReachable', (await page.locator('.review').count()) > 0, true);

const exitCode = finish(errors);
await browser.close();
process.exit(exitCode);
