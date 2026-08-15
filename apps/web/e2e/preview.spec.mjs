import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The preview must show the *edit*, not the recording.
 *
 * Three symptoms that turn out to be one failure, reported from a real 51-clip project:
 * a black picture, playback that always starts from the beginning, and footage that was
 * cut appearing to be back. All three are what a `<video>` element playing the raw source
 * from zero looks like from the outside — the timeline is fine, and nothing on screen is
 * reading it.
 *
 * So this asserts the mapping directly, which nothing else did. Every other check in the
 * suite reads the EDL, and the EDL was never wrong.
 *
 * The fixture is deliberately shaped like the project that broke: many clips, alternating
 * ones dropped so the output is nothing like the source, and — the part that matters — the
 * whole thing reloaded from storage first, because a restored project is the case where a
 * seek can be issued before the element has metadata and silently discarded.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Eight cuts, then drop every other piece: the output timeline now shares no run of more
// than a second with the source, so "is the preview following the edit" has an answer that
// cannot be arrived at by accident.
for (const fraction of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  await scrubTo(page, fraction);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(100);
}
const cut = await page.locator('.clip-block').count();
set('clipsAfterCuts', cut);
check('enoughClipsToBeAnEdit', cut >= 8, true);

for (const index of [0, 2, 4]) {
  await page.locator('.clip-block').nth(index).click();
  await page.locator('button[aria-label="Delete clip"]').click();
  await page.waitForTimeout(200);
}

// The reload is part of the case, not tidiness: this is how the user meets their project.
await page.waitForTimeout(700);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);

const edl = await exportEdl(page, 'preview-edl.json');
const clips = edl.timeline.tracks[0].clips.filter((c) => c.enabled);
set('keptClips', clips.length);
const totalUs = clips.reduce((total, c) => total + Math.round((c.sourceOut - c.sourceIn) / c.speed), 0);
set('timelineUs', totalUs);

/** Where the timeline says the source should be at output time `us`. */
const sourceAt = (us) => {
  let at = 0;
  for (const c of clips) {
    const length = Math.round((c.sourceOut - c.sourceIn) / c.speed);
    if (us < at + length) return c.sourceIn + (us - at) * c.speed;
    at += length;
  }
  return clips.at(-1).sourceOut;
};

const videoState = () =>
  page.evaluate(() => {
    const video = document.querySelector('.player video.live');
    if (!video) return { missing: true };
    const box = video.getBoundingClientRect();
    return {
      currentTime: video.currentTime,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      width: Math.round(box.width),
      height: Math.round(box.height),
      error: video.error ? `${video.error.code}: ${video.error.message}` : null,
      paused: video.paused,
    };
  });

// --- There is a picture at all -------------------------------------------------------
const onOpen = await videoState();
set('videoOnOpen', onOpen);
check('thePlayerExists', onOpen.missing !== true, true);
check('theElementHasAPicture', onOpen.videoWidth > 0, true);
check('theElementHasSizeOnScreen', onOpen.width > 40 && onOpen.height > 40, true);
check('noMediaError', onOpen.error, null);

// The first clip does not start at the head of the recording, so an element parked at
// zero is the definitive form of "the preview is showing the raw video".
const firstSourceUs = clips[0].sourceIn;
set('firstClipStartsAtUs', firstSourceUs);
check('firstClipIsNotTheHeadOfTheSource', firstSourceUs > 500_000, true);
check(
  'openingFrameComesFromTheEdit',
  Math.abs(onOpen.currentTime * 1_000_000 - firstSourceUs) < 700_000,
  true,
);
await page.screenshot({ path: artifact('preview-on-open.png') });

/**
 * A flick must not be pulled back.
 *
 * Scrolling seeks, seeking moves the playhead, and the playhead scrolls the lane — a ring
 * that is only safe while the two halves cannot both be live. With momentum they can: the
 * finger has let go, the lane is still travelling, and the effect that parks the lane on
 * the playhead reads a position from three frames ago and hauls it back there. On a
 * desktop wheel, where a scroll is one instantaneous jump, this is invisible. On a phone,
 * where every scroll has a second of coasting, it means the timeline barely moves and the
 * preview is asked to seek a 5GB file a dozen times on the way.
 *
 * Simulated as a real browser flick would arrive: a run of positions, one per frame.
 */
const flick = await page.evaluate(async () => {
  const scroller = document.querySelector('.timeline-scroller');
  const box = scroller.getBoundingClientRect();
  scroller.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
  );
  const max = scroller.scrollWidth - scroller.clientWidth;
  const targets = [];
  for (let i = 1; i <= 12; i += 1) targets.push(Math.round((max * 0.7 * i) / 12));
  for (const target of targets) {
    scroller.scrollLeft = target;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { wanted: targets.at(-1), landed: Math.round(scroller.scrollLeft), max };
});
set('flick', flick);
check('aFlickIsNotPulledBack', Math.abs(flick.landed - flick.wanted) <= 2, true);

/** What the element is showing, against what the timeline says it should be showing. */
const pictureHere = async () => {
  const scroller = await page.evaluate(() => {
    const el = document.querySelector('.timeline-scroller');
    return { left: el.scrollLeft, max: el.scrollWidth - el.clientWidth };
  });
  const outputUs = Math.round((scroller.left / Math.max(1, scroller.max)) * totalUs);
  const state = await videoState();
  return {
    expectedSourceMs: Math.round(sourceAt(outputUs) / 1000),
    actualSourceMs: Math.round(state.currentTime * 1000),
    readyState: state.readyState,
  };
};

await page.waitForTimeout(600);
const afterFlick = await pictureHere();
set('pictureAfterFlick', afterFlick);
// The seek at the end of a gesture is exact and unthrottled, so coasting to a stop must
// leave the right frame on screen — not the last one a dropped approximate seek reached.
check('theFlickSettlesOnTheRightFrame', Math.abs(afterFlick.actualSourceMs - afterFlick.expectedSourceMs) < 900, true);
check('andTheElementIsDecodedThere', afterFlick.readyState >= 2, true);

/**
 * The same gesture at the scale a long edit is actually viewed at.
 *
 * Zoomed to fit, a nine-minute assembly is four pixels a second — a quarter of a second
 * per pixel — and a flick crosses minutes. Every ratio in the feedback ring changes with
 * the scale, so the coarse end deserves its own run rather than an argument that it is
 * the same case.
 */
const zoomOut = page.locator('button[aria-label="Zoom out"]');
for (let i = 0; i < 12 && !(await zoomOut.isDisabled()); i += 1) {
  await zoomOut.click();
  await page.waitForTimeout(60);
}
set('zoomedOutPxPerSecond', await page.evaluate(() => {
  const el = document.querySelector('.timeline-scroller');
  return Math.round(el.scrollWidth - el.clientWidth);
}));

const coarseFlick = await page.evaluate(async () => {
  const scroller = document.querySelector('.timeline-scroller');
  const box = scroller.getBoundingClientRect();
  scroller.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
  );
  const max = scroller.scrollWidth - scroller.clientWidth;
  const targets = [];
  for (let i = 1; i <= 10; i += 1) targets.push(Math.round((max * 0.8 * i) / 10));
  for (const target of targets) {
    scroller.scrollLeft = target;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { wanted: targets.at(-1), landed: Math.round(scroller.scrollLeft) };
});
set('coarseFlick', coarseFlick);
check('aFlickHoldsWhenZoomedOutToo', Math.abs(coarseFlick.landed - coarseFlick.wanted) <= 2, true);

await page.waitForTimeout(600);
const coarsePicture = await pictureHere();
set('pictureAfterCoarseFlick', coarsePicture);
check(
  'theCoarseFlickSettlesOnTheRightFrame',
  Math.abs(coarsePicture.actualSourceMs - coarsePicture.expectedSourceMs) < 900,
  true,
);

await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(500);

// --- Scrubbing lands on the mapped source time ----------------------------------------
const probes = [];
for (const fraction of [0.35, 0.7]) {
  await scrubTo(page, fraction);
  await page.waitForTimeout(900);
  const clock = await page.locator('.timeline-clock').innerText();
  const state = await videoState();
  const outputUs = Math.round(fraction * totalUs);
  probes.push({
    fraction,
    clock,
    expectedSourceMs: Math.round(sourceAt(outputUs) / 1000),
    actualSourceMs: Math.round(state.currentTime * 1000),
    rawWouldBeMs: Math.round(outputUs / 1000),
  });
}
set('scrubProbes', probes);
// Against the *mapped* time, and — separately — not merely at the raw time. A preview
// playing the recording straight through would match `rawWouldBeMs`, and on this fixture
// the two answers are seconds apart.
check('scrubbingShowsTheMappedFrame', probes.every((p) => Math.abs(p.actualSourceMs - p.expectedSourceMs) < 900), true);
check(
  'andNotTheRawRecording',
  probes.every((p) => Math.abs(p.expectedSourceMs - p.rawWouldBeMs) > 1000),
  true,
);

// --- Play resumes from where the playhead is, not from zero ----------------------------
await scrubTo(page, 0.6);
await page.waitForTimeout(800);
const parkedClock = await page.locator('.timeline-clock').innerText();
const parked = await videoState();

await page.locator('button.play').click();
await page.waitForTimeout(1400);
const during = await videoState();
const duringClock = await page.locator('.timeline-clock').innerText();
await page.locator('button.play').click();

set('clockBeforePlay', parkedClock);
set('clockDuringPlay', duringClock);
set('sourceTimeBeforePlay', Number(parked.currentTime.toFixed(2)));
set('sourceTimeDuringPlay', Number(during.currentTime.toFixed(2)));
check('playbackActuallyStarted', during.currentTime !== parked.currentTime, true);
// The failure being guarded: playback that restarts the recording from its head, which
// looks exactly like "all my cuts are gone".
check('playDidNotJumpToTheStart', Math.abs(during.currentTime - parked.currentTime) < 3, true);
check('theClockAdvancedRatherThanReset', duringClock !== '0:00.000', true);

/**
 * Playing across cuts is continuous.
 *
 * The reported symptom: "each cut seems like it takes a second to think before it actually
 * starts to play, so it's difficult to fully understand how the video flows." A cut is a
 * jump in the recording, and a single element pays for that jump with an exact seek at
 * every boundary. Two elements ping-ponged pay for it in advance instead.
 *
 * Asserted three ways, because each catches a different failure:
 *
 *  - **The clock never stalls.** Sampled ten times a second; the longest gap between
 *    advances is the stutter, in milliseconds. This is the number the complaint is about.
 *  - **Playback is never stopped by the app.** The other half of the report — "it would
 *    play for a moment or two and then stop again on its own" — was the timeline treating
 *    its own scroll-to-follow-the-playhead as a gesture, which pauses playback.
 *  - **Both elements exist and take turns.** Without this the first two checks pass on a
 *    fixture whose cuts are cheap, which the twelve-second test clip's certainly are.
 */
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(300);
await scrubTo(page, 0.05);
await page.waitForTimeout(700);

set('videoElements', await page.evaluate(() => document.querySelectorAll('.player video').length));
check('thereAreTwoElementsToHandOverBetween', await page.evaluate(() => document.querySelectorAll('.player video').length), 2);

await page.locator('button.play').click();
const run = await page.evaluate(async () => {
  const clock = () => document.querySelector('.timeline-clock')?.textContent ?? '';
  const which = () => [...document.querySelectorAll('.player video')].findIndex((v) => v.classList.contains('live'));

  const samples = [];
  const started = performance.now();
  let last = clock();
  let lastChange = started;
  let longestStall = 0;
  const seen = new Set([which()]);
  let handoffs = 0;
  let live = which();

  while (performance.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = performance.now();
    const current = clock();
    if (current !== last) {
      longestStall = Math.max(longestStall, now - lastChange);
      lastChange = now;
      last = current;
    }
    const nowLive = which();
    if (nowLive !== live) {
      handoffs += 1;
      live = nowLive;
      seen.add(nowLive);
    }
    samples.push(current);
  }
  longestStall = Math.max(longestStall, performance.now() - lastChange);

  return {
    longestStallMs: Math.round(longestStall),
    handoffs,
    elementsUsed: seen.size,
    advanced: new Set(samples).size,
    stillPlaying: !document.querySelector('.player video.live')?.paused,
    finalClock: last,
  };
});
set('playback', run);
// Half a second is already visible as a hitch; a full second is the complaint. The
// twelve-second fixture cuts cheaply, so this is a floor, not proof it is fast on 4K.
check('playbackNeverStalls', run.longestStallMs < 500, true);
check('theClockKeptMoving', run.advanced > 10, true);
check('nothingStoppedPlaybackOnItsOwn', run.stillPlaying, true);
check('theSpareElementTookOverAtACut', run.handoffs >= 1, true);
check('bothElementsWereUsed', run.elementsUsed, 2);
await page.locator('button.play').click();

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
