import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  commitOps,
  digest,
  freezeCoarsePass,
  makeLogger,
  newId,
  projectFromSource,
  serializeLog,
  timelineDuration,
  type LogEvent,
  type LogEventType,
  previewOps,
  resolveReview,
  type ColorValue,
  type Op,
  type SetTransformOp,
  type OpPreview,
  type OpVerdict,
  type Project,
  type RefinementPlan,
  type ReviewSession,
} from '@evocut/edl';
import { planLocalRefinement, proposeRefinement, type ClipFrames } from '@evocut/agent';
import type { SourceSignals } from '@evocut/signals';
import {
  isRenderSupported,
  renderProject,
  type MediaResolver,
  type RenderProgress,
} from '@evocut/renderer';
import {
  bindProjectMedia,
  createStores,
  rebindSource,
  requestPersistentStorage,
  type MissingMedia,
  type ProjectSummary,
} from '@evocut/store';
import { probeVideo, sourceFromMedia } from './probe.ts';
import { isMediaServerActive, mediaUrlFor, releaseMediaUrl, startMediaServer } from './media-url.ts';
import { captureContactSheet, forgetContactSheets } from './contact.ts';
import { setFilmstripExtraction } from './filmstrip.ts';
import { noteInteraction } from './quiet.ts';
import { frameUsOf, snapToFrame } from './frames.ts';
import { getPlayhead, resetPlayhead, setPlayhead as writePlayhead } from './playhead.ts';
import { beginOpen, clearOnExit, finishOpen, noteStage } from './recover.ts';
import { useSourceSignals, type SignalsReport } from './signals.ts';
import { EMPTY_SETTINGS, useSettings, type RefinementSettings } from './settings.ts';

/**
 * Session state: the project, its media, its log, and any refinement awaiting review.
 *
 * Three things are being produced at once and all three have to survive a reload, because
 * the coarse pass happens on a phone and a phone will background the tab mid-edit:
 *
 *  1. the EDL — what the user kept,
 *  2. the log — how they got there,
 *  3. the review verdicts — what they thought of the machine's suggestions.
 *
 * Every edit goes through `edit()`, which commits, logs, and schedules a save together.
 * There is no path that changes the timeline without leaving a trail; the training set
 * depends on that being true without exception.
 */
const stores = createStores();

/** Coalesces saves. A scrub can fire many edits a second; IndexedDB should not see them all. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * Scrub logging is throttled to this.
 *
 * A drag emits sixty positions a second. The log wants the attention trail — where the
 * playhead lingered before a cut landed — and sixty samples a second is noise wrapped
 * around that signal, not more of it. The final position of every drag is always logged.
 */
const SCRUB_LOG_INTERVAL_MS = 250;

/**
 * How long an editor has to stay up, with nothing left to measure, before the open counts
 * as having succeeded.
 *
 * Not the first frame. What kills a tab on a phone happens a minute into an open — an
 * audio pass working through half an hour of AAC while three decoders are live — so
 * "it rendered" is not evidence of anything.
 */
const SETTLED_MS = 30_000;

/** How many steps back the editor can go. */
const HISTORY_LIMIT = 50;

/**
 * Bring the project's live timeline back in line with its open review.
 *
 * The invariant, in one function: `timeline === baseline + accepted ops`. Everything
 * downstream — the player, the export, the EDL someone downloads — reads `timeline` and
 * knows nothing about reviews, which is why this is maintained on write rather than
 * derived at render time. Every path that touches `review` goes through here.
 */
function deriveReview(project: Project): Project {
  if (!project.review) return project;
  const resolved = resolveReview(project.review, { sources: project.sources });
  return { ...project, timeline: resolved.timeline, updatedAt: new Date().toISOString() };
}

export type SessionStatus = 'loading' | 'empty' | 'ready';

/** The keyframe shape `setTransform` takes, named so the UI does not have to spell it. */
export type TransformKeyframe = NonNullable<SetTransformOp['keyframes']>[number];

/**
 * A refinement pass, mid-flight.
 *
 * `ops` is counted out of the partial answer as it streams, which is the number that
 * actually reassures someone: "34 edits so far" is a pass working, where a spinner is a
 * pass that might have died four minutes ago.
 */
export interface RefineProgress {
  /** `looking` is the frame capture, which happens before a single byte is sent. */
  phase: 'looking' | 'thinking' | 'drafting';
  tokens: number;
  ops: number;
  startedAt: number;
  /** Frames captured, while `phase` is `looking`. */
  framesDone?: number;
  framesTotal?: number;
}

/**
 * A render in flight, or the file it produced.
 *
 * The blob is held alongside its object URL because the two are used for different things:
 * the URL feeds a preview and a download link, the blob feeds the share sheet, and on iOS
 * the share sheet is the only route into the camera roll.
 */
export interface ExportState {
  status: 'rendering' | 'done' | 'error';
  stage: RenderProgress['stage'];
  progress: number;
  framesEncoded: number;
  framesTotal: number;
  result: {
    blob: Blob;
    url: string;
    filename: string;
    sizeBytes: number;
    durationUs: number;
    width: number;
    height: number;
    warnings: string[];
  } | null;
  error: string | null;
}

export interface Session {
  status: SessionStatus;
  persistent: boolean;
  project: Project | null;
  /**
   * Set when the previous open of this project ended with the tab being killed.
   *
   * Carries the stage it died at, and turns the analysis off for this session — see
   * `recover.ts`. The editor is otherwise entirely usable, which is the point: the edit,
   * the log and the EDL all have to remain reachable after a crash.
   */
  recovered: { stage: string } | null;
  /** Clear the breadcrumb and reload, to try a full open again. */
  retryOpen(): void;
  selectedClipId: string | null;
  canUndo: boolean;
  /** Object URLs by source id. */
  mediaUrls: Map<string, string>;
  missingMedia: MissingMedia[];
  recentProjects: ProjectSummary[];
  playhead: number;
  duration: number;
  events: LogEvent[];
  busy: boolean;
  error: string | null;

  /**
   * A refinement pass the user is still deciding on, or null.
   *
   * Live, not modal. The suggestions sit on the timeline as bubbles and each one is
   * accepted or taken back independently, with the edit re-derived every time — so
   * "I've changed my mind about that one" costs a tap rather than an undo stack.
   */
  review: ReviewSession | null;
  /** What each suggestion does, in the terms the review UI draws. */
  previews: OpPreview[];
  /** Suggestions that were accepted but no longer apply, by index. */
  reviewFailures: Map<number, string>;

  importFile(file: File): Promise<void>;
  relinkMedia(sourceId: string, file: File): Promise<void>;
  openProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  closeProject(): void;

  seek(to: number, final?: boolean): void;
  select(clipId: string | null): void;
  splitAtPlayhead(): void;
  removeClip(clipId: string): void;
  deleteSelected(): void;
  toggleClip(clipId: string): void;
  keepOnly(clipId: string): void;
  undo(): void;
  finishCoarsePass(): void;

  /** End of a trim drag: one op, one revision, one log row. */
  commitTrim(clipId: string, sourceIn: number, sourceOut: number): void;

  /** Colour and tone for one clip. `null` clears it. */
  setClipColor(clipId: string, color: ColorValue | null): void;
  /** The same grade on every clip in the timeline, as one revision. */
  applyColorToAll(color: ColorValue | null): void;
  /** Framing over time for one clip. `null` clears it. */
  setClipTransform(clipId: string, keyframes: TransformKeyframe[] | null): void;
  /** How fast one clip plays. */
  setClipSpeed(clipId: string, speed: number): void;
  /** Copy a clip, with its grade, speed and framing, after itself or at the head. */
  duplicateClip(clipId: string, at: 'after' | 'start'): void;

  /** True once the player has reported that this browser cannot seek the media. */
  seekingUnsupported: boolean;
  reportMediaDiagnostics(info: Record<string, unknown>): void;

  /**
   * What the footage sounds and looks like, by source id. Empty until the analysis pass
   * finishes, which is fine — the refinement pass works without it, just blind.
   */
  signals: Map<string, SourceSignals>;
  /** Sources still being measured. */
  measuring: string[];
  /**
   * How far through the current source the measurement is, 0..1.
   *
   * Reading half an hour of audio out of a file takes tens of seconds. A spinner with no
   * number attached, for that long, reads as a hang.
   */
  measuringProgress: number;

  /** True while a refinement pass is in flight. It is a network call now, not a function. */
  refining: boolean;
  /**
   * What the pass is doing right now, or null between passes.
   *
   * A pass over fifty clips runs for minutes. A screen that says only "Thinking…" for four
   * of them is indistinguishable from one that has hung, and the first thing a person does
   * about a hung screen is reload it — throwing away the pass they are waiting for.
   */
  refineProgress: RefineProgress | null;
  /** How the last pass was produced, for the review screen to say so. */
  refinedBy: 'model' | 'heuristics' | null;
  /**
   * Ask for a pass.
   *
   * Takes the brief and target explicitly rather than reading them back off the project,
   * because the brief sheet saves and runs in the same gesture and a `setProject` has not
   * committed by the time the run starts. Passing them through means the pass is steered
   * by what the person just typed, not by what it replaced. The model is passed for the
   * same reason: it is picked on that sheet too.
   */
  requestRefinement(steer?: {
    brief: string;
    targetDurationUs: number | null;
    model?: string;
    /** Send frames so the pass can see the footage. Pictures leave the device when true. */
    sendFrames?: boolean;
  }): void;
  cancelRefinement(): void;

  settings: RefinementSettings;
  settingsLoaded: boolean;
  saveSettings(next: RefinementSettings): Promise<void>;
  forgetApiKey(): Promise<void>;
  setVerdict(index: number, accepted: boolean): void;
  setAllVerdicts(accepted: boolean): void;
  /** Close the review, recording every verdict — including the rejections. */
  finishReview(): void;
  /** Close it and take everything back. */
  discardReview(): void;

  /** What this edit is meant to be, and how long. Per project, not per device. */
  saveBrief(brief: string, targetDurationUs: number | null): void;

  /** False on a browser with no video encoder; the export button says so rather than lying. */
  canExport: boolean;
  exportState: ExportState | null;
  startExport(): void;
  cancelExport(): void;
  dismissExport(): void;
}

export function useSession(): Session {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [project, setProject] = useState<Project | null>(null);
  /*
    Whether the last attempt to open this project ended with the tab being killed.

    A phone editor cannot assume it will be allowed to finish opening: a multi-gigabyte
    recording, two `<video>` elements holding hardware decoders, a third extracting
    thumbnails and an audio pass decoding half an hour of AAC all sit inside an allowance
    iOS ends the process for exceeding — with no warning and nothing to catch. Reported
    exactly that way, and because opening is what killed it, every reload killed it again.

    So: a breadcrumb, and an open that skips the analysis when it finds one. See
    `recover.ts`.
  */
  const [recovered, setRecovered] = useState<{ stage: string } | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  // Read from inside the refinement's async body, which starts before the render that
  // would have closed over a fresh copy.
  const mediaUrlsRef = useRef(mediaUrls);
  mediaUrlsRef.current = mediaUrls;
  const [missingMedia, setMissingMedia] = useState<MissingMedia[]>([]);
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [history, setHistory] = useState<Project[]>([]);
  const [seekingUnsupported, setSeekingUnsupported] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineProgress, setRefineProgress] = useState<RefineProgress | null>(null);
  const [refinedBy, setRefinedBy] = useState<'model' | 'heuristics' | null>(null);

  const loggerRef = useRef<ReturnType<typeof makeLogger> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const lastScrubLogRef = useRef(0);
  /*
    One frame of the output, kept in a ref so `seek` does not have to be rebuilt — and
    every consumer of `seek` re-memoised — each time the project changes.
  */
  const frameUsRef = useRef(0);
  frameUsRef.current = project ? frameUsOf(project.timeline.frameRate) : 0;
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportUrlRef = useRef<string | null>(null);
  const refineAbortRef = useRef<AbortController | null>(null);

  const releaseUrls = useCallback(() => {
    for (const url of urlsRef.current.values()) releaseMediaUrl(url);
    urlsRef.current = new Map();
  }, []);

  const refreshRecents = useCallback(async () => {
    setRecentProjects(await stores.projects.list());
  }, []);

  /** Persist the project, coalescing bursts of edits into one write. */
  const scheduleSave = useCallback((next: Project) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void stores.projects.save(next).catch((cause) => setError(describeError(cause)));
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const record = useCallback((type: LogEventType, detail: Partial<LogEvent> = {}) => {
    const logger = loggerRef.current;
    if (!logger) return;
    const event = logger(type, 'human', detail);
    setEvents((previous) => [...previous, event]);
    // Log rows are small and append-only, so they go straight through rather than
    // waiting on the project debounce. Losing the tab should cost at most the last edit,
    // never the trail that led to it.
    void stores.projects.appendEvents([event]).catch(() => {});
  }, []);

  const bind = useCallback(
    async (next: Project) => {
      releaseUrls();
      // Waited on, not fired and forgotten: media bound before the range server controls
      // the page would be stuck on an unseekable blob URL for the rest of the session.
      await startMediaServer();
      const bound = await bindProjectMedia(next, stores.media, { createUrl: (file, source) => mediaUrlFor(source, file).url });
      urlsRef.current = bound.urls;
      setMediaUrls(bound.urls);
      setMissingMedia(bound.missing);
    },
    [releaseUrls],
  );

  const adopt = useCallback(
    async (next: Project, existingEvents: LogEvent[]) => {
      // Resume the sequence where the stored log left off, so a reopened project's log
      // stays monotonic instead of overwriting its own first rows.
      loggerRef.current = makeLogger(
        next.id,
        () => newId('event'),
        () => new Date().toISOString(),
        (existingEvents.at(-1)?.seq ?? -1) + 1,
      );

      /*
        Before anything expensive. If the last open of this project never reached the end
        of its analysis, the process was killed doing it — so this one does not try again,
        and says where the last one got to. That line is the whole point: a crash on a
        phone leaves no stack, no console and no exportable log, and "it died measuring"
        is the difference between a guess and a fix.
      */
      const failed = beginOpen(next.id);
      setRecovered(failed ? { stage: failed.stage } : null);

      setProject(next);
      setEvents(existingEvents);
      setPlayhead(0);
      setSelectedClipId(null);
      setHistory([]);
      if (failed) {
        record('app.recovered', { payload: { diedAt: failed.stage, sinceMs: Date.now() - failed.at } });
      }
      noteStage('media');
      await bind(next);
      await stores.projects.setLastOpened(next.id);
      noteStage('measure');
      setStatus('ready');
    },
    [bind, record],
  );

  // Reopen whatever the user was last working on.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [lastOpened, summaries] = await Promise.all([
          stores.projects.getLastOpened(),
          stores.projects.list(),
        ]);
        if (cancelled) return;
        setRecentProjects(summaries);

        if (!lastOpened) {
          setStatus('empty');
          return;
        }

        const restored = await stores.projects.load(lastOpened);
        if (cancelled) return;
        if (!restored) {
          setStatus('empty');
          return;
        }

        await adopt(restored, await stores.projects.readEvents(restored.id));
      } catch (cause) {
        if (cancelled) return;
        // A project that will not load must not trap the user on a blank screen —
        // report it and let them start or open something else.
        setError(describeError(cause));
        setStatus('empty');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adopt]);

  useEffect(() => releaseUrls, [releaseUrls]);

  const importFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        // Media first: a project is never persisted pointing at bytes we have not stored.
        const stored = await stores.media.put(file);

        // Probed from the file the user picked, not the copy read back out of storage.
        // Same bytes either way, but this one still has its real name, so a failure here
        // says "IMG_0421.MOV" instead of the fingerprint the storage path is named after.
        const meta = await probeVideo(file);
        const created = projectFromSource(sourceFromMedia(stored, meta));

        // The copy is what every later session will play, so check it opens now rather
        // than leaving the user a project that only fails the next time they open it.
        const playable = await stores.media.get(stored.path);
        if (!playable) throw new Error(`${file.name} was saved but could not be read back.`);

        await stores.projects.save(created);
        await adopt(created, []);
        record('source.import', {
          payload: { sourceId: created.sources[0]!.id, filename: file.name, duration: meta.durationUs },
        });
        void requestPersistentStorage();
        void refreshRecents();
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setBusy(false);
      }
    },
    [adopt, record, refreshRecents],
  );

  /** Re-attach a project whose media went missing, without disturbing its cut points. */
  const relinkMedia = useCallback(
    async (sourceId: string, file: File) => {
      if (!project) return;
      // A relink means these bytes are not the bytes the cached frames came from.
      forgetContactSheets();
      setBusy(true);
      setError(null);
      try {
        const stored = await stores.media.put(file);
        const next = rebindSource(project, sourceId, stored.path, stored.fingerprint);
        setProject(next);
        await stores.projects.save(next);
        await bind(next);
        record('source.probe', { payload: { sourceId, relinked: stored.path } });
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setBusy(false);
      }
    },
    [bind, project, record],
  );

  const openProject = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const loaded = await stores.projects.load(id);
        if (!loaded) throw new Error('That project is no longer stored.');
        await adopt(loaded, await stores.projects.readEvents(id));
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setBusy(false);
      }
    },
    [adopt],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await stores.projects.delete(id);
      if (project?.id === id) {
        releaseUrls();
        setProject(null);
        setEvents([]);
        setStatus('empty');
      }
      await refreshRecents();
    },
    [project, refreshRecents, releaseUrls],
  );

  const closeProject = useCallback(() => {
    releaseUrls();
    // The frames belong to this project's media. Holding a hundred JPEGs for a project
    // nobody has open is memory spent on nothing.
    forgetContactSheets();
    resetPlayhead();
    setProject(null);
    setEvents([]);
    setMediaUrls(new Map());
    setMissingMedia([]);
    setStatus('empty');
    void stores.projects.setLastOpened(null);
    void refreshRecents();
  }, [refreshRecents, releaseUrls]);

  /**
   * Apply ops, log them, and schedule a save.
   *
   * Human and machine edits share this path and land in the same revision chain, which is
   * what makes `by: 'human'` versus `by: 'llm'` a real distinction rather than a label.
   */
  const edit = useCallback(
    (
      type: LogEventType,
      ops: Op[],
      options: { review?: { verdicts: OpVerdict[] }; by?: 'human' | 'llm'; model?: string } = {},
    ) => {
      if (!project) return;

      /*
        A manual edit while a review is open goes to the *baseline*, not to what is on
        screen.

        The visible timeline is `baseline + accepted suggestions`, derived. Committing a
        trim against the derived state would bake the accepted suggestions into it, and
        the next tick of a bubble would then apply them a second time. Editing underneath
        instead keeps the one rule intact: your edit and the machine's are separate layers,
        and either can be changed without disturbing the other.
      */
      const open = project.review;
      const target = open ? { ...project, timeline: open.baseline } : project;

      // Computed outside `setProject` on purpose. Logging and saving are side effects,
      // and StrictMode invokes state updaters twice — running them in there would
      // double every row in the log.
      const result = commitOps(target, ops, {
        by: options.by ?? 'human',
        ...(options.review ? { review: options.review } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      if (result.errors.length > 0 && result.applied.length === 0) {
        setError(result.errors[0]!.message);
        return;
      }

      const next = open
        ? deriveReview({ ...result.project, review: { ...open, baseline: result.project.timeline } })
        : result.project;

      setHistory((previous) => [...previous, project].slice(-HISTORY_LIMIT));
      setProject(next);
      record(type, { ops: result.applied, revisionId: result.revision.id, playhead: getPlayhead() });
      scheduleSave(next);
    },
    [project, record, scheduleSave],
  );

  /**
   * Step back one edit.
   *
   * Restores the whole previous project, `revisions` included, so the chain stays
   * replayable rather than describing a timeline that no longer exists. The undone ops go
   * into the log with the `edit.undo` row — "the user tried this and took it back" is
   * signal we would otherwise throw away by rolling the revision off.
   */
  const undo = useCallback(() => {
    const previous = history.at(-1);
    if (!previous || !project) return;

    const undone = project.revisions.at(-1);
    setHistory((stack) => stack.slice(0, -1));
    setProject(previous);
    setSelectedClipId(null);
    record('edit.undo', {
      ...(undone ? { ops: undone.ops, revisionId: undone.id } : {}),
      playhead,
    });
    scheduleSave(previous);
  }, [history, playhead, project, record, scheduleSave]);

  /**
   * Move the playhead.
   *
   * The store is written every time; React state is written only on a *final* seek, plus a
   * coalesced catch-up on the same timer as the scrub log. A scroll and a playing video
   * both call this sixty times a second, and putting sixty renders of the whole editor
   * behind each gesture is the jank — the four or five things that genuinely need the
   * position at 60Hz subscribe to the store instead.
   */
  const seek = useCallback(
    (to: number, final = true) => {
      /*
        A parked playhead sits on a frame.

        Not while it is moving — a scrub and a playing video both want the continuous
        position, and rounding sixty times a second would make the picture stutter against
        its own clock. But the moment a gesture ends, the position becomes a place: it is
        what a cut is made at, what a keyframe is dropped on, and what the ruler's ticks are
        being read against. Left unrounded it is none of those things exactly, and the frame
        on screen — which is always the frame the time falls *inside* — sits up to a whole
        frame away from wherever the next edit lands.
      */
      const target = final ? snapToFrame(Math.max(0, to), frameUsRef.current) : Math.max(0, to);
      writePlayhead(target);
      // Everything that moves the playhead comes through here, which makes this the one
      // place that knows the user is busy. Background work reads it and stands aside; see
      // `quiet.ts` for what that was costing.
      noteInteraction();

      const now = Date.now();
      const due = now - lastScrubLogRef.current >= SCRUB_LOG_INTERVAL_MS;
      if (final || due) setPlayhead(target);
      if (!final && !due) return;
      lastScrubLogRef.current = now;
      record(final ? 'playback.seek' : 'playback.scrub', { playhead: target });
    },
    [record],
  );

  /**
   * Come out of recovery and open normally again.
   *
   * The breadcrumb has to be cleared *before* the reload, or the next open finds this
   * session's own and recovers again — which is the correct default (nothing has yet
   * proved this project can be opened) and the wrong answer to someone asking for another
   * go at it.
   */
  const retryOpen = useCallback(() => {
    finishOpen();
    window.location.reload();
  }, []);

  const select = useCallback((clipId: string | null) => setSelectedClipId(clipId), []);

  /**
   * Record what the media element can actually do.
   *
   * "Plays but will not seek" is invisible from the EDL — every cut looks fine and the
   * playback is simply wrong. Putting it in the log means the next exported session says
   * so outright instead of needing another round of guessing.
   */
  const reportMediaDiagnostics = useCallback(
    (info: Record<string, unknown>) => {
      setSeekingUnsupported(info.seekable === false);
      record('media.diagnostics', {
        payload: { ...info, rangeServer: isMediaServerActive(), backend: stores.backend },
      });
    },
    [record],
  );

  /**
   * Measure the footage, in the background, as soon as a project has media.
   *
   * Deliberately not deferred to the moment Refine is tapped: a person who has just
   * finished their coarse pass should not then wait on a progress bar, and the analysis is
   * cached by content so it usually costs nothing at all on a second open.
   */
  const onSignals = useCallback(
    (report: SignalsReport) => record('signals.compute', { payload: { ...report } }),
    [record],
  );
  const settingsRef = useRef<RefinementSettings>(EMPTY_SETTINGS);

  /*
    Nothing is measured in recovery. The analysis is where the allowance goes — an audio
    decode of the whole recording, and a filmstrip pass that opens a third decoder — so a
    session that is only trying to stay up long enough to be useful does without it.
  */
  const { signals, pending: measuring, progress: measuringProgress } = useSourceSignals(
    stores,
    recovered ? null : project,
    mediaUrls,
    onSignals,
  );

  useEffect(() => {
    setFilmstripExtraction(!recovered);
  }, [recovered]);

  /**
   * The dangerous part is over: forget the breadcrumb.
   *
   * "Over" is the analysis having finished and the editor having stayed up for a while
   * afterwards — not merely having rendered, because the thing that kills the tab happens
   * a minute into an open rather than at the first frame of it.
   */
  useEffect(() => {
    if (status !== 'ready' || measuring.length > 0) return;
    const timer = setTimeout(finishOpen, SETTLED_MS);
    return () => clearTimeout(timer);
  }, [status, measuring.length]);

  /*
    And leaving on purpose is not crashing. Without this the mechanism is a nuisance rather
    than a safety net: a reload ten seconds into an open — for any of the ordinary reasons
    people reload — would look exactly like a tab that had been killed.
  */
  useEffect(clearOnExit, []);
  const settingsState = useSettings(stores);
  const { settings } = settingsState;
  settingsRef.current = settings;

  const review = project?.review ?? null;
  /*
    Recomputed whenever the review or the edit underneath it moves.

    `previewOps` runs `applyOps` once per suggestion against the baseline, so this is
    O(suggestions x clips) — a few dozen of each. Cheap enough to do on every toggle, and
    doing it any other way would mean caching a derived value that must never be stale.
  */
  const previews = useMemo<OpPreview[]>(
    () =>
      review && project
        ? previewOps(review, project.timeline, { sources: project.sources })
        : [],
    [project, review],
  );
  const reviewFailures = useMemo(() => {
    if (!review || !project) return new Map<number, string>();
    const resolved = resolveReview(review, { sources: project.sources });
    return new Map(resolved.failures.map((failure) => [failure.index, failure.message]));
  }, [project, review]);

  const commitTrim = useCallback(
    (clipId: string, sourceIn: number, sourceOut: number) => {
      const clip = project?.timeline.tracks[0]?.clips.find((c) => c.id === clipId);
      // A drag that ended where it started is not an edit; recording one would put a
      // no-op revision in the chain and a meaningless row in the training data.
      if (!clip || (clip.sourceIn === sourceIn && clip.sourceOut === sourceOut)) return;
      edit('clip.trim', [{ op: 'trim', clipId, sourceIn, sourceOut }]);
    },
    [edit, project],
  );

  /**
   * Set one clip's grade, or clear it.
   *
   * One op, one revision, one log row — committed when the sheet closes rather than as the
   * slider moves. The sheet holds the draft in the meantime and the preview reads it
   * directly, so a look someone spent a minute finding arrives here as a single decision
   * instead of two hundred.
   */
  const setClipColor = useCallback(
    (clipId: string, color: ColorValue | null) => {
      edit('clip.color', [{ op: 'setColor', clipId, color }]);
    },
    [edit],
  );

  /**
   * Put the same grade on every clip.
   *
   * One revision covering all of them, not one per clip: undo should take back "I made
   * them all match", which is the thing that was decided, rather than walking backwards
   * through fifty-one identical steps. Disabled clips are included — a clip that comes
   * back later should come back looking like its neighbours.
   */
  const applyColorToAll = useCallback(
    (color: ColorValue | null) => {
      const clips = project?.timeline.tracks.flatMap((track) => track.clips) ?? [];
      if (clips.length === 0) return;
      edit(
        'clip.color',
        clips.map((clip) => ({ op: 'setColor' as const, clipId: clip.id, color })),
      );
    },
    [edit, project],
  );

  const setClipTransform = useCallback(
    (clipId: string, keyframes: TransformKeyframe[] | null) => {
      edit('clip.transform', [{ op: 'setTransform', clipId, keyframes }]);
    },
    [edit],
  );

  const setClipSpeed = useCallback(
    (clipId: string, speed: number) => {
      edit('clip.speed', [{ op: 'setSpeed', clipId, speed }]);
    },
    [edit],
  );

  const duplicateClip = useCallback(
    (clipId: string, at: 'after' | 'start') => {
      edit('clip.duplicate', [{ op: 'duplicateClip', clipId, at }]);
    },
    [edit],
  );

  const clipAtPlayhead = useCallback(() => {
    const clips = project?.timeline.tracks[0]?.clips ?? [];
    return (
      clips.find((clip) => {
        const end = clip.start + Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);
        const at = getPlayhead();
        return clip.enabled && at >= clip.start && at < end;
      }) ?? null
    );
  }, [project]);

  const splitAtPlayhead = useCallback(() => {
    const clip = clipAtPlayhead();
    if (!clip) return;
    // The live position, not React's copy of it. A cut has to land where the playhead is
    // *now* — the coalesced value can be a fraction of a second behind after a scroll, and
    // a cut a fraction of a second off is a cut in the wrong place.
    edit('clip.split', [{ op: 'split', clipId: clip.id, at: getPlayhead() }]);
  }, [clipAtPlayhead, edit]);

  const removeClip = useCallback(
    (clipId: string) => {
      edit('clip.remove', [{ op: 'remove', clipId }]);
      setSelectedClipId((current) => (current === clipId ? null : current));
    },
    [edit],
  );

  const deleteSelected = useCallback(() => {
    if (selectedClipId) removeClip(selectedClipId);
  }, [removeClip, selectedClipId]);

  const toggleClip = useCallback(
    (clipId: string) => {
      const clip = project?.timeline.tracks[0]?.clips.find((c) => c.id === clipId);
      if (!clip) return;
      edit(clip.enabled ? 'clip.remove' : 'clip.restore', [
        { op: 'setEnabled', clipId, enabled: !clip.enabled },
      ]);
    },
    [edit, project],
  );

  /** The coarse pass in one gesture: this take is the good one, drop the rest. */
  const keepOnly = useCallback(
    (clipId: string) => {
      const clips = project?.timeline.tracks[0]?.clips ?? [];
      const ops: Op[] = clips
        .filter((clip) => clip.id !== clipId && clip.enabled)
        .map((clip) => ({ op: 'setEnabled', clipId: clip.id, enabled: false }));
      if (ops.length > 0) edit('clip.remove', ops);
    },
    [edit, project],
  );

  const finishCoarsePass = useCallback(() => {
    if (!project) return;
    const frozen = freezeCoarsePass(project);
    setProject(frozen);
    record('coarse.commit', {
      payload: {
        clips: frozen.timeline.tracks[0]?.clips.filter((c) => c.enabled).length ?? 0,
        duration: timelineDuration(frozen.timeline),
      },
    });
    scheduleSave(frozen);
  }, [project, record, scheduleSave]);

  /**
   * Open a pass for review.
   *
   * Nothing is pre-accepted. A screen that opens with everything ticked collects consent,
   * not judgement, and the judgement is the entire point of the screen.
   *
   * The current timeline becomes the review's baseline, so the moment this lands the
   * visible edit is unchanged — the suggestions are on the timeline as bubbles, and
   * nothing has happened to the video until one is tapped.
   */
  const openReview = useCallback(
    (
      proposal: RefinementPlan,
      by: 'model' | 'heuristics',
      detail: Record<string, unknown>,
      usedModel?: string,
    ) => {
      setProject((current) => {
        if (!current) return current;
        const session: ReviewSession = {
          id: newId('revision'),
          by,
          ...(by === 'model' ? { model: usedModel ?? settingsRef.current.model } : {}),
          ...(proposal.summary ? { summary: proposal.summary } : {}),
          ops: proposal.ops,
          accepted: proposal.ops.map(() => false),
          baseline: current.timeline,
          createdAt: new Date().toISOString(),
        };
        const next = deriveReview({ ...current, review: session });
        scheduleSave(next);
        return next;
      });
      setRefinedBy(by);
      record('llm.plan', {
        payload: {
          ops: proposal.ops.length,
          summary: proposal.summary ?? '',
          by,
          // Whether the pass could see the footage is the first thing to know when reading
          // back a session where the suggestions were poor.
          measuredSources: signals.size,
          ...detail,
        },
      });
    },
    [record, scheduleSave, signals],
  );

  /**
   * Ask for a refinement pass.
   *
   * With a key configured this is a network call to a model; without one it falls back to
   * the local heuristics. The fallback is not a degraded mode to apologise for — it is
   * what makes the review screen usable, and testable, on a phone with no key and no
   * signal. Both paths produce the same `RefinementPlan` and land on the same screen.
   */
  const requestRefinement = useCallback(
    (steer?: {
      brief: string;
      targetDurationUs: number | null;
      model?: string;
      sendFrames?: boolean;
    }) => {
    if (!project || refining) return;

    const steered: Project = steer
      ? {
          ...project,
          brief: steer.brief,
          ...(steer.targetDurationUs ? { targetDurationUs: steer.targetDurationUs } : { targetDurationUs: undefined }),
        }
      : project;

    // Taken from the sheet rather than from settings for the same reason the brief is: the
    // save that persists the choice for next time has not committed yet, and a run that
    // used last week's model because of a React batch is impossible to explain afterwards.
    const model = steer?.model ?? settings.model;

    if (!settings.apiKey) {
      openReview(planLocalRefinement(steered, { signals }), 'heuristics', {});
      return;
    }

    const controller = new AbortController();
    refineAbortRef.current = controller;
    const sendFrames = steer?.sendFrames ?? false;

    setRefining(true);
    setRefineProgress({ phase: sendFrames ? 'looking' : 'thinking', tokens: 0, ops: 0, startedAt: Date.now() });
    setError(null);

    const startedAt = Date.now();
    record('llm.request', {
      payload: {
        model,
        effort: settings.effort || 'default',
        clips: steered.timeline.tracks[0]?.clips.filter((clip) => clip.enabled).length ?? 0,
        measuredSources: signals.size,
        // A digest rather than the brief itself. Two passes with the same digest were
        // steered the same way, which is what a training set needs to group by — and the
        // brief is free text the user typed about their own life, which is not.
        brief: steered.brief ? digest(steered.brief).slice(0, 12) : null,
        targetDurationUs: steered.targetDurationUs ?? null,
        // Recorded on every pass, because "did pictures of my footage leave this phone"
        // is a question that must be answerable from the log rather than from memory.
        sendFrames,
      },
    });

    void (async () => {
      let usage: Record<string, unknown> = {};
      // The vendor SDK is loaded here rather than imported at the top, so a coarse pass
      // on a phone never downloads a network client it will not use.
      let describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
      try {
        const { createAnthropicComplete, describeApiError } = await import('@evocut/agent/anthropic');
        describe = describeApiError;

        const complete = createAnthropicComplete(
          {
            apiKey: settings.apiKey,
            model,
            ...(settings.effort ? { effort: settings.effort } : {}),
            signal: controller.signal,
            onProgress: (progress) =>
              setRefineProgress((current) => ({ ...progress, startedAt: current?.startedAt ?? startedAt })),
          },
          (reported) => {
            usage = { ...reported };
          },
        );

        /*
          The frames, captured before the request goes out.

          Every one is a seek in a multi-gigabyte file, so this is the slow part and it is
          reported as its own phase — a person watching "Thinking…" for ninety seconds
          while the phone is actually seeking has been told the wrong thing.
        */
        let frames: ClipFrames[] = [];
        if (sendFrames) {
          const url = mediaUrlsRef.current.get(steered.timeline.tracks[0]?.clips[0]?.sourceId ?? '');
          if (url) {
            frames = await captureContactSheet(steered.timeline, url, {
              signal: controller.signal,
              onProgress: ({ done, total }) =>
                setRefineProgress((current) => ({
                  phase: 'looking',
                  tokens: 0,
                  ops: 0,
                  startedAt: current?.startedAt ?? startedAt,
                  framesDone: done,
                  framesTotal: total,
                })),
            });
          }
          if (controller.signal.aborted) return;
          setRefineProgress((current) => ({
            phase: 'thinking',
            tokens: 0,
            ops: 0,
            startedAt: current?.startedAt ?? startedAt,
          }));
        }

        const result = await proposeRefinement(steered, {
          complete,
          signals,
          ...(frames.length > 0 ? { frames } : {}),
          ...(steered.brief ? { instruction: steered.brief } : {}),
        });
        if (controller.signal.aborted) return;

        openReview(
          result.plan,
          'model',
          {
            rounds: result.rounds,
            // Ops the engine refused even after a repair round. Logged rather than
            // discarded: a model that keeps proposing edits the schema rejects is a prompt
            // problem, and this is the only place it would show up.
            rejected: result.rejected.length,
            rejectedReasons: result.rejected.map((failure) => failure.message).slice(0, 5),
            framesSent: frames.reduce((sum, clip) => sum + clip.frames.length, 0),
            clipsSeen: frames.length,
            elapsedMs: Date.now() - startedAt,
            ...usage,
          },
          model,
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = describe(cause);
        setError(message);
        record('llm.error', {
          payload: { message, model, elapsedMs: Date.now() - startedAt, ...usage },
        });
      } finally {
        if (!controller.signal.aborted) {
          setRefining(false);
          setRefineProgress(null);
        }
        refineAbortRef.current = null;
      }
    })();
    },
    [openReview, project, record, refining, settings, signals],
  );

  const cancelRefinement = useCallback(() => {
    refineAbortRef.current?.abort();
    refineAbortRef.current = null;
    setRefining(false);
    setRefineProgress(null);
  }, []);

  /**
   * Accept a suggestion, or take it back.
   *
   * Both directions are the same code path, which is the point: the timeline is re-derived
   * from `baseline + accepted`, so un-ticking is not an undo of anything. There is nothing
   * to reverse, so there is nothing to get wrong.
   */
  const setVerdicts = useCallback(
    (next: (previous: boolean[]) => boolean[], logAs: Record<string, unknown>) => {
      setProject((current) => {
        if (!current?.review) return current;
        const accepted = next(current.review.accepted);
        const updated = deriveReview({ ...current, review: { ...current.review, accepted } });
        scheduleSave(updated);
        return updated;
      });
      record('llm.verdict', { payload: logAs });
    },
    [record, scheduleSave],
  );

  const setVerdict = useCallback(
    (index: number, accepted: boolean) => {
      setVerdicts(
        (previous) => previous.map((value, at) => (at === index ? accepted : value)),
        { index, accepted },
      );
    },
    [setVerdicts],
  );

  const setAllVerdicts = useCallback(
    (accepted: boolean) => {
      setVerdicts((previous) => previous.map(() => accepted), { all: true, accepted });
    },
    [setVerdicts],
  );

  /**
   * Close the review and commit what survived it.
   *
   * One revision carrying *every* op with its verdict, not just the accepted subset — a
   * rejected op leaves no mark on the timeline, so this is the only place it survives, and
   * the rejections are half of what makes this a training set rather than a diff.
   *
   * The accepted ops are committed against the baseline, which is exactly how the derived
   * timeline was built, so the revision chain lands on the picture the user is looking at.
   */
  const finishReview = useCallback(() => {
    const open = project?.review;
    if (!project || !open) return;

    const allVerdicts: OpVerdict[] = open.ops.map((op, index) => ({
      op,
      accepted: open.accepted[index] ?? false,
    }));
    const result = commitOps(
      { ...project, timeline: open.baseline },
      allVerdicts.filter((verdict) => verdict.accepted).map((verdict) => verdict.op),
      {
        by: 'llm',
        review: { verdicts: allVerdicts },
        // Which model proposed this. Without it the training set pools verdicts from
        // different models — and "a human rejected this edit" means nothing if you cannot
        // tell which model proposed it.
        model: open.by === 'model' ? open.model ?? settings.model : 'local-heuristics',
        ...(open.summary ? { summary: open.summary } : {}),
      },
    );

    const { review: _closed, ...rest } = result.project;
    setHistory((previous) => [...previous, project].slice(-HISTORY_LIMIT));
    setProject(rest);
    setRefinedBy(null);
    record('llm.review', { ops: result.applied, revisionId: result.revision.id, playhead });
    scheduleSave(rest);
  }, [playhead, project, record, scheduleSave, settings.model]);

  const discardReview = useCallback(() => {
    const open = project?.review;
    if (!project || !open) return;
    record('llm.review', { payload: { discarded: true, ops: open.ops.length, by: open.by } });
    const { review: _dropped, ...rest } = project;
    // Back to the baseline outright: discarding means none of it happened, and the
    // baseline is by construction the timeline without any of it.
    const next = { ...rest, timeline: open.baseline };
    setProject(next);
    setRefinedBy(null);
    scheduleSave(next);
  }, [project, record, scheduleSave]);

  /**
   * What this edit is meant to be, and how long it should run.
   *
   * On the project, so it travels with the video rather than with the phone. A booster
   * bundle and a twenty-minute build log want opposite things from the same model, and a
   * device-wide brief would make every project after the first one wrong by default.
   */
  const saveBrief = useCallback(
    (brief: string, targetDurationUs: number | null) => {
      setProject((current) => {
        if (!current) return current;
        const next: Project = {
          ...current,
          brief: brief.trim(),
          ...(targetDurationUs && targetDurationUs > 0
            ? { targetDurationUs }
            : { targetDurationUs: undefined }),
          updatedAt: new Date().toISOString(),
        };
        scheduleSave(next);
        return next;
      });
      record('project.brief', {
        payload: {
          // A digest, not the words. Two passes with the same digest were steered the same
          // way, which is what a training set groups by; the brief itself is free text the
          // user typed about their own life, which is not.
          brief: brief.trim() ? digest(brief.trim()).slice(0, 12) : null,
          targetDurationUs,
        },
      });
    },
    [record, scheduleSave],
  );

  /**
   * How the renderer reaches the footage.
   *
   * Two different things, because the renderer needs the media twice over: a URL for the
   * `<video>` element that decodes the picture — the same range-served URL the preview
   * uses, since it is the only kind iOS will seek in — and the stored file itself, which
   * the audio path slices rather than reads.
   *
   * The file handle, not its bytes. This used to hand back `file.arrayBuffer()`, which on
   * a phone recording means asking for five gigabytes in one allocation; it fails, the
   * failure is caught, and the export comes out silent with nothing to say about why.
   */
  const resolver = useMemo<MediaResolver>(
    () => ({
      async url(sourceId) {
        const url = urlsRef.current.get(sourceId);
        if (!url) throw new Error('That clip’s video is not on this device.');
        return url;
      },
      async file(sourceId) {
        const source = project?.sources.find((candidate) => candidate.id === sourceId);
        if (source?.locator.kind !== 'opfs') return null;
        return (await stores.media.get(source.locator.path)) ?? null;
      },
    }),
    [project],
  );

  const releaseExportUrl = useCallback(() => {
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
    exportUrlRef.current = null;
  }, []);

  const startExport = useCallback(() => {
    if (!project) return;
    exportAbortRef.current?.abort();
    releaseExportUrl();

    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportState({
      status: 'rendering',
      stage: 'preparing',
      progress: 0,
      framesEncoded: 0,
      framesTotal: 0,
      result: null,
      error: null,
    });
    record('render.start', {
      payload: {
        clips: project.timeline.tracks[0]?.clips.filter((clip) => clip.enabled).length ?? 0,
        durationUs: timelineDuration(project.timeline),
        resolution: `${project.timeline.resolution.width}x${project.timeline.resolution.height}`,
      },
    });

    const startedAt = Date.now();
    void (async () => {
      try {
        const result = await renderProject({ project, resolver, signal: controller.signal }, (progress) =>
          setExportState((previous) =>
            previous?.status === 'rendering' ? { ...previous, ...progress } : previous,
          ),
        );
        if (controller.signal.aborted) return;

        const url = URL.createObjectURL(result.blob);
        exportUrlRef.current = url;
        setExportState({
          status: 'done',
          stage: 'done',
          progress: 1,
          framesEncoded: result.framesEncoded,
          framesTotal: result.framesEncoded,
          error: null,
          result: {
            blob: result.blob,
            url,
            filename: `${slug(project.name)}.mp4`,
            sizeBytes: result.blob.size,
            durationUs: result.durationUs,
            width: result.width,
            height: result.height,
            warnings: result.warnings,
          },
        });
        // How long an export actually takes, on a real phone, with real footage, is not
        // something that can be measured anywhere but here.
        record('render.complete', {
          payload: {
            elapsedMs: Date.now() - startedAt,
            durationUs: result.durationUs,
            framesEncoded: result.framesEncoded,
            sizeBytes: result.blob.size,
            videoCodec: result.videoCodec,
            audioCodec: result.audioCodec,
            resolution: `${result.width}x${result.height}`,
            warnings: result.warnings,
          },
        });
      } catch (cause) {
        if (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
          setExportState(null);
          return;
        }
        setExportState({
          status: 'error',
          stage: 'preparing',
          progress: 0,
          framesEncoded: 0,
          framesTotal: 0,
          result: null,
          error: describeError(cause),
        });
        record('render.error', {
          payload: { message: describeError(cause), elapsedMs: Date.now() - startedAt },
        });
      }
    })();
  }, [project, record, releaseExportUrl, resolver]);

  const cancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    setExportState(null);
  }, []);

  const dismissExport = useCallback(() => {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    // The object URL is deliberately not revoked here. Dismissing usually follows a tap on
    // Download, and revoking mid-download cancels it on some browsers. It is released when
    // the next export starts, or when the session ends.
    setExportState(null);
  }, []);

  useEffect(() => releaseExportUrl, [releaseExportUrl]);

  const duration = useMemo(
    () => (project ? timelineDuration(project.timeline) : 0),
    [project],
  );

  return {
    status,
    persistent: stores.persistent,
    project,
    /** Set when the previous open of this project killed the tab. Analysis is off. */
    recovered,
    retryOpen,
    selectedClipId,
    canUndo: history.length > 0,
    mediaUrls,
    missingMedia,
    recentProjects,
    playhead,
    duration,
    events,
    busy,
    error,
    review,
    previews,
    reviewFailures,
    importFile,
    relinkMedia,
    openProject,
    deleteProject,
    closeProject,
    seek,
    select,
    splitAtPlayhead,
    removeClip,
    deleteSelected,
    toggleClip,
    keepOnly,
    undo,
    finishCoarsePass,
    commitTrim,
    setClipColor,
    applyColorToAll,
    setClipTransform,
    setClipSpeed,
    duplicateClip,
    seekingUnsupported,
    reportMediaDiagnostics,
    requestRefinement,
    setVerdict,
    setAllVerdicts,
    finishReview,
    discardReview,
    saveBrief,
    signals,
    measuring,
    measuringProgress,
    refining,
    refineProgress,
    refinedBy,
    cancelRefinement,
    settings: settingsState.settings,
    settingsLoaded: settingsState.loaded,
    saveSettings: settingsState.save,
    forgetApiKey: settingsState.forgetKey,
    canExport: isRenderSupported(),
    exportState,
    startExport,
    cancelExport,
    dismissExport,
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Trigger a download of the project EDL. */
export function downloadProject(project: Project): void {
  download(`${slug(project.name)}.evocut.json`, JSON.stringify(project, null, 2), 'application/json');
}

/**
 * Trigger a download of the session log.
 *
 * JSONL rather than JSON: the log is append-only and will eventually be streamed rather
 * than held in memory, and a truncated JSONL file is still readable up to its last
 * complete line.
 */
export function downloadLog(project: Project, events: LogEvent[]): void {
  download(`${slug(project.name)}.evocut.jsonl`, serializeLog(events), 'application/x-ndjson');
}

function slug(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'project';
}

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
