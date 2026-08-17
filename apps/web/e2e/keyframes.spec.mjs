import { APP_URL, ensureClip, exportEdl, launch, makeReport, openClipTool, scrubTo } from './harness.mjs';

/**
 * Where a keyframe actually lands.
 *
 * The existing coverage counted keys and stopped there — "adjusting later makes its own
 * key" — which is true and says nothing about *when*. Reported from a real session:
 *
 *   "They don't seem to drop where I tell them to, instead they are offset a bit, and then
 *   if I try moving along the timeline, zooming in to drop another, it just doesn't. The
 *   whole clip seems to be set at that zoom then instead of in a new keyframe."
 *
 * Three separate claims, and a count cannot tell any of them apart from working. So this
 * spec reads the times out of the EDL and compares them to where the playhead was.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Three clips, so "the playhead has left the clip you are framing" is reachable.
for (const fraction of [0.33, 0.66]) {
  await scrubTo(page, fraction);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(200);
}
check('threeClipsToFrame', await page.locator('.clip-block').count(), 3);

const playheadUs = () =>
  page.evaluate(() => {
    const text = document.querySelector('.timeline-clock').textContent ?? '0:00.000';
    const [minutes, rest] = text.split(':');
    return Math.round((Number(minutes) * 60 + Number(rest)) * 1_000_000);
  });

const keysOf = (edl, index) =>
  edl.timeline.tracks[0].clips[index].effects.find((effect) => effect.type === 'transform')?.keyframes ?? [];

const slider = (name) => page.locator(`.panel.transform input[aria-label="${name}"]`);
const tab = (name) => page.locator(`.panel.transform .tab:has-text("${name}")`);

// --- Open on the middle clip -------------------------------------------------------------
await scrubTo(page, 0.45);
await page.waitForTimeout(300);
await page.locator('.clip-block').nth(1).tap();
await page.waitForTimeout(200);
await openClipTool(page, 'Transform');
await page.locator('.panel.transform').waitFor({ timeout: 5000 });

// --- A key lands where the playhead is ---------------------------------------------------
const firstAt = await playheadUs();
await tab('Zoom').click();
await slider('Zoom').fill('140');
await page.waitForTimeout(250);

/*
  Zoom in hard before moving. This is the condition the report was made under, and it is not
  decoration: the panel used to treat two keyframes within 66ms of each other as the same
  one, which at the old maximum zoom was a sliver of the screen and at this one is a fifth
  of it. Everything below is measured at the zoom where the difference shows.
*/
for (let i = 0; i < 8; i += 1) {
  await page.locator('button[aria-label="Zoom in"]').click();
  await page.waitForTimeout(50);
}
await page.waitForTimeout(200);

// A small nudge along the lane — a few hundred milliseconds, which at this zoom is most of
// the screen and is exactly the "move along a bit and drop another" gesture.
const nudge = await page.evaluate(() => {
  const scroller = document.querySelector('.timeline-scroller');
  const box = scroller.getBoundingClientRect();
  scroller.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
  );
  scroller.scrollLeft += 150;
  return scroller.scrollLeft;
});
await page.waitForTimeout(400);
set('nudgedTo', nudge);

const secondAt = await playheadUs();
set('playheads', { first: firstAt, second: secondAt, apartMs: (secondAt - firstAt) / 1000 });
check('theNudgeMovedThePlayhead', secondAt > firstAt, true);

await slider('Zoom').fill('220');
await page.waitForTimeout(250);
set('keyCountInPanel', await page.locator('.panel.transform .panel-title em').innerText());

await page.locator('.panel.transform button[aria-label="Done"]').click();
await page.waitForTimeout(400);

const edl = await exportEdl(page, 'keyframes.json');
const keys = keysOf(edl, 1);
const clipStartUs = edl.timeline.tracks[0].clips[1].start;
set('keys', keys.map((key) => ({ t: key.t, scale: key.value.scale })));
set('clipStartUs', clipStartUs);

// Two adjustments at two different moments are two keyframes. The report was that the
// second one silently became a rewrite of the first, which is a static reframe of the
// whole shot rather than a move.
check('twoAdjustmentsAreTwoKeyframes', keys.length, 2);
check('andTheyHoldTheTwoValues', [keys[0]?.value.scale, keys[1]?.value.scale], [1.4, 2.2]);

// And they sit where the playhead was, in clip-relative time.
const wanted = [firstAt - clipStartUs, secondAt - clipStartUs];
const landed = keys.map((key) => key.t);
set('wantedVsLanded', { wanted, landed });
check(
  'eachKeyLandedWhereItWasDropped',
  landed.every((t, index) => Math.abs(t - wanted[index]) <= 40_000),
  true,
);

// --- A move built from nudges smaller than the old tolerance -----------------------------
/**
 * Three adjustments a frame or two apart are three keyframes.
 *
 * The zoom that made this fail is the one the ruler work opened up: a third of a second
 * across a phone. A nudge of 40 pixels there is under 40ms, which the old rule counted as
 * "the same keyframe" — so the second adjustment overwrote the first and the third
 * overwrote the second, and what looked like building a move left one static reframe.
 */
// On the *first* clip, which has no keys yet — each section of this spec has to start from
// a known state or a carried-over key makes the next assertion mean something else.
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(300);
await scrubTo(page, 0.12);
await page.waitForTimeout(300);
await page.locator('.clip-block').first().tap();
await page.waitForTimeout(200);
await openClipTool(page, 'Transform');
await page.locator('.panel.transform').waitFor({ timeout: 5000 });
for (let i = 0; i < 8; i += 1) {
  await page.locator('button[aria-label="Zoom in"]').click();
  await page.waitForTimeout(50);
}
await page.waitForTimeout(250);
await tab('Zoom').click();

const nudged = [];
for (const [index, scale] of [120, 180, 260].entries()) {
  if (index > 0) {
    await page.evaluate(() => {
      const scroller = document.querySelector('.timeline-scroller');
      const box = scroller.getBoundingClientRect();
      scroller.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
      );
      scroller.scrollLeft += 40;
    });
    await page.waitForTimeout(400);
  }
  nudged.push(await playheadUs());
  await slider('Zoom').fill(String(scale));
  await page.waitForTimeout(250);
}
set('nudgeApartMs', [nudged[1] - nudged[0], nudged[2] - nudged[1]].map((us) => Math.round(us / 1000)));
await page.locator('.panel.transform button[aria-label="Done"]').click();
await page.waitForTimeout(400);

const small = await exportEdl(page, 'keyframes-nudges.json');
const smallKeys = keysOf(small, 0);
set('keysFromNudges', smallKeys.map((key) => ({ t: key.t, scale: key.value.scale })));
check('everyAdjustmentIsItsOwnKey', smallKeys.length, 3);
check('andNoneOfTheValuesWereLost', smallKeys.map((key) => key.value.scale), [1.2, 1.8, 2.6]);
// On frame boundaries, because a key between frames is a key whose value is never sampled.
const frameUs = 1_000_000 / (small.timeline.frameRate.num / small.timeline.frameRate.den);
check(
  'andTheyLandOnFrames',
  smallKeys.every((key) => Math.abs(key.t / frameUs - Math.round(key.t / frameUs)) < 0.001),
  true,
);

// --- The panel follows the playhead off the clip -----------------------------------------
/**
 * The one that did real damage, silently.
 *
 * The panel opened on a clip and stayed pinned to it while the timeline underneath stayed
 * live. Scrub into another shot, adjust, and the write was *clamped* into the clip you had
 * left — a keyframe on its last frame, which as the only key on that clip is a static
 * reframe of a whole shot you were not looking at. Nothing on screen said so.
 */
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(300);
await scrubTo(page, 0.12);
await page.waitForTimeout(300);
await page.locator('.clip-block').first().tap();
await page.waitForTimeout(200);
await openClipTool(page, 'Transform');
await page.locator('.panel.transform').waitFor({ timeout: 5000 });

await scrubTo(page, 0.92);
await page.waitForTimeout(400);
const landedIn = await playheadUs();
set('panelTitleAfterCrossing', await page.locator('.panel.transform .panel-title').innerText());
check('thePanelFollowedToTheNewClip', /Clip 3/.test(await page.locator('.panel.transform .panel-title').innerText()), true);

await tab('Zoom').click();
await slider('Zoom').fill('300');
await page.waitForTimeout(250);
await page.locator('.panel.transform button[aria-label="Done"]').click();
await page.waitForTimeout(400);

const crossed = await exportEdl(page, 'keyframes-crossed.json');
set('keysPerClipAfterCrossing', crossed.timeline.tracks[0].clips.map((_, index) => keysOf(crossed, index).length));
// The adjustment belongs to the clip that was on screen when it was made.
check('theAdjustmentLandedOnTheClipUnderThePlayhead', keysOf(crossed, 2).length, 1);
// And nothing was written onto the clip the panel was opened on.
check('andTheClipItLeftKeptWhatItHad', keysOf(crossed, 0).length, 3);

const thirdStart = crossed.timeline.tracks[0].clips[2].start;
set('crossedKey', { at: keysOf(crossed, 2)[0]?.t, wanted: landedIn - thirdStart });
check(
  'andItLandedWhereThePlayheadWas',
  Math.abs((keysOf(crossed, 2)[0]?.t ?? -1) - (landedIn - thirdStart)) <= 40_000,
  true,
);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
