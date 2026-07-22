import { createContext, useContext } from 'react';

export type ToastType = 'pending' | 'success' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  explorerUrl?: string;
}

export interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
