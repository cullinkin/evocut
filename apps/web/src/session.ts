import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  commitOps,
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
import { planLocalRefinement } from '@evocut/agent';
import {
  bindProjectMedia,
  createStores,
  rebindSource,
  requestPersistentStorage,
  type MissingMedia,
  type ProjectSummary,
} from '@evocut/store';
import { probeVideo, sourceFromMedia } from './probe.ts';

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

export type SessionStatus = 'loading' | 'empty' | 'ready';

export interface Session {
  status: SessionStatus;
  persistent: boolean;
  project: Project | null;
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

  seek(to: number, viaScrub?: boolean): void;
  splitAtPlayhead(): void;
  removeClip(clipId: string): void;
  toggleClip(clipId: string): void;
  keepOnly(clipId: string): void;
  finishCoarsePass(): void;

  requestRefinement(): void;
  setVerdict(index: number, accepted: boolean): void;
  setAllVerdicts(accepted: boolean): void;
  applyReview(): void;
  discardReview(): void;
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

  const loggerRef = useRef<ReturnType<typeof makeLogger> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());

  const releaseUrls = useCallback(() => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
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
      const bound = await bindProjectMedia(next, stores.media);
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
        const bytes = await stores.media.get(stored.path);
        if (!bytes) throw new Error('The file was saved but could not be read back.');

        const meta = await probeVideo(bytes);
        const created = projectFromSource(sourceFromMedia(stored, meta));

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
    (type: LogEventType, ops: Op[], options: { review?: { verdicts: OpVerdict[] }; by?: 'human' | 'llm' } = {}) => {
      if (!project) return;

      // Computed outside `setProject` on purpose. Logging and saving are side effects,
      // and StrictMode invokes state updaters twice — running them in there would
      // double every row in the log.
      const result = commitOps(project, ops, {
        by: options.by ?? 'human',
        ...(options.review ? { review: options.review } : {}),
      });
      if (result.errors.length > 0 && result.applied.length === 0) {
        setError(result.errors[0]!.message);
        return;
      }

      setProject(result.project);
      record(type, { ops: result.applied, revisionId: result.revision.id, playhead });
      scheduleSave(result.project);
    },
    [playhead, project, record, scheduleSave],
  );

  const seek = useCallback(
    (to: number, viaScrub = false) => {
      const target = Math.max(0, to);
      setPlayhead(target);
      record(viaScrub ? 'playback.scrub' : 'playback.seek', { playhead: target });
    },
    [record],
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

  const removeClip = useCallback((clipId: string) => edit('clip.remove', [{ op: 'remove', clipId }]), [edit]);

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

  const requestRefinement = useCallback(() => {
    if (!project) return;
    const proposal = planLocalRefinement(project);
    setPlan(proposal);
    // Nothing is pre-accepted. A screen that opens with everything ticked collects
    // consent, not judgement, and the judgement is the entire point of the screen.
    setVerdicts(new Map(proposal.ops.map((_, index) => [index, false])));
    record('llm.plan', {
      payload: { ops: proposal.ops.length, summary: proposal.summary ?? '' },
    });
  }, [project, record]);

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
    edit('llm.review', accepted, { by: 'llm', review: { verdicts: allVerdicts } });
    setPlan(null);
    setVerdicts(new Map());
  }, [edit, plan, verdicts]);

  const discardReview = useCallback(() => {
    if (plan) record('llm.review', { payload: { discarded: true, ops: plan.ops.length } });
    setPlan(null);
    setVerdicts(new Map());
  }, [plan, record]);

  const duration = useMemo(() => (project ? timelineDuration(project.timeline) : 0), [project]);

  return {
    status,
    persistent: stores.persistent,
    project,
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
    splitAtPlayhead,
    removeClip,
    toggleClip,
    keepOnly,
    finishCoarsePass,
    requestRefinement,
    setVerdict,
    setAllVerdicts,
    applyReview,
    discardReview,
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
