import { readFileSync } from 'node:fs';
import { APP_URL, artifact, ensureClip, launch, makeReport, scrubTo } from './harness.mjs';

/**
 * The signals pass, on real media, in a real browser.
 *
 * The generated test clip is built with a known shape: a tone, two seconds of silence
 * starting at 4s, then a tone with sharp bursts at 7s and 9s. So this is not "did the
 * analysis produce plausible-looking numbers" — it is "did it find the pause and the hits
 * that are actually in there, at the times they are actually at".
 *
 * That matters more here than almost anywhere else in the project, because these numbers
 * are the only thing standing between the refinement pass and confident invention. An
 * onset detector that is subtly wrong does not fail; it produces a rationale citing a hit
 * that was never there, which reads exactly like the real thing.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { report, check, set, finish } = makeReport({});

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// The filmstrip pass has to finish before motion can be measured from it, and the audio
// decode runs alongside. Both are background work with no spinner of their own.
await page.waitForFunction(
  () => !document.querySelector('.meta')?.textContent?.includes('listening to the footage'),
  null,
  { timeout: 90_000 },
);

const signals = await page.evaluate(async () => {
  // Read what was cached rather than recomputing: this is the value the refinement pass
  // will actually be handed, including its trip through IndexedDB.
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('evocut');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction('derived', 'readonly').objectStore('derived').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return rows.map((row) => ({ key: row.key, value: row.value }));
});

check('oneSourceMeasured', signals.length, 1);
const measured = signals[0]?.value;
set('cacheKey', signals[0]?.key ?? null);

check('keyIsFingerprintAndVersion', /^signals:[0-9a-f]+:\d+$/.test(signals[0]?.key ?? ''), true);
check('hasAudioSignals', Boolean(measured?.audio), true);
check('hasMotionSignals', Boolean(measured?.motion), true);

// --- The pause that is actually in the recording ---------------------------------
const quiet = (measured?.audio?.quiet ?? []).map((r) => [r.start / 1e6, r.end / 1e6]);
set('quiet', quiet);
check('foundOnePause', quiet.length, 1);
check('pauseStartsAtFourSeconds', Math.abs((quiet[0]?.[0] ?? -99) - 4) < 0.5, true);
check('pauseEndsAtSixSeconds', Math.abs((quiet[0]?.[1] ?? -99) - 6) < 0.5, true);

// --- The hits that are actually in the recording ---------------------------------
const onsets = (measured?.audio?.onsets ?? []).map((o) => ({
  t: Number((o.t / 1e6).toFixed(2)),
  strength: o.strength,
}));
set('onsets', onsets);

// The bursts are at 7s and 9s. The tone restarting at 6s after two seconds of silence is
// also a genuine rise in level, so three is the honest expectation, not two.
const near = (seconds) => onsets.some((o) => Math.abs(o.t - seconds) < 0.4);
check('heardTheBurstAtSeven', near(7), true);
check('heardTheBurstAtNine', near(9), true);
check('didNotHearHitsInTheSilence', onsets.filter((o) => o.t > 4.3 && o.t < 5.7).length, 0);
check('didNotFloodWithHits', onsets.length <= 6, true);

// --- Motion --------------------------------------------------------------------
// Every frame of the clip is a different colour, so nothing in it is ever still. A "still"
// region here would mean the motion measure is reading nothing at all.
set('motionSamples', measured?.motion?.motion?.length ?? 0);
set('still', measured?.motion?.still ?? []);
check('nothingIsStillInAClipThatChangesEveryFrame', (measured?.motion?.still ?? []).length, 0);
check('motionWasActuallySampled', (measured?.motion?.motion?.length ?? 0) >= 5, true);

// --- It is logged, and it is cached ----------------------------------------------
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('footer button:has-text("Log")').click(),
]);
const logPath = artifact('signals-log.jsonl');
await download.saveAs(logPath);
const events = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const computed = events.filter((event) => event.type === 'signals.compute');
check('loggedTheMeasurement', computed.length, 1);

/**
 * Editing does not re-measure.
 *
 * This is the check that was missing. The pass is keyed on the source and cached by
 * content, so in principle it runs once per recording ever — but it lived in an effect
 * that depended on the whole project, and a project changes on every cut. On a real
 * session of 160 edits it ran 160 times, re-reading a 5.2 GB file each time, and nothing
 * anywhere said so. Signals belong to the footage; nothing a trim does can change what the
 * footage sounds like, and this asserts that in the one place it can be observed.
 */
for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
  await scrubTo(page, fraction);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(120);
}
check('cutsMade', (await page.locator('.clip-block').count()) >= 5, true);

const [afterEdits] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('footer button:has-text("Log")').click(),
]);
await afterEdits.saveAs(artifact('signals-log-after-edits.jsonl'));
const recomputes = readFileSync(artifact('signals-log-after-edits.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((event) => event.type === 'signals.compute').length;
check('editingDoesNotReMeasure', recomputes, 1);
set('measurementCost', computed[0]?.payload ?? null);
check('firstPassWasNotACacheHit', computed[0]?.payload?.fromCache, false);

// Reload: the second open must not pay for the analysis again.
await page.reload();
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });
await page.waitForFunction(
  () =>
    Boolean(
      [...document.querySelectorAll('footer button')].find((b) => b.textContent?.includes('Log')),
    ),
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(3000);

const [second] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('footer button:has-text("Log")').click(),
]);
await second.saveAs(artifact('signals-log-2.jsonl'));
const reopened = readFileSync(artifact('signals-log-2.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((event) => event.type === 'signals.compute');

set('measurementsAfterReload', reopened.map((event) => event.payload?.fromCache));
check('reopeningReusesTheAnalysis', reopened.at(-1)?.fromCache ?? reopened.at(-1)?.payload?.fromCache, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
