import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useClickOutside } from '../../lib/hooks';

export interface MenuItem {
  label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; divider?: boolean;
}

export function Menu({ trigger, items, align = 'end', label }: {
  trigger: (p: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: MenuItem[]; align?: 'start' | 'end'; label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };

  return (
    <div className="menu-wrap" ref={ref} onKeyDown={onKey}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div className={`menu menu-${align}`} role="menu" aria-label={label}>
          {items.map((it, i) => it.divider ? <hr key={i} /> : (
            <button key={i} role={it.checked !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={it.checked}
              className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
              onClick={() => { close(); it.onClick(); }}>
              <span className="menu-icon">{it.icon}</span>
              <span>{it.label}</span>
              {it.checked && <span className="menu-check" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
