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
  type Op,
  type OpVerdict,
  type Project,
  type RefinementPlan,
} from '@evocut/edl';
import { planLocalRefinement, proposeRefinement } from '@evocut/agent';
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
import { useSourceSignals, type SignalsReport } from './signals.ts';
import { useSettings, type RefinementSettings } from './settings.ts';

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

/** How many steps back the editor can go. */
const HISTORY_LIMIT = 50;

export type SessionStatus = 'loading' | 'empty' | 'ready';

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

  /** A refinement pass awaiting review, with the user's verdict on each op so far. */
  plan: RefinementPlan | null;
  verdicts: Map<number, boolean>;

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

  /** True while a refinement pass is in flight. It is a network call now, not a function. */
  refining: boolean;
  /** How the last pass was produced, for the review screen to say so. */
  refinedBy: 'model' | 'heuristics' | null;
  requestRefinement(): void;
  cancelRefinement(): void;

  settings: RefinementSettings;
  settingsLoaded: boolean;
  saveSettings(next: RefinementSettings): Promise<void>;
  forgetApiKey(): Promise<void>;
  setVerdict(index: number, accepted: boolean): void;
  setAllVerdicts(accepted: boolean): void;
  applyReview(): void;
  discardReview(): void;

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
  const [mediaUrls, setMediaUrls] = useState<Map<string, string>>(new Map());
  const [missingMedia, setMissingMedia] = useState<MissingMedia[]>([]);
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RefinementPlan | null>(null);
  const [verdicts, setVerdicts] = useState<Map<number, boolean>>(new Map());
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [history, setHistory] = useState<Project[]>([]);
  const [seekingUnsupported, setSeekingUnsupported] = useState(false);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [refining, setRefining] = useState(false);
  const [refinedBy, setRefinedBy] = useState<'model' | 'heuristics' | null>(null);

  const loggerRef = useRef<ReturnType<typeof makeLogger> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const lastScrubLogRef = useRef(0);
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

      setProject(next);
      setEvents(existingEvents);
      setPlayhead(0);
      setPlan(null);
      setVerdicts(new Map());
      setSelectedClipId(null);
      setHistory([]);
      await bind(next);
      await stores.projects.setLastOpened(next.id);
      setStatus('ready');
    },
    [bind],
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
    setProject(null);
    setEvents([]);
    setPlan(null);
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

      // Computed outside `setProject` on purpose. Logging and saving are side effects,
      // and StrictMode invokes state updaters twice — running them in there would
      // double every row in the log.
      const result = commitOps(project, ops, {
        by: options.by ?? 'human',
        ...(options.review ? { review: options.review } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      if (result.errors.length > 0 && result.applied.length === 0) {
        setError(result.errors[0]!.message);
        return;
      }

      setHistory((previous) => [...previous, project].slice(-HISTORY_LIMIT));
      setProject(result.project);
      record(type, { ops: result.applied, revisionId: result.revision.id, playhead });
      scheduleSave(result.project);
    },
    [playhead, project, record, scheduleSave],
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

  const seek = useCallback(
    (to: number, final = true) => {
      const target = Math.max(0, to);
      setPlayhead(target);

      const now = Date.now();
      if (!final && now - lastScrubLogRef.current < SCRUB_LOG_INTERVAL_MS) return;
      lastScrubLogRef.current = now;
      record(final ? 'playback.seek' : 'playback.scrub', { playhead: target });
    },
    [record],
  );

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
  const { signals, pending: measuring } = useSourceSignals(stores, project, mediaUrls, onSignals);
  const settingsState = useSettings(stores);
  const { settings } = settingsState;

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

  const clipAtPlayhead = useCallback(() => {
    const clips = project?.timeline.tracks[0]?.clips ?? [];
    return (
      clips.find((clip) => {
        const end = clip.start + Math.round((clip.sourceOut - clip.sourceIn) / clip.speed);
        return clip.enabled && playhead >= clip.start && playhead < end;
      }) ?? null
    );
  }, [project, playhead]);

  const splitAtPlayhead = useCallback(() => {
    const clip = clipAtPlayhead();
    if (!clip) return;
    edit('clip.split', [{ op: 'split', clipId: clip.id, at: playhead }]);
  }, [clipAtPlayhead, edit, playhead]);

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
   * Present a plan for review.
   *
   * Nothing is pre-accepted. A screen that opens with everything ticked collects consent,
   * not judgement, and the judgement is the entire point of the screen.
   */
  const presentPlan = useCallback(
    (proposal: RefinementPlan, by: 'model' | 'heuristics', detail: Record<string, unknown>) => {
      setPlan(proposal);
      setVerdicts(new Map(proposal.ops.map((_, index) => [index, false])));
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
    [record, signals],
  );

  /**
   * Ask for a refinement pass.
   *
   * With a key configured this is a network call to a model; without one it falls back to
   * the local heuristics. The fallback is not a degraded mode to apologise for — it is
   * what makes the review screen usable, and testable, on a phone with no key and no
   * signal. Both paths produce the same `RefinementPlan` and land on the same screen.
   */
  const requestRefinement = useCallback(() => {
    if (!project || refining) return;

    if (!settings.apiKey) {
      presentPlan(planLocalRefinement(project, { signals }), 'heuristics', {});
      return;
    }

    const controller = new AbortController();
    refineAbortRef.current = controller;
    setRefining(true);
    setError(null);

    const startedAt = Date.now();
    record('llm.request', {
      payload: {
        model: settings.model,
        effort: settings.effort || 'default',
        clips: project.timeline.tracks[0]?.clips.filter((clip) => clip.enabled).length ?? 0,
        measuredSources: signals.size,
        // A digest rather than the brief itself. Two passes with the same digest were
        // steered the same way, which is what a training set needs to group by — and the
        // brief is free text the user typed about their own life, which is not.
        brief: settings.brief ? digest(settings.brief).slice(0, 12) : null,
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
            model: settings.model,
            ...(settings.effort ? { effort: settings.effort } : {}),
            signal: controller.signal,
          },
          (reported) => {
            usage = { ...reported };
          },
        );

        const result = await proposeRefinement(project, {
          complete,
          signals,
          ...(settings.brief ? { instruction: settings.brief } : {}),
        });
        if (controller.signal.aborted) return;

        presentPlan(result.plan, 'model', {
          rounds: result.rounds,
          // Ops the engine refused even after a repair round. Logged rather than
          // discarded: a model that keeps proposing edits the schema rejects is a prompt
          // problem, and this is the only place it would show up.
          rejected: result.rejected.length,
          rejectedReasons: result.rejected.map((failure) => failure.message).slice(0, 5),
          elapsedMs: Date.now() - startedAt,
          ...usage,
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = describe(cause);
        setError(message);
        record('llm.error', {
          payload: { message, model: settings.model, elapsedMs: Date.now() - startedAt, ...usage },
        });
      } finally {
        if (!controller.signal.aborted) setRefining(false);
        refineAbortRef.current = null;
      }
    })();
  }, [presentPlan, project, record, refining, settings, signals]);

  const cancelRefinement = useCallback(() => {
    refineAbortRef.current?.abort();
    refineAbortRef.current = null;
    setRefining(false);
  }, []);

  const setVerdict = useCallback((index: number, accepted: boolean) => {
    setVerdicts((previous) => new Map(previous).set(index, accepted));
  }, []);

  const setAllVerdicts = useCallback(
    (accepted: boolean) => {
      if (!plan) return;
      setVerdicts(new Map(plan.ops.map((_, index) => [index, accepted])));
    },
    [plan],
  );

  const applyReview = useCallback(() => {
    if (!plan) return;
    const allVerdicts: OpVerdict[] = plan.ops.map((op, index) => ({
      op,
      accepted: verdicts.get(index) ?? false,
    }));
    const accepted = allVerdicts.filter((v) => v.accepted).map((v) => v.op);

    // The whole proposal goes into the revision, not just the accepted subset: a rejected
    // op leaves no mark on the timeline, so this is the only place it survives.
    edit('llm.review', accepted, {
      by: 'llm',
      review: { verdicts: allVerdicts },
      // Which model proposed this. Without it the training set pools verdicts from
      // different models — and "a human rejected this edit" means nothing if you cannot
      // tell which model proposed it.
      model: refinedBy === 'model' ? settings.model : 'local-heuristics',
    });
    setPlan(null);
    setVerdicts(new Map());
    setRefinedBy(null);
  }, [edit, plan, refinedBy, settings.model, verdicts]);

  const discardReview = useCallback(() => {
    if (plan) record('llm.review', { payload: { discarded: true, ops: plan.ops.length, by: refinedBy } });
    setPlan(null);
    setVerdicts(new Map());
    setRefinedBy(null);
  }, [plan, record, refinedBy]);

  /**
   * How the renderer reaches the footage.
   *
   * Two different things, because the renderer needs the media twice over: a URL for the
   * `<video>` element that decodes the picture — the same range-served URL the preview
   * uses, since it is the only kind iOS will seek in — and the raw bytes for
   * `decodeAudioData`, which cannot work from a URL at all.
   */
  const resolver = useMemo<MediaResolver>(
    () => ({
      async url(sourceId) {
        const url = urlsRef.current.get(sourceId);
        if (!url) throw new Error('That clip’s video is not on this device.');
        return url;
      },
      async bytes(sourceId) {
        const source = project?.sources.find((candidate) => candidate.id === sourceId);
        if (source?.locator.kind !== 'opfs') return null;
        const file = await stores.media.get(source.locator.path);
        return file ? file.arrayBuffer() : null;
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
    plan,
    verdicts,
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
    seekingUnsupported,
    reportMediaDiagnostics,
    requestRefinement,
    setVerdict,
    setAllVerdicts,
    applyReview,
    discardReview,
    signals,
    measuring,
    refining,
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
