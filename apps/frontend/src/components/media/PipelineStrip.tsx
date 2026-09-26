import type { Pipeline } from '../../api/types';

/**
 * The platform's signature detail: one segment per processing job, filling in
 * as workers finish (live, via server events). Order: done -> failed ->
 * running -> waiting, so progress reads left to right.
 */
export function PipelineStrip({ pipeline, status }: { pipeline: Pipeline | null; status: string }) {
  const total = pipeline?.total ?? 0;
  if (total === 0) {
    // Upload confirmed but jobs not visible yet: show an indeterminate shimmer.
    return <div className="pipeline pipeline-wait" role="progressbar" aria-label="Queued for processing"><span /></div>;
  }
  const { done, failed, running } = pipeline!;
  const segs = Array.from({ length: Math.min(total, 10) }, (_, i) =>
    i < done ? 'done' : i < done + failed ? 'failed' : i < done + failed + running ? 'running' : 'wait');
  const label = failed ? `${failed} processing step${failed > 1 ? 's' : ''} failed` : `${done} of ${total} processing steps complete`;
  return (
    <div className={`pipeline ${status === 'FAILED' ? 'pipeline-failed' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}>
      {segs.map((s, i) => <span key={i} className={s} />)}
    </div>
  );
}
