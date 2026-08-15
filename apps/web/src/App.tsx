import { useCallback, useEffect, useState } from 'react';
import { findModel } from '@evocut/agent';
import { formatTimecode, lengthStanding, timelineDuration } from '@evocut/edl';
import type { MissingMedia, ProjectSummary } from '@evocut/store';
import { BriefSheet } from './Brief.tsx';
import { ExportPanel } from './Export.tsx';
import { SettingsScreen } from './Settings.tsx';
import { Player } from './Player.tsx';
import { Review } from './Review.tsx';
import { SuggestionSheet } from './Suggestion.tsx';
import { TimelineEditor, type TimelineDragState } from './Timeline.tsx';
import { downloadLog, downloadProject, useSession, type RefineProgress } from './session.ts';

/**
 * The editor.
 *
 * Laid out for a phone held in one hand: preview on top, transport under it, the timeline
 * at the bottom where a thumb naturally rests. Nothing scrolls vertically during editing —
 * the whole screen is the tool, and a page that moves under a drag is the fastest way to
 * make touch editing feel broken.
 */
export function App() {
  const session = useSession();
  const [playing, setPlaying] = useState(false);
  const [drag, setDrag] = useState<TimelineDragState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const [showList, setShowList] = useState(false);
  /** Index of the suggestion whose sheet is open, or null. */
  const [openSuggestion, setOpenSuggestion] = useState<number | null>(null);

  const onTime = useCallback((t: number) => session.seek(t, false), [session]);
  const onEnded = useCallback(() => setPlaying(false), []);

  /**
   * A drag stops playback.
   *
   * Not tidiness: the playback loop writes the playhead from the video's own position
   * every frame, so dragging the playhead while playing was a tug of war the loop won.
   * The preview looked frozen because every drag position was immediately overwritten.
   */
  useEffect(() => {
    if (drag) setPlaying(false);
  }, [drag]);

  /**
   * The two files this app produces besides the video.
   *
   * They were in the editor's footer, one tap from every edit, which put two downloads
   * next to the buttons a thumb reaches for while scrubbing. They are also not editing
   * tools: the EDL is the edit as a document and the log is how it was arrived at. So they
   * live one level in, on a screen that can say what each of them is.
   */
  if (showMetadata && session.project) {
    const openProject = session.project;
    return (
      <main className="shell">
        <header>
          <button className="ghost" onClick={() => setShowMetadata(false)} aria-label="Back">
            ←
          </button>
          <div className="title">
            <h1>Metadata</h1>
            <p className="meta">{openProject.name}</p>
          </div>
        </header>
        <div className="settings metadata">
          <ul className="exports">
            <li>
              <div>
                <strong>EDL</strong>
                <small>
                  Every cut, trim and suggestion as JSON — the edit itself, without the
                  footage. This is what to keep if you want to rebuild this project later.
                </small>
              </div>
              <button
                className="ghost download"
                onClick={() => downloadProject(openProject)}
                aria-label="Export EDL"
              >
                ⤓
              </button>
            </li>
            <li>
              <div>
                <strong>Logs</strong>
                <small>
                  {session.events.length} {session.events.length === 1 ? 'event' : 'events'} — how
                  the edit was arrived at, in order. The record a training set is built from.
                </small>
              </div>
              <button
                className="ghost download"
                onClick={() => downloadLog(openProject, session.events)}
                aria-label="Export Logs"
              >
                ⤓
              </button>
            </li>
          </ul>
          <p className="meta">
            Neither file contains your API key or any footage. The EDL does carry the style
            brief you typed for this video.
          </p>
        </div>
      </main>
    );
  }

  if (showSettings) {
    return (
      <main className="shell">
        <header>
          <button className="ghost" onClick={() => setShowSettings(false)} aria-label="Back">
            ←
          </button>
          <div className="title">
            <h1>Settings</h1>
            <p className="meta">{session.settings.apiKey ? 'Key saved on this device' : 'No key yet'}</p>
          </div>
        </header>
        <SettingsScreen
          settings={session.settings}
          busy={!session.settingsLoaded}
          onSave={(next) => void session.saveSettings(next).then(() => setShowSettings(false))}
          onForgetKey={() => void session.forgetApiKey()}
          onClose={() => setShowSettings(false)}
          {...(session.project
            ? {
                onMetadata: () => {
                  setShowSettings(false);
                  setShowMetadata(true);
                },
              }
            : {})}
        />
      </main>
    );
  }

  if (session.status === 'loading') {
    return (
      <main className="shell empty">
        <p className="lede">Opening…</p>
      </main>
    );
  }

  if (session.status === 'empty' || !session.project) {
    return (
      <StartScreen
        busy={session.busy}
        error={session.error}
        persistent={session.persistent}
        recents={session.recentProjects}
        onPick={(file) => void session.importFile(file)}
        onOpen={(id) => void session.openProject(id)}
        onDelete={(id) => void session.deleteProject(id)}
        onSettings={() => setShowSettings(true)}
      />
    );
  }

  const { project, playhead, review, previews } = session;
  const open = openSuggestion === null ? null : previews[openSuggestion] ?? null;
  const clips = project.timeline.tracks[0]?.clips ?? [];
  const kept = clips.filter((clip) => clip.enabled);
  const total = timelineDuration(project.timeline);
  const frozen = project.stage !== 'coarse';
  const selected = clips.find((c) => c.id === session.selectedClipId) ?? null;
  const mediaUrl = session.mediaUrls.get(clips[0]?.sourceId ?? '') ?? null;

  // The export owns the whole screen while it runs. It takes about as long as the video
  // is, the tab has to stay in front for it, and a progress bar tucked into a corner of a
  // live editor invites exactly the tab switch that stalls the capture.
  if (session.exportState) {
    return (
      <main className="shell">
        <header>
          <div className="title">
            <h1>{project.name}</h1>
            <p className="meta">Export</p>
          </div>
        </header>
        <ExportPanel
          state={session.exportState}
          onStart={session.startExport}
          onCancel={session.cancelExport}
          onClose={session.dismissExport}
        />
      </main>
    );
  }

  return (
    <main className="shell editor">
      <header>
        <button className="ghost" onClick={session.closeProject} aria-label="Projects">
          ←
        </button>
        <div className="title">
          <h1>{project.name}</h1>
          <p className="meta">
            {kept.length} {kept.length === 1 ? 'clip' : 'clips'} ·{' '}
            {project.targetDurationUs
              ? lengthStanding(project.timeline, project.targetDurationUs).label
              : formatTimecode(total, undefined, { compact: true })}
            {!session.persistent && ' · not saved'}
            {/*
              Worth saying out loud: the refinement pass is meaningfully better once the
              footage has been measured, and a person who taps Refine ten seconds after
              importing would otherwise have no way to know they got the blind version.
            */}
            {session.measuring.length > 0 &&
              ` · listening to the footage${
                session.measuringProgress > 0 ? ` ${Math.round(session.measuringProgress * 100)}%` : ''
              }`}
          </p>
        </div>
        {review ? (
          <button className="primary small" onClick={() => setShowList(true)}>
            {previews.filter((_, i) => review.accepted[i]).length}/{previews.length} kept
          </button>
        ) : frozen ? (
          <button className="primary small" onClick={() => setShowBrief(true)} disabled={session.refining}>
            {session.refining ? 'Thinking…' : 'Refine'}
          </button>
        ) : (
          <button className="primary small" onClick={session.finishCoarsePass} disabled={kept.length === 0}>
            Done
          </button>
        )}
      </header>

      {session.refining && (
        <RefineBanner
          model={findModel(session.settings.model)?.label ?? session.settings.model}
          progress={session.refineProgress}
          onCancel={session.cancelRefinement}
        />
      )}

      {session.missingMedia.length > 0 && (
        <RelinkPrompt
          missing={session.missingMedia}
          busy={session.busy}
          onRelink={(sourceId, file) => void session.relinkMedia(sourceId, file)}
        />
      )}

      {mediaUrl && (
        <Player
          objectUrl={mediaUrl}
          timeline={project.timeline}
          playhead={playhead}
          playing={playing}
          scrubbing={drag !== null}
          scrubSourceTime={drag?.scrubSourceTime ?? null}
          onTime={onTime}
          onEnded={onEnded}
          onDiagnostics={session.reportMediaDiagnostics}
        />
      )}

      {session.seekingUnsupported && (
        <p className="warning">
          This browser will play this video but will not seek inside it, so cuts and
          scrubbing have no effect on the preview. The edit itself is still being recorded
          correctly — it is only the preview that is wrong.
        </p>
      )}

      <div className="transport">
        <button className="icon" onClick={() => session.seek(0)} aria-label="Back to start">
          ⏮
        </button>
        <button className="play" onClick={() => setPlaying((p) => !p)} disabled={!mediaUrl}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="clock">
          {formatTimecode(playhead, undefined, { compact: true })}
          <em> / {formatTimecode(total, undefined, { compact: true })}</em>
        </span>
      </div>

      <TimelineEditor
        timeline={project.timeline}
        sources={project.sources}
        mediaUrls={session.mediaUrls}
        playhead={playhead}
        selectedClipId={session.selectedClipId}
        frozen={frozen}
        previews={previews}
        accepted={review?.accepted ?? []}
        onSeek={session.seek}
        onSelect={session.select}
        onTrimCommit={session.commitTrim}
        onDragChange={setDrag}
        onOpenSuggestion={setOpenSuggestion}
      />

      <nav className="toolbar" aria-label="Editing tools">
        <button onClick={session.undo} disabled={!session.canUndo} aria-label="Undo">
          <span aria-hidden="true">⤺</span>
          <small>Undo</small>
        </button>
        <button onClick={session.splitAtPlayhead} disabled={frozen} aria-label="Cut at playhead">
          <span aria-hidden="true">✂</span>
          <small>Cut</small>
        </button>
        <button
          onClick={() => selected && session.toggleClip(selected.id)}
          disabled={frozen || !selected}
          aria-label={selected?.enabled === false ? 'Restore clip' : 'Drop clip'}
        >
          <span aria-hidden="true">{selected?.enabled === false ? '◍' : '◌'}</span>
          <small>{selected?.enabled === false ? 'Restore' : 'Drop'}</small>
        </button>
        <button
          className="danger"
          onClick={session.deleteSelected}
          disabled={frozen || !selected}
          aria-label="Delete clip"
        >
          <span aria-hidden="true">🗑</span>
          <small>Delete</small>
        </button>
      </nav>

      {showBrief && (
        <BriefSheet
          brief={project.brief ?? ''}
          targetDurationUs={project.targetDurationUs ?? null}
          currentUs={total}
          busy={session.refining}
          hasKey={Boolean(session.settings.apiKey)}
          model={session.settings.model}
          onRun={(brief, target, model) => {
            // Saved *and* passed. The save is what persists it for next time; the argument
            // is what steers this run, because neither `setProject` nor the settings write
            // has committed yet.
            session.saveBrief(brief, target);
            if (model !== session.settings.model) {
              void session.saveSettings({ ...session.settings, model });
            }
            session.requestRefinement({ brief, targetDurationUs: target, model });
            setShowBrief(false);
          }}
          onClose={() => setShowBrief(false)}
        />
      )}

      {review && openSuggestion !== null && open && (
        <SuggestionSheet
          preview={open}
          index={openSuggestion}
          count={previews.length}
          accepted={review.accepted[openSuggestion] ?? false}
          source={project.sources.find((source) => source.id === open.before?.sourceId) ?? null}
          mediaUrl={session.mediaUrls.get(open.before?.sourceId ?? '') ?? null}
          totalUs={total}
          standing={lengthStanding(project.timeline, project.targetDurationUs).label}
          failure={session.reviewFailures.get(openSuggestion) ?? null}
          onVerdict={(accepted) => session.setVerdict(openSuggestion, accepted)}
          onStep={(delta) =>
            setOpenSuggestion((current) =>
              current === null ? null : (current + delta + previews.length) % previews.length,
            )
          }
          onClose={() => setOpenSuggestion(null)}
        />
      )}

      {review && showList && (
        <Review
          previews={previews}
          accepted={review.accepted}
          failures={session.reviewFailures}
          by={review.by}
          model={review.model ?? null}
          summary={review.summary ?? null}
          standing={lengthStanding(project.timeline, project.targetDurationUs).label}
          onOpen={(index) => {
            setShowList(false);
            setOpenSuggestion(index);
          }}
          onVerdict={session.setVerdict}
          onAll={session.setAllVerdicts}
          onFinish={() => {
            session.finishReview();
            setShowList(false);
          }}
          onDiscard={() => {
            session.discardReview();
            setShowList(false);
          }}
          onClose={() => setShowList(false)}
        />
      )}

      {selected && (
        <p className="selection-hint">
          Clip {clips.indexOf(selected) + 1} selected · drag either end to trim or extend
        </p>
      )}
      {session.error && <p className="error">{session.error}</p>}

      <footer>
        <button
          className="primary small"
          onClick={session.startExport}
          disabled={!session.canExport || kept.length === 0}
        >
          {session.canExport ? 'Export video' : 'No encoder'}
        </button>
        {/*
          The EDL and the log are still first-class outputs — the record of how the coarse
          pass was made, and the reason it can become a training set later. They are one
          level in now, under Settings → Metadata, because they are not editing tools and
          this row is where a thumb rests during an edit.
        */}
        <button className="ghost" onClick={() => setShowSettings(true)} aria-label="Settings">
          ⚙
        </button>
      </footer>
    </main>
  );
}

/**
 * What the pass is doing, while it does it.
 *
 * A pass over fifty clips runs for minutes, and the version of this that said "Thinking…"
 * and nothing else was indistinguishable from a hang. The first thing anyone does about a
 * hang is reload — which throws away the pass they were waiting for and bills them for it.
 *
 * So: a clock that visibly moves, and the count of edits drafted so far, read off the
 * answer as it streams in.
 */
function RefineBanner({
  model,
  progress,
  onCancel,
}: {
  model: string;
  progress: RefineProgress | null;
  onCancel(): void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = progress ? Math.max(0, Math.round((now - progress.startedAt) / 1000)) : 0;
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <p className="relink">
      Asking Claude ({model}) for edits — {elapsed}.{' '}
      {progress?.phase === 'drafting'
        ? progress.ops > 0
          ? `Writing the edit: ${progress.ops} so far.`
          : 'Writing the edit.'
        : 'Reading the timeline.'}{' '}
      Only the timeline description and the measurements leave this device — never the
      footage. Keep this tab in front until it finishes.{' '}
      <button className="ghost small" onClick={onCancel}>
        Cancel
      </button>
    </p>
  );
}

interface StartScreenProps {
  busy: boolean;
  error: string | null;
  persistent: boolean;
  recents: ProjectSummary[];
  onPick(file: File): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onSettings(): void;
}

function StartScreen({
  busy,
  error,
  persistent,
  recents,
  onPick,
  onOpen,
  onDelete,
  onSettings,
}: StartScreenProps) {
  return (
    <main className="shell empty">
      <h1>EvoCut</h1>
      <p className="lede">
        Pick a recording, keep the parts worth using, and hand the rest to the refinement pass.
      </p>

      <label className="picker">
        {/*
          `capture` is deliberately absent: on iOS adding it forces the camera and hides
          the library, and the footage people want to edit is already on their phone.
        */}
        <input
          type="file"
          accept="video/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onPick(file);
          }}
        />
        <span>{busy ? 'Saving…' : 'Choose a video'}</span>
      </label>

      {!persistent && (
        <p className="warning">
          This browser will not let EvoCut store anything, so your work is lost when the tab closes.
        </p>
      )}

      {recents.length > 0 && (
        <ol className="recents">
          {recents.map((summary) => (
            <li key={summary.id}>
              <button className="recent-main" onClick={() => onOpen(summary.id)}>
                <strong>{summary.name}</strong>
                <small>
                  {summary.clipCount} {summary.clipCount === 1 ? 'clip' : 'clips'} · {summary.stage}
                </small>
              </button>
              <button className="ghost danger" onClick={() => onDelete(summary.id)} aria-label="Delete project">
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}

      {error && <p className="error">{error}</p>}

      <button className="ghost" onClick={onSettings}>
        Settings
      </button>
    </main>
  );
}

/**
 * Media went missing — usually because the user cleared site data, or opened a project
 * synced from another device. The cut points are all still valid, so this asks for the
 * file back rather than treating the project as lost.
 */
function RelinkPrompt({
  missing,
  busy,
  onRelink,
}: {
  missing: MissingMedia[];
  busy: boolean;
  onRelink(sourceId: string, file: File): void;
}) {
  return (
    <div className="relink">
      <p>
        {missing.length === 1 ? 'This project’s video is' : 'Some of this project’s videos are'} not on
        this device. Your cuts are safe — pick the file again to keep working.
      </p>
      {missing.map((item) => (
        <label key={item.sourceId} className="picker small">
          <input
            type="file"
            accept="video/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onRelink(item.sourceId, file);
            }}
          />
          <span>
            {busy ? 'Saving…' : `Find ${item.filename}`} ·{' '}
            {formatTimecode(item.durationUs, undefined, { compact: true })}
          </span>
        </label>
      ))}
    </div>
  );
}
