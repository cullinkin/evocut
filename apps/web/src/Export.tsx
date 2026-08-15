import { useState } from 'react';
import { formatTimecode } from '@evocut/edl';
import type { ExportState } from './session.ts';

/**
 * The export screen.
 *
 * A render takes about as long as the video is, so this is a screen rather than a spinner
 * on a button: it has to survive being looked at for two minutes. It says what stage the
 * work is in, how far along it is, and — once there is a file — offers the one action that
 * actually matters on a phone, which is getting the video into the camera roll.
 *
 * Share before download, deliberately. On iOS a download lands in Files, several taps from
 * anywhere useful, whereas the share sheet has "Save Video" at the top. Where the Web Share
 * API cannot take a file, the download link is the fallback rather than the plan.
 */
export interface ExportPanelProps {
  state: ExportState;
  onStart(): void;
  onCancel(): void;
  onClose(): void;
}

const STAGE_LABELS: Record<string, string> = {
  preparing: 'Getting ready',
  audio: 'Mixing the sound',
  encoding: 'Rendering frames',
  muxing: 'Writing the file',
  done: 'Finished',
};

export function ExportPanel({ state, onStart, onCancel, onClose }: ExportPanelProps) {
  return (
    <div className="export">
      {state.status === 'rendering' && <Rendering state={state} onCancel={onCancel} />}
      {state.status === 'done' && state.result && <Finished result={state.result} onClose={onClose} onStart={onStart} />}
      {state.status === 'error' && (
        <>
          <h2>The export stopped</h2>
          <p className="error">{state.error}</p>
          <div className="export-actions">
            <button className="ghost" onClick={onClose}>
              Back to editing
            </button>
            <button className="primary" onClick={onStart}>
              Try again
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Rendering({ state, onCancel }: { state: ExportState; onCancel(): void }) {
  const percent = Math.round(state.progress * 100);
  return (
    <>
      <h2>{STAGE_LABELS[state.stage] ?? 'Working'}</h2>
      <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="lede">
        {state.framesTotal > 0
          ? `${state.framesEncoded} of ${state.framesTotal} frames · ${percent}%`
          : 'Starting up…'}
      </p>
      <p className="meta">
        {/*
          Said plainly because it is the difference between "this is slow" and "this has
          hung", and a person who does not know which will kill the tab at ninety seconds.
        */}
        Rendering runs at about the speed of the video itself, and the screen has to stay
        awake for it. Leave this tab in front until it finishes.
      </p>
      <div className="export-actions">
        <button className="ghost danger" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Finished({
  result,
  onClose,
  onStart,
}: {
  result: NonNullable<ExportState['result']>;
  onClose(): void;
  onStart(): void;
}) {
  const [shareError, setShareError] = useState<string | null>(null);
  const file = new File([result.blob], result.filename, { type: result.blob.type });
  const shareable = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

  const share = async () => {
    setShareError(null);
    try {
      await navigator.share({ files: [file], title: result.filename });
    } catch (cause) {
      // A dismissed share sheet throws exactly like a failed one. Only say something when
      // it was a real failure, or the user gets an error for changing their mind.
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setShareError('Sharing did not work. Use Download instead.');
    }
  };

  return (
    <>
      <h2>Your video is ready</h2>
      <p className="lede">
        {formatTimecode(result.durationUs, undefined, { compact: true })} · {formatBytes(result.sizeBytes)} ·{' '}
        {result.width}×{result.height}
      </p>

      <video className="export-preview" src={result.url} controls playsInline preload="metadata" />

      <div className="export-actions">
        {shareable && (
          <button className="primary" onClick={() => void share()}>
            Save or share
          </button>
        )}
        <a className="button-link" href={result.url} download={result.filename}>
          Download
        </a>
      </div>

      {shareError && <p className="error">{shareError}</p>}
      {result.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}

      <div className="export-actions">
        <button className="ghost" onClick={onClose}>
          Back to editing
        </button>
        <button className="ghost" onClick={onStart}>
          Render again
        </button>
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
