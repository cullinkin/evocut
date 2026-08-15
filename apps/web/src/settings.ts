import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_MODEL } from '@evocut/agent';
import type { AppStores } from '@evocut/store';

/**
 * What the user configured for the refinement pass.
 *
 * Kept out of the `Project` deliberately. A project is a document about an edit and gets
 * exported, shared, and one day turned into training data; an API key in it would leak the
 * first time someone sent a colleague their EDL. These live in device storage instead, and
 * travel with the phone rather than with the work.
 */
export interface RefinementSettings {
  apiKey: string;
  model: string;
  /** Empty means "whatever the API defaults to" rather than a level we picked. */
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Free-text steer, in the user's own words. Rides into every prompt. */
  brief: string;
}

export const EMPTY_SETTINGS: RefinementSettings = {
  apiKey: '',
  model: DEFAULT_MODEL,
  effort: '',
  brief: '',
};

const KEY = 'refinement';

export interface SettingsState {
  settings: RefinementSettings;
  /** True once storage has been read, so the UI never flashes "no key" at someone who has one. */
  loaded: boolean;
  save(next: RefinementSettings): Promise<void>;
  forgetKey(): Promise<void>;
}

export function useSettings(stores: AppStores): SettingsState {
  const [settings, setSettings] = useState<RefinementSettings>(EMPTY_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void stores.settings
      .get<Partial<RefinementSettings>>(KEY)
      .then((stored) => {
        if (!live) return;
        // Merged over the defaults rather than trusted wholesale: a value written by an
        // older version is missing fields a newer one reads.
        if (stored) setSettings({ ...EMPTY_SETTINGS, ...stored });
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [stores]);

  const save = useCallback(
    async (next: RefinementSettings) => {
      const trimmed = { ...next, apiKey: next.apiKey.trim(), brief: next.brief.trim() };
      setSettings(trimmed);
      await stores.settings.set(KEY, trimmed);
    },
    [stores],
  );

  const forgetKey = useCallback(async () => {
    const next = { ...settings, apiKey: '' };
    setSettings(next);
    await stores.settings.set(KEY, next);
  }, [settings, stores]);

  return { settings, loaded, save, forgetKey };
}
