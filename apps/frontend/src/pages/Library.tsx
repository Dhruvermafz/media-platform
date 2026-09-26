import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownUp,
  CheckSquare,
  FolderMinus,
  FolderPlus,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  List,
  Pencil,
  RotateCcw,
  Search,
  Star,
  Tag,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { api } from "../api/client";
import type {
  AssetKind,
  AssetStatus,
  AssetSummary,
  ListFilters,
} from "../api/types";
import { AssetRow } from "../components/media/AssetRow";
import { AssetTile } from "../components/media/AssetTile";
import { BulkTagDialog } from "../components/media/BulkTagDialog";
import { CollectionPicker } from "../components/media/CollectionPicker";
import { ShareDialog } from "../components/media/ShareDialog";
import { Viewer } from "../components/media/Viewer";
import { useShell } from "../components/layout/AppShell";
import { ConfirmDialog, Dialog } from "../components/ui/Dialog";
import { Menu } from "../components/ui/Menu";
import {
  EmptyState,
  ErrorState,
  Field,
  Segmented,
  Skeleton,
  Spinner,
} from "../components/ui/primitives";
import { useToast } from "../context/ToastContext";
import { useUploads } from "../context/UploadContext";
import { dateGroupLabel, pluralize } from "../lib/format";
import { useHotkey, useInfiniteSentinel, useLocalStorage } from "../lib/hooks";
import {
  useAssetActions,
  useAssets,
  useInvalidateLibrary,
} from "../lib/queries";

export type LibraryMode =
  | "library"
  | "favorites"
  | "trash"
  | "collection"
  | "tag";
type Sort = NonNullable<ListFilters["sort"]>;

const SORTS: { sort: Sort; order: "asc" | "desc"; label: string }[] = [
  { sort: "createdAt", order: "desc", label: "Newest first" },
  { sort: "createdAt", order: "asc", label: "Oldest first" },
  { sort: "fileName", order: "asc", label: "Name A–Z" },
  { sort: "fileSize", order: "desc", label: "Largest first" },
];

export function LibraryPage({ mode }: { mode: LibraryMode }) {
  const routeParams = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { pickFiles } = useShell();
  const uploads = useUploads();
  const actions = useAssetActions();
  const invalidate = useInvalidateLibrary();

  const [view, setView] = useLocalStorage<"grid" | "list">("lib.view", "grid");
  const [size, setSize] = useLocalStorage<"s" | "m" | "l">("lib.size", "m");

  const collectionId = mode === "collection" ? routeParams.id : undefined;
  const tag =
    mode === "tag" ? decodeURIComponent(routeParams.name ?? "") : undefined;
  const q = params.get("q") ?? "";
  const kind = (params.get("kind") as AssetKind | null) ?? undefined;
  const status = (params.get("status") as AssetStatus | null) ?? undefined;
  const sortKey = params.get("sort") ?? "createdAt:desc";
  const [sort, order] = sortKey.split(":") as [Sort, "asc" | "desc"];

  const filters: ListFilters = useMemo(
    () => ({
      q: q || undefined,
      kind,
      status,
      sort,
      order,
      favorite: mode === "favorites" || undefined,
      trashed: mode === "trash" || undefined,
      collectionId,
      tag,
    }),
    [q, kind, status, sort, order, mode, collectionId, tag],
  );

  const query = useAssets(filters);
  const items = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;
  const sentinel = useInfiniteSentinel(
    () => void query.fetchNextPage(),
    Boolean(query.hasNextPage) && !query.isFetchingNextPage,
  );

  // ---- collection header data
  const collection = useQuery({
    queryKey: ["collection", collectionId],
    queryFn: () => api.collection(collectionId!),
    enabled: Boolean(collectionId),
  });
  // Uploads started on a collection page land in that collection.
  useEffect(() => {
    if (!collectionId) return;
    uploads.setDefaultCollectionId(collectionId);
    return () => uploads.setDefaultCollectionId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);

  // ---- selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    lastClicked.current = null;
  }, [mode, collectionId, tag, q, kind, status, sortKey]);
  const selecting = selected.size > 0;
  const ids = useMemo(() => items.map((i) => i.id), [items]);

  const onSelect = useCallback(
    (a: AssetSummary, e: { shiftKey: boolean }) => {
      // Capture the anchor NOW: the updater below runs later (during render), by
      // which point lastClicked.current has already been overwritten.
      const anchor = lastClicked.current;
      lastClicked.current = a.id;
      setSelected((prev) => {
        const next = new Set(prev);
        if (e.shiftKey && anchor && anchor !== a.id) {
          const [from, to] = [ids.indexOf(anchor), ids.indexOf(a.id)].sort(
            (x, y) => x - y,
          );
          if (from >= 0) for (const id of ids.slice(from, to + 1)) next.add(id);
        } else if (next.has(a.id)) next.delete(a.id);
        else next.add(a.id);
        return next;
      });
    },
    [ids],
  );
  useHotkey(
    "Escape",
    () => setSelected(new Set()),
    selecting && !params.get("asset"),
  );

  // ---- viewer (deep-linkable through ?asset=)
  const openId = params.get("asset");
  const openViewer = useCallback(
    (a: AssetSummary) => {
      const next = new URLSearchParams(params);
      next.set("asset", a.id);
      setParams(next, { state: { viewer: true } });
    },
    [params, setParams],
  );
  const navigateViewer = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set("asset", id);
      setParams(next, { replace: true, state: location.state });
    },
    [params, setParams, location.state],
  );
  const closeViewer = useCallback(() => {
    if ((location.state as { viewer?: boolean } | null)?.viewer) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete("asset");
    setParams(next, { replace: true });
  }, [location.state, navigate, params, setParams]);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // ---- dialogs
  const [dlg, setDlg] = useState<
    | null
    | "collection"
    | "tags"
    | "trash"
    | "delete"
    | "emptyTrash"
    | "share"
    | "rename"
    | "deleteCollection"
  >(null);
  const selectedIds = useMemo(() => [...selected], [selected]);
  const clearSelection = () => setSelected(new Set());

  const toggleFavorite = useCallback(
    (a: AssetSummary) => {
      void actions.setFavorite([a.id], !a.isFavorite);
    },
    [actions],
  );

  // ---- grouping by date (only meaningful when sorted by date)
  const sections = useMemo(() => {
    if (view === "list" || sort !== "createdAt") return [{ label: "", items }];
    const out: { label: string; items: AssetSummary[] }[] = [];
    for (const a of items) {
      const label = dateGroupLabel(a.createdAt);
      if (out.length && out[out.length - 1].label === label)
        out[out.length - 1].items.push(a);
      else out.push({ label, items: [a] });
    }
    return out;
  }, [items, sort, view]);

  const emptyTrash = async () => {
    setDlg(null);
    try {
      const all: string[] = [];
      for (let page = 1; ; page++) {
        const res = await api.listAssets({ trashed: true }, page, 100);
        all.push(...res.items.map((i) => i.id));
        if (!res.hasMore) break;
      }
      for (let i = 0; i < all.length; i += 200)
        await api.bulk(all.slice(i, i + 200), "delete");
      toast.success(`Permanently deleted ${pluralize(all.length, "item")}`);
      void invalidate();
    } catch (e) {
      toast.error(e);
    }
  };

  const title =
    mode === "library"
      ? "Library"
      : mode === "favorites"
        ? "Favorites"
        : mode === "trash"
          ? "Trash"
          : mode === "tag"
            ? `#${tag}`
            : (collection.data?.name ?? "Collection");
  const hasFilters = Boolean(q || kind || status);
  const currentSort =
    SORTS.find((s) => s.sort === sort && s.order === order) ?? SORTS[0];

  const renderItem = (a: AssetSummary) =>
    view === "grid" ? (
      <AssetTile
        key={a.id}
        asset={a}
        selected={selected.has(a.id)}
        selecting={selecting}
        onOpen={openViewer}
        onSelect={onSelect}
        onFavorite={toggleFavorite}
      />
    ) : (
      <AssetRow
        key={a.id}
        asset={a}
        selected={selected.has(a.id)}
        selecting={selecting}
        onOpen={openViewer}
        onSelect={onSelect}
        onFavorite={toggleFavorite}
      />
    );

  return (
    <div className="page library">
      <header className="page-head">
        <div className="page-title">
          <h1>{title}</h1>
          <span className="muted">
            {query.isLoading
              ? ""
              : pluralize(total, mode === "trash" ? "item" : "item")}
            {hasFilters ? " match" : ""}
          </span>
        </div>
        <div className="page-actions">
          {mode === "collection" && collection.data && (
            <>
              <button className="btn" onClick={() => setDlg("share")}>
                <Link2 size={16} />
                <span className="hide-sm">Share</span>
              </button>
              <Menu
                label="Collection actions"
                trigger={(p) => (
                  <button className="btn" {...p}>
                    <Pencil size={16} />
                    <span className="hide-sm">Edit</span>
                  </button>
                )}
                items={[
                  {
                    label: "Rename…",
                    icon: <Pencil size={16} />,
                    onClick: () => setDlg("rename"),
                  },
                  {
                    label: "Delete collection…",
                    icon: <Trash2 size={16} />,
                    danger: true,
                    onClick: () => setDlg("deleteCollection"),
                  },
                ]}
              />
              <button className="btn btn-primary" onClick={pickFiles}>
                <UploadCloud size={16} />
                <span className="hide-sm">Upload here</span>
              </button>
            </>
          )}
          {mode === "trash" && total > 0 && (
            <button
              className="btn btn-danger-ghost"
              onClick={() => setDlg("emptyTrash")}
            >
              <Trash2 size={16} />
              Empty trash
            </button>
          )}
        </div>
      </header>
      {mode === "collection" && collection.data?.description && (
        <p className="muted lead">{collection.data.description}</p>
      )}
      {mode === "trash" && (
        <p className="muted lead">
          Items are deleted permanently after 30 days.
        </p>
      )}

      <div className="toolbar" role="toolbar" aria-label="Library controls">
        <Segmented<string>
          label="Filter by type"
          value={kind ?? "all"}
          onChange={(v) => setParam("kind", v === "all" ? undefined : v)}
          options={[
            { value: "all", label: "All" },
            { value: "IMAGE", label: "Photos" },
            { value: "VIDEO", label: "Videos" },
          ]}
        />
        {mode !== "trash" && (
          <select
            className="input input-sm"
            value={status ?? ""}
            onChange={(e) => setParam("status", e.target.value || undefined)}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="PROCESSING">Processing</option>
            <option value="READY">Ready</option>
            <option value="FAILED">Failed</option>
          </select>
        )}
        <span className="grow" />
        <Menu
          label="Sort"
          trigger={(p) => (
            <button className="btn btn-sm" {...p}>
              <ArrowDownUp size={15} />
              <span className="hide-sm">{currentSort.label}</span>
            </button>
          )}
          items={SORTS.map((s) => ({
            label: s.label,
            checked: s === currentSort,
            onClick: () =>
              setParam(
                "sort",
                s.sort === "createdAt" && s.order === "desc"
                  ? undefined
                  : `${s.sort}:${s.order}`,
              ),
          }))}
        />
        {view === "grid" && (
          <Segmented<"s" | "m" | "l">
            label="Tile size"
            value={size}
            onChange={setSize}
            options={[
              { value: "s", label: "S", title: "Small tiles" },
              { value: "m", label: "M", title: "Medium tiles" },
              { value: "l", label: "L", title: "Large tiles" },
            ]}
          />
        )}
        <Segmented<"grid" | "list">
          label="View"
          value={view}
          onChange={setView}
          options={[
            {
              value: "grid",
              label: <LayoutGrid size={16} aria-label="Grid view" />,
            },
            { value: "list", label: <List size={16} aria-label="List view" /> },
          ]}
        />
        <button
          className="btn btn-sm"
          onClick={() => items[0] && onSelect(items[0], { shiftKey: false })}
          disabled={items.length === 0}
          aria-label="Select items"
        >
          <CheckSquare size={15} />
          <span className="hide-sm">Select</span>
        </button>
      </div>

      {selecting && (
        <div className="bulkbar" role="toolbar" aria-label="Selection actions">
          <button
            className="icon-btn"
            aria-label="Clear selection"
            onClick={clearSelection}
          >
            <X size={18} />
          </button>
          <strong>{selected.size} selected</strong>
          <button
            className="link-btn"
            onClick={() => setSelected(new Set(ids))}
          >
            Select all {items.length}
          </button>
          <span className="grow" />
          {mode === "trash" ? (
            <>
              <button
                className="btn btn-sm"
                onClick={() =>
                  void actions.restore(selectedIds).then(clearSelection)
                }
              >
                <RotateCcw size={15} />
                Restore
              </button>
              <button
                className="btn btn-sm btn-danger-ghost"
                onClick={() => setDlg("delete")}
              >
                <Trash2 size={15} />
                Delete forever
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-sm"
                onClick={() =>
                  void actions
                    .setFavorite(selectedIds, true)
                    .then(clearSelection)
                }
              >
                <Star size={15} />
                <span className="hide-sm">Favorite</span>
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setDlg("collection")}
              >
                <FolderPlus size={15} />
                <span className="hide-sm">Collection</span>
              </button>
              <button className="btn btn-sm" onClick={() => setDlg("tags")}>
                <Tag size={15} />
                <span className="hide-sm">Tag</span>
              </button>
              {mode === "collection" && (
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void actions
                      .removeFromCollection(selectedIds, collectionId!)
                      .then(clearSelection)
                  }
                >
                  <FolderMinus size={15} />
                  <span className="hide-sm">Remove</span>
                </button>
              )}
              <button
                className="btn btn-sm btn-danger-ghost"
                onClick={() => setDlg("trash")}
              >
                <Trash2 size={15} />
                <span className="hide-sm">Trash</span>
              </button>
            </>
          )}
        </div>
      )}

      {query.isError ? (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      ) : query.isLoading ? (
        <div className="grid" data-size={size}>
          {Array.from({ length: 24 }, (_, i) => (
            <Skeleton key={i} className="tile-skel" />
          ))}
        </div>
      ) : items.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={<Search size={28} />}
            title="Nothing matches"
            action={
              <button
                className="btn"
                onClick={() =>
                  setParams(new URLSearchParams(), { replace: true })
                }
              >
                Clear filters
              </button>
            }
          >
            {q ? (
              <>No results for “{q}”. Try a different word, or search by tag.</>
            ) : (
              "Try removing a filter."
            )}
          </EmptyState>
        ) : mode === "favorites" ? (
          <EmptyState icon={<Heart size={28} />} title="No favorites yet">
            Tap the star on any photo or video to keep it close.
          </EmptyState>
        ) : mode === "trash" ? (
          <EmptyState icon={<Trash2 size={28} />} title="Trash is empty">
            Deleted items wait here for 30 days before they’re gone for good.
          </EmptyState>
        ) : mode === "tag" ? (
          <EmptyState icon={<Tag size={28} />} title="No items with this tag" />
        ) : mode === "collection" ? (
          <EmptyState
            icon={<FolderOpen size={28} />}
            title="This collection is empty"
            action={
              <button className="btn btn-primary" onClick={pickFiles}>
                <UploadCloud size={16} />
                Upload here
              </button>
            }
          >
            Upload files or add existing ones from your library using the
            Collection button.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<ImageIcon size={28} />}
            title="Your library is empty"
            action={
              <button className="btn btn-primary" onClick={pickFiles}>
                <UploadCloud size={16} />
                Upload photos & videos
              </button>
            }
          >
            Drop files anywhere, or press <kbd>U</kbd>. Each upload is processed
            into thumbnails, optimised copies and metadata automatically.
          </EmptyState>
        )
      ) : view === "grid" ? (
        <div className={query.isPlaceholderData ? "is-stale" : ""}>
          {sections.map((s) => (
            <Fragment key={s.label || "all"}>
              {s.label && <h2 className="group-label">{s.label}</h2>}
              <div className="grid" data-size={size}>
                {s.items.map(renderItem)}
              </div>
            </Fragment>
          ))}
        </div>
      ) : (
        <div
          className={`list ${query.isPlaceholderData ? "is-stale" : ""}`}
          role="list"
        >
          {items.map(renderItem)}
        </div>
      )}

      <div ref={sentinel} className="sentinel">
        {query.isFetchingNextPage && <Spinner />}
      </div>

      {openId && (
        <Viewer
          assetId={openId}
          ids={ids.includes(openId) ? ids : [openId]}
          initial={items.find((i) => i.id === openId)}
          onNavigate={navigateViewer}
          onClose={closeViewer}
        />
      )}

      <CollectionPicker
        open={dlg === "collection"}
        onClose={() => setDlg(null)}
        assetIds={selectedIds}
        onDone={clearSelection}
      />
      <BulkTagDialog
        open={dlg === "tags"}
        onClose={() => setDlg(null)}
        assetIds={selectedIds}
        onDone={clearSelection}
      />
      <ConfirmDialog
        open={dlg === "trash"}
        title={`Move ${pluralize(selected.size, "item")} to trash?`}
        message="You can restore them from the trash for 30 days."
        confirmLabel="Move to trash"
        danger
        onClose={() => setDlg(null)}
        onConfirm={() => {
          setDlg(null);
          void actions.trash(selectedIds).then(clearSelection);
        }}
      />
      <ConfirmDialog
        open={dlg === "delete"}
        title={`Delete ${pluralize(selected.size, "item")} forever?`}
        message="This permanently removes the files and every rendition. It can’t be undone."
        confirmLabel="Delete forever"
        danger
        onClose={() => setDlg(null)}
        onConfirm={() => {
          setDlg(null);
          void actions.deleteForever(selectedIds).then(clearSelection);
        }}
      />
      <ConfirmDialog
        open={dlg === "emptyTrash"}
        title="Empty the trash?"
        message={`This permanently deletes ${pluralize(total, "item")}. It can’t be undone.`}
        confirmLabel="Empty trash"
        danger
        onClose={() => setDlg(null)}
        onConfirm={() => void emptyTrash()}
      />
      {collection.data && (
        <>
          <ShareDialog
            open={dlg === "share"}
            onClose={() => setDlg(null)}
            name={collection.data.name}
            target={{ collectionId }}
          />
          <RenameCollection
            open={dlg === "rename"}
            onClose={() => setDlg(null)}
            id={collection.data.id}
            name={collection.data.name}
            description={collection.data.description ?? ""}
          />
          <ConfirmDialog
            open={dlg === "deleteCollection"}
            title={`Delete “${collection.data.name}”?`}
            message="The collection is removed. The photos and videos in it stay in your library."
            confirmLabel="Delete collection"
            danger
            onClose={() => setDlg(null)}
            onConfirm={async () => {
              setDlg(null);
              try {
                await api.deleteCollection(collection.data!.id);
                void invalidate();
                navigate("/collections", { replace: true });
              } catch (e) {
                toast.error(e);
              }
            }}
          />
        </>
      )}
    </div>
  );
}

function RenameCollection({
  open,
  onClose,
  id,
  name,
  description,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
  name: string;
  description: string;
}) {
  const [n, setN] = useState(name);
  const [d, setD] = useState(description);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateLibrary();
  useEffect(() => {
    if (open) {
      setN(name);
      setD(description);
    }
  }, [open, name, description]);
  const save = async () => {
    setBusy(true);
    try {
      await api.updateCollection(id, { name: n.trim(), description: d });
      void invalidate();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit collection"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!n.trim() || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input
            className="input"
            value={n}
            maxLength={80}
            onChange={(e) => setN(e.target.value)}
            data-autofocus
          />
        </Field>
        <Field label="Description">
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            value={d}
            onChange={(e) => setD(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
