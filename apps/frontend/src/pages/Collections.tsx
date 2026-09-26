import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderOpen, Plus } from "lucide-react";
import { api } from "../api/client";
import { Dialog } from "../components/ui/Dialog";
import {
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
} from "../components/ui/primitives";
import { useToast } from "../context/ToastContext";
import { pluralize, timeAgo } from "../lib/format";
import { useCollections, useInvalidateLibrary } from "../lib/queries";

export function CollectionsPage() {
  const { data, isLoading, error, refetch } = useCollections();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateLibrary();

  const create = async () => {
    setBusy(true);
    try {
      const c = await api.createCollection(name.trim());
      void invalidate();
      setCreating(false);
      setName("");
      navigate(`/collections/${c.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const newBtn = (
    <button className="btn btn-primary" onClick={() => setCreating(true)}>
      <Plus size={16} />
      New collection
    </button>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Collections</h1>
          {data && (
            <span className="muted">
              {pluralize(data.length, "collection")}
            </span>
          )}
        </div>
        {newBtn}
      </header>
      {error ? (
        <ErrorState
          message={(error as Error).message}
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <div className="cards">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="card-skel" />
          ))}
        </div>
      ) : data?.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={28} />}
          title="No collections yet"
          action={newBtn}
        >
          Group photos and videos into albums you can share as a single link.
        </EmptyState>
      ) : (
        <div className="cards">
          {data?.map((c) => (
            <Link key={c.id} to={`/collections/${c.id}`} className="card">
              <div
                className={`mosaic m${Math.min(4, c.covers?.length ?? 0)}`}
                aria-hidden
              >
                {(c.covers ?? []).length === 0 ? (
                  <span className="mosaic-empty">
                    <FolderOpen size={30} />
                  </span>
                ) : (
                  c.covers!.map((cv) => (
                    <span
                      key={cv.assetId}
                      style={{ backgroundColor: cv.dominantColor ?? undefined }}
                    >
                      {cv.url && <img src={cv.url} alt="" loading="lazy" />}
                    </span>
                  ))
                )}
              </div>
              <div className="card-body">
                <strong>{c.name}</strong>
                <span className="muted small">
                  {pluralize(c.itemCount, "item")} · updated{" "}
                  {timeAgo(c.updatedAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New collection"
        footer={
          <>
            <button className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!name.trim() || busy}
              onClick={() => void create()}
            >
              Create
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Field label="Name">
            <input
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              data-autofocus
              placeholder="e.g. Lisbon trip"
            />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
