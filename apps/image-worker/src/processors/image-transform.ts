import sharp from 'sharp';
import { JobType } from '@media-platform/shared';

export interface TransformResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  variantName: string; // file name used to build the storage key
}

/**
 * One function per JobType this worker handles, all sharing the same
 * shape so the caller (main.ts) doesn't need a switch of its own beyond
 * picking which function to call.
 */
export async function transform(
  type: JobType,
  input: Buffer,
  params: Record<string, unknown>,
): Promise<TransformResult> {
  switch (type) {
    case JobType.IMAGE_THUMBNAIL:
      return thumbnail(input, params);
    case JobType.IMAGE_RESIZE:
      return resize(input, params);
    case JobType.IMAGE_COMPRESS:
      return compress(input, params);
    case JobType.IMAGE_FORMAT_CONVERT:
      return formatConvert(input, params);
    default:
      throw new Error(`image-worker cannot handle job type ${type}`);
  }
}

async function thumbnail(input: Buffer, params: Record<string, unknown>): Promise<TransformResult> {
  const width = Number(params.width ?? 320);
  const height = Number(params.height ?? 320);
  const buffer = await sharp(input).rotate().resize(width, height, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, mimeType: 'image/jpeg', width: meta.width ?? width, height: meta.height ?? height, variantName: `thumbnail_${width}x${height}.jpg` };
}

async function resize(input: Buffer, params: Record<string, unknown>): Promise<TransformResult> {
  const width = Number(params.width ?? 1024);
  const buffer = await sharp(input).rotate().resize({ width, withoutEnlargement: true }).toBuffer();
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    mimeType: `image/${meta.format ?? 'jpeg'}`,
    width: meta.width ?? width,
    height: meta.height ?? 0,
    variantName: `resize_${width}w.${meta.format ?? 'jpg'}`,
  };
}

async function compress(input: Buffer, params: Record<string, unknown>): Promise<TransformResult> {
  const quality = Number(params.quality ?? 75);
  const meta0 = await sharp(input).metadata();
  const format = meta0.format === 'png' ? 'png' : 'jpeg';
  const pipeline = sharp(input).rotate();
  const buffer =
    format === 'png' ? await pipeline.png({ quality, compressionLevel: 9 }).toBuffer() : await pipeline.jpeg({ quality }).toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, mimeType: `image/${format}`, width: meta.width ?? 0, height: meta.height ?? 0, variantName: `compressed_q${quality}.${format}` };
}

async function formatConvert(input: Buffer, params: Record<string, unknown>): Promise<TransformResult> {
  const targetFormat = String(params.format ?? 'webp') as 'webp' | 'jpeg' | 'png' | 'avif';
  const buffer = await sharp(input).rotate().toFormat(targetFormat).toBuffer();
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    mimeType: `image/${targetFormat}`,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    variantName: `converted.${targetFormat}`,
  };
}
