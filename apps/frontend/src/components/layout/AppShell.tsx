import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, FolderOpen, Gauge, Image as ImageIcon, LayoutGrid, LogOut, Monitor, Moon, MoreHorizontal, Plus, Search, Settings, Share2, Star, Sun, Tag, Trash2, UploadCloud, X, Cpu,
} from 'lucide-react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useRealtime } from '../../context/RealtimeContext';
import { useTheme, type ThemeMode } from '../../context/ThemeContext';
import { useUploads } from '../../context/UploadContext';
import { useDebounced, useHotkey } from '../../lib/hooks';
import { useTags, useUsage } from '../../lib/queries';
import { formatBytes } from '../../lib/format';
import { Dialog } from '../ui/Dialog';
import { Menu } from '../ui/Menu';
import { Avatar, ProgressBar, Segmented } from '../ui/primitives';
import { DropOverlay } from '../upload/DropOverlay';
import { UploadTray } from '../upload/UploadTray';

const ShellCtx = createContext<{ pickFiles: () => void }>({ pickFiles: () => undefined });
export const useShell = () => useContext(ShellCtx);

const LIBRARY_PATHS = /^\/(library|favorites|trash|collections\/[^/]+|tags\/[^/]+)$/;

function useActiveJobCount() {
  const { data } = useQuery({ queryKey: ['jobs', 'list'], queryFn: () => api.jobs(), staleTime: 10_000 });
  const c = data?.counts ?? {};
  return (c.PENDING ?? 0) + (c.PROCESSING ?? 0) + (c.RETRY ?? 0);
}

export function AppShell() {
  const { user, isAdmin, logout } = useAuth();
  const { enqueue, defaultCollectionId } = useUploads();
  const { status: rt } = useRealtime();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [more, setMore] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const activeJobs = useActiveJobCount();
  const { data: usage } = useUsage();
  const { data: tags } = useTags();
  const { mode, setMode } = useTheme();

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ---- global search: writes ?q= on the current library view (or jumps to /library)
  const urlQ = params.get('q') ?? '';
  const [q, setQ] = useState(urlQ);
  const debouncedQ = useDebounced(q, 300);
  useEffect(() => { setQ(urlQ); }, [urlQ]);
  useEffect(() => {
    if (debouncedQ === urlQ) return;
    if (LIBRARY_PATHS.test(pathname)) {
      const next = new URLSearchParams(params);
      if (debouncedQ) next.set('q', debouncedQ); else next.delete('q');
      setParams(next, { replace: true });
    } else if (debouncedQ) navigate(`/library?q=${encodeURIComponent(debouncedQ)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const pickFiles = useCallback(() => fileRef.current?.click(), []);
  useHotkey('/', (e) => { e.preventDefault(); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); });
  useHotkey('u', () => pickFiles());

  const name = user?.displayName || user?.email || '';
  const shell = useMemo(() => ({ pickFiles }), [pickFiles]);

  const nav = [
    { to: '/library', label: 'Library', icon: ImageIcon },
    { to: '/favorites', label: 'Favorites', icon: Star },
    { to: '/collections', label: 'Collections', icon: FolderOpen },
    { to: '/shares', label: 'Shared', icon: Share2 },
    { to: '/processing', label: 'Processing', icon: Cpu, badge: activeJobs },
    { to: '/activity', label: 'Activity', icon: Activity },
    { to: '/trash', label: 'Trash', icon: Trash2 },
  ];
  const themeIcon = mode === 'dark' ? <Moon size={16} /> : mode === 'light' ? <Sun size={16} /> : <Monitor size={16} />;

  return (
    <ShellCtx.Provider value={shell}>
      <div className="shell">
        <aside className="sidebar" aria-label="Primary">
          <Link to="/library" className="brand" aria-label="Media Platform home"><span className="brand-mark"><LayoutGrid size={18} /></span><span className="brand-name">Media</span></Link>
          <button className="btn btn-primary btn-upload" onClick={pickFiles}><UploadCloud size={18} /><span className="label">Upload</span></button>
          <nav>
            {nav.map(({ to, label, icon: Icon, badge }) => (
              <NavLink key={to} to={to} className={({ isActive }) => `nav-link ${isActive || (to === '/collections' && pathname.startsWith('/collections')) ? 'active' : ''}`} title={label}>
                <Icon size={19} aria-hidden /><span className="label">{label}</span>
                {!!badge && <span className="badge" aria-label={`${badge} active`}>{badge}</span>}
              </NavLink>
            ))}
            {isAdmin && <NavLink to="/admin" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title="Operations"><Gauge size={19} aria-hidden /><span className="label">Operations</span></NavLink>}
          </nav>
          {tags && tags.filter((t) => t.count > 0).length > 0 && (
            <div className="side-tags">
              <h3>Tags</h3>
              {tags.filter((t) => t.count > 0).slice(0, 8).map((t) => (
                <NavLink key={t.id} to={`/tags/${encodeURIComponent(t.name)}`} className={({ isActive }) => `nav-link nav-tag ${isActive ? 'active' : ''}`}><Tag size={15} aria-hidden /><span className="label">{t.name}</span><span className="count">{t.count}</span></NavLink>
              ))}
            </div>
          )}
          <div className="side-foot">
            {usage && (
              <div className="storage" title={`${formatBytes(usage.usedBytes)} of ${formatBytes(usage.quotaBytes)}`}>
                <ProgressBar value={usage.quotaBytes ? usage.usedBytes / usage.quotaBytes : 0} tone={usage.usedBytes / usage.quotaBytes > 0.9 ? 'bad' : 'accent'} />
                <span className="small muted label">{formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}</span>
              </div>
            )}
            <Menu label="Account" align="start"
              trigger={(p) => <button className="user-btn" {...p}><Avatar name={name} /><span className="label"><strong>{user?.displayName || user?.email.split('@')[0]}</strong><span className="small muted">{isAdmin ? 'Admin' : user?.email}</span></span></button>}
              items={[
                { label: 'Settings', icon: <Settings size={16} />, onClick: () => navigate('/settings') },
                { label: `Theme: ${mode}`, icon: themeIcon, onClick: () => setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system') },
                { divider: true, label: '', onClick: () => undefined },
                { label: 'Sign out', icon: <LogOut size={16} />, onClick: logout },
              ]} />
          </div>
        </aside>

        <div className="main">
          {!online && <div className="banner" role="status">You’re offline. Changes will fail until you reconnect.</div>}
          <header className={`topbar ${searchOpen ? 'search-open' : ''}`}>
            <Link to="/library" className="brand only-mobile" aria-label="Home"><span className="brand-mark"><LayoutGrid size={18} /></span></Link>
            <div className="search">
              <Search size={18} aria-hidden />
              <input ref={searchRef} type="search" value={q} placeholder="Search name, tag or description  ( / )" aria-label="Search library" onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearchOpen(false)} />
              {q && <button className="icon-btn" aria-label="Clear search" onClick={() => setQ('')}><X size={16} /></button>}
            </div>
            <button className="icon-btn only-mobile search-toggle" aria-label="Search" onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }}><Search size={22} /></button>
            <span className={`live-dot ${rt}`} role="status" title={rt === 'live' ? 'Live updates on' : 'Live updates paused; reconnecting…'} aria-label={rt === 'live' ? 'Live updates on' : 'Live updates paused'} />
          </header>
          <main id="content" className="content"><Outlet /></main>
        </div>

        <nav className="bottom-nav" aria-label="Primary">
          <NavLink to="/library" className="bn-item"><ImageIcon size={22} /><span>Library</span></NavLink>
          <NavLink to="/collections" className="bn-item"><FolderOpen size={22} /><span>Collections</span></NavLink>
          <button className="bn-fab" onClick={() => { setMore(false); pickFiles(); }} aria-label="Upload"><Plus size={26} /></button>
          <NavLink to="/processing" className="bn-item"><span className="bn-icon"><Cpu size={22} />{activeJobs > 0 && <i className="badge">{activeJobs}</i>}</span><span>Processing</span></NavLink>
          <button className="bn-item" onClick={() => setMore(true)}><MoreHorizontal size={22} /><span>More</span></button>
        </nav>

        <input ref={fileRef} type="file" multiple accept="image/*,video/*,.heic,.heif,.mov" hidden
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) enqueue(files, { collectionId: defaultCollectionId }); e.target.value = ''; }} />
        <UploadTray />
        <DropOverlay />

        <Dialog open={more} onClose={() => setMore(false)} title="More" size="sm">
          <div className="more-grid">
            {[{ to: '/favorites', label: 'Favorites', icon: Star }, { to: '/shares', label: 'Shared links', icon: Share2 }, { to: '/activity', label: 'Activity', icon: Activity }, { to: '/trash', label: 'Trash', icon: Trash2 }, { to: '/settings', label: 'Settings', icon: Settings }, ...(isAdmin ? [{ to: '/admin', label: 'Operations', icon: Gauge }] : [])].map(({ to, label, icon: I }) => (
              <Link key={to} to={to} className="more-item" onClick={() => setMore(false)}><I size={22} aria-hidden /><span>{label}</span></Link>
            ))}
          </div>
          <Segmented<ThemeMode> label="Theme" value={mode} onChange={setMode} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          <button className="btn btn-block" onClick={() => { setMore(false); logout(); }}><LogOut size={16} /> Sign out</button>
        </Dialog>
      </div>
    </ShellCtx.Provider>
  );
}
