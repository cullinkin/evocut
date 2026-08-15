import { useState } from 'react';
import { DEFAULT_MODEL } from '@evocut/agent';
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
 * ## About the brief
 *
 * A link to a reference video is inert: the model cannot watch it. What it can use is a
 * written description of what the reference *does* — pacing, how long a shot holds, where
 * the emphasis lands. So this asks for that, in those words, rather than offering a URL
 * field that would quietly do nothing.
 */
export interface SettingsScreenProps {
  settings: RefinementSettings;
  busy: boolean;
  onSave(next: RefinementSettings): void;
  onForgetKey(): void;
  onClose(): void;
}

const MODELS = [
  { id: DEFAULT_MODEL, label: 'Claude Opus 5 — best judgement' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, cheaper' },
];

const EFFORTS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low — quickest' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Very high — slowest' },
] as const;

export function SettingsScreen({ settings, busy, onSave, onForgetKey, onClose }: SettingsScreenProps) {
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
        <span>Model</span>
        <select value={draft.model} onChange={(event) => change('model', event.target.value)}>
          {MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>

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

      <label className="field">
        <span>Style brief</span>
        <textarea
          value={draft.brief}
          onChange={(event) => change('brief', event.target.value)}
          rows={5}
          placeholder="Describe the edit you want, the way you'd describe it to an editor. What the pacing feels like, how long a shot holds before it cuts, where the emphasis lands."
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
