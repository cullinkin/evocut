/**
 * Getting back in after the tab dies.
 *
 * ## Why this exists
 *
 * Reported from a phone: the editor appears for a moment, the screen goes black, and a
 * reload gets Safari's "a problem repeatedly occurred". That is the web process being
 * killed — and because opening a project is what killed it, every reload killed it again.
 * The app had locked its own user out of their edit, and out of the log that would have
 * said why.
 *
 * A phone editor cannot assume it will be allowed to finish. Opening a project on one
 * means a multi-gigabyte recording, two `<video>` elements holding hardware decoders, a
 * third one extracting thumbnails, and an audio pass decoding half an hour of AAC — all
 * inside an allowance iOS will end the process for exceeding, with no warning and no
 * catchable error. So the app has to notice that it did not survive last time, and open
 * differently.
 *
 * ## The rule
 *
 * A breadcrumb is written before the dangerous part and cleared once it is over. Finding
 * one at startup means the previous open did not finish: this one skips the analysis
 * entirely, says so, and leaves the edit — and the log, and the EDL — reachable.
 *
 * Deliberately not clever. It does not try to work out *what* killed the tab; it records
 * how far the last attempt got, which is the one fact nobody had.
 */

const KEY = 'evocut:open';

/** How far an open got before the tab stopped existing. */
export interface OpenAttempt {
  projectId: string;
  /** The last milestone reached. */
  stage: string;
  /** When that milestone was reached, so a stale breadcrumb can be told from a fresh one. */
  at: number;
}

/**
 * A breadcrumb older than this is not evidence about this session.
 *
 * A tab closed normally mid-analysis leaves one behind — the process ended, so nothing
 * cleared it — and that is not a crash. Coming back a day later and being told the app is
 * in recovery would be worse than useless. An hour is long enough that a real crash loop is
 * always caught and short enough that yesterday's ordinary exit is not.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

function read(): OpenAttempt | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OpenAttempt>;
    if (typeof parsed?.projectId !== 'string' || typeof parsed?.at !== 'number') return null;
    return { projectId: parsed.projectId, stage: String(parsed.stage ?? 'unknown'), at: parsed.at };
  } catch {
    // A private window, a full quota, a hostile value someone typed in — none of which is
    // a reason to fail to open a project.
    return null;
  }
}

function write(attempt: OpenAttempt | null): void {
  try {
    if (attempt) localStorage.setItem(KEY, JSON.stringify(attempt));
    else localStorage.removeItem(KEY);
  } catch {
    // Then there is no breadcrumb, and the app behaves as it did before this file existed.
  }
}

/**
 * Whether a breadcrumb is evidence that *this* open should be a careful one.
 *
 * Pure, so the rule can be stated exactly: the same project, recently enough to be about
 * this sitting.
 */
export function shouldRecover(previous: OpenAttempt | null, projectId: string, now: number): boolean {
  if (!previous || previous.projectId !== projectId) return false;
  return now - previous.at < STALE_AFTER_MS;
}

/**
 * Start an open, and say whether the last one finished.
 *
 * Returns the failed attempt when there was one — the caller records it, because where the
 * last session died is the single most useful line in a log that could not be exported.
 */
export function beginOpen(projectId: string, now = Date.now()): OpenAttempt | null {
  const previous = read();
  const failed = shouldRecover(previous, projectId, now) ? previous : null;
  runs = failed ? runs + 1 : 0;
  write({ projectId, stage: 'open', at: now });
  return failed;
}

/**
 * Mark how far this open has got.
 *
 * The names matter more than they look. "measure" covered everything after the media was
 * bound — the audio pass, the filmstrip, the index reads — which is three candidates
 * wearing one label, and a crash report that says "it died measuring" narrows nothing. Each
 * thing that could plausibly take the process down says its own name before it starts.
 */
export function noteStage(stage: string, now = Date.now()): void {
  const current = read();
  if (!current) return;
  write({ ...current, stage, at: now });
}

/** How many opens in a row have failed. Reset by `finishOpen`, like everything else here. */
export function failedRuns(): number {
  return runs;
}

let runs = 0;

/** The dangerous part is over. */
export function finishOpen(): void {
  runs = 0;
  write(null);
}

/**
 * Clear the breadcrumb when the page is left deliberately.
 *
 * This is what tells a crash from a reload, and without it the whole mechanism is a
 * nuisance: someone who reloads ten seconds into an open — for any of the ordinary reasons
 * people reload — would be told their app had crashed and put into a reduced session.
 *
 * `pagehide` fires when a page is navigated away from, reloaded, or backgrounded. A
 * process killed for using too much memory fires nothing at all. So a breadcrumb that
 * survives is one nobody had the chance to clean up, which is exactly the case worth
 * catching.
 *
 * Returns a teardown, and is a no-op where there is no window.
 */
export function clearOnExit(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onHide = () => finishOpen();
  window.addEventListener('pagehide', onHide);
  return () => window.removeEventListener('pagehide', onHide);
}

/** Test seam: forget everything. */
export function resetOpen(): void {
  runs = 0;
  write(null);
}
