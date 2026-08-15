import { useCallback, useState } from 'react';
import {
  clipEnd,
  formatTimecode,
  outputDuration,
  timelineDuration,
  type Clip,
} from '@evocut/edl';
import { Player } from './Player.tsx';
import { downloadLog, downloadProject, useSession } from './session.ts';

/**
 * The coarse pass, and only the coarse pass.
 *
 * There is intentionally no trim handle, no effect panel, and no zoom control here. The
 * product bet is that a person on a phone is good at one judgement — "is this bit worth
 * keeping?" — and bad at everything else, and that the refinement pass is what everything
 * else is for. Every control on this screen serves that one judgement.
 */
export function App() {
  const session = useSession();
  const [playing, setPlaying] = useState(false);

  const onTime = useCallback((t: number) => session.seek(t), [session]);
  const onEnded = useCallback(() => setPlaying(false), []);

  if (!session.project) {
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
              if (file) void session.importFile(file);
            }}
          />
          <span>{session.busy ? 'Reading…' : 'Choose a video'}</span>
        </label>
        {session.error && <p className="error">{session.error}</p>}
      </main>
    );
  }

  const { project, playhead } = session;
  const clips = project.timeline.tracks[0]?.clips ?? [];
  const kept = clips.filter((clip) => clip.enabled);
  const total = timelineDuration(project.timeline);
  const frozen = project.stage !== 'coarse';

  return (
    <main className="shell">
      <header>
        <button className="ghost" onClick={session.reset}>
          ←
        </button>
        <div>
          <h1>{project.name}</h1>
          <p className="meta">
            {kept.length} {kept.length === 1 ? 'clip' : 'clips'} · {formatTimecode(total, undefined, { compact: true })}
          </p>
        </div>
      </header>

      {session.objectUrl && (
        <Player
          objectUrl={session.objectUrl}
          timeline={project.timeline}
          playhead={playhead}
          playing={playing}
          onTime={onTime}
          onEnded={onEnded}
        />
      )}

      <div className="transport">
        <button className="primary" onClick={() => setPlaying((p) => !p)}>
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
        <button onClick={session.finishCoarsePass} disabled={frozen || kept.length === 0}>
          {frozen ? 'Coarse pass frozen' : 'Finish coarse pass'}
        </button>
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
          <strong>{formatTimecode(outputDuration(clip), undefined, { compact: true })}</strong>
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
