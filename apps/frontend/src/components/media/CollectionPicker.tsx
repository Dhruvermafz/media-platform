import { useState } from 'react';
import { FolderPlus, FolderOpen, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { useAssetActions, useCollections } from '../../lib/queries';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/primitives';
import { pluralize } from '../../lib/format';

export function CollectionPicker({ open, onClose, assetIds, onDone }: { open: boolean; onClose: () => void; assetIds: string[]; onDone?: () => void }) {
  const { data, isLoading, refetch } = useCollections();
  const actions = useAssetActions();
  const toast = useToast();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const add = async (id: string, label: string) => {
    await actions.addToCollection(assetIds, id, label);
    onDone?.();
    onClose();
  };
  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    try {
      const c = await api.createCollection(n);
      await refetch();
      await add(c.id, c.name);
      setName('');
    } catch (e) { toast.error(e); } finally { setCreating(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Add to collection" description={pluralize(assetIds.length, 'item') + ' selected'}>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }}>
        <FolderPlus size={18} aria-hidden />
        <input className="input" placeholder="New collection name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="New collection name" />
        <button className="btn btn-primary" disabled={!name.trim() || creating}><Plus size={16} />Create</button>
      </form>
      <div className="pick-list" role="list">
        {isLoading && <Spinner />}
        {data?.length === 0 && <p className="muted pad">No collections yet. Create your first one above.</p>}
        {data?.map((c) => (
          <button key={c.id} role="listitem" className="pick-item" onClick={() => void add(c.id, c.name)} disabled={actions.busy}>
            <FolderOpen size={18} aria-hidden />
            <span><strong>{c.name}</strong><span className="muted small">{pluralize(c.itemCount, 'item')}</span></span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
