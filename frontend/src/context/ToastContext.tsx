import { useState, useCallback, useRef, ReactNode } from 'react';
import type { Toast } from './ToastContextValue';
import { ToastContext } from './ToastContextValue';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...toast, id }]);
    if (toast.type === 'success') {
      timers.current.set(id, setTimeout(() => removeToast(id), 5000));
    }
    return id;
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}
