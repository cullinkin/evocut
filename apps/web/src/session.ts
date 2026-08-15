import { useCallback, useMemo, useRef, useState } from 'react';
import {
  applyOps,
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
  type Project,
} from '@evocut/edl';
import { probeVideoFile } from './probe.ts';

/**
 * Coarse-pass session state.
 *
 * Two things are being produced here at once, and keeping that visible is the point of
 * this module: the EDL (what the user kept) and the log (how they arrived at it). Every
 * edit goes through `record`, so there is no path that mutates the timeline without
 * leaving a trail — the training set depends on that being true without exception.
 */
export interface Session {
  project: Project | null;
  objectUrl: string | null;
  playhead: number;
  duration: number;
  events: LogEvent[];
  busy: boolean;
  error: string | null;

  importFile(file: File): Promise<void>;
  seek(to: number, viaScrub?: boolean): void;
  splitAtPlayhead(): void;
  removeClip(clipId: string): void;
  toggleClip(clipId: string): void;
  keepOnly(clipId: string): void;
  finishCoarsePass(): void;
  reset(): void;
}

export function useSession(): Session {
  const [project, setProject] = useState<Project | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loggerRef = useRef<ReturnType<typeof makeLogger> | null>(null);

  const record = useCallback(
    (type: LogEventType, detail: Partial<LogEvent> = {}) => {
      const logger = loggerRef.current;
      if (!logger) return;
      setEvents((previous) => [...previous, logger(type, 'human', { playhead, ...detail })]);
    },
    [playhead],
  );

  const importFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const { source, objectUrl: url } = await probeVideoFile(file);
      const created = projectFromSource(source);

      loggerRef.current = makeLogger(created.id, () => newId('event'), () => new Date().toISOString());
      const logger = loggerRef.current;

      setObjectUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return url;
      });
      setProject(created);
      setPlayhead(0);
      setEvents([
        logger('project.create', 'human', { payload: { name: created.name } }),
        logger('source.import', 'human', {
          payload: { sourceId: source.id, filename: file.name, duration: source.duration },
        }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Apply ops and log them together.
   *
   * `commitOps` records a revision, so an edit made here is replayable in exactly the same
   * way as one the model makes later — the two passes share one history, which is what
   * makes `by: 'human'` versus `by: 'llm'` a meaningful distinction rather than a label.
   */
  const edit = useCallback(
    (type: LogEventType, ops: Op[]) => {
      setProject((current) => {
        if (!current) return current;
        const result = commitOps(current, ops, { by: 'human' });
        if (result.errors.length > 0) {
          setError(result.errors[0]!.message);
          return current;
        }
        record(type, { ops: result.applied, revisionId: result.revision.id });
        return result.project;
      });
    },
    [record],
  );

  const seek = useCallback(
    (to: number, viaScrub = false) => {
      setPlayhead(Math.max(0, to));
      record(viaScrub ? 'playback.scrub' : 'playback.seek', { playhead: Math.max(0, to) });
    },
    [record],
  );

  const clipAtPlayhead = useCallback(() => {
    if (!project) return null;
    const clips = project.timeline.tracks[0]?.clips ?? [];
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
    (clipId: string) => edit('clip.remove', [{ op: 'remove', clipId }]),
    [edit],
  );

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
    setProject((current) => {
      if (!current) return current;
      const frozen = freezeCoarsePass(current);
      record('coarse.commit', {
        payload: {
          clips: frozen.timeline.tracks[0]?.clips.filter((c) => c.enabled).length ?? 0,
          duration: timelineDuration(frozen.timeline),
        },
      });
      return frozen;
    });
  }, [record]);

  const reset = useCallback(() => {
    setObjectUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    loggerRef.current = null;
    setProject(null);
    setEvents([]);
    setPlayhead(0);
    setError(null);
  }, []);

  const duration = useMemo(
    () => (project ? timelineDuration(project.timeline) : 0),
    [project],
  );

  return {
    project,
    objectUrl,
    playhead,
    duration,
    events,
    busy,
    error,
    importFile,
    seek,
    splitAtPlayhead,
    removeClip,
    toggleClip,
    keepOnly,
    finishCoarsePass,
    reset,
  };
}

/** Trigger a download of the project EDL. */
export function downloadProject(project: Project): void {
  download(`${slug(project.name)}.evocut.json`, JSON.stringify(project, null, 2), 'application/json');
}

/**
 * Trigger a download of the session log.
 *
 * JSONL rather than JSON: the log is append-only and will eventually be streamed
 * somewhere rather than held in memory, and a truncated JSONL file is still readable
 * up to the last complete line.
 */
export function downloadLog(project: Project, events: LogEvent[]): void {
  download(`${slug(project.name)}.evocut.jsonl`, serializeLog(events), 'application/x-ndjson');
}

/** Preview what a set of ops would do without committing them. Used by the dev panel. */
export function previewOps(project: Project, ops: Op[]) {
  return applyOps(project.timeline, ops, { sources: project.sources });
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
