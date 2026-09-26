import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

/**
 * Thin wrapper over the S3 API so the rest of the app never imports
 * @aws-sdk/client-s3 directly. Works against MinIO locally and AWS S3 (or
 * any S3-compatible provider) in production purely through env vars —
 * see migration.md "Object Storage Setup". No branching on environment
 * anywhere in this class.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const s3Config = this.config.get('s3')!;
    this.bucket = s3Config.bucket;
    this.client = new S3Client({
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      forcePathStyle: s3Config.forcePathStyle, // required for MinIO; harmless on AWS
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });
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
        await this.client.send(
          new PutBucketCorsCommand({
            Bucket: this.bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedMethods: ['GET', 'PUT', 'POST'],
                  AllowedOrigins: ['*'],
                  AllowedHeaders: ['*'],
                },
              ],
            },
          }),
        );
        this.logger.log(`Created dev bucket "${this.bucket}" on ${this.config.get('s3').endpoint}`);
      } catch (err) {
        this.logger.warn(`Could not auto-create dev bucket: ${(err as Error).message}`);
      }
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
    const url = await getSignedUrl(this.client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return { url, expiresIn: UPLOAD_URL_TTL_SECONDS };
  }

  async getPresignedDownloadUrl(storageKey: string): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: storageKey });
    return getSignedUrl(this.client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
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
}
