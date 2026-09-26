import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { useTags } from '../../lib/queries';

/** Chip input: Enter / comma adds, Backspace on empty removes the last chip. */
export function TagEditor({ tags, onChange, disabled }: { tags: string[]; onChange: (tags: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const { data: known } = useTags();

  const commit = () => {
    const t = draft.trim().replace(/^#+/, '').toLowerCase();
    setDraft('');
    if (t && !tags.includes(t) && tags.length < 20) onChange([...tags, t]);
  };

  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <span key={t} className="chip chip-x">
          {t}
          <button aria-label={`Remove tag ${t}`} disabled={disabled} onClick={() => onChange(tags.filter((x) => x !== t))}><X size={12} /></button>
        </span>
      ))}
      <input
        className="tag-input" value={draft} list={listId} placeholder={tags.length ? 'Add tag…' : 'Add tags…'} maxLength={32} disabled={disabled} aria-label="Add a tag"
        onChange={(e) => (e.target.value.endsWith(',') ? (setDraft(e.target.value.slice(0, -1)), setTimeout(commit, 0)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={commit}
      />
      <datalist id={listId}>{known?.filter((k) => !tags.includes(k.name)).slice(0, 20).map((k) => <option key={k.id} value={k.name} />)}</datalist>
    </div>
  );
}
