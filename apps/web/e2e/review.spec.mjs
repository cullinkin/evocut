import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The refinement review, now that it is live rather than modal.
 *
 * Two families of assertion, and they exist for different reasons.
 *
 * **The rejections**, which is why this file was written. An accepted op shows up on the
 * timeline and would be caught by almost any check; a rejected one leaves no trace except
 * the verdict, so if the review ever stops recording them the training data quietly loses
 * half its labels and nothing else breaks.
 *
 * **Taking one back.** The review used to be a screen you got through: tick boxes against
 * text, press Apply, live with it. Now each suggestion is a live toggle against the edit
 * behind it, and the claim that makes that safe is exact reversibility — the timeline is
 * re-derived as `baseline + accepted`, so un-ticking is not an undo of a past mutation.
 * The way to test a claim like that is to measure the timeline, accept, take it back, and
 * demand the original number to the microsecond.
 */
const { browser, page, errors } = await launch();
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// Two cuts, placed either side of the silence the test clip carries at 4–6 seconds, so
// the planner has something measurable to act on at both joins. Since the signals pass
// landed, the planner declines to trim a join it cannot hear dead air at — which is the
// behaviour we want and does mean the fixture has to contain some.
await scrubTo(page, 0.42);
await page.locator('button[aria-label="Cut at playhead"]').click();
await scrubTo(page, 0.75);
await page.locator('button[aria-label="Cut at playhead"]').click();
await page.waitForTimeout(300);
check('clipsAfterCuts', await page.locator('.clip-block').count(), 3);

// Drop one clip, and confirm it dims rather than disappearing. The last one, so the two
// that survive still sit either side of the silence.
await page.locator('.clip-block').last().click();
await page.locator('button[aria-label="Drop clip"]').click();
await page.waitForTimeout(400);
check('droppedShown', await page.locator('.clip-block.dropped').count(), 1);

const metaBefore = await page.locator('.meta').innerText();

// The reload that used to lose everything.
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
check('clipsAfterReload', await page.locator('.clip-block').count(), 3);
check('droppedSurvivedReload', await page.locator('.clip-block.dropped').count(), 1);
check('metaSurvivedReload', await page.locator('.meta').innerText(), metaBefore);
check('relinkPromptShown', await page.locator('.relink').count(), 0);

// --- Freeze, then ask — with a brief, on this video ---------------------------------
await page.locator('button:has-text("Done")').click();
await page.waitForTimeout(300);
await page.locator('button:has-text("Refine")').click();
await page.locator('.sheet').waitFor({ timeout: 10000 });

await page.locator('.sheet textarea').fill('Punchy. Hold on the hits, cut the dead air.');
await page.locator('.sheet input[type=text]').fill('0:08');
await page.screenshot({ path: artifact('brief-sheet.png') });
await page.locator('.sheet-actions .primary').click();
await page.locator('.bubble').first().waitFor({ timeout: 15000 });

const durationOf = async () =>
  (await exportEdl(page, 'review-stage.json')).timeline.tracks[0].clips
    .filter((clip) => clip.enabled)
    .reduce((total, clip) => total + Math.round((clip.sourceOut - clip.sourceIn) / clip.speed), 0);

const untouched = await durationOf();
set('durationWhenSuggestionsArrived', untouched);

// --- The suggestions are on the timeline, and nothing has happened yet ---------------
const bubbles = await page.locator('.bubble').count();
set('bubbleCount', bubbles);
check('suggestionsAppearAsBubbles', bubbles > 0, true);
check('nothingAcceptedOnArrival', await page.locator('.bubble.accepted').count(), 0);
await page.screenshot({ path: artifact('bubbles.png') });

// --- Tap one: a before and after, not a row of text ----------------------------------
await page.locator('.bubble').first().click();
await page.locator('.sheet[aria-label="Suggested edit"]').waitFor({ timeout: 10000 });

const shots = await page.locator('.sheet .shot').count();
set('headline', await page.locator('.sheet h2').innerText());
check('showsBeforeAndAfter', shots, 2);
// Both bars are drawn in output seconds against one scale, so an edit that shortens the
// shot draws a shorter bar. A pair of equal bars would mean the change has no size on
// screen, which is the whole failure the old text-only screen had.
const barWidths = await page.evaluate(() =>
  [...document.querySelectorAll('.sheet .shot-bar')].map((el) => Math.round(el.getBoundingClientRect().width)),
);
set('barWidths', barWidths);
check('theAfterBarIsShorter', barWidths[1] < barWidths[0], true);
check('showsWhatItCosts', (await page.locator('.sheet .cost dd').allInnerTexts()).length, 2);
await page.screenshot({ path: artifact('suggestion-sheet.png') });

// --- Keep it: the edit changes underneath, immediately -------------------------------
await page.locator('.sheet-actions .primary').click();
await page.waitForTimeout(400);
check('keepIsReflectedInTheButton', await page.locator('.sheet-actions .primary').innerText(), 'Kept');
await page.locator('.sheet button[aria-label="Close"]').click();
await page.waitForTimeout(300);

const accepted = await durationOf();
set('durationAfterKeeping', accepted);
check('keepingChangedTheEdit', accepted !== untouched, true);
check('theBubbleShowsItWasKept', await page.locator('.bubble.accepted').count(), 1);

// --- Take it back: exactly back, and back in the list ---------------------------------
await page.locator('.bubble.accepted').first().click();
await page.locator('.sheet[aria-label="Suggested edit"]').waitFor({ timeout: 10000 });
// The wording changes with the state: "Skip" is a decision, "Put it back" is a reversal,
// and a person cannot use a reversal they are not told exists.
check('offersToPutItBack', await page.locator('.sheet-actions .ghost').innerText(), 'Put it back');
await page.locator('.sheet-actions .ghost').click();
await page.waitForTimeout(400);
await page.locator('.sheet button[aria-label="Close"]').click();
await page.waitForTimeout(300);

const restored = await durationOf();
set('durationAfterPuttingItBack', restored);
// To the microsecond. Anything else would mean un-accepting is an approximate reversal
// rather than the same derivation with one fewer op.
check('takingItBackRestoresTheEditExactly', restored, untouched);
check('andItIsPendingAgain', await page.locator('.bubble.accepted').count(), 0);

// --- The whole list, and finishing ----------------------------------------------------
await page.locator('header .primary').click();
await page.locator('.review').waitFor({ timeout: 10000 });
const proposals = await page.locator('.proposal').count();
set('proposalCount', proposals);
check('enoughProposalsToReview', proposals >= 2, true);
check('listAgreesWithTheBubbles', proposals, bubbles);
set('firstProposal', await page.locator('.proposal').first().locator('strong').innerText());
check('preAccepted', await page.locator('.proposal.accepted').count(), 0);
check('finishLabelBeforeAnyChoice', await page.locator('.review-actions .primary').innerText(), 'Done — kept none');

await page.locator('.proposal').nth(0).locator('button:has-text("Keep")').click();
await page.locator('.proposal').nth(1).locator('button:has-text("Skip")').click();
await page.waitForTimeout(200);
check('acceptedAfterOneKeep', await page.locator('.proposal.accepted').count(), 1);
check('finishLabel', await page.locator('.review-actions .primary').innerText(), 'Done — kept 1');
await page.screenshot({ path: artifact('review-screen.png') });

// --- A review in progress survives the tab being backgrounded -------------------------
// It lives on the project, not in component state, because a phone will kill a tab
// mid-review and the verdicts are the product.
await page.locator('.review button[aria-label="Close"]').click();
await page.waitForTimeout(700);
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
check('reviewSurvivedAReload', await page.locator('.bubble').count(), bubbles);
check('andSoDidTheVerdict', await page.locator('.bubble.accepted').count(), 1);

await page.locator('header .primary').click();
await page.locator('.review').waitFor({ timeout: 10000 });
await page.locator('.review-actions .primary').click();
await page.locator('.timeline').waitFor({ timeout: 10000 });
await page.waitForTimeout(600);
check('bubblesGoWhenTheReviewIsDone', await page.locator('.bubble').count(), 0);

const edl = await exportEdl(page, 'review-export.json');
const reviewed = edl.revisions.filter((r) => r.review);
set('reviewedRevisions', reviewed.length);
check('verdictsRecorded', reviewed.at(-1)?.review.verdicts.length, proposals);
check('appliedOpsRecorded', reviewed.at(-1)?.ops.length, 1);
check('passMarkedAccepted', reviewed.at(-1)?.accepted, true);
check('rejectionsSurvived', reviewed.at(-1)?.review.verdicts.filter((v) => !v.accepted).length, proposals - 1);
check('coarseSnapshotKept', typeof edl.coarseSnapshot, 'object');
set('rationaleInEdl', reviewed.at(-1)?.review.verdicts[0]?.op?.rationale);

// The brief and the target belong to this video, and travel with its EDL.
set('briefInEdl', edl.brief);
check('briefIsPerProject', edl.brief, 'Punchy. Hold on the hits, cut the dead air.');
check('targetIsPerProject', edl.targetDurationUs, 8_000_000);

// One more reload, then back out to the project list.
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
check('clipsAfterFinalReload', await page.locator('.clip-block').count(), 3);

await page.locator('header .ghost').click();
await page.locator('.recents').waitFor({ timeout: 10000 });
check('recentProjects', await page.locator('.recents li').count(), 1);
await page.screenshot({ path: artifact('start-screen.png') });

const exitCode = finish(errors);
await browser.close();
process.exit(exitCode);
