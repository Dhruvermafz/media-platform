import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { JobType } from '@media-platform/shared';

export interface ThumbnailResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  variantName: string;
}

export async function transform(
  type: JobType,
  input: Buffer,
  params: Record<string, unknown>,
): Promise<ThumbnailResult> {
  if (type !== JobType.VIDEO_THUMBNAIL) {
    throw new Error(`thumbnail-worker cannot handle job type ${type}`);
  }
  const atSeconds = Number(params.atSeconds ?? 1);
  const width = Number(params.width ?? 640);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-worker-'));
  const inputPath = path.join(dir, `in-${randomUUID()}`);
  const outputPath = path.join(dir, `out-${randomUUID()}.jpg`);
  try {
    await fs.writeFile(inputPath, input);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .on('error', reject)
        .on('end', () => resolve())
        .screenshots({
          timestamps: [atSeconds],
          filename: path.basename(outputPath),
          folder: dir,
          size: `${width}x?`,
        });
    });
    const buffer = await fs.readFile(outputPath);
    return { buffer, mimeType: 'image/jpeg', width, height: 0, variantName: `frame_${atSeconds}s.jpg` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
