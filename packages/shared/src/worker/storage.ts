import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function s3ConfigFromEnv(): S3Config {
  return {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
    bucket: process.env.S3_BUCKET ?? 'media-platform',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  };
}

/** Same bucket, same key scheme as the API's StorageService, but
 * deliberately a separate small client rather than a shared Nest
 * service — workers are plain Node processes with no DI container. */
export class WorkerStorage {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor(private readonly config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async downloadToBuffer(storageKey: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Streams an object straight to disk without holding it in memory.
   * downloadToBuffer() above cannot handle large videos (a Node Buffer
   * tops out near 2-4 GiB, and uploads are allowed up to 5 GiB), so
   * anything that can be handed to a CLI tool as a path should use this. */
  async downloadToFile(storageKey: string, destPath: string): Promise<void> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }

  async upload(storageKey: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: body, ContentType: mimeType }),
    );
  }

  variantKey(assetId: string, variantName: string): string {
    return `variants/${assetId}/${variantName}`;
  }
}
