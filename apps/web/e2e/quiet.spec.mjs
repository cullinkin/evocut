import { APP_URL, ensureClip, launch, makeReport } from './harness.mjs';

/**
 * The main thread belongs to whoever is holding the phone.
 *
 * Measured off a screen recording of a real session, frame by frame: while the user was
 * scrubbing, the *whole* interface — preview and timeline together — updated 26 to 32 times
 * a second on a 60Hz phone, with entire seconds where nothing moved at all. The two froze in
 * lockstep, which rules out anything about drawing either of them. The thread was gone.
 *
 * It was gone extracting filmstrip thumbnails: a seek on a hidden third `<video>`, then a
 * `drawImage` of a 4K frame, then a JPEG encode, up to six hundred and eighty times per
 * source, for minutes after a project opens — which is exactly the window in which someone
 * is trying to find their first cut.
 *
 * Two changes, and this is the test of the first: extraction now waits for a gap in what the
 * user is doing. (The second is that the six hundred extra seeks are gone outright — the
 * picture's movement is read from the container's index instead, which `export.spec` checks
 * on a real file.)
 *
 * The fixture is a twelve-second clip where a seek is a millisecond, so this cannot measure
 * the cost. What it can measure is the rule: thumbnails do not arrive while a thumb is
 * moving, and they do arrive once it stops.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

const thumbs = () => page.locator('.clip-thumbs .thumb').count();

/**
 * Scrub without pause for `ms`, the way a thumb does, sampling what arrives while it runs.
 *
 * A pointer first, then the scroll: the timeline only treats a scroll as a scrub when a hand
 * was on the element, and it is the scrub that says the user is busy.
 */
async function scrubFor(ms) {
  const started = Date.now();
  const seen = [];
  let at = 0;
  while (Date.now() - started < ms) {
    at = (at + 24) % 400;
    await page.evaluate((left) => {
      const scroller = document.querySelector('.timeline-scroller');
      if (!scroller) return;
      const box = scroller.getBoundingClientRect();
      scroller.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
      );
      scroller.scrollLeft = left;
    }, at);
    seen.push(await thumbs());
  }
  return seen;
}

const before = await thumbs();
const during = await scrubFor(2_500);
const arrivedWhileBusy = Math.max(...during) - before;

set('thumbnailsBeforeScrubbing', before);
set('thumbnailsSeenWhileScrubbing', { first: during[0], last: during.at(-1), samples: during.length });
set('arrivedWhileBusy', arrivedWhileBusy);

/*
  A hold, not a halt. Sustained interaction is bounded at four seconds, so a couple of
  frames may still get through a long scrub — that is deliberate, because playback moves the
  playhead sixty times a second for as long as it runs and a strip that appears only once
  you stop watching your own footage is a strip that appears never.
*/
check('thumbnailsWaitedForTheThumbToStop', arrivedWhileBusy <= 2, true);

/*
  And then they arrive, quickly — which is what says the pass was being *held* rather than
  simply not started yet. Opening the media is not gated and had all of the scrub to
  finish; only the seek-and-draw loop waits.
*/
const quietAt = Date.now();
await page.waitForFunction(
  (was) => document.querySelectorAll('.clip-thumbs .thumb').length > was,
  before,
  { timeout: 30_000 },
);
const waited = Date.now() - quietAt;
const after = await thumbs();
set('msFromQuietToFirstThumbnail', waited);
set('thumbnailsAfterQuiet', after);
check('andResumedOnceItDid', after > before, true);
check('promptly', waited < 5_000, true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
