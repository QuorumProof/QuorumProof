import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFormAutosave } from '../useFormAutosave';

const KEY = 'test-form';
const STORAGE_KEY = `qp_autosave_${KEY}`;

describe('useFormAutosave', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not report a draft when storage is empty', () => {
    const { result } = renderHook(() => useFormAutosave(KEY, { name: '' }));
    expect(result.current.draft).toBeNull();
    expect(result.current.hasDraft).toBe(false);
  });

  it('debounce-saves changed values to localStorage', () => {
    const { rerender } = renderHook(({ value }) => useFormAutosave(KEY, value, { debounceMs: 1000 }), {
      initialProps: { value: { name: '' } },
    });

    rerender({ value: { name: 'Acme University' } });
    act(() => vi.advanceTimersByTime(1000));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.data).toEqual({ name: 'Acme University' });
    expect(typeof stored.savedAt).toBe('number');
  });

  it('does not overwrite an existing draft while the form is pristine', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: { name: 'Saved Draft' }, savedAt: 123 }),
    );

    renderHook(() => useFormAutosave(KEY, { name: '' }, { debounceMs: 1000 }));
    act(() => vi.advanceTimersByTime(5000));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.data).toEqual({ name: 'Saved Draft' });
  });

  it('recovers a saved draft that differs from the pristine value', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: { name: 'Recovered' }, savedAt: 456 }),
    );

    const { result } = renderHook(() => useFormAutosave(KEY, { name: '' }));
    expect(result.current.hasDraft).toBe(true);
    expect(result.current.draft).toEqual({ name: 'Recovered' });
    expect(result.current.savedAt).toBe(456);
  });

  it('clear() removes the draft from storage and dismisses recovery', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ data: { name: 'Recovered' }, savedAt: 456 }),
    );

    const { result } = renderHook(() => useFormAutosave(KEY, { name: '' }));
    act(() => result.current.clear());

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.draft).toBeNull();
    expect(result.current.hasDraft).toBe(false);
  });

  it('periodically saves on the interval as a safety net', () => {
    const { rerender } = renderHook(({ value }) => useFormAutosave(KEY, value, { debounceMs: 999999, intervalMs: 5000 }), {
      initialProps: { value: { name: '' } },
    });

    rerender({ value: { name: 'Interval Save' } });
    act(() => vi.advanceTimersByTime(5000));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.data).toEqual({ name: 'Interval Save' });
  });

  it('does nothing when disabled', () => {
    const { rerender } = renderHook(({ value }) => useFormAutosave(KEY, value, { enabled: false, debounceMs: 1000 }), {
      initialProps: { value: { name: '' } },
    });

    rerender({ value: { name: 'Should Not Save' } });
    act(() => vi.advanceTimersByTime(10000));

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('treats corrupt stored data as no draft', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    const { result } = renderHook(() => useFormAutosave(KEY, { name: '' }));
    expect(result.current.draft).toBeNull();
  });
});
