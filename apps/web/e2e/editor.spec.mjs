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
