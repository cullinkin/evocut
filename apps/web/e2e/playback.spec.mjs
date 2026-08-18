import { APP_URL, ensureClip, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * Playing the edit, zoomed in, without the picture juddering.
 *
 * Everything measured so far has been about *scrubbing* — a gesture, driving the lane from
 * a finger. Playback is the other half and nothing had ever measured it, which is why it
 * kept being reported and kept not being found: "still very difficult to use because of the
 * scrubbing and jumpiness when playing the video while zoomed in."
 *
 * Playback is a different load from a scrub. The lane is scrolled *by the app*, sixty times
 * a second, across content that at full zoom is over a million pixels wide; the playhead is
 * written by the player's own loop rather than by a scroll event; and any work that happens
 * on a schedule — a window of ruler being rebuilt, a canvas tile being remounted, a React
 * state update four times a second — lands as a periodic hitch rather than as a slow frame,
 * which is exactly what "jumpy" means and is invisible to an average.
 *
 * So this measures the frame clock during real playback and, separately, counts the DOM
 * work done while it runs.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

/*
  Cut, and then *delete every other one*.

  This is the part the benchmark was missing, and missing it made it measure the wrong
  thing entirely. Splitting a recording leaves clips that meet where the recording meets
  itself — `continues` is true at every join, no handoff is needed and none happens, so a
  bench built from splits alone plays a single unbroken stream and reports that cuts are
  free. They are not: a real edit is mostly *deletions*, and every join in it is a jump to
  somewhere else in the file. The reported session had a hundred and one splits and
  fifty-one removals.

  So half of these go, and every remaining boundary is a real cut with a real seek behind
  it — which is what the two-element handoff exists for and what "it freezes between each
  clip" is about.
*/
for (let i = 1; i <= 23; i += 1) {
  await scrubTo(page, i / 24);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(60);
}
for (let i = 0; i < 11; i += 1) {
  await page.locator('.clip-block').nth(1 + i).tap();
  await page.waitForTimeout(80);
  await page.locator('button[aria-label="Delete clip"]').click();
  await page.waitForTimeout(120);
}
const clipCount = await page.locator('.clip-block').count();
set('clips', clipCount);
check('everyBoundaryIsARealCut', clipCount >= 10, true);

/** Wait for the filmstrip to stop being built, so a decode is not measured as playback. */
async function settle(page, quietMs = 1200, limitMs = 90_000) {
  const started = Date.now();
  let last = -1;
  let since = Date.now();
  while (Date.now() - started < limitMs) {
    const now = await page.locator('.clip-thumbs .thumb').count();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return Date.now() - started;
    await page.waitForTimeout(200);
  }
  return -1;
}
await page.locator('button[aria-label="Fit timeline"]').click();
set('filmstripSettledInMs', await settle(page));

/**
 * Play, and watch the frame clock and the DOM at the same time.
 *
 * The mutation counts are the interesting half. A frame gap tells you *that* something
 * stalled; the counts tell you what was being built while it did.
 */
const measure = async (label) =>
  page.evaluate(async (seconds) => {
    const content = document.querySelector('.timeline-content');
    let laneMutations = 0;
    let rulerMutations = 0;
    let waveMutations = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        const el = target.nodeType === 1 ? target : target.parentElement;
        if (!el) continue;
        if (el.closest('.ruler')) rulerMutations += 1;
        else if (el.closest('.wave-lane')) waveMutations += 1;
        else if (el.closest('.timeline-lane')) laneMutations += 1;
      }
    });
    observer.observe(content, { childList: true, subtree: true, attributes: true });

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

    document.querySelector('button.play').click();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    document.querySelector('button.play').click();

    running = false;
    observer.disconnect();

    const frames = gaps.slice(2);
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      frames: frames.length,
      medianGapMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
      p95GapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      worstGapMs: Math.round(Math.max(...frames)),
      // The number "jumpy" actually describes: how often a frame took long enough to see.
      hitches: frames.filter((gap) => gap > 60).length,
      laneMutations,
      rulerMutations,
      waveMutations,
      clock: document.querySelector('.timeline-clock')?.textContent ?? '',
    };
  }, 6);

// --- Fitted -------------------------------------------------------------------------------
const fitted = await measure('fit');
set('playbackAtFit', fitted);
check('itActuallyPlayed', fitted.clock !== '0:00.000', true);

// --- All the way in, which is where it was reported ---------------------------------------
const zoomIn = page.locator('button[aria-label="Zoom in"]');
for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(50);
}
await page.waitForTimeout(400);
await page.locator('button[aria-label="Back to start"]').click();
await page.waitForTimeout(400);

const deep = await measure('zoomed');
set('playbackZoomedIn', deep);
set('costOfZoomingIn', {
  medianMs: deep.medianGapMs - fitted.medianGapMs,
  hitches: deep.hitches - fitted.hitches,
});

check('itPlayedZoomedInToo', deep.clock !== '0:00.000', true);

/*
  What these numbers are, and what they are not.

  Measured on this fixture under six-times throttling, playing zoomed all the way in, before
  and after the ruler and the audio came out of the scrolled content:

                        median   p95   worst   hitches
      before              35ms   93ms   238ms      22
      after               33ms   70ms   ~110ms     19

  The tail is what "jumpy" means. A frame that takes 238ms is a quarter-second freeze you
  can see, and those came from a hundred DOM operations landing in one frame every time the
  ruler's window slid a page. There is no window now and nothing to slide, so the periodic
  hitch has nowhere to come from.

  The median barely moved, and it is honest to say so: playing zoomed in still costs about
  twice what playing fitted does, and the reason is not in this app's code — with the whole
  timeline removed from the page the floor is still 20ms a frame here. The thresholds below
  sit where the measurements actually are, not where they ought to be, so that a regression
  fails here rather than in someone's hands, and so that nobody mistakes this for solved.
*/
check('noSingleStallIsVisibleAsAFreeze', deep.worstGapMs < 200, true);
check('andTheTailIsNotFullOfThem', deep.p95GapMs < 85, true);
check('playbackIsNotHitchy', deep.hitches <= 26, true);
// The strips are the size of the screen now, so a scroll neither builds nor destroys any of
// them. Any mutation here is the periodic rebuild coming back.
check('theStripsAreNotRebuiltWhilePlaying', deep.rulerMutations + deep.waveMutations, 0);
check('norIsTheLane', deep.laneMutations, 0);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
