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

const openTool = (label) => page.locator(`nav.toolbar button[aria-label="${label}"]`).click();

const effectsOf = (edl, index, type) =>
  edl.timeline.tracks[0].clips[index].effects.filter((effect) => effect.type === type);

/*
  --- Transform: a move, built the way an editor builds one ------------------------------

  On the *second* clip deliberately. Keyframe times are clip-relative, and on the first clip
  — which starts at zero — clip-relative and absolute are the same number, so a spec that
  frames clip one cannot tell the two apart and will pass either way.
*/
await scrubTo(page, 0.4);
await page.waitForTimeout(400);
await page.locator('.clip-block').nth(1).click();
await openTool('Transform');
await page.locator('.panel.transform').waitFor({ timeout: 5000 });

const tab = (name) => page.locator(`.panel.transform .tab:has-text("${name}")`);
const slider = (name) => page.locator(`.panel.transform input[aria-label="${name}"]`);
const keyCount = async () => {
  const text = await page.locator('.panel-title em').innerText();
  const found = /(\d+) key/.exec(text);
  return found ? Number(found[1]) : 0;
};

/*
  The panel replaces the toolbar rather than covering the timeline, which is the point of
  the layout: the preview keeps its height, and the timeline is still there to scrub with.
*/
check('theTimelineIsStillUsable', await page.locator('.timeline-scroller').isVisible(), true);
check('andThePreviewIsStillOnScreen', await page.locator('.player video.live').isVisible(), true);
check('theToolbarStoodAside', await page.locator('nav.toolbar').count(), 0);
check('itStartsWithNoKeyframes', await keyCount(), 0);

// Frame the head of the shot, which drops the first key.
await page.locator('.panel.transform button[aria-label="Add keyframe"]').click();
await page.waitForTimeout(150);
check('addingAKeyIsCounted', await keyCount(), 1);
await tab('Zoom').click();
await slider('Zoom').fill('100');
await page.waitForTimeout(150);

// Scrub with the real timeline — the panel has no clock of its own — then adjust. That
// adjustment must become a *second* key rather than editing the first.
await scrubTo(page, 0.55);
await page.waitForTimeout(250);
await slider('Zoom').fill('160');
await tab('Position').click();
await slider('X axis').fill('12');
await page.waitForTimeout(200);
set('keysAfterSecondAdjustment', await keyCount());
check('adjustingLaterMakesItsOwnKey', await keyCount(), 2);

// Undo and redo walk the panel's own draft, so a nudge too far costs one tap.
await page.locator('.panel.transform button[aria-label="Undo framing"]').click();
await page.waitForTimeout(150);
const undone = await slider('X axis').inputValue();
await page.locator('.panel.transform button[aria-label="Redo framing"]').click();
await page.waitForTimeout(150);
set('undoRedo', { undone, redone: await slider('X axis').inputValue() });
check('undoTookTheNudgeBack', undone !== '12', true);
check('andRedoPutItBack', await slider('X axis').inputValue(), '12');

// The preview shows the framing while it is being set — the element's own transform.
const liveTransform = await page.evaluate(
  () => getComputedStyle(document.querySelector('.player video.live')).transform,
);
set('previewTransform', liveTransform);
check('thePreviewIsFramedWhileYouFrameIt', liveTransform !== 'none', true);

/*
  A pan moves the picture *within* the frame, and the frame does not move.

  Reported exactly: "the position adjust menu doesn't seem to actually move the picture in
  the frame. It moves the entire frame left and right up/down in the app." The cause was
  the video simply filling the player box under `object-fit: contain`, so the picture sat
  letterboxed in black bars and translating it slid the whole picture around inside them.

  The stage is the output frame now: it holds still and clips, and the source slides behind
  it — which is what `drawLayer` does against the canvas edges.
*/
const framingGeometry = await page.evaluate(() => {
  const player = document.querySelector('.player').getBoundingClientRect();
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const video = document.querySelector('.player video.live').getBoundingClientRect();
  return {
    stage: { x: Math.round(stage.x - player.x), width: Math.round(stage.width), height: Math.round(stage.height) },
    videoOffset: Math.round(video.x - stage.x),
    clipped: getComputedStyle(document.querySelector('.stage')).overflow,
  };
});
set('framingGeometry', framingGeometry);
// The panned picture actually left the frame's left edge — otherwise nothing moved.
check('thePictureMovedInsideTheFrame', framingGeometry.videoOffset !== 0, true);
// And the frame itself is clipped, so what left the edge is gone rather than drawn beside it.
check('andTheFrameClipsRatherThanLettingItSpill', framingGeometry.clipped, 'hidden');

// Now prove the frame did not move: pan the other way and measure the stage again.
await slider('X axis').fill('-40');
await page.waitForTimeout(200);
const panned = await page.evaluate(() => {
  const player = document.querySelector('.player').getBoundingClientRect();
  const stage = document.querySelector('.stage').getBoundingClientRect();
  const video = document.querySelector('.player video.live').getBoundingClientRect();
  return {
    stageX: Math.round(stage.x - player.x),
    stageWidth: Math.round(stage.width),
    videoOffset: Math.round(video.x - stage.x),
  };
});
set('afterPanningTheOtherWay', panned);
check('theFrameItselfDidNotMove', panned.stageX, framingGeometry.stage.x);
check('norDidItChangeSize', panned.stageWidth, framingGeometry.stage.width);
// Compared rather than signed: the picture is also zoomed here, so both offsets are
// negative — what matters is that panning left moved it left.
check('butThePictureDid', panned.videoOffset < framingGeometry.videoOffset, true);
await slider('X axis').fill('12');
await page.waitForTimeout(150);

// --- Keyframes are on the timeline ------------------------------------------------------
// A key you cannot see on the lane is a key you cannot tell landed.
const keysOnLane = await page.locator('.clip-block .clip-key').count();
set('keysDrawnOnTheLane', keysOnLane);
check('keyframesShowOnTheTimeline', keysOnLane, 2);
check(
  'andOnlyOnTheClipTheyBelongTo',
  await page.locator('.clip-block').nth(1).locator('.clip-key').count(),
  2,
);
await page.screenshot({ path: artifact('transform-sheet.png') });

await page.locator('.panel.transform button[aria-label="Done"]').click();
await page.waitForTimeout(400);

const framed = await exportEdl(page, 'tools-transform.json');
const framedClip = framed.timeline.tracks[0].clips[1];
const framedLength = Math.round((framedClip.sourceOut - framedClip.sourceIn) / framedClip.speed);
const move = effectsOf(framed, 1, 'transform')[0];
set('transformKeyframes', move?.keyframes?.map((k) => ({ t: k.t, scale: k.value.scale })));
set('framedClip', { start: framedClip.start, length: framedLength });
check('theMoveIsInTheEdl', move?.keyframes?.length, 2);
check('andItGoesFromWhereToWhere', move.keyframes[1].value.scale > move.keyframes[0].value.scale, true);
/*
  Clip-relative, because a shot's move belongs to the shot rather than to where it sits.
  This clip starts well into the edit, so a keyframe recorded in timeline time would be
  larger than the clip is long — which is exactly what this rules out.
*/
check('keyframesAreClipRelative', move.keyframes.every((k) => k.t <= framedLength), true);
check('andNotTimelineTime', move.keyframes.every((k) => k.t < framedClip.start), true);
// One op for the whole session with the sheet, not one per slider movement.
check('oneRevisionForTheWholeMove', framed.revisions.at(-1).ops.length, 1);
check('andItIsASetTransform', framed.revisions.at(-1).ops[0].op, 'setTransform');

// --- Speed: the fine half is actually fine ---------------------------------------------
await page.locator('.clip-block').nth(2).click();
await openTool('Speed');
await page.locator('.panel.speed').waitFor({ timeout: 5000 });
check('theTimelineStaysUsableWhileRetiming', await page.locator('.timeline-scroller').isVisible(), true);

const speedSlider = page.locator('.panel.speed input[type=range]');
const readout = () => page.locator('.panel.speed .speed-readout strong').innerText();

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
set('speedReadout', await page.locator('.panel.speed .panel-title em').innerText());
check('itSaysWhatTheClipBecomes', /→/.test(await page.locator('.panel.speed .panel-title em').innerText()), true);

await page.locator('.panel.speed button[aria-label="Done"]').click();
await page.waitForTimeout(400);

const retimed = await exportEdl(page, 'tools-speed.json');
set('speeds', retimed.timeline.tracks[0].clips.map((c) => c.speed));
check('theSpeedIsInTheEdl', retimed.timeline.tracks[0].clips[2].speed, 2);
check('andOnlyOnThatClip', retimed.timeline.tracks[0].clips[0].speed, 1);

// --- Duplicate: the finished shot, twice ------------------------------------------------
// Clip 2 carries the move, so grading it too makes "did the copy bring them" one question.
await page.locator('.clip-block').nth(1).click();
await openTool('Adjust colour');
await page.locator('.panel.adjust').waitFor({ timeout: 5000 });
await page.locator('.panel.adjust .tab:has-text("Saturation")').click();
await page.locator('.panel.adjust input[type=range]').fill('45');
await page.locator('.panel.adjust button[aria-label="Done"]').click();
await page.waitForTimeout(400);

await page.locator('.clip-block').nth(1).click();
await page.locator('nav.toolbar button[aria-label="Duplicate clip"]').click();
await page.locator('.sheet.clip-menu').waitFor({ timeout: 5000 });
await page.locator('.sheet.clip-menu button:has-text("To the start")').click();
await page.waitForTimeout(500);

const copied = await exportEdl(page, 'tools-duplicate.json');
const clipsNow = copied.timeline.tracks[0].clips;
set('clipCountAfterDuplicate', clipsNow.length);
check('thereIsOneMoreClip', clipsNow.length, 4);
check('theCopyIsAtTheHead', clipsNow[0].start, 0);
check('andItIsTheSameFootage', clipsNow[0].sourceIn, clipsNow[2].sourceIn);
// The point of duplicating rather than inserting: it is the *finished* shot.
check('theCopyBroughtTheGrade', effectsOf(copied, 0, 'color').length, 1);
check('andTheMove', effectsOf(copied, 0, 'transform')[0]?.keyframes?.length, 2);
// Its own ids, or editing one edits both.
check('withItsOwnClipId', clipsNow[0].id !== clipsNow[2].id, true);
check('andItsOwnEffectIds', effectsOf(copied, 0, 'color')[0].id !== effectsOf(copied, 2, 'color')[0].id, true);

// --- And it survives a reload ------------------------------------------------------------
await page.waitForTimeout(700);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);

const reopened = await exportEdl(page, 'tools-reload.json');
set('afterReload', {
  clips: reopened.timeline.tracks[0].clips.length,
  keys: effectsOf(reopened, 0, 'transform')[0]?.keyframes?.length,
  speeds: reopened.timeline.tracks[0].clips.map((c) => c.speed),
});
check('everythingSurvivedTheReload', reopened.timeline.tracks[0].clips.length, 4);
check('theMoveSurvived', effectsOf(reopened, 0, 'transform')[0]?.keyframes?.length, 2);
check('theSpeedSurvived', reopened.timeline.tracks[0].clips[3].speed, 2);
// The keys are drawn from the committed effect once the panel is closed, not only from
// the draft — a restored project must show its own framing.
check('andTheKeysAreStillDrawnOnTheLane', (await page.locator('.clip-block .clip-key').count()) >= 2, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
