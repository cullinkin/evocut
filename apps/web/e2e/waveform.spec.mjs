import { APP_URL, artifact, ensureClip, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The audio lane.
 *
 * The mapping — output time to source time, through trims and speed changes — is arithmetic
 * and is tested exactly in `test/waveform.test.ts`. What needs a browser is everything that
 * decides whether it is *visible*: that the canvases are actually painted rather than left
 * blank, that they are tiled instead of one impossible canvas per clip, that the picture
 * lane above them did not lose any height to make room, and that none of it costs anything
 * while scrolling.
 *
 * The fixture's audio is a tone that stops and starts, so "did it draw" and "did it draw
 * the right shape" are different questions with different answers.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// The lane is drawn from the signals pass, which decodes the audio in the background.
await page.locator('canvas.wave-lane').waitFor({ timeout: 60000 });
/*
  Wait for *level* pixels, not merely for pixels. The bed is drawn as soon as there is a
  timeline; the levels arrive only when the signals pass has decoded the audio, which takes
  seconds. Waiting for "something that is not the top-left colour" was satisfied by the bed
  itself — so every reading below was taken before the audio existed.
*/
await page.waitForFunction(
  () => {
    const canvas = document.querySelector('canvas.wave-lane');
    if (!canvas?.width) return false;
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--wave-ink').trim();
    const want = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let at = 0; at < data.length; at += 4) {
      if (
        data[at + 3] > 0 &&
        Math.abs(data[at] - want[0]) < 24 &&
        Math.abs(data[at + 1] - want[1]) < 24 &&
        Math.abs(data[at + 2] - want[2]) < 24
      ) {
        return true;
      }
    }
    return false;
  },
  { timeout: 60000 },
);
await page.waitForTimeout(400);

/**
 * How much ink is in the lane, and how tall it gets.
 *
 * One canvas the size of the viewport now, painted from the scroll position rather than
 * tiled across the content — so this reads the pixels of what is on screen. Ink is anything
 * that is not the bed colour, which the top-left corner is guaranteed to be at any scroll
 * position where the edit has started.
 */
const readLane = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas.wave-lane');
    const { data, width, height } = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);

    /*
      Ink is the level colour, taken from the stylesheet rather than guessed from the
      picture. Guessing it as "the commonest colour" reads the *ink* as the bed wherever the
      sound is loud enough to fill the lane, which is precisely where a waveform is doing
      its job.
    */
    const hex = getComputedStyle(document.documentElement).getPropertyValue('--wave-ink').trim();
    const want = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    const near = (at) =>
      data[at + 3] > 0 &&
      Math.abs(data[at] - want[0]) < 24 &&
      Math.abs(data[at + 1] - want[1]) < 24 &&
      Math.abs(data[at + 2] - want[2]) < 24;

    let ink = 0;
    let highest = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (!near(at)) continue;
      ink += 1;
      const row = Math.floor(at / 4 / width);
      highest = Math.max(highest, Math.abs(height / 2 - row));
    }

    const lane = canvas.getBoundingClientRect();
    const clips = document.querySelector('.clip-block').getBoundingClientRect();
    return {
      ink,
      tallest: Math.round((highest / (height / 2)) * 100) / 100,
      canvasCssWidth: Math.round(lane.width),
      viewportPx: document.querySelector('.timeline-scroller').clientWidth,
      laneHeight: Math.round(lane.height),
      clipHeight: Math.round(clips.height),
      // The audio sits under the picture, not over it.
      below: lane.top >= clips.bottom - 1,
    };
  });

const lane = await readLane();
set('lane', lane);
check('theLaneIsPainted', lane.ink > 200, true);
// Mirrored about the centre and reaching most of the way up somewhere: a lane drawn at a
// constant tiny height would pass "is painted" while showing nothing you could read.
check('withRealDynamicRange', lane.tallest > 0.5, true);
check('theAudioSitsUnderThePicture', lane.below, true);
// Compressed to make room, not stretched over it: the preview keeps its height.
check('thePictureLaneMadeRoom', lane.clipHeight <= 52, true);
check('andTheAudioLaneGotIt', lane.laneHeight >= 28, true);
check('thePreviewKeptItsHeight', (await page.locator('.stage').boundingBox()).height > 150, true);
await page.screenshot({ path: artifact('waveform.png') });

// --- Cutting moves it ------------------------------------------------------------------
/**
 * The lane is a function of the *edit*, not of the recording.
 *
 * A clip dropped from the timeline takes its audio off the lane with it, which is the
 * property that makes the waveform worth looking at while cutting: what you see is what the
 * export will contain.
 */
await scrubTo(page, 0.5);
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.waitForTimeout(300);
// The *second* half, deliberately. The fixture's audio is a tone for four seconds, two
// seconds of silence, then a tone with beats — so dropping the front would take away all
// the ink and "it went to zero" would prove nothing about the mapping. Dropping the back
// half has to leave the front half's tone exactly where it was.
await page.locator('.clip-block').nth(1).tap();
await page.waitForTimeout(200);
const before = await readLane();
await page.locator('button[aria-label="Drop clip"]').click();
await page.waitForTimeout(700);
const after = await readLane();

set('inkBeforeDrop', before.ink);
set('inkAfterDrop', after.ink);
check('droppingAClipTakesItsAudioWithIt', after.ink < before.ink, true);
check('andLeavesTheRestOfTheEditAlone', after.ink > 0, true);

// --- Zoomed in, it tiles rather than growing without bound ------------------------------
const zoomIn = page.locator('button[aria-label="Zoom in"]');
for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(60);
}
await page.waitForTimeout(500);

const deep = await readLane();
const contentPx = await page.evaluate(() =>
  Math.round(document.querySelector('.timeline-content').getBoundingClientRect().width),
);
set('zoomed', { canvasCssWidth: deep.canvasCssWidth, viewportPx: deep.viewportPx, contentPx });
/*
  The lane is the size of the screen, not the size of the edit.

  It was tiled canvases positioned in content space, which scrolled natively and cost
  nothing to move — except that painting them as they came into view was measured at eight
  milliseconds a frame during playback, the largest single cost in the editor. One canvas a
  little wider than the viewport, painted from the scroll position, has no such cost.
*/
check('theLaneIsTheSizeOfTheScreen', deep.canvasCssWidth < deep.viewportPx + 600, true);
check('andHasNoTilesOfItsOwn', await page.locator('.wave-tile').count(), 0);
check('evenThoughTheContentIsEnormous', contentPx > 4000, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
