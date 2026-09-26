import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  FolderOpen,
  Link2,
  RotateCcw,
  Trash2,
  UploadCloud,
  Wand2,
} from "lucide-react";
import { api } from "../api/client";
import type { ActivityEntry } from "../api/types";
import {
  EmptyState,
  ErrorState,
  PageSpinner,
  Spinner,
} from "../components/ui/primitives";
import { ACTION_LABEL } from "../lib/labels";
import { dateGroupLabel } from "../lib/format";
import { useInfiniteSentinel } from "../lib/hooks";

const ICONS: Record<string, typeof UploadCloud> = {
  "asset.uploaded": UploadCloud,
  "asset.trashed": Trash2,
  "asset.restored": RotateCcw,
  "asset.deleted": Trash2,
  "variant.requested": Wand2,
  "collection.created": FolderOpen,
  "collection.deleted": FolderOpen,
  "share.created": Link2,
  "share.revoked": Link2,
};

export function ActivityPage() {
  const q = useInfiniteQuery({
    queryKey: ["activity"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.activity(pageParam),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const sentinel = useInfiniteSentinel(
    () => void q.fetchNextPage(),
    Boolean(q.hasNextPage) && !q.isFetchingNextPage,
  );
  const groups = useMemo(() => {
    const out: { label: string; items: ActivityEntry[] }[] = [];
    for (const e of q.data?.pages.flatMap((p) => p.items) ?? []) {
      const label = dateGroupLabel(e.createdAt);
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [q.data]);

  if (q.isLoading) return <PageSpinner />;
  if (q.error)
    return (
      <ErrorState
        message={(q.error as Error).message}
        onRetry={() => void q.refetch()}
      />
    );
  return (
    <div className="page narrow">
      <header className="page-head">
        <div className="page-title">
          <h1>Activity</h1>
        </div>
      </header>
      {groups.length === 0 ? (
        <EmptyState icon={<ActivityIcon size={28} />} title="No activity yet">
          Uploads, deletions and sharing show up here.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.label}>
            <h2 className="group-label">{g.label}</h2>
            <ul className="timeline">
              {g.items.map((e) => {
                const I = ICONS[e.action] ?? ActivityIcon;
                return (
                  <li key={e.id}>
                    <span className="tl-dot">
                      <I size={15} aria-hidden />
                    </span>
                    <div>
                      <span>{ACTION_LABEL[e.action] ?? e.action}</span>
                      {e.entityName && (
                        <>
                          {" "}
                          <strong>{e.entityName}</strong>
                        </>
                      )}
                    </div>
                    <time className="muted small" dateTime={e.createdAt}>
                      {new Date(e.createdAt).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <div ref={sentinel} className="sentinel">
        {q.isFetchingNextPage && <Spinner />}
      </div>
    </div>
  );
}
