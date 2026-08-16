import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The per-clip tools: Transform, Speed, Duplicate.
 *
 * Each is a sheet holding a draft that becomes one op, and each has a claim that can only
 * be checked in a browser:
 *
 *  - **Transform** builds a *move*. The flow it exists for is "add a key, scrub forward,
 *    adjust" — and the thing that makes it work is that the second adjustment creates a
 *    second keyframe rather than editing the first. That is asserted on the EDL, and the
 *    preview element's own `transform` is checked too, because a framing you cannot see
 *    while you set it is a framing you are setting blind.
 *  - **Speed** has a bent slider: four fifths of the track covers 0.1x–5x. The check is
 *    that the fine half really is fine — a step in the middle must move the speed by
 *    hundredths, not by whole multiples.
 *  - **Duplicate** copies the finished shot, not the raw footage, which is the whole
 *    reason it is not an insert.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Three clips, so a duplicate has somewhere to land and an index to be checked against.
for (const fraction of [0.35, 0.7]) {
  await scrubTo(page, fraction);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(150);
}
check('threeClips', await page.locator('.clip-block').count(), 3);

const openTool = async (name) => {
  await page.locator('button[aria-label="Clip tools"]').click();
  await page.locator('.sheet.clip-menu').waitFor({ timeout: 5000 });
  await page.locator(`.sheet.clip-menu .row-link:has-text("${name}")`).click();
};

const effectsOf = (edl, index, type) =>
  edl.timeline.tracks[0].clips[index].effects.filter((effect) => effect.type === type);

// --- Transform: a move, built the way an editor builds one ------------------------------
await scrubTo(page, 0.05);
await page.waitForTimeout(400);
await page.locator('.clip-block').first().click();
await openTool('Transform');
await page.locator('.sheet.transform').waitFor({ timeout: 5000 });

const keyline = page.locator('.keyline input[type=range]');
const slider = (name) => page.locator(`.sheet.transform input[aria-label="${name}"]`);

check('itStartsWithNoKeyframes', await page.locator('.keyline .key').count(), 0);

// Frame the head of the shot, which drops the first key.
await keyline.fill('0');
await slider('Zoom').fill('100');
await page.waitForTimeout(150);
await page.locator('.sheet.transform button:has-text("Add key")').click();
await page.waitForTimeout(150);
check('addingAKeyMarksTheStrip', await page.locator('.keyline .key').count(), 1);

// Scrub forward inside the clip and change the framing. This must become a *second* key.
await keyline.fill('900');
await page.waitForTimeout(200);
await slider('Zoom').fill('160');
await slider('Pan across').fill('12');
await page.waitForTimeout(200);
set('keysAfterSecondAdjustment', await page.locator('.keyline .key').count());
check('adjustingLaterMakesItsOwnKey', await page.locator('.keyline .key').count(), 2);

// The preview shows the framing while it is being set — the element's own transform.
const liveTransform = await page.evaluate(
  () => getComputedStyle(document.querySelector('.player video.live')).transform,
);
set('previewTransform', liveTransform);
check('thePreviewIsFramedWhileYouFrameIt', liveTransform !== 'none', true);
await page.screenshot({ path: artifact('transform-sheet.png') });

await page.locator('.sheet.transform .sheet-actions .primary').click();
await page.waitForTimeout(400);

const framed = await exportEdl(page, 'tools-transform.json');
const move = effectsOf(framed, 0, 'transform')[0];
set('transformKeyframes', move?.keyframes?.map((k) => ({ t: k.t, scale: k.value.scale })));
check('theMoveIsInTheEdl', move?.keyframes?.length, 2);
check('andItGoesFromWhereToWhere', move.keyframes[1].value.scale > move.keyframes[0].value.scale, true);
// Clip-relative, because a shot's move belongs to the shot rather than to where it sits.
check('keyframesAreClipRelative', move.keyframes[0].t, 0);
check('andTheSecondIsInsideTheClip', move.keyframes[1].t <= framed.timeline.tracks[0].clips[0].sourceOut, true);
// One op for the whole session with the sheet, not one per slider movement.
check('oneRevisionForTheWholeMove', framed.revisions.at(-1).ops.length, 1);
check('andItIsASetTransform', framed.revisions.at(-1).ops[0].op, 'setTransform');

// --- Speed: the fine half is actually fine ---------------------------------------------
await page.locator('.clip-block').nth(1).click();
await openTool('Speed');
await page.locator('.sheet.speed').waitFor({ timeout: 5000 });

const speedSlider = page.locator('.sheet.speed input[type=range]');
const readout = () => page.locator('.speed-readout strong').innerText();

await speedSlider.fill('400'); // Middle of the fine half.
const mid = await readout();
await speedSlider.fill('401');
const nudged = await readout();
set('fineStep', { mid, nudged });
const asNumber = (text) => Number(text.replace('×', ''));
check('oneStepInTheFineHalfIsHundredths', Math.abs(asNumber(nudged) - asNumber(mid)) < 0.05, true);
check('andTheFineHalfTopsOutAtFive', asNumber(await (async () => { await speedSlider.fill('800'); return readout(); })()) <= 5.01, true);
// The far end is still reachable, which is the other half of the bargain.
await speedSlider.fill('1000');
check('theSliderStillReachesTwenty', asNumber(await readout()), 20);

// The tick marks are tappable, because a slider on a phone cannot land on exactly 2x.
await page.locator('.speed-marks .tick:has-text("2×")').click();
check('aTickSetsItExactly', asNumber(await readout()), 2);
// And the length it produces is on screen, which is the number anyone actually wants.
set('speedReadout', await page.locator('.speed-readout em').innerText());
check('itSaysWhatTheClipBecomes', /→/.test(await page.locator('.speed-readout em').innerText()), true);

await page.locator('.sheet.speed .sheet-actions .primary').click();
await page.waitForTimeout(400);

const retimed = await exportEdl(page, 'tools-speed.json');
set('speeds', retimed.timeline.tracks[0].clips.map((c) => c.speed));
check('theSpeedIsInTheEdl', retimed.timeline.tracks[0].clips[1].speed, 2);
check('andOnlyOnThatClip', retimed.timeline.tracks[0].clips[0].speed, 1);

// --- Duplicate: the finished shot, twice ------------------------------------------------
// The first clip carries a move and a grade, so "did the copy bring them" has an answer.
await page.locator('.clip-block').first().click();
await openTool('Adjust');
await page.locator('.sheet.adjust').waitFor({ timeout: 5000 });
await page.locator('.sheet.adjust input[aria-label^="Saturation"]').fill('45');
await page.locator('.sheet.adjust .sheet-actions .primary').click();
await page.waitForTimeout(400);

await page.locator('.clip-block').first().click();
await page.locator('button[aria-label="Clip tools"]').click();
await page.locator('.sheet.clip-menu').waitFor({ timeout: 5000 });
await page.locator('.sheet.clip-menu button:has-text("To the start")').click();
await page.waitForTimeout(500);

const copied = await exportEdl(page, 'tools-duplicate.json');
const clipsNow = copied.timeline.tracks[0].clips;
set('clipCountAfterDuplicate', clipsNow.length);
check('thereIsOneMoreClip', clipsNow.length, 4);
check('theCopyIsAtTheHead', clipsNow[0].start, 0);
check('andItIsTheSameFootage', clipsNow[0].sourceIn, clipsNow[1].sourceIn);
// The point of duplicating rather than inserting: it is the *finished* shot.
check('theCopyBroughtTheGrade', effectsOf(copied, 0, 'color').length, 1);
check('andTheMove', effectsOf(copied, 0, 'transform')[0]?.keyframes?.length, 2);
// Its own ids, or editing one edits both.
check('withItsOwnClipId', clipsNow[0].id !== clipsNow[1].id, true);
check('andItsOwnEffectIds', effectsOf(copied, 0, 'color')[0].id !== effectsOf(copied, 1, 'color')[0].id, true);

// --- And it survives a reload ------------------------------------------------------------
await page.waitForTimeout(700);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);

const reopened = await exportEdl(page, 'tools-reload.json');
set('afterReload', {
  clips: reopened.timeline.tracks[0].clips.length,
  keys: effectsOf(reopened, 0, 'transform')[0]?.keyframes?.length,
  speed: reopened.timeline.tracks[0].clips[2].speed,
});
check('everythingSurvivedTheReload', reopened.timeline.tracks[0].clips.length, 4);
check('theMoveSurvived', effectsOf(reopened, 0, 'transform')[0]?.keyframes?.length, 2);
check('theSpeedSurvived', reopened.timeline.tracks[0].clips[2].speed, 2);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
