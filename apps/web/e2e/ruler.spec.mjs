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

/**
 * Everything the ruler is currently saying, read off the pixels.
 *
 * The ruler is a canvas now — one the size of the viewport, painted from the scroll
 * position rather than scrolled — so there are no elements to interrogate. That is the
 * better thing to assert on anyway: a planner that was right and a painter that put the
 * marks somewhere else would have passed the old DOM checks and looked wrong on the phone.
 *
 * A mark is a column of ink reaching the foot of the ruler. A *labelled* one also reaches
 * the top of the band, since it is drawn taller; the number beside it does not reach the
 * foot, which is what separates the two. What each label actually says is decided by
 * `planRuler` and asserted exactly in `test/ruler.test.ts`.
 */
const readRuler = () =>
  page.evaluate(() => {
    const scroller = document.querySelector('.timeline-scroller');
    const canvas = document.querySelector('canvas.ruler');
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / Number.parseFloat(canvas.style.width);
    const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const alphaAt = (x, cssY) => data[((Math.round(cssY * dpr) * width) + x) * 4 + 3];

    // The canvas is painted wider than the viewport and slid with a transform; measured
    // rather than parsed out of the styles, so the transform is already accounted for.
    const canvasBox = canvas.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    const originCss = canvasBox.left - scrollerBox.left;

    const marks = [];
    let previous = 0;
    for (let x = 0; x < width; x += 1) {
      const foot = alphaAt(x, 28);
      if (!foot || previous) {
        previous = foot;
        continue;
      }
      previous = foot;
      marks.push({ left: originCss + x / dpr, labelled: alphaAt(x, 13) > 0 });
    }

    return {
      viewportPx: scroller.clientWidth,
      canvasCssWidth: Math.round(canvasBox.width),
      count: marks.length,
      labelled: marks.filter((mark) => mark.labelled).length,
      minors: marks.filter((mark) => !mark.labelled).map((mark) => mark.left),
      gaps: marks.slice(1).map((mark, index) => mark.left - marks[index].left),
      onScreen: marks.filter((mark) => mark.left >= 0 && mark.left <= scroller.clientWidth).length,
      labelledOnScreen: marks.filter(
        (mark) => mark.labelled && mark.left >= 0 && mark.left <= scroller.clientWidth,
      ).length,
    };
  });

// --- Fitted, the ruler counts seconds ----------------------------------------------------
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(300);
const fitted = await readRuler();
set('fitted', { count: fitted.count, labelled: fitted.labelled });
// Fitted, every mark is a second and every second is labelled: no frame grid to trip over.
check('fittedRulerCountsSeconds', fitted.count > 0 && fitted.count === fitted.labelled, true);

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
set('deep', { count: deep.count, labelled: deep.labelled, onScreen: deep.onScreen });

/*
  As far in as it goes is a third of a second across the screen — ten frames on a phone at
  30fps, which is far enough apart that a thumb can land on the one it meant. With a mark on
  every frame, counting the marks on screen *is* counting the frames on screen.
*/
const framesOnScreen = deep.onScreen;
set('framesOnScreenAtFullZoom', framesOnScreen);
check('aboutAThirdOfASecondFillsTheScreen', framesOnScreen >= 8 && framesOnScreen <= 13, true);

// The whole complaint: at this zoom the old ruler had two marks, a second apart.
check('thereIsAFrameGrid', deep.minors.length > 5, true);
check('andSomeOfThemAreNumbered', deep.labelled > 0 && deep.labelled < deep.count, true);

/*
  Every mark is one frame from the next — labelled and unlabelled alike, since a label sits
  on a frame too. Measured off the painted pixels: the whole point is that what is *drawn*
  is an even frame grid, and a planner that was right with a painter that was not would look
  exactly like a ruler that lies.
*/
const spacing = [...deep.gaps].sort((a, b) => a - b);
const median = spacing[Math.floor(spacing.length / 2)];
set('frameGapPx', { smallest: Math.round(Math.min(...deep.gaps)), largest: Math.round(Math.max(...deep.gaps)), median: Math.round(median) });
check('theMarksAreEvenlySpaced', deep.gaps.every((gap) => Math.abs(gap - median) < 2), true);
// Ten frames across a third of a second on a phone: a mark every few dozen pixels.
check('andFarEnoughApartToAimAt', median > 20, true);

/*
  The ruler is the size of the screen, not the size of the edit.

  It used to be positioned in timeline pixels inside the scrolled content, windowed to a few
  pages so the DOM stayed bounded. Measured, that cost two thirds of a frame budget during
  playback and produced a burst of a hundred DOM operations every time the window slid. Now
  there is one canvas a little wider than the viewport, and nothing to slide.
*/
set('rulerSize', { canvasCssWidth: deep.canvasCssWidth, viewportPx: deep.viewportPx });
check('theRulerIsTheSizeOfTheScreen', deep.canvasCssWidth < deep.viewportPx + 600, true);
check('andHasNoElementsOfItsOwn', await page.locator('.ruler .tick').count(), 0);

/*
  Enough numbers on screen to read without counting across the whole viewport.

  This is the check that caught the first version. The arithmetic was right and every unit
  test passed, and on the phone the ruler showed one number and a row of anonymous marks —
  because a label spacing chosen for the zoom where frames *start* being counted is far too
  wide for the zoom where you are actually placing the cut.
*/
set('labelsOnScreenAtFullZoom', deep.labelledOnScreen);
check('enoughNumbersToReadTheRulerBy', deep.labelledOnScreen >= 2, true);
await page.screenshot({ path: artifact('ruler-frames.png') });

// --- It still takes you there ------------------------------------------------------------
const before = await page.locator('.timeline-clock').innerText();
await page.evaluate(() => {
  const ruler = document.querySelector('canvas.ruler');
  const box = document.querySelector('.timeline-scroller').getBoundingClientRect();
  ruler.dispatchEvent(
    new MouseEvent('click', { bubbles: true, clientX: box.left + box.width * 0.8, clientY: box.top - 10 }),
  );
});
await page.waitForTimeout(700);
const after = await page.locator('.timeline-clock').innerText();
set('clock', { before, after });
check('tappingAFrameMarkGoesThere', before !== after, true);

// --- And the lane did not lose its place --------------------------------------------------
const settled = await readRuler();
check('theRulerFollowedTheScroll', settled.count > 0, true);
check('andIsStillTheSizeOfTheScreen', settled.canvasCssWidth < settled.viewportPx + 600, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
