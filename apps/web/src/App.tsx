import { useCallback, useState } from 'react';
import { clipEnd, formatTimecode, outputDuration, timelineDuration, type Clip } from '@evocut/edl';
import type { MissingMedia, ProjectSummary } from '@evocut/store';
import { Player } from './Player.tsx';
import { Review } from './Review.tsx';
import { downloadLog, downloadProject, useSession } from './session.ts';

/**
 * The coarse pass, and the review of what the machine proposed afterwards.
 *
 * There is intentionally no trim handle, no effect panel, and no zoom control on the
 * coarse screen. The product bet is that a person on a phone is good at one judgement —
 * "is this bit worth keeping?" — and that the refinement pass is what everything else is
 * for. The review screen is where they judge that pass.
 */
export function App() {
  const session = useSession();
  const [playing, setPlaying] = useState(false);

  const onTime = useCallback((t: number) => session.seek(t), [session]);
  const onEnded = useCallback(() => setPlaying(false), []);

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
      />
    );
  }

  const { project, playhead, plan } = session;
  const clips = project.timeline.tracks[0]?.clips ?? [];
  const kept = clips.filter((clip) => clip.enabled);
  const total = timelineDuration(project.timeline);
  const frozen = project.stage !== 'coarse';
  const mediaUrl = session.mediaUrls.get(clips[0]?.sourceId ?? '') ?? null;

  if (plan) {
    return (
      <main className="shell">
        <header>
          <button className="ghost" onClick={session.discardReview} aria-label="Back">
            ←
          </button>
          <div>
            <h1>{project.name}</h1>
            <p className="meta">Refinement review</p>
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
    <main className="shell">
      <header>
        <button className="ghost" onClick={session.closeProject} aria-label="Back">
          ←
        </button>
        <div>
          <h1>{project.name}</h1>
          <p className="meta">
            {kept.length} {kept.length === 1 ? 'clip' : 'clips'} ·{' '}
            {formatTimecode(total, undefined, { compact: true })}
            {!session.persistent && ' · not saved'}
          </p>
        </div>
      </header>

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
          onTime={onTime}
          onEnded={onEnded}
        />
      )}

      <div className="transport">
        <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!mediaUrl}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(total - 1, 0)}
          value={Math.min(playhead, total)}
          onChange={(event) => session.seek(Number(event.target.value), true)}
        />
        <span className="clock">{formatTimecode(playhead, undefined, { compact: true })}</span>
      </div>

      <div className="actions">
        <button onClick={session.splitAtPlayhead} disabled={frozen}>
          Split here
        </button>
        {frozen ? (
          <button className="primary" onClick={session.requestRefinement}>
            Refine
          </button>
        ) : (
          <button onClick={session.finishCoarsePass} disabled={kept.length === 0}>
            Finish coarse pass
          </button>
        )}
      </div>

      <ol className="clips">
        {clips.map((clip, index) => (
          <ClipRow
            key={clip.id}
            clip={clip}
            index={index}
            active={playhead >= clip.start && playhead < clipEnd(clip)}
            frozen={frozen}
            onSeek={() => session.seek(clip.start)}
            onToggle={() => session.toggleClip(clip.id)}
            onKeepOnly={() => session.keepOnly(clip.id)}
            onRemove={() => session.removeClip(clip.id)}
          />
        ))}
      </ol>

      {session.error && <p className="error">{session.error}</p>}

      <footer>
        {/*
          The log is a first-class output, not a debug aid: it is the record of how the
          coarse pass was made, and the reason it can become a training set later.
        */}
        <button className="ghost" onClick={() => downloadProject(project)}>
          Export EDL
        </button>
        <button className="ghost" onClick={() => downloadLog(project, session.events)}>
          Export log ({session.events.length})
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
}

function StartScreen({ busy, error, persistent, recents, onPick, onOpen, onDelete }: StartScreenProps) {
  return (
    <main className="shell empty">
      <h1>EvoCut</h1>
      <p className="lede">
        Pick a recording, keep the parts worth using, and hand the rest to the refinement pass.
      </p>

      <label className="picker">
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

interface ClipRowProps {
  clip: Clip;
  index: number;
  active: boolean;
  frozen: boolean;
  onSeek(): void;
  onToggle(): void;
  onKeepOnly(): void;
  onRemove(): void;
}

function ClipRow({ clip, index, active, frozen, onSeek, onToggle, onKeepOnly, onRemove }: ClipRowProps) {
  const classes = ['clip', active ? 'active' : '', clip.enabled ? '' : 'dropped'].filter(Boolean);

  return (
    <li className={classes.join(' ')}>
      <button className="clip-main" onClick={onSeek}>
        <span className="index">{index + 1}</span>
        <span className="times">
          <strong>
            {formatTimecode(outputDuration(clip), undefined, { compact: true })}
            {clip.speed !== 1 && <em> · {clip.speed}×</em>}
            {clip.effects.length > 0 && <em> · {clip.effects.length} fx</em>}
          </strong>
          <small>
            source {formatTimecode(clip.sourceIn, undefined, { compact: true })}–
            {formatTimecode(clip.sourceOut, undefined, { compact: true })}
          </small>
        </span>
      </button>
      <div className="clip-actions">
        <button onClick={onToggle} disabled={frozen} title={clip.enabled ? 'Drop this clip' : 'Bring it back'}>
          {clip.enabled ? 'Drop' : 'Keep'}
        </button>
        <button onClick={onKeepOnly} disabled={frozen || !clip.enabled} title="Drop every other clip">
          Only
        </button>
        <button onClick={onRemove} disabled={frozen} title="Delete permanently">
          ✕
        </button>
      </div>
    </li>
  );
}
