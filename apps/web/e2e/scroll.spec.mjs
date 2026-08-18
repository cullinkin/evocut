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


/**
 * Wait until the filmstrip has stopped being built.
 *
 * Not politeness — correctness. Extracting thumbnails means seeking and decoding the video,
 * and under six-times throttling that competes with the scroll for the same main thread. A
 * fixed half-second wait meant the measurement sometimes ran against a finished filmstrip
 * and sometimes against one still being decoded, which is how the same commit measured a
 * 0ms scroll cost on one run and 24ms on the next. Two numbers, one of them nonsense, and
 * no way to tell from the report which was which.
 *
 * The thumbnails appear as `<img>` elements as they are produced, so a count that has
 * stopped moving is the pass having finished.
 */
async function settleFilmstrips(page, quietMs = 1200, limitMs = 90_000) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < limitMs) {
    const now = await page.locator('.clip-thumbs .thumb').count();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return { frames: now, tookMs: Date.now() - started };
    }
    await page.waitForTimeout(200);
  }
  return { frames: last, tookMs: Date.now() - started, timedOut: true };
}

set('filmstrip', await settleFilmstrips(page));

/**
 * How fast this machine's frame clock runs when nothing is asked of it.
 *
 * The same rAF clock as the scroll measurement, under the same throttle, with the page
 * sitting still. Reported rather than asserted on: it is the number that says whether a
 * disappointing result means the app got slower or the machine did.
 */
const idle = async () =>
  page.evaluate(async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 1200));
    running = false;
    const frames = gaps.slice(1).sort((a, b) => a - b);
    return Math.round(frames[Math.floor(frames.length / 2)]);
  });

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

set('idleFrameMs', await idle());

/*
  The control: the same gesture over a one-clip lane.

  This is the measurement that used to be an absolute number, and the absolute number
  stopped meaning anything. It was written when the same fixture reported 66ms unmemoised,
  36ms memoised, 23ms with the playhead out of React — so a threshold of 32ms sat neatly
  below the middle. Today, on this machine, four consecutive commits measure between 20ms
  and 33ms *over idle*, in no particular order, with ±7ms between repeat runs of the same
  build. The signal the threshold was cutting through is gone, and a check that fails on
  four builds in a row including the ones it passed on this morning is not evidence of
  anything.

  So this asks the question the check was always really asking. The fix under test is that
  the lane's cost does not grow with the number of clips: one filmstrip subscription rather
  than one per block, memoised blocks that a playhead change cannot touch. That is a
  *comparison*, and it can be made inside a single run where the host's mood is the same
  for both halves. One clip, then twenty-four, same gesture, same page.

  Unmemoised, the twenty-four-clip lane reconciles twenty-four components with a row of
  thumbnails each on every frame, and the gap between the two is enormous. Memoised, adding
  twenty-three clips is nearly free — which is the whole claim.
*/
const oneClip = await measure('one-clip');
set('scrollWithOneClip', oneClip);

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
set('filmstripAfterCutting', await settleFilmstrips(page));

const scroll = await measure('fit');
set('scrollAtFit', scroll);
set('whatTwentyThreeMoreClipsCost', scroll.medianGapMs - oneClip.medianGapMs);
// 16ms is a frame. A gap past 250ms is a stall you can feel; the reported freeze was
// seconds. This is the number the complaint is about.
check('theMainThreadStaysFree', scroll.longestGapMs < 150, true);
// Under a frame for twenty-three extra clips. Lose the memo or the shared subscription and
// this is tens of milliseconds, because it becomes per-clip work per frame.
check('theLaneCostsAlmostNothingPerClip', scroll.medianGapMs - oneClip.medianGapMs < 16, true);
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
set('whatTwentyThreeMoreClipsCostZoomedIn', close.medianGapMs - oneClip.medianGapMs);
check('theMainThreadStaysFreeZoomedIn', close.longestGapMs < 250, true);
check('theLaneCostsAlmostNothingPerClipZoomedIn', close.medianGapMs - oneClip.medianGapMs < 16, true);
check('scrollingDoesNotRebuildTheLaneZoomedIn', close.laneMutations, 0);

/*
  --- How much DOM the lane builds, all the way in -----------------------------------------

  The number that mattered most, and the one no timing check would ever have named.
  Thumbnails were one per 56 pixels of block with nothing bounding them, so at full zoom a
  single clip built hundreds of `<img>` elements and a real fifty-clip timeline built tens
  of thousands — on a phone, synchronously, the moment you pressed the zoom button.
  "Extraordinarily slow and laggy, especially when zoomed in" was this, and "especially
  when zoomed in" was the clue: it is the only number in the editor that grew without bound
  as the zoom went up.

  The bound now comes from two places, and the second is the useful one: a block never draws
  more pictures than the filmstrip actually holds for that stretch of recording. On the
  fixture the strip is dense, so the flat cap does the work; on a half-hour master there are
  two frames for a thirty-second clip and it draws two.
*/
for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(60);
}
await page.waitForTimeout(400);

const built = await page.evaluate(() => ({
  thumbnails: document.querySelectorAll('.clip-thumbs .thumb').length,
  worstClip: Math.max(
    ...[...document.querySelectorAll('.clip-block')].map((block) => block.querySelectorAll('img').length),
  ),
  contentPx: Math.round(document.querySelector('.timeline-content').getBoundingClientRect().width),
}));
set('laneAtFullZoom', built);
check('theContentIsEnormous', built.contentPx > 8000, true);
check('andTheLaneIsStillASensibleSize', built.thumbnails < 600, true);
check('noSingleBlockRunsAway', built.worstClip <= 40, true);

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
