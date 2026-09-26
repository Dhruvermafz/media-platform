import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ApiError } from '../api/client';

type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; message: string; action?: { label: string; onClick: () => void } }
interface ToastApi {
  success: (m: string, action?: Toast['action']) => void;
  error: (m: unknown) => void;
  info: (m: string, action?: Toast['action']) => void;
}
const Ctx = createContext<ToastApi | null>(null);

export const errorMessage = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Kind, message: string, action?: Toast['action']) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message, action }]);
    setTimeout(() => dismiss(id), action ? 7000 : kind === 'error' ? 6000 : 3500);
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    success: (m, a) => push('success', m, a),
    error: (e) => push('error', errorMessage(e)),
    info: (m, a) => push('info', m, a),
  }), [push]);

  const Icon = { success: CheckCircle2, error: AlertCircle, info: Info };
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {toasts.map((t) => {
          const I = Icon[t.kind];
          return (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <I size={18} aria-hidden />
              <span>{t.message}</span>
              {t.action && <button className="toast-action" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
              <button className="icon-btn toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={16} /></button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside ToastProvider');
  return v;
};
