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
await page.locator('.wave-tile').first().waitFor({ timeout: 60000 });
await page.waitForTimeout(600);

/** How much ink is in the lane, and where. */
const readLane = () =>
  page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.wave-tile')];
    const painted = tiles.map((canvas) => {
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      let highest = 0;
      for (let at = 3; at < data.length; at += 4) {
        if (data[at] === 0) continue;
        ink += 1;
        const row = Math.floor(at / 4 / canvas.width);
        highest = Math.max(highest, Math.abs(canvas.height / 2 - row));
      }
      return { ink, tallest: Math.round((highest / (canvas.height / 2)) * 100) / 100 };
    });
    const lane = document.querySelector('.wave-lane').getBoundingClientRect();
    const clips = document.querySelector('.clip-block').getBoundingClientRect();
    return {
      tiles: tiles.length,
      painted,
      laneHeight: Math.round(lane.height),
      clipHeight: Math.round(clips.height),
      // The audio sits under the picture, not over it.
      below: lane.top >= clips.bottom - 1,
    };
  });

const lane = await readLane();
set('lane', lane);
check('theLaneIsThere', lane.tiles > 0, true);
check('andItIsPainted', lane.painted.some((tile) => tile.ink > 200), true);
// Mirrored about the centre and reaching most of the way up somewhere: a lane drawn at a
// constant tiny height would pass "is painted" while showing nothing you could read.
check('withRealDynamicRange', Math.max(...lane.painted.map((tile) => tile.tallest)) > 0.5, true);
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

const ink = (lane) => lane.painted.reduce((sum, tile) => sum + tile.ink, 0);
set('inkBeforeDrop', ink(before));
set('inkAfterDrop', ink(after));
check('droppingAClipTakesItsAudioWithIt', ink(after) < ink(before), true);
check('andLeavesTheRestOfTheEditAlone', ink(after) > 0, true);

// --- Zoomed in, it tiles rather than growing without bound ------------------------------
const zoomIn = page.locator('button[aria-label="Zoom in"]');
for (let i = 0; i < 20 && !(await zoomIn.isDisabled()); i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(60);
}
await page.waitForTimeout(500);

const deep = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.wave-tile')];
  return {
    tiles: tiles.length,
    widest: Math.max(...tiles.map((canvas) => canvas.width)),
    contentPx: Math.round(document.querySelector('.timeline-content').getBoundingClientRect().width),
  };
});
set('zoomed', deep);
// A canvas per clip would be tens of thousands of pixels wide here — past what a canvas can
// be — so the lane is tiled and windowed instead.
check('theLaneIsTiled', deep.widest <= 2048, true);
check('andOnlyNearTheViewport', deep.tiles < 24, true);
check('eventThoughTheContentIsEnormous', deep.contentPx > 4000, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
