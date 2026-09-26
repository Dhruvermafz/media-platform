import type { Job, JobType } from '../api/types';

const BASE: Record<JobType, string> = {
  IMAGE_THUMBNAIL: 'Thumbnail', IMAGE_RESIZE: 'Resize', IMAGE_COMPRESS: 'Compress', IMAGE_FORMAT_CONVERT: 'Format conversion',
  VIDEO_TRANSCODE: 'Transcode', VIDEO_THUMBNAIL: 'Video thumbnail', VIDEO_PREVIEW: 'Preview clip', METADATA_EXTRACT: 'Metadata',
};

/** "Transcode · 720p", "Resize · 1600 px" - uses the job params when present. */
export function jobLabel(job: Pick<Job, 'type' | 'params'>): string {
  const p = job.params ?? {};
  const detail =
    job.type === 'VIDEO_TRANSCODE' ? (p.resolution as string) :
    job.type === 'IMAGE_RESIZE' ? (p.width ? `${p.width} px` : '') :
    job.type === 'IMAGE_COMPRESS' ? (p.quality ? `q${p.quality}` : '') :
    job.type === 'IMAGE_FORMAT_CONVERT' ? (p.format as string) : '';
  return detail ? `${BASE[job.type]} · ${detail}` : BASE[job.type];
}
export const jobTypeLabel = (t: JobType) => BASE[t];

export const ACTION_LABEL: Record<string, string> = {
  'asset.uploaded': 'Uploaded', 'asset.trashed': 'Moved to trash', 'asset.restored': 'Restored', 'asset.deleted': 'Permanently deleted',
  'variant.requested': 'Requested a rendition of', 'collection.created': 'Created collection', 'collection.deleted': 'Deleted collection',
  'share.created': 'Created a share link for', 'share.revoked': 'Revoked a share link',
};
