import { APP_URL, ensureClip, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * Scrolling the timeline must track a finger.
 *
 * Reported from a real fifty-one clip project: "the scrolling throughout the timeline is
 * still not very smooth. It freezes all the time and you need to play the video to
 * sometimes unfreeze it."
 *
 * The cause was structural rather than a slow function. Every scroll event announced a new
 * playhead, every playhead change re-rendered the whole editor, and each clip block held
 * its own filmstrip subscription — so a single scroll gesture asked React to reconcile
 * fifty-one components with a row of thumbnails each, sixty times a second, on a phone.
 *
 * What is asserted here is therefore not "is it fast" but the two structural facts that
 * make it fast, plus one end-to-end number:
 *
 *  1. **The main thread stays free.** Measured by how long the longest gap between
 *     animation frames is *during* a scroll. A frame budget is 16ms; anything past 100ms is
 *     a visible stall and past 500ms is the freeze that was reported.
 *  2. **A scroll does not re-render the lane.** Counted by a mutation observer on the clip
 *     blocks: the lane's contents do not depend on the playhead, so scrolling must not
 *     touch them.
 *  3. **The picture still follows.** All of the above is trivially achievable by breaking
 *     scrubbing, so the preview must still land on the right frame at the end.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

/*
  A throttled CPU, because the bug is a phone bug.

  Desktop Chromium reconciles fifty unmemoised components inside a frame budget without
  breaking a sweat, so an unthrottled run reports everything is fine and always will.
  Six-times throttling is roughly the gap between this machine and an iPhone doing this
  work on 4K thumbnails, and it is what makes the difference between a memoised lane and
  an unmemoised one show up as milliseconds rather than as an opinion.
*/
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Twenty-four clips out of a twelve-second fixture. Not fifty-one, but far past the point
// where a per-clip subscription and an unmemoised block start costing whole frames.
for (let i = 1; i <= 23; i += 1) {
  await scrubTo(page, i / 24);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(60);
}
const count = await page.locator('.clip-block').count();
set('clips', count);
check('enoughClipsToBeSlow', count >= 20, true);

await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(500);

/**
 * Scroll the way a finger does — a run of positions, one per frame, with momentum — while
 * watching the animation-frame clock and the DOM.
 */
const measure = async (label) =>
  page.evaluate(async () => {
    const scroller = document.querySelector('.timeline-scroller');
    const lane = document.querySelector('.timeline-lane');

    let laneMutations = 0;
    const observer = new MutationObserver((records) => {
      laneMutations += records.length;
    });
    observer.observe(lane, { childList: true, subtree: true, attributes: true, characterData: true });

    // A frame clock, so a blocked main thread is measured rather than inferred.
    const gaps = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const box = scroller.getBoundingClientRect();
    scroller.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
    );

    const max = scroller.scrollWidth - scroller.clientWidth;
    // Back and forth, because a single sweep can coast through a stall without meeting it.
    for (const sweep of [0.85, 0.15, 0.7]) {
      const from = scroller.scrollLeft;
      const to = max * sweep;
      for (let i = 1; i <= 24; i += 1) {
        scroller.scrollLeft = Math.round(from + ((to - from) * i) / 24);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
    running = false;
    observer.disconnect();

    // The first gap is the time since the clock started, not a frame — drop it.
    const frames = gaps.slice(1);
    return {
      frames: frames.length,
      longestGapMs: Math.round(Math.max(...frames)),
      medianGapMs: Math.round(frames.slice().sort((a, b) => a - b)[Math.floor(frames.length / 2)]),
      laneMutations,
      landed: Math.round(scroller.scrollLeft),
      wanted: Math.round(max * 0.7),
    };
  }, label);

const scroll = await measure('fit');
set('scrollAtFit', scroll);
// 16ms is a frame. A gap past 250ms is a stall you can feel; the reported freeze was
// seconds. This is the number the complaint is about.
check('theMainThreadStaysFree', scroll.longestGapMs < 250, true);
// Measured: 36ms with the lane memoised, 66ms without, under 6x throttling. The threshold
// sits between them on purpose — this is the check that fails if the memo is ever lost.
check('andMostFramesArePrompt', scroll.medianGapMs < 50, true);
// The lane's contents are a function of the clips, the zoom and the selection — none of
// which a scroll changes. Any mutation here is work being done for nothing, per frame.
check('scrollingDoesNotRebuildTheLane', scroll.laneMutations, 0);
check('theScrollWentWhereItWasPut', Math.abs(scroll.landed - scroll.wanted) <= 2, true);

// Zoomed in, where the blocks are wide, each carries more thumbnails, and the same gesture
// crosses far fewer clips — a different cost profile for the same code.
const zoomIn = page.locator('button[aria-label="Zoom in"]');
for (let i = 0; i < 4 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(60);
}
const close = await measure('zoomed');
set('scrollZoomedIn', close);
check('theMainThreadStaysFreeZoomedIn', close.longestGapMs < 250, true);
check('andMostFramesArePromptZoomedIn', close.medianGapMs < 50, true);
check('scrollingDoesNotRebuildTheLaneZoomedIn', close.laneMutations, 0);

// --- And it still scrubs -----------------------------------------------------------
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(400);
await scrubTo(page, 0.45);
await page.waitForTimeout(800);

const picture = await page.evaluate(() => {
  const scroller = document.querySelector('.timeline-scroller');
  const video = document.querySelector('.player video.live');
  return {
    fraction: scroller.scrollLeft / Math.max(1, scroller.scrollWidth - scroller.clientWidth),
    clock: document.querySelector('.timeline-clock')?.textContent ?? '',
    sourceMs: Math.round(video.currentTime * 1000),
    readyState: video.readyState,
  };
});
set('afterScrubbing', picture);
check('theClockFollowedTheScroll', picture.clock !== '0:00.000', true);
check('andThePictureIsDecodedThere', picture.readyState >= 2, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
