import { useState } from 'react';
import { useAssetActions } from '../../lib/queries';
import { Dialog } from '../ui/Dialog';
import { TagEditor } from './TagEditor';
import { pluralize } from '../../lib/format';

export function BulkTagDialog({ open, onClose, assetIds, onDone }: { open: boolean; onClose: () => void; assetIds: string[]; onDone?: () => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const actions = useAssetActions();
  const apply = async () => { await actions.addTags(assetIds, tags); setTags([]); onDone?.(); onClose(); };
  return (
    <Dialog open={open} onClose={onClose} title="Add tags" description={`Applied to ${pluralize(assetIds.length, 'item')}. Existing tags are kept.`}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!tags.length || actions.busy} onClick={() => void apply()}>Add tags</button></>}>
      <TagEditor tags={tags} onChange={setTags} />
    </Dialog>
  );
}
