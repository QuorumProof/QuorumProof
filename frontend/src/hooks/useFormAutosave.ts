import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Periodically persists form state to localStorage so long forms survive a
 * crash, accidental navigation, or reload. On mount the hook surfaces any
 * previously saved draft (`draft`) so the component can offer recovery, without
 * clobbering the live form. Call `clear()` once the form is successfully
 * submitted (or the user discards the draft).
 */

const AUTOSAVE_PREFIX = 'qp_autosave_';

interface AutosaveEnvelope<T> {
  data: T;
  savedAt: number;
}

export interface UseFormAutosaveOptions {
  /** Debounce delay before saving after a change, in ms. Default 1000. */
  debounceMs?: number;
  /** Periodic save interval as a safety net, in ms. Default 30000. */
  intervalMs?: number;
  /** When false, autosave is paused (no reads or writes). Default true. */
  enabled?: boolean;
}

export interface UseFormAutosaveResult<T> {
  /** A recoverable draft found in storage on mount, or null if none. */
  draft: T | null;
  /** Timestamp (ms since epoch) of the recovered draft, or null. */
  savedAt: number | null;
  /** Convenience flag: true when a recoverable draft exists. */
  hasDraft: boolean;
  /** Force an immediate save of the current value. */
  save: () => void;
  /** Remove the saved draft and dismiss the recovery prompt. */
  clear: () => void;
}

function storageKeyFor(key: string): string {
  return AUTOSAVE_PREFIX + key;
}

function readDraft<T>(key: string): AutosaveEnvelope<T> | null {
  try {
    const raw = localStorage.getItem(storageKeyFor(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutosaveEnvelope<T>;
    if (parsed && typeof parsed.savedAt === 'number' && 'data' in parsed) {
      return parsed;
    }
  } catch {
    // Corrupt or unavailable storage — treat as no draft.
  }
  return null;
}

export function useFormAutosave<T>(
  key: string,
  value: T,
  options: UseFormAutosaveOptions = {},
): UseFormAutosaveResult<T> {
  const { debounceMs = 1000, intervalMs = 30000, enabled = true } = options;

  // Snapshot the pristine value once so an untouched form never overwrites a
  // recovered draft. Lazy init keeps the serialization off every render.
  const [pristine] = useState(() => JSON.stringify(value));

  // Keep the latest value in a ref so interval/unmount saves stay current
  // without re-subscribing the timers on every keystroke.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });

  const [restored] = useState(() => (enabled ? readDraft<T>(key) : null));
  const [draft, setDraft] = useState<T | null>(() => {
    if (!restored) return null;
    // Ignore a stored draft that matches the pristine form — nothing to recover.
    return JSON.stringify(restored.data) === pristine ? null : restored.data;
  });
  const [savedAt, setSavedAt] = useState<number | null>(() =>
    draft !== null && restored ? restored.savedAt : null,
  );

  const save = useCallback(() => {
    if (!enabled) return;
    // Skip writing while the form is still pristine to preserve any draft.
    if (JSON.stringify(valueRef.current) === pristine) return;
    try {
      const envelope: AutosaveEnvelope<T> = { data: valueRef.current, savedAt: Date.now() };
      localStorage.setItem(storageKeyFor(key), JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage unavailable — drop silently.
    }
  }, [enabled, key, pristine]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(storageKeyFor(key));
    } catch {
      // Ignore — best effort.
    }
    setDraft(null);
    setSavedAt(null);
  }, [key]);

  // Debounced save whenever the value changes.
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(save, debounceMs);
    return () => clearTimeout(timer);
  }, [value, enabled, debounceMs, save]);

  // Periodic save as a safety net against crashes between keystrokes.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(save, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, save]);

  // Final flush on unmount so in-flight edits aren't lost.
  useEffect(() => {
    return () => save();
  }, [save]);

  return { draft, savedAt, hasDraft: draft !== null, save, clear };
}
