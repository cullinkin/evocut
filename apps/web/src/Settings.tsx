import { useState } from 'react';
import type { RefinementSettings } from './settings.ts';

/**
 * Where the refinement pass gets its key, and its brief.
 *
 * ## About the key
 *
 * It is stored in this browser, on this device, unencrypted, and sent only to Anthropic's
 * API. That is stated on the screen rather than buried here, because it is the user's
 * decision to make and they cannot make it from a page that stays quiet about it. The
 * mitigation that actually matters is not obfuscation — a key the page can read is a key
 * an attacker on the page can read — it is that the key is revocable in one click from the
 * Anthropic console, and the screen says where.
 *
 * The style brief is deliberately *not* here. It is per video, and lives on the project —
 * see `Brief.tsx`. Nor is the model: it is picked on the same sheet, where the cost is
 * about to be paid and the choice is in front of the thing it applies to. What is on this
 * screen is what belongs to the device.
 */
export interface SettingsScreenProps {
  settings: RefinementSettings;
  busy: boolean;
  onSave(next: RefinementSettings): void;
  onForgetKey(): void;
  onClose(): void;
  /** Absent when no project is open — there would be nothing to export. */
  onMetadata?(): void;
}

const EFFORTS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low — quickest' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Very high — slowest' },
] as const;

export function SettingsScreen({
  settings,
  busy,
  onSave,
  onForgetKey,
  onClose,
  onMetadata,
}: SettingsScreenProps) {
  const [draft, setDraft] = useState<RefinementSettings>(settings);
  const [revealed, setRevealed] = useState(false);
  const change = <K extends keyof RefinementSettings>(key: K, value: RefinementSettings[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="settings">
      <h2>Refinement</h2>
      <p className="lede">
        The refinement pass asks Claude for edits, which you then review one by one. Without a
        key it falls back to a set of local heuristics.
      </p>

      <label className="field">
        <span>Anthropic API key</span>
        <input
          type={revealed ? 'text' : 'password'}
          value={draft.apiKey}
          onChange={(event) => change('apiKey', event.target.value)}
          placeholder="sk-ant-…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </label>
      <button className="ghost small" onClick={() => setRevealed((shown) => !shown)}>
        {revealed ? 'Hide key' : 'Show key'}
      </button>

      <p className="warning">
        This key is stored in this browser, on this device, and is sent only to Anthropic. It is
        not encrypted — anything that can run code on this page can read it. Use a key you are
        willing to revoke, and revoke it at console.anthropic.com if this phone is lost.
      </p>

      <label className="field">
        <span>How hard it should think</span>
        <select
          value={draft.effort}
          onChange={(event) => change('effort', event.target.value as RefinementSettings['effort'])}
        >
          {EFFORTS.map((effort) => (
            <option key={effort.id} value={effort.id}>
              {effort.label}
            </option>
          ))}
        </select>
      </label>

      <p className="meta">
        What each video is meant to be — its brief, its target length, and which model to
        ask — is chosen on the video itself, when you tap Refine.
      </p>

      {onMetadata && (
        <>
          <h2>This project</h2>
          <button className="row-link" onClick={onMetadata}>
            <span>
              <strong>Metadata</strong>
              <small>Export the EDL and the log.</small>
            </span>
            <span aria-hidden="true">›</span>
          </button>
        </>
      )}

      <div className="settings-actions">
        <button className="ghost" onClick={onClose}>
          Back
        </button>
        <button className="primary" onClick={() => onSave(draft)} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {settings.apiKey && (
        <button className="ghost danger" onClick={onForgetKey}>
          Forget the key on this device
        </button>
      )}
    </div>
  );
}
