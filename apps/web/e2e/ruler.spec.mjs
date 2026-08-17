import { APP_URL, artifact, ensureClip, launch, makeReport } from './harness.mjs';

/**
 * The ruler, at the zoom where a fine cut is actually made.
 *
 * The ladder itself — which step at which zoom, what each mark is called, where it sits on
 * a 29.97 recording — is decided by a pure function and tested exactly in `test/ruler.test.ts`.
 * There is no point restating any of that here.
 *
 * What needs a browser is the part that is about the *page*: that the zoom really goes as
 * far in as it claims, that the marks are painted where the arithmetic put them, that a
 * ruler over frames does not turn into ten thousand DOM nodes the moment you zoom in, and
 * that tapping one still takes you there. The last of those is the reason the ruler exists.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(600);

/** Everything the ruler is currently saying, with where it says it. */
const readRuler = () =>
  page.evaluate(() => {
    const scroller = document.querySelector('.timeline-scroller');
    const marks = [...document.querySelectorAll('.ruler .tick')].map((tick) => ({
      label: tick.textContent ?? '',
      left: Number.parseFloat(tick.style.left),
      minor: tick.classList.contains('minor'),
    }));
    marks.sort((a, b) => a.left - b.left);

    /*
      The scale, read off the ruler itself rather than taken from the component.

      Two consecutive second labels are one second apart by definition, so the distance
      between them *is* pixels-per-second — and measuring it this way means the frame-gap
      check below is comparing the ruler against itself rather than against a number the
      same code produced.
    */
    const seconds = marks.filter((mark) => /^\d+:\d\d$/.test(mark.label));
    const pxPerSecond =
      seconds.length > 1 ? (seconds.at(-1).left - seconds[0].left) / (seconds.length - 1) : 0;

    return {
      viewportPx: scroller.clientWidth,
      pxPerSecond,
      count: marks.length,
      labels: marks.filter((mark) => !mark.minor).map((mark) => mark.label),
      gaps: marks.slice(1).map((mark, index) => mark.left - marks[index].left),
      minors: marks.filter((mark) => mark.minor).map((mark) => mark.left),
    };
  });

// --- Fitted, the ruler counts seconds ----------------------------------------------------
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(300);
const fitted = await readRuler();
set('fitted', { labels: fitted.labels, count: fitted.count });
check('fittedRulerCountsSeconds', fitted.labels.every((label) => /^\d+:\d\d$/.test(label)), true);
check('andHasNoFrameMarksToTripOver', fitted.minors.length, 0);

// --- All the way in ----------------------------------------------------------------------
const zoomIn = page.locator('button[aria-label="Zoom in"]');
for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(60);
}
check('theZoomStops', await zoomIn.isDisabled(), true);

// Away from time zero, where the ruler is clipped by the start of the edit and would
// flatter itself.
await page.evaluate(() => {
  const scroller = document.querySelector('.timeline-scroller');
  scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 }));
  scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) * 0.4;
});
await page.waitForTimeout(900);

const deep = await readRuler();
set('deep', { pxPerSecond: Math.round(deep.pxPerSecond), labels: deep.labels, count: deep.count });

/*
  As far in as it goes is a third of a second across the screen — ten frames on a phone at
  30fps, which is far enough apart that a thumb can land on the one it meant. Stated as a
  fraction of the viewport rather than as a pixel rate, because that is what it means.
*/
const secondsOnScreen = deep.viewportPx / deep.pxPerSecond;
set('secondsOnScreenAtFullZoom', Number(secondsOnScreen.toFixed(3)));
check('aboutAThirdOfASecondFillsTheScreen', secondsOnScreen > 0.28 && secondsOnScreen < 0.4, true);

// The whole complaint: at this zoom the old ruler had two labels, both of them timecode.
check('theRulerCountsFrames', deep.labels.some((label) => /^\d+f$/.test(label)), true);
check('andStillMarksTheSecond', deep.labels.some((label) => /^\d+:\d\d$/.test(label)), true);
check('thereIsAFrameGrid', deep.minors.length > 5, true);

/*
  Every mark is one frame from the next — labelled and unlabelled alike, since a label sits
  on a frame too. Measured off the DOM rather than computed, because the point of this check
  is that what is *painted* is a frame grid: a planner that was right and a stylesheet that
  put the marks somewhere else would look exactly like a ruler that lies.
*/
const expectedGap = deep.pxPerSecond / 30;
set('frameGapPx', {
  smallest: Math.round(Math.min(...deep.gaps)),
  largest: Math.round(Math.max(...deep.gaps)),
  expected: Math.round(expectedGap),
});
check('theMarksAreOneFrameApart', deep.gaps.every((gap) => Math.abs(gap - expectedGap) < 1.5), true);

/*
  Windowed. A twelve-second clip at full zoom is fourteen thousand pixels of ruler, and a
  ruler that built every frame of it would put four hundred nodes on the page and rebuild
  them on every scroll event — which is the cost that made scrubbing unusable in the first
  place. Only what is near the screen is built.
*/
check('theRulerIsWindowed', deep.count < 200, true);

/*
  Enough numbers on screen to read without counting across the whole viewport.

  This is the check that caught the first version. The arithmetic was right and every unit
  test passed, and on the phone the ruler showed one number and a row of anonymous marks —
  because a label spacing chosen for the zoom where frames *start* being counted is far too
  wide for the zoom where you are actually placing the cut.
*/
const onScreen = await page.evaluate(() => {
  const box = document.querySelector('.timeline-scroller').getBoundingClientRect();
  return [...document.querySelectorAll('.ruler .tick:not(.minor)')].filter((tick) => {
    const at = tick.getBoundingClientRect();
    return at.left >= box.left && at.right <= box.right;
  }).length;
});
set('labelsOnScreenAtFullZoom', onScreen);
check('enoughNumbersToReadTheRulerBy', onScreen >= 2, true);
await page.screenshot({ path: artifact('ruler-frames.png') });

// --- It still takes you there ------------------------------------------------------------
const before = await page.locator('.timeline-clock').innerText();
await page.evaluate(() => {
  const marks = [...document.querySelectorAll('.ruler .tick')].filter((tick) => /f$/.test(tick.textContent ?? ''));
  const target = marks[marks.length - 1];
  const box = target.getBoundingClientRect();
  document
    .querySelector('.ruler')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left, clientY: box.top + 4 }));
});
await page.waitForTimeout(700);
const after = await page.locator('.timeline-clock').innerText();
set('clock', { before, after });
check('tappingAFrameMarkGoesThere', before !== after, true);

// --- And the lane did not lose its place --------------------------------------------------
const settled = await readRuler();
check('theRulerFollowedTheScroll', settled.labels.length > 0, true);
check('andIsStillWindowed', settled.count < 200, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
