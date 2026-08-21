import { APP_URL, ensureClip, exportEdl, exportLog, launch, makeReport } from './harness.mjs';

/**
 * Getting back in after the tab dies.
 *
 * Reported from a phone: the editor appears for a moment, the screen goes black, and a
 * reload gets Safari's "a problem repeatedly occurred". That is the web process being
 * killed — and because *opening the project* is what killed it, every reload killed it
 * again. The app had locked its own user out of their edit, and out of the log that would
 * have said why.
 *
 * There is no way to make a phone promise not to do that. Opening a project means a
 * multi-gigabyte recording, two `<video>` elements holding hardware decoders, a third
 * extracting thumbnails, and an audio pass working through half an hour of AAC — all
 * inside an allowance iOS ends the process for exceeding, with no warning and nothing to
 * catch. What the app can do is notice, and open differently.
 *
 * This spec fakes the breadcrumb rather than the crash, because a crash is exactly the
 * thing a test cannot arrange. What is under test is the rule: a breadcrumb means no
 * analysis, a visible reason, and an editor that still works.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.locator('.clip-thumbs .thumb').first().waitFor({ timeout: 30000 });

const project = await exportEdl(page, 'recover-before.json');
set('projectId', project.id);
check('opensNormallyToBeginWith', await page.locator('.banner.recovered').count(), 0);

/*
  An ordinary reload is not a crash, and must not be read as one — otherwise the mechanism
  is a nuisance that puts anyone who reloads into a reduced session.
*/
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
check('anOrdinaryReloadIsNotACrash', await page.locator('.banner.recovered').count(), 0);

/*
  The state a killed tab leaves behind: a breadcrumb, written before the analysis and never
  cleared, because nothing ran after it.

  Planted from an init script rather than before the reload, and that detail is the rule
  under test from the other side: leaving a page on purpose clears the breadcrumb, so a
  value written before `reload()` would be swept up by the very handler that tells a reload
  from a crash. It has to appear as the *next* document starts, which is what a killed
  process leaves behind.
*/
await page.addInitScript(() => {
  if (!localStorage.getItem('e2e:arm')) return;
  localStorage.removeItem('e2e:arm');
  localStorage.setItem(
    'evocut:open',
    JSON.stringify({ projectId: localStorage.getItem('e2e:project'), stage: 'measure', at: Date.now() }),
  );
});
await page.evaluate((id) => {
  localStorage.setItem('e2e:arm', '1');
  localStorage.setItem('e2e:project', id);
}, project.id);

await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(4000);

set('bannerText', await page.locator('.banner.recovered').innerText().catch(() => null));
check('saysWhatHappened', await page.locator('.banner.recovered').isVisible(), true);
check('andWhereItDied', /measuring the footage/.test(await page.locator('.banner.recovered').innerText()), true);

/*
  The editor still works. This is the whole point of the mode: a crash must not cost
  someone their edit, their log, or their export — only the analysis, which is where the
  allowance was going.
*/
check('theTimelineIsThere', await page.locator('.timeline-scroller').isVisible(), true);
check('andSoIsThePreview', await page.locator('.player video.live').count() > 0, true);
const clipsNow = await page.locator('.clip-block').count();
check('withTheEditIntact', clipsNow, project.timeline.tracks[0].clips.length);

// And the expensive work is genuinely off, rather than merely hidden.
const thumbs = await page.locator('.clip-thumbs .thumb').count();
set('thumbnailsInRecovery', thumbs);
check('noFilmstripExtraction', thumbs, 0);

const log = await exportLog(page, 'recover-log.jsonl');
const recovered = log.events.filter((event) => event.type === 'app.recovered');
set('recoveredRows', recovered.map((event) => event.payload));
// The row that could not exist before: a crash on a phone leaves no stack and no console,
// and the log that would have said so could not be exported because the app would not stay
// up long enough to export it.
check('theLogSaysTheLastOpenDied', recovered.length, 1);
check('andHowFarItGot', recovered[0]?.payload?.diedAt, 'measure');

// Try again clears it.
await page.locator('.banner.recovered button').click();
await page.locator('.clip-block').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
check('tryingAgainOpensNormally', await page.locator('.banner.recovered').count(), 0);
await page.locator('.clip-thumbs .thumb').first().waitFor({ timeout: 30000 });
check('andTheFilmstripComesBack', (await page.locator('.clip-thumbs .thumb').count()) > 0, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
