import { useState } from 'react';
import { MODELS, findModel } from '@evocut/agent';
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
 * The model is the third kind of thing: a preference, not a secret and not a property of
 * the edit. It is chosen here because this is the screen where the cost is about to be
 * paid, and remembered on the device for next time.
 *
 * ## Why the length is its own field
 *
 * Because it is the one instruction the model can check its own work against. Every clip's
 * length goes into the prompt, so "1:10" is a sum it can actually do — where the same words
 * buried in free text are a mood it can nod along to. It is also the instruction that
 * changes the *kind* of pass: with no number there is no reason to drop a whole shot, and
 * dropping whole shots is the only way nine minutes becomes three.
 *
 * ## Two boxes, not one
 *
 * It used to be a single field showing `1:10` as its example, with `inputMode="numeric"`
 * asking iOS for the number pad — which has no colon on it. So the app demonstrated a
 * format the keyboard it had just summoned could not type. Minutes and seconds as separate
 * boxes needs no separator at all, and each one is a plain number on the same pad.
 */
export interface BriefProps {
  brief: string;
  targetDurationUs: number | null;
  currentUs: number;
  busy: boolean;
  /** False when there is no API key, so this says which pass it is about to run. */
  hasKey: boolean;
  model: string;
  onRun(brief: string, targetDurationUs: number | null, model: string): void;
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
  const split = splitDuration(targetDurationUs);
  const [minutes, setMinutes] = useState(split.minutes);
  const [seconds, setSeconds] = useState(split.seconds);
  const [chosen, setChosen] = useState(model);

  const parsed = joinDuration(minutes, seconds);
  const invalid = (minutes.trim() !== '' || seconds.trim() !== '') && parsed === null;
  const over = parsed !== null ? currentUs - parsed : null;
  const choice = findModel(chosen);

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

      <fieldset className="field duration">
        <legend>Target length</legend>
        <span className="duration-box">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={minutes}
            onChange={(event) => setMinutes(digits(event.target.value))}
            placeholder="1"
            autoComplete="off"
            aria-label="Target length, minutes"
            aria-invalid={invalid}
          />
          <small>min</small>
        </span>
        <span className="duration-box">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={seconds}
            onChange={(event) => setSeconds(digits(event.target.value))}
            placeholder="10"
            autoComplete="off"
            aria-label="Target length, seconds"
            aria-invalid={invalid}
          />
          <small>sec</small>
        </span>
      </fieldset>
      <p className={invalid ? 'warning' : 'meta'}>
        {invalid
          ? 'Seconds must be under 60 — put the rest in minutes.'
          : over === null
            ? `This cut runs ${formatTimecode(currentUs, undefined, { compact: true })}. Leave it blank to let the pass just tighten what's there.`
            : `This cut runs ${formatTimecode(currentUs, undefined, { compact: true })} — ${formatDuration(Math.abs(over))} ${over > 0 ? 'over' : 'under'}.`}
      </p>

      <label className="field">
        <span>Model</span>
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          {MODELS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {choice && <p className={choice.costly ? 'warning' : 'meta'}>{choice.note}</p>}

      <div className="sheet-actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || invalid}
          onClick={() => onRun(text, parsed, chosen)}
        >
          {busy ? 'Thinking…' : hasKey ? 'Ask Claude' : 'Suggest edits'}
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

/** Strip everything that is not a digit, so a paste of "1:10" cannot half-land. */
function digits(input: string): string {
  return input.replace(/\D/g, '').slice(0, 3);
}

/**
 * Minutes and seconds as they were typed, into microseconds.
 *
 * Null means "no target", which is a legitimate answer and the one the field starts on.
 * Sixty or more seconds is a typo rather than a value to normalise: someone who meant 90
 * seconds and typed it in the seconds box gets told, instead of silently getting 1:30 and
 * never learning which box does what.
 */
export function joinDuration(minutes: string, seconds: string): number | null {
  if (minutes.trim() === '' && seconds.trim() === '') return null;
  const m = minutes.trim() === '' ? 0 : Number(minutes);
  const s = seconds.trim() === '' ? 0 : Number(seconds);
  if (!Number.isFinite(m) || !Number.isFinite(s) || s >= 60) return null;
  const total = m * 60 + s;
  return total > 0 ? total * 1_000_000 : null;
}

export function splitDuration(us: number | null): { minutes: string; seconds: string } {
  if (!us || us <= 0) return { minutes: '', seconds: '' };
  const total = Math.round(us / 1_000_000);
  return { minutes: String(Math.floor(total / 60)), seconds: String(total % 60) };
}

export function formatDuration(us: number): string {
  const total = Math.round(us / 1_000_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
