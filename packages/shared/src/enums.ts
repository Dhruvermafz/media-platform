/**
 * Asset lifecycle — set once on upload, then transitions as processing
 * jobs for that asset complete.
 */
export enum AssetStatus {
  UPLOADING = 'UPLOADING', // presigned URL issued, file not confirmed yet
  UPLOADED = 'UPLOADED', // file confirmed present in object storage
  PROCESSING = 'PROCESSING', // at least one job in flight
  READY = 'READY', // all required jobs completed
  FAILED = 'FAILED', // a required job hit DEAD_LETTER
}

/**
 * Job state machine (see docs/architecture.md for the diagram).
 *
 *   PENDING -> PROCESSING -> COMPLETED
 *                  |
 *                  +-> FAILED -> RETRY -> PROCESSING (loop)
 *                                  |
 *                                  +-> DEAD_LETTER (after max attempts)
 */
export enum JobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  RETRY = 'RETRY',
  DEAD_LETTER = 'DEAD_LETTER',
}

export enum JobType {
  IMAGE_THUMBNAIL = 'IMAGE_THUMBNAIL',
  IMAGE_RESIZE = 'IMAGE_RESIZE',
  IMAGE_COMPRESS = 'IMAGE_COMPRESS',
  IMAGE_FORMAT_CONVERT = 'IMAGE_FORMAT_CONVERT',
  VIDEO_TRANSCODE = 'VIDEO_TRANSCODE',
  VIDEO_THUMBNAIL = 'VIDEO_THUMBNAIL',
  VIDEO_PREVIEW = 'VIDEO_PREVIEW',
  /** Extracts dimensions, duration, EXIF/codec info and a dominant colour
   * onto the asset row itself. Unlike every other job type it produces no
   * variant file - see JobStore.completeMetadataJob. */
  METADATA_EXTRACT = 'METADATA_EXTRACT',
}

export enum WorkerKind {
  IMAGE = 'image-worker',
  VIDEO = 'video-worker',
  THUMBNAIL = 'thumbnail-worker',
  METADATA = 'metadata-worker',
}

/** Which worker kind handles which job type. Single source of truth so
 * routing logic in the API and the consumer-group name in each worker
 * can never silently drift apart. */
export const JOB_TYPE_TO_WORKER: Record<JobType, WorkerKind> = {
  [JobType.IMAGE_THUMBNAIL]: WorkerKind.IMAGE,
  [JobType.IMAGE_RESIZE]: WorkerKind.IMAGE,
  [JobType.IMAGE_COMPRESS]: WorkerKind.IMAGE,
  [JobType.IMAGE_FORMAT_CONVERT]: WorkerKind.IMAGE,
  [JobType.VIDEO_TRANSCODE]: WorkerKind.VIDEO,
  [JobType.VIDEO_PREVIEW]: WorkerKind.VIDEO,
  [JobType.VIDEO_THUMBNAIL]: WorkerKind.THUMBNAIL,
  [JobType.METADATA_EXTRACT]: WorkerKind.METADATA,
};

export enum AssetKind {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
}
