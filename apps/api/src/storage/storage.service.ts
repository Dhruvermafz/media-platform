import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Download URLs are signed against a *bucketed* timestamp instead of "now".
 *
 * A presigned URL embeds its signing time (X-Amz-Date), so signing at the
 * exact current second gives every API response a brand-new URL for the
 * same object. Browsers key their cache on the full URL, so a thumbnail
 * would be re-downloaded on every list refresh, which with real-time
 * updates means constantly. Rounding the signing time down to a 30-minute
 * boundary makes the URL identical for everyone within that window, so the
 * browser HTTP cache (and the CDN, if you add one) actually works.
 *
 * Validity: a URL signed at the start of its bucket and valid for 3 hours
 * is still valid for at least 2.5 hours when handed out, well beyond
 * any UI session's need to display an image.
 */
const DOWNLOAD_SIGNING_BUCKET_SECONDS = 30 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 3 * 60 * 60;

export interface DownloadUrlOptions {
  /** Force a browser "Save as" with this file name instead of inline display. */
  attachmentFileName?: string;
}

/**
 * Thin wrapper over the S3 API so the rest of the app never imports
 * @aws-sdk/client-s3 directly. Works against MinIO locally and AWS S3 (or
 * any S3-compatible provider) in production purely through env vars —
 * see migration.md "Object Storage Setup". No branching on environment
 * anywhere in this class.
 *
 * Two clients on purpose: `client` talks to storage from inside the
 * cluster (HEAD/DELETE/LIST), while `presignClient` signs URLs that a
 * *browser* will call. In docker-compose those are different hostnames
 * (minio:9000 vs localhost:9000); in production they are usually the same.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const s3Config = this.config.get('s3')!;
    this.bucket = s3Config.bucket;
    const credentials = { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey };
    const common = { region: s3Config.region, forcePathStyle: s3Config.forcePathStyle, credentials };
    this.client = new S3Client({ ...common, endpoint: s3Config.endpoint });
    this.presignClient = new S3Client({ ...common, endpoint: s3Config.publicEndpoint });
  }

  /** Dev convenience only: ensures the bucket exists on local MinIO so
   * `docker compose up` gives a working environment with zero manual
   * console clicking. In production the bucket is created once via the
   * migration.md runbook, not auto-created by the app on boot. */
  async onModuleInit() {
    if (this.config.get('nodeEnv') !== 'production') {
      await this.ensureDevBucket();
    }
  }

  private async ensureDevBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created dev bucket "${this.bucket}" on ${this.config.get('s3').endpoint}`);
      } catch (err) {
        this.logger.warn(`Could not auto-create dev bucket: ${(err as Error).message}`);
        return;
      }
      // MinIO handles CORS server-wide and answers PutBucketCors with
      // NotImplemented; real S3 needs it (video playback needs Range).
      await this.client
        .send(
          new PutBucketCorsCommand({
            Bucket: this.bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedMethods: ['GET', 'HEAD', 'PUT'],
                  AllowedOrigins: ['*'],
                  AllowedHeaders: ['*'],
                  ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
                },
              ],
            },
          }),
        )
        .catch(() => undefined);
    }
  }

  buildStorageKey(userId: string, fileName: string): string {
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `uploads/${userId}/${randomUUID()}-${safe}`;
  }

  buildVariantKey(assetId: string, variantName: string): string {
    return `variants/${assetId}/${variantName}`;
  }

  async getPresignedUploadUrl(storageKey: string, mimeType: string): Promise<{ url: string; expiresIn: number }> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, ContentType: mimeType });
    const url = await getSignedUrl(this.presignClient, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return { url, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  /** Cache-stable, browser-reachable GET URL. See DOWNLOAD_SIGNING_BUCKET_SECONDS. */
  async getPresignedDownloadUrl(storageKey: string, opts: DownloadUrlOptions = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ...(opts.attachmentFileName
        ? { ResponseContentDisposition: contentDisposition(opts.attachmentFileName) }
        : {}),
    });
    const bucketMs = DOWNLOAD_SIGNING_BUCKET_SECONDS * 1000;
    const signingDate = new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
    return getSignedUrl(this.presignClient, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS, signingDate });
  }

  /** Confirms the client actually finished the presigned PUT before we
   * flip an asset's status away from UPLOADING. Cheap HEAD, no body transfer. */
  async objectExists(storageKey: string): Promise<{ exists: boolean; size?: number }> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }));
      return { exists: true, size: res.ContentLength };
    } catch {
      return { exists: false };
    }
  }

  async deleteObject(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }

  async putObject(storageKey: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: body, ContentType: mimeType }),
    );
  }

  /** One page of a prefix listing (used by the orphan-upload sweep). */
  async listObjects(
    prefix: string,
    continuationToken?: string,
    maxKeys = 500,
  ): Promise<{ objects: Array<{ key: string; size: number; lastModified: Date }>; nextToken?: string }> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: maxKeys,
      }),
    );
    return {
      objects: (res.Contents ?? []).map((o) => ({
        key: o.Key!,
        size: o.Size ?? 0,
        lastModified: o.LastModified ?? new Date(),
      })),
      nextToken: res.IsTruncated ? res.NextContinuationToken : undefined,
    };
  }
}

/** RFC 6266 header with an ASCII fallback plus a UTF-8 `filename*`, so
 * names like "Réunion été.mp4" survive the round trip. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
