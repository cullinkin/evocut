import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

/**
 * Shared harness for the browser checks.
 *
 * These are not unit tests and they are not in CI: they need a real browser, a running
 * dev server, and a real video file. They exist because the things they cover — a touch
 * drag actually moving a trim handle, a project actually surviving a reload — cannot be
 * asserted anywhere else. OPFS, IndexedDB, `touch-action`, and `<video>` seeking have no
 * Node equivalents, so a suite that ran without a browser would be testing a mock of the
 * only part that can really break.
 */

export const ARTIFACTS = fileURLToPath(new URL('./artifacts', import.meta.url));
export const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean);

export function artifact(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  return `${ARTIFACTS}/${name}`;
}

export async function launch({ device } = {}) {
  const executablePath = CHROMIUM_CANDIDATES.find((path) => existsSync(path));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const profile = device ? devices[device] ?? {} : {};
  const context = await browser.newContext({ ...profile, acceptDownloads: true });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(String(error)));

  return { browser, context, page, errors, profile };
}

/** Collects pass/fail without stopping at the first problem, so one run reports everything. */
export function makeReport(initial = {}) {
  const report = { ...initial };
  return {
    report,
    set(name, value) {
      report[name] = value;
    },
    check(name, actual, expected) {
      report[name] = actual;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        report[`${name}__EXPECTED`] = expected;
        report.FAILURES = (report.FAILURES ?? 0) + 1;
      }
    },
    finish(errors) {
      console.log(JSON.stringify(report, null, 2));
      console.log('console errors:', errors.length ? errors : 'none');
      console.log(report.FAILURES ? `FAILURES: ${report.FAILURES}` : 'ALL CHECKS PASSED');
      return report.FAILURES ? 1 : 0;
    },
  };
}

/**
 * A ~12 second test recording, made by the browser itself.
 *
 * Generated with MediaRecorder over a canvas rather than shipped as a fixture: a binary
 * video in the repo would be the largest file in it, and this way the clip can be built to
 * contain known answers.
 *
 * Three of them:
 *
 *  - **A visible running clock**, so a screenshot of a mis-seeked preview is obvious at a
 *    glance.
 *  - **A background colour that encodes its own timestamp** (`hsl(t/40, …)`), so sampling
 *    a pixel out of an exported frame recovers which moment of the source it came from.
 *    That is what turns "did the export honour the edit?" into a number.
 *  - **An audio track with a deliberate shape**: tone, two seconds of silence, tone with a
 *    sharp burst at 7s and 9s. The signals pass should find exactly one quiet stretch and
 *    two hits, and finding them somewhere else is a failure with a location.
 */
export async function ensureClip(page) {
  const path = artifact('take1.webm');
  if (existsSync(path)) return path;

  await page.goto('about:blank');
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 640;
    const g = canvas.getContext('2d');
    const chunks = [];

    const stream = canvas.captureStream(30);
    const audio = new AudioContext();
    await audio.resume().catch(() => {});
    const destination = audio.createMediaStreamDestination();
    const oscillator = audio.createOscillator();
    oscillator.frequency.value = 220;
    const gain = audio.createGain();
    oscillator.connect(gain).connect(destination);

    // Steps rather than ramps: a hit is a sudden rise, and a fade in would be a fade in.
    const at = audio.currentTime;
    gain.gain.setValueAtTime(0.25, at);
    gain.gain.setValueAtTime(0.0001, at + 4);
    gain.gain.setValueAtTime(0.25, at + 6);
    for (const beat of [7, 9]) {
      gain.gain.setValueAtTime(0.9, at + beat);
      gain.gain.setValueAtTime(0.25, at + beat + 0.15);
    }
    oscillator.start();
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start();

    const started = performance.now();
    await new Promise((resolve) => {
      const draw = () => {
        const t = performance.now() - started;
        g.fillStyle = `hsl(${(t / 40) % 360} 70% 45%)`;
        g.fillRect(0, 0, 360, 640);
        g.fillStyle = '#fff';
        g.font = '48px sans-serif';
        g.fillText(`${(t / 1000).toFixed(1)}s`, 40, 320);
        if (t > 12000) resolve();
        else requestAnimationFrame(draw);
      };
      draw();
    });

    recorder.stop();
    oscillator.stop();
    void audio.close();
    const blob = await new Promise((r) => (recorder.onstop = () => r(new Blob(chunks, { type: 'video/webm' }))));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });

  writeFileSync(path, Buffer.from(base64, 'base64'));
  return path;
}

/** A genuine single-finger touch drag, so `touch-action` is actually exercised. */
export async function touchDrag(cdp, page, from, to, steps = 14) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id: 1 },
      ],
    });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(120);
}

export async function centre(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Download the project EDL and parse it — the only way to assert on what was recorded. */
export async function exportEdl(page, name = 'export.json') {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('footer button:has-text("EDL")').click(),
  ]);
  const path = artifact(name);
  await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}
