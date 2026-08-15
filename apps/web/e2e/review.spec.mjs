import { APP_URL, artifact, ensureClip, exportEdl, launch, makeReport } from './harness.mjs';

/**
 * The refinement review, and what it writes into the EDL.
 *
 * The assertions that matter here are about the *rejections*. An accepted op shows up on
 * the timeline and would be caught by almost any check; a rejected one leaves no trace
 * except the verdict, so if the review screen ever stops recording them the training data
 * quietly loses half its labels and nothing else breaks.
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
const slider = page.locator('.timeline-scroller');
const seekTo = async (fraction) => {
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + box.width * fraction, box.y + 14);
  await page.waitForTimeout(120);
};

await seekTo(0.42);
await page.locator('button[aria-label="Cut at playhead"]').click();
await seekTo(0.75);
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

// Freeze, refine, review.
await page.locator('button:has-text("Done")').click();
await page.waitForTimeout(300);
await page.locator('button:has-text("Refine")').click();
await page.locator('.proposal').first().waitFor({ timeout: 10000 });

const proposals = await page.locator('.proposal').count();
set('proposalCount', proposals);
// Stated rather than assumed: the keep-one/skip-one flow below needs at least two, and a
// planner that quietly stopped proposing would otherwise fail as a click timeout.
check('enoughProposalsToReview', proposals >= 2, true);
set('firstProposal', await page.locator('.proposal').first().locator('strong').innerText());
set('firstRationale', await page.locator('.proposal').first().locator('small').innerText());

// Nothing may start accepted — a pre-ticked screen collects consent, not judgement.
check('preAccepted', await page.locator('.proposal.accepted').count(), 0);
check(
  'applyLabelBeforeAnyChoice',
  await page.locator('.review-actions .primary').innerText(),
  'Reject the whole pass',
);

await page.locator('.proposal').nth(0).locator('button:has-text("Keep")').click();
await page.locator('.proposal').nth(1).locator('button:has-text("Skip")').click();
await page.waitForTimeout(150);
check('acceptedAfterOneKeep', await page.locator('.proposal.accepted').count(), 1);
check('applyLabel', await page.locator('.review-actions .primary').innerText(), `Apply 1 of ${proposals}`);
await page.screenshot({ path: artifact('review-screen.png') });

await page.locator('.review-actions .primary').click();
await page.locator('.timeline').waitFor({ timeout: 10000 });
await page.waitForTimeout(600);

const edl = await exportEdl(page, 'review-export.json');
const reviewed = edl.revisions.filter((r) => r.review);
set('reviewedRevisions', reviewed.length);
check('verdictsRecorded', reviewed.at(-1)?.review.verdicts.length, proposals);
check('appliedOpsRecorded', reviewed.at(-1)?.ops.length, 1);
check('passMarkedAccepted', reviewed.at(-1)?.accepted, true);
check('rejectionsSurvived', reviewed.at(-1)?.review.verdicts.filter((v) => !v.accepted).length, proposals - 1);
check('coarseSnapshotKept', typeof edl.coarseSnapshot, 'object');
set('rationaleInEdl', reviewed.at(-1)?.review.verdicts[0]?.op?.rationale);

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
