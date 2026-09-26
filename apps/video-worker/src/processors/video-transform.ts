import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { JobType } from '@media-platform/shared';

export interface VideoTransformResult {
  buffer: Buffer;
  mimeType: string;
  durationMs?: number;
  variantName: string;
}

const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
  '360p': { width: 640, height: 360 },
};

export async function transform(
  type: JobType,
  input: Buffer,
  params: Record<string, unknown>,
): Promise<VideoTransformResult> {
  switch (type) {
    case JobType.VIDEO_TRANSCODE:
      return transcode(input, params);
    case JobType.VIDEO_PREVIEW:
      return preview(input, params);
    default:
      throw new Error(`video-worker cannot handle job type ${type}`);
  }
}

async function withTempFiles<T>(input: Buffer, fn: (inputPath: string, outputPath: string) => Promise<T>, ext: string): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-worker-'));
  const inputPath = path.join(dir, `in-${randomUUID()}`);
  const outputPath = path.join(dir, `out-${randomUUID()}.${ext}`);
  try {
    await fs.writeFile(inputPath, input);
    return await fn(inputPath, outputPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function transcode(input: Buffer, params: Record<string, unknown>): Promise<VideoTransformResult> {
  const resolutionKey = String(params.resolution ?? '720p');
  const target = RESOLUTIONS[resolutionKey] ?? RESOLUTIONS['720p'];

  const { buffer, durationMs } = await withTempFiles(
    input,
    (inputPath, outputPath) =>
      new Promise<{ buffer: Buffer; durationMs: number }>((resolve, reject) => {
        let durationMs = 0;
        ffmpeg(inputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .size(`${target.width}x${target.height}`)
          .outputOptions(['-preset veryfast', '-movflags +faststart'])
          .on('codecData', (data) => {
            durationMs = parseDurationToMs(data.duration);
          })
          .on('error', reject)
          .on('end', async () => {
            const buffer = await fs.readFile(outputPath);
            resolve({ buffer, durationMs });
          })
          .save(outputPath);
      }),
    'mp4',
  );

  return { buffer, mimeType: 'video/mp4', durationMs, variantName: `${resolutionKey}.mp4` };
}

async function preview(input: Buffer, params: Record<string, unknown>): Promise<VideoTransformResult> {
  const durationSeconds = Number(params.durationSeconds ?? 5);
  const startSeconds = Number(params.startSeconds ?? 0);

  const buffer = await withTempFiles(
    input,
    (inputPath, outputPath) =>
      new Promise<Buffer>((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(startSeconds)
          .duration(durationSeconds)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions(['-preset veryfast', '-movflags +faststart'])
          .on('error', reject)
          .on('end', async () => resolve(await fs.readFile(outputPath)))
          .save(outputPath);
      }),
    'mp4',
  );

  return { buffer, mimeType: 'video/mp4', durationMs: durationSeconds * 1000, variantName: `preview_${durationSeconds}s.mp4` };
}

function parseDurationToMs(duration: string): number {
  // fluent-ffmpeg's codecData.duration is "HH:MM:SS.ms"
  const [h, m, s] = duration.split(':').map(Number);
  if ([h, m, s].some(Number.isNaN)) return 0;
  return Math.round((h * 3600 + m * 60 + s) * 1000);
}
