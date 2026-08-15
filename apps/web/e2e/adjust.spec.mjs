import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * Colour and tone: on the picture, in the EDL, on every clip, and still there tomorrow.
 *
 * The thing worth guarding is not that a slider moves. It is the chain: a value set in the
 * sheet reaches the *preview element* as a filter, reaches the *EDL* as an effect, reaches
 * *every clip* when asked to, and survives a reload — because a grade that has to be
 * redone after closing the tab is worse than no grade at all.
 *
 * The preview filter matters more than it looks. It is the same string `ctx.filter` gets
 * during the export, produced by the same function; asserting it here is the closest a
 * browser check can get to "the file will look like this" without rendering the file.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Three clips, so "apply to all" has something to be about.
for (const fraction of [0.3, 0.6]) {
  await scrubTo(page, fraction);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(150);
}
check('threeClipsToGrade', await page.locator('.clip-block').count(), 3);

const filter = () =>
  page.evaluate(() => document.querySelector('.player video.live')?.style.filter ?? '');

// --- Nothing is graded until something is graded ---------------------------------------
await scrubTo(page, 0.1);
await page.waitForTimeout(400);
const before = await filter();
set('filterBeforeAdjusting', before);
check('anUntouchedClipHasNoFilter', before === '' || before === 'none', true);

// --- The sliders reach the picture -----------------------------------------------------
await page.locator('button[aria-label="Adjust colour"]').click();
await page.locator('.sheet.adjust').waitFor({ timeout: 5000 });

const slider = (name) => page.locator(`.sheet.adjust input[aria-label^="${name}"]`);
await slider('Saturation').fill('60');
await slider('Contrast').fill('40');
await page.waitForTimeout(200);

const live = await filter();
set('filterWhileAdjusting', live);
check('theSliderShowsOnThePicture', /saturate\(/.test(live) && /contrast\(/.test(live), true);
await page.screenshot({ path: artifact('adjust-sheet.png') });

// The draft is not the edit: nothing should be in the EDL until Done.
await page.locator('.sheet-actions .primary').click();
await page.waitForTimeout(400);

const graded = await exportEdl(page, 'adjust-one.json');
const colorOf = (edl, index) =>
  edl.timeline.tracks[0].clips[index].effects.find((effect) => effect.type === 'color')?.value ?? null;

set('clipOneColor', colorOf(graded, 0));
check('theGradeIsInTheEdl', colorOf(graded, 0)?.saturation, 0.6);
check('andOnlyOnTheClipItWasMadeOn', colorOf(graded, 1), null);
// One op, one revision — a slider dragged across its range must not leave a trail of them.
set('revisions', graded.revisions.length);
check('oneRevisionForTheWholeAdjustment', graded.revisions.at(-1).ops.length, 1);
check('andItIsASetColorOp', graded.revisions.at(-1).ops[0].op, 'setColor');

// --- Apply to all ----------------------------------------------------------------------
await page.locator('button[aria-label="Adjust colour"]').click();
await page.locator('.sheet.adjust').waitFor({ timeout: 5000 });
// It reopens on the grade the clip already has, rather than on zero.
check('theSheetReopensOnWhatIsThere', await slider('Saturation').inputValue(), '60');
await slider('Exposure').fill('-25');
await page.locator('.sheet-actions button:has-text("Apply to all")').click();
await page.waitForTimeout(500);

const all = await exportEdl(page, 'adjust-all.json');
const everyColor = all.timeline.tracks[0].clips.map((_, index) => colorOf(all, index));
set('everyClipColor', everyColor);
check('everyClipIsGraded', everyColor.every((color) => color !== null), true);
check(
  'andTheyAreAllIdentical',
  everyColor.every((color) => JSON.stringify(color) === JSON.stringify(everyColor[0])),
  true,
);
check('withTheValueThatWasOnScreen', everyColor[0].exposure, -0.25);
// One revision covering all three, so undo takes back the decision rather than a third of it.
check('appliedAsASingleRevision', all.revisions.at(-1).ops.length, 3);

// --- Auto reads the frame that is on screen --------------------------------------------
/**
 * The generated clip is a flat field of one saturated colour with a clock drawn on it: no
 * shadows, no highlights, a single hue. So an auto-adjust that is actually looking at
 * pixels has something definite to say about it, and one that is returning a canned answer
 * or failing silently has nothing.
 */
await page.locator('button[aria-label="Adjust colour"]').click();
await page.locator('.sheet.adjust').waitFor({ timeout: 5000 });
await page.locator('.sheet-actions button:has-text("Reset")').click();
await page.locator('.sheet.adjust button:has-text("Auto")').click();
await page.waitForTimeout(300);

const autoValues = await page.evaluate(() =>
  [...document.querySelectorAll('.sheet.adjust input[type=range]')].map((input) => Number(input.value)),
);
const autoNote = await page.locator('.sheet.adjust .meta').first().innerText();
set('autoValues', autoValues);
set('autoNote', autoNote);
check('autoProposedSomething', autoValues.some((amount) => amount !== 0), true);
check('autoStayedWithinTheSliders', autoValues.every((amount) => Math.abs(amount) <= 100), true);
check('autoSaidWhatItDid', /Adjusted from the frame|already looks about right/.test(autoNote), true);
// Idempotent, because it reads the undecorated frame rather than the one it just graded —
// otherwise tapping it twice would compound and the third tap would be unusable.
await page.locator('.sheet.adjust button:has-text("Auto")').click();
await page.waitForTimeout(300);
const twice = await page.evaluate(() =>
  [...document.querySelectorAll('.sheet.adjust input[type=range]')].map((input) => Number(input.value)),
);
set('autoTwice', twice);
check('autoDoesNotCompoundOnItself', twice, autoValues);
await page.locator('.sheet-head button[aria-label="Close"]').click();
await page.waitForTimeout(300);
// Cancelled, so nothing it proposed should have reached the EDL.
const cancelled = await exportEdl(page, 'adjust-cancelled.json');
check(
  'closingTheSheetCommitsNothing',
  JSON.stringify(colorOf(cancelled, 0)),
  JSON.stringify(colorOf(all, 0)),
);

// --- It survives a reload --------------------------------------------------------------
await page.waitForTimeout(700);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);

const reopened = await exportEdl(page, 'adjust-reload.json');
set('colorAfterReload', colorOf(reopened, 0));
check('theGradeSurvivesAReload', colorOf(reopened, 0)?.exposure, -0.25);

await scrubTo(page, 0.1);
await page.waitForTimeout(600);
const restored = await filter();
set('filterAfterReload', restored);
check('andIsPaintedOnTheRestoredPreview', /brightness\(/.test(restored), true);

// --- Reset -----------------------------------------------------------------------------
await page.locator('button[aria-label="Adjust colour"]').click();
await page.locator('.sheet.adjust').waitFor({ timeout: 5000 });
await page.locator('.sheet-actions button:has-text("Reset")').click();
await page.locator('.sheet-actions .primary').click();
await page.waitForTimeout(400);

const cleared = await exportEdl(page, 'adjust-reset.json');
set('colorAfterReset', colorOf(cleared, 0));
// Cleared, not stored as zeroes: "graded to nothing" and "never graded" must be the same
// clip, or every reader downstream needs to know to ignore a neutral effect.
check('resetTakesTheEffectOffEntirely', colorOf(cleared, 0), null);
check('andTheClipKeepsItsOtherProperties', cleared.timeline.tracks[0].clips[0].enabled, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
