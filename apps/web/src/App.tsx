import { useCallback, useEffect, useState } from 'react';
import { formatTimecode, timelineDuration } from '@evocut/edl';
import type { MissingMedia, ProjectSummary } from '@evocut/store';
import { ExportPanel } from './Export.tsx';
import { SettingsScreen } from './Settings.tsx';
import { Player } from './Player.tsx';
import { Review } from './Review.tsx';
import { TimelineEditor, type TimelineDragState } from './Timeline.tsx';
import { downloadLog, downloadProject, useSession } from './session.ts';

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

  const { project, playhead, plan } = session;
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

  if (plan) {
    return (
      <main className="shell">
        <header>
          <button className="ghost" onClick={session.discardReview} aria-label="Back">
            ←
          </button>
          <div className="title">
            <h1>{project.name}</h1>
            <p className="meta">
              {session.refinedBy === 'model'
                ? `Suggested by ${session.settings.model}`
                : 'Suggested by the built-in heuristics'}
            </p>
          </div>
        </header>
        <Review
          plan={plan}
          timeline={project.timeline}
          verdicts={session.verdicts}
          busy={session.busy}
          onVerdict={session.setVerdict}
          onAll={session.setAllVerdicts}
          onApply={session.applyReview}
          onDiscard={session.discardReview}
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
            {formatTimecode(total, undefined, { compact: true })}
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
        {frozen ? (
          <button className="primary small" onClick={session.requestRefinement} disabled={session.refining}>
            {session.refining ? 'Thinking…' : 'Refine'}
          </button>
        ) : (
          <button className="primary small" onClick={session.finishCoarsePass} disabled={kept.length === 0}>
            Done
          </button>
        )}
      </header>

      {session.refining && (
        <p className="relink">
          Asking {session.settings.model} for edits. Only the timeline description and the
          measurements leave this device — never the footage.{' '}
          <button className="ghost small" onClick={session.cancelRefinement}>
            Cancel
          </button>
        </p>
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
        onSeek={session.seek}
        onSelect={session.select}
        onTrimCommit={session.commitTrim}
        onDragChange={setDrag}
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
          The log is a first-class output, not a debug aid: it is the record of how the
          coarse pass was made, and the reason it can become a training set later.
        */}
        <button className="ghost" onClick={() => downloadProject(project)}>
          EDL
        </button>
        <button className="ghost" onClick={() => downloadLog(project, session.events)}>
          Log ({session.events.length})
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} aria-label="Settings">
          ⚙
        </button>
      </footer>
    </main>
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
