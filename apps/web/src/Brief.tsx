import { useState } from 'react';
import { formatTimecode } from '@evocut/edl';

/**
 * What this video is meant to be, asked at the moment it matters.
 *
 * ## Per video, not per phone
 *
 * The brief used to live in Settings, next to the API key, and that was wrong in a way
 * that only shows up on the second project: a booster bundle and a twenty-minute build log
 * want opposite things from the same model, and a device-wide brief silently applies the
 * first one's answer to everything after it. The key belongs to the phone. This belongs to
 * the video, so it lives on the project and travels with the EDL.
 *
 * ## Why the length is its own field
 *
 * Because it is the one instruction the model can check its own work against. Every clip's
 * length goes into the prompt, so "1:10" is a sum it can actually do — where the same words
 * buried in free text are a mood it can nod along to. It is also the instruction that
 * changes the *kind* of pass: with no number there is no reason to drop a whole shot, and
 * dropping whole shots is the only way nine minutes becomes three.
 *
 * The field takes `m:ss` or plain seconds, because both are things a person types, and
 * rejecting one of them to enforce a format nobody agreed on is not a service.
 */
export interface BriefProps {
  brief: string;
  targetDurationUs: number | null;
  currentUs: number;
  busy: boolean;
  /** False when there is no API key, so this says which pass it is about to run. */
  hasKey: boolean;
  model: string;
  onRun(brief: string, targetDurationUs: number | null): void;
  onClose(): void;
}

export function BriefSheet({
  brief,
  targetDurationUs,
  currentUs,
  busy,
  hasKey,
  model,
  onRun,
  onClose,
}: BriefProps) {
  const [text, setText] = useState(brief);
  const [length, setLength] = useState(targetDurationUs ? formatDuration(targetDurationUs) : '');

  const parsed = parseDuration(length);
  const invalid = length.trim() !== '' && parsed === null;
  const over = parsed !== null ? currentUs - parsed : null;

  return (
    <div className="sheet" role="dialog" aria-label="Refine">
      <div className="sheet-head">
        <button className="ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <span className="sheet-count">Refine</span>
      </div>

      <label className="field">
        <span>What is this video?</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder="Describe the edit the way you'd describe it to an editor. What it's for, how it should feel, how long a shot holds before it cuts, where the emphasis lands."
        />
      </label>
      <p className="meta">
        {/*
          Said here rather than discovered later: pasting a URL is the obvious thing to try
          and the one thing that cannot work.
        */}
        A link to a video won’t help — the model can’t watch it. Describing what that video
        does will.
      </p>

      <label className="field">
        <span>Target length</span>
        <input
          type="text"
          inputMode="numeric"
          value={length}
          onChange={(event) => setLength(event.target.value)}
          placeholder="1:10"
          autoComplete="off"
          aria-invalid={invalid}
        />
      </label>
      <p className={invalid ? 'warning' : 'meta'}>
        {invalid
          ? 'Give it as m:ss or a number of seconds — 1:10, or 70.'
          : over === null
            ? `This cut runs ${formatTimecode(currentUs, undefined, { compact: true })}. Leave it blank to let the pass just tighten what's there.`
            : `This cut runs ${formatTimecode(currentUs, undefined, { compact: true })} — ${formatDuration(Math.abs(over))} ${over > 0 ? 'over' : 'under'}.`}
      </p>

      <div className="sheet-actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || invalid}
          onClick={() => onRun(text, parsed)}
        >
          {busy ? 'Thinking…' : hasKey ? `Ask ${model}` : 'Suggest edits'}
        </button>
      </div>

      {!hasKey && (
        <p className="meta">
          No API key is set, so this runs the built-in heuristics instead of a model. Add one
          in Settings to get a real pass.
        </p>
      )}
    </div>
  );
}

/** `m:ss`, `h:mm:ss`, or a bare number of seconds. Null when it is none of those. */
export function parseDuration(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d+(:[0-5]?\d)*(\.\d+)?$/.test(text)) return null;

  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const totalSeconds = parts.reduce((total, part) => total * 60 + part, 0);
  return totalSeconds > 0 ? Math.round(totalSeconds * 1_000_000) : null;
}

export function formatDuration(us: number): string {
  const total = Math.round(us / 1_000_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
