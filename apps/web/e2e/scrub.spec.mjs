import { APP_URL, ensureClip, launch, makeReport } from './harness.mjs';

/**
 * Scrubbing, measured against media that is slow to seek.
 *
 * The previous benchmark measured the main thread's frame cadence and reported 23ms —
 * and the phone still froze. It was measuring the wrong thing. The fixture is a twelve
 * second 360x640 clip where a seek costs nothing; the real project is 5 GB of 4K HEVC
 * where one keyframe seek is most of a second. Nothing about React was the problem at that
 * point: the problem was six seeks a second issued at a decoder that could finish one.
 *
 * This fixture cannot be made slow to seek. CPU throttling starves the test's own rAF loop
 * long before it slows a 360p keyframe decode, and there is no lever here that turns a
 * twelve-second webm into a 4K master. So the *pacing rule* — one seek in flight, and no
 * faster than the last one took — is unit-tested exactly, in `test/scrub.test.ts`, where it
 * is a pure function and the timings can simply be stated.
 *
 * What this spec is for is everything that needs a real browser, and it is the half that
 * decides whether the gesture feels alive:
 *
 *  1. **Seeks do not pile up**, even here where they are cheap. At most one in flight.
 *  2. **The proxy carries the picture.** A perfectly paced scrub on slow media still shows
 *     about one frame a second, which is a slideshow. The already-decoded filmstrip frame
 *     is what moves with the thumb — so it must appear, change, and then get out of the way.
 *  3. **The real frame is underneath when it settles**, or the proxy is a lie.
 */
const { browser, page, errors } = await launch({ device: 'iPhone 15 Pro' });
const { check, set, finish } = makeReport();

const clip = await ensureClip(page);

await page.goto(APP_URL);
await page.locator('text=Choose a video').waitFor();
await page.setInputFiles('input[type=file]', clip);
await page.locator('.clip-block').first().waitFor({ timeout: 20000 });

// A dozen cuts, so a scrub crosses clip boundaries the way a real one does.
for (let i = 1; i <= 11; i += 1) {
  await page.evaluate((at) => {
    const scroller = document.querySelector('.timeline-scroller');
    const box = scroller.getBoundingClientRect();
    scroller.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
    );
    scroller.scrollLeft = at * (scroller.scrollWidth - scroller.clientWidth);
  }, i / 12);
  await page.waitForTimeout(320);
  await page.locator('button[aria-label="Cut at playhead"]').click();
  await page.waitForTimeout(60);
}
set('clips', await page.locator('.clip-block').count());

// Let the filmstrip finish, because the proxy is made of it. Unthrottled — the extraction
// is not what is being measured, and throttling it just makes the spec slow.
await page.waitForTimeout(4000);
await page.locator('button[aria-label="Fit timeline"]').click();
await page.waitForTimeout(400);

/**
 * Instrument the elements and flick the lane.
 *
 * Counting `seeking` against `seeked` is the whole measurement: they must never differ by
 * more than one, because one is "a seek is happening" and two is "a seek was abandoned
 * half-done to start another", which is the state the preview never comes back from.
 */
const run = await page.evaluate(async () => {
  const videos = [...document.querySelectorAll('.stage video')];
  let started = 0;
  let landed = 0;
  let worstInFlight = 0;
  for (const video of videos) {
    video.addEventListener('seeking', () => {
      started += 1;
      worstInFlight = Math.max(worstInFlight, started - landed);
    });
    video.addEventListener('seeked', () => {
      landed += 1;
    });
  }

  const proxies = new Set();
  const watchProxy = setInterval(() => {
    const proxy = document.querySelector('.scrub-proxy');
    if (proxy) proxies.add(proxy.getAttribute('src'));
  }, 40);

  const scroller = document.querySelector('.timeline-scroller');
  const box = scroller.getBoundingClientRect();
  scroller.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + 4 }),
  );

  const max = scroller.scrollWidth - scroller.clientWidth;
  let sawProxy = false;
  for (const sweep of [0.9, 0.1, 0.75]) {
    const from = scroller.scrollLeft;
    const to = max * sweep;
    for (let i = 1; i <= 30; i += 1) {
      scroller.scrollLeft = Math.round(from + ((to - from) * i) / 30);
      sawProxy = sawProxy || Boolean(document.querySelector('.scrub-proxy'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));
  clearInterval(watchProxy);

  return {
    seeksStarted: started,
    seeksLanded: landed,
    worstInFlight,
    sawProxy,
    distinctProxyFrames: proxies.size,
    proxyGoneAfterSettling: !document.querySelector('.scrub-proxy'),
  };
});

set('scrub', run);
// The whole bug, in one number. Two seeks in flight means one was abandoned half-done.
check('neverMoreThanOneSeekInFlight', run.worstInFlight <= 1, true);
check('andTheSeeksActuallyCompleted', run.seeksLanded > 0, true);

// The proxy is what makes a gesture feel live when the decoder cannot keep up.
check('theProxyCarriesTheGesture', run.sawProxy, true);
// More than one frame, or it is a still image rather than a scrub.
check('andItActuallyMoves', run.distinctProxyFrames > 1, true);
// And it gets out of the way, so what you are left looking at is the real frame.
check('thenStandsAside', run.proxyGoneAfterSettling, true);

// --- The real frame is underneath -------------------------------------------------------
await page.waitForTimeout(1200);
const settled = await page.evaluate(() => {
  const scroller = document.querySelector('.timeline-scroller');
  const video = document.querySelector('.stage video.live');
  return {
    fraction: scroller.scrollLeft / Math.max(1, scroller.scrollWidth - scroller.clientWidth),
    readyState: video.readyState,
    seeking: video.seeking,
    clock: document.querySelector('.timeline-clock')?.textContent ?? '',
  };
});
set('afterSettling', settled);
check('theElementFinishedSeeking', settled.seeking, false);
check('andHasAFrameDecoded', settled.readyState >= 2, true);
check('theClockFollowedTheGesture', settled.clock !== '0:00.000', true);

const code = finish(errors.filter((error) => !error.includes('favicon')));
await browser.close();
process.exit(code);
