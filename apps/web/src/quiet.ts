/**
 * When the main thread is allowed to be spent on background work.
 *
 * ## The measurement this exists for
 *
 * A screen recording of a real editing session, sampled frame by frame: while the user was
 * scrubbing, the *entire interface* — preview and timeline together — updated 26 to 32
 * times a second on a 60Hz phone, with whole seconds where nothing moved at all. Preview
 * and lane froze in lockstep, which rules out anything about drawing either of them and
 * says the main thread was simply gone.
 *
 * It was gone extracting the filmstrip. That pass seeks a third `<video>` element through
 * the source — up to six hundred and eighty times on a long recording — and each seek is
 * followed by a `drawImage` of a 4K frame and either a JPEG encode or a `getImageData`.
 * On a phone the seek alone is most of a second on a multi-gigabyte HEVC file, the
 * decoder is hardware and there are already two other elements using it, and the draw is
 * main-thread work that lands in the middle of whatever the user is doing. It runs for
 * *minutes* after a project opens, which is exactly the window in which someone is trying
 * to find their first cut.
 *
 * ## The rule
 *
 * Background work waits for quiet. Anything that moves the playhead — a scrub, playback, a
 * key — says so here, and the extractor asks for a gap before each seek.
 *
 * The gap is short, because the work still has to finish: a filmstrip nobody ever gets is
 * no better than one that stutters. And the wait is bounded, so sustained interaction
 * slows the pass to a crawl rather than stopping it dead — playback moves the playhead
 * sixty times a second for as long as it runs, and a strip that appears only once the
 * user stops watching their own footage is a strip that appears never.
 */

/** How long the main thread has to be free before background work may take it. */
export const QUIET_MS = 350;

/**
 * The longest a piece of background work will hold off.
 *
 * Reached only while something is *continuously* moving the playhead. One seek every four
 * seconds through a scrub is slow, and slow is the correct answer to "the user is busy".
 */
export const MAX_HOLD_MS = 4_000;

let lastAt = 0;

/** Something the main thread has to be free for is happening now. */
export function noteInteraction(now = Date.now()): void {
  lastAt = now;
}

/** When the last interaction was, for tests and for logging. */
export function lastInteractionAt(): number {
  return lastAt;
}

/**
 * How much longer to wait before background work should run, given the last interaction.
 *
 * Pure, so the rule can be stated exactly and the waiting can be tested without a clock:
 * zero once the gap has been long enough, and never more than what is left of the hold.
 */
export function holdFor(lastInteraction: number, now: number, waitedMs: number): number {
  const quiet = now - lastInteraction;
  if (quiet >= QUIET_MS) return 0;
  return Math.max(0, Math.min(QUIET_MS - quiet, MAX_HOLD_MS - waitedMs));
}

/** Wait for a gap in what the user is doing. Resolves immediately when there is one. */
export async function whenQuiet(): Promise<void> {
  const started = Date.now();
  for (;;) {
    const wait = holdFor(lastAt, Date.now(), Date.now() - started);
    if (wait <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Forget the last interaction. Tests only — a stale timestamp would leak between them. */
export function resetQuiet(): void {
  lastAt = 0;
}
