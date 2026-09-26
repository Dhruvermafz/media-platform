// Mirrors the JSON returned by apps/api (see docs/api.md). Dates arrive as ISO strings.
export type Role = 'USER' | 'ADMIN';
export type AssetKind = 'IMAGE' | 'VIDEO';
export type AssetStatus = 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRY' | 'DEAD_LETTER';
export type JobType =
  | 'IMAGE_THUMBNAIL' | 'IMAGE_RESIZE' | 'IMAGE_COMPRESS' | 'IMAGE_FORMAT_CONVERT'
  | 'VIDEO_TRANSCODE' | 'VIDEO_THUMBNAIL' | 'VIDEO_PREVIEW' | 'METADATA_EXTRACT';

export interface User { id: string; email: string; displayName: string | null; role: Role; createdAt: string }
export interface Profile extends User { storageQuotaBytes: number }
export interface AuthResponse { user: User; accessToken: string }

export interface Pipeline { total: number; done: number; running: number; failed: number }

export interface AssetSummary {
  id: string; ownerId: string; fileName: string; title: string | null; description: string | null;
  mimeType: string; kind: AssetKind; fileSize: number; status: AssetStatus; isFavorite: boolean;
  width: number | null; height: number | null; durationMs: number | null; dominantColor: string | null;
  capturedAt: string | null; tags: string[]; createdAt: string; updatedAt: string; deletedAt: string | null;
  thumbnailUrl: string | null; clipUrl: string | null; pipeline: Pipeline | null;
}
export interface Variant {
  id: string; type: JobType; name: string; mimeType: string; fileSize: number;
  width: number | null; height: number | null; durationMs: number | null; createdAt: string; downloadUrl: string;
}
export interface AssetDetail extends Omit<AssetSummary, 'pipeline'> {
  previewUrl: string | null; originalUrl: string;
  metadata: Record<string, unknown> | null;
  collections: { id: string; name: string }[];
  variants: Variant[];
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean }

export interface Collection {
  id: string; name: string; description: string | null; itemCount: number; createdAt: string; updatedAt: string;
  covers?: { assetId: string; dominantColor: string | null; url: string | null }[];
}
export interface Tag { id: string; name: string; count: number }

export interface Job {
  id: string; assetId: string; type: JobType; status: JobStatus; attempt: number; maxAttempts: number;
  failureReason: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
  params?: Record<string, unknown>;
}
export interface JobWithAsset extends Job {
  asset: { id: string; fileName: string; title: string | null; kind: AssetKind; deletedAt: string | null };
}
export interface JobList { items: JobWithAsset[]; counts: Partial<Record<JobStatus, number>> }

export interface ShareLink {
  id: string; token: string; path: string; hasPassword: boolean; allowDownload: boolean;
  expiresAt: string | null; revokedAt: string | null; viewCount: number; lastViewedAt: string | null;
  createdAt: string; targetType: 'asset' | 'collection'; targetName: string;
}
export interface PublicShareItem {
  id: string; name: string; kind: AssetKind; mimeType: string; width: number | null; height: number | null;
  durationMs: number | null; dominantColor: string | null; thumbnailUrl: string | null; viewUrl: string; downloadUrl: string | null;
}
export interface PublicShare { type: 'asset' | 'collection'; title: string; allowDownload: boolean; expiresAt: string | null; items: PublicShareItem[] }

export interface ActivityEntry {
  id: string; action: string; entityType: string; entityId: string | null; entityName: string | null;
  meta: Record<string, unknown> | null; createdAt: string;
}
export interface ActivityPage { items: ActivityEntry[]; nextCursor: string | null }
export interface Usage {
  usedBytes: number; quotaBytes: number; trashBytes: number;
  counts: { total: number; trashed: number; images: number; videos: number };
  breakdown: { imageBytes: number; videoBytes: number };
}

export interface AdminStats {
  totalAssets: number;
  assetsByStatus: Record<string, number>;
  jobsByStatus: Record<string, number>;
  queueDepths: Record<string, number>;
  deadLetterDepths: Record<string, number>;
  activeWorkers: Record<string, number>;
  averageProcessingTimeMs: number | null;
  p95ProcessingTimeMs: number | null;
  retryCount: number;
  deadLetterJobCount: number;
}
export interface AdminUser {
  id: string; email: string; displayName: string | null; role: Role; createdAt: string;
  storageQuotaBytes: number; usedBytes: number; assetCount: number;
}
export interface FailedJob {
  id: string; assetId: string; type: JobType; status: JobStatus; attempt: number; failureReason: string | null;
  updatedAt: string; asset: { fileName: string; ownerId: string };
}

export interface ListFilters {
  q?: string; kind?: AssetKind; status?: AssetStatus; favorite?: boolean; trashed?: boolean;
  collectionId?: string; tag?: string; sort?: 'createdAt' | 'updatedAt' | 'fileName' | 'fileSize'; order?: 'asc' | 'desc';
}
export type BulkAction = 'trash' | 'restore' | 'delete' | 'favorite' | 'unfavorite' | 'addToCollection' | 'removeFromCollection' | 'addTags';
export type RequestableType = 'IMAGE_RESIZE' | 'IMAGE_COMPRESS' | 'IMAGE_FORMAT_CONVERT' | 'VIDEO_TRANSCODE' | 'VIDEO_PREVIEW';
