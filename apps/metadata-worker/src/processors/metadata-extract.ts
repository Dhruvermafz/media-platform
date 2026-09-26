import exifr from 'exifr';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';

export interface MetadataResult {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  dominantColor: string | null;
  capturedAt: Date | null;
  metadata: Record<string, unknown>;
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * Privacy: GPS coordinates are deliberately NOT extracted or stored. Photos
 * routinely embed the exact location of someone's home; a media library
 * that surfaces (or shares, see public links) that by default is a
 * liability. Camera settings and capture time are kept.
 */
export async function extractImageMetadata(input: Buffer): Promise<MetadataResult> {
  const meta = await sharp(input).metadata();
  // EXIF orientation 5-8 means the stored pixels are rotated 90 degrees
  // relative to how the image is displayed, so width/height must swap.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? null;
  const height = (rotated ? meta.width : meta.height) ?? null;

  // Downscale first: computing stats on a 40 MP original is needlessly slow.
  const { dominant } = await sharp(input).rotate().resize(64, 64, { fit: 'inside' }).stats();
  const dominantColor = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;

  let exif: Record<string, any> | undefined;
  try {
    exif = await exifr.parse(input, {
      gps: false,
      tiff: true,
      exif: true,
      ifd1: false,
      interop: false,
      pick: ['Make', 'Model', 'LensModel', 'DateTimeOriginal', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength'],
    });
  } catch {
    // Unreadable/absent EXIF is normal (PNGs, screenshots, stripped files).
  }

  const capturedAt = exif?.DateTimeOriginal instanceof Date && !Number.isNaN(exif.DateTimeOriginal.getTime()) ? exif.DateTimeOriginal : null;
  const metadata: Record<string, unknown> = {
    format: meta.format,
    colorSpace: meta.space,
    hasAlpha: meta.hasAlpha ?? false,
    density: meta.density ?? null,
    pages: meta.pages ?? 1,
    camera: exif?.Make || exif?.Model ? [exif.Make, exif.Model].filter(Boolean).join(' ').trim() : null,
    lens: exif?.LensModel ?? null,
    exposure: exif?.ExposureTime ? `1/${Math.round(1 / exif.ExposureTime)}` : null,
    aperture: exif?.FNumber ? `f/${Number(exif.FNumber).toFixed(1).replace(/\.0$/, '')}` : null,
    iso: exif?.ISO ?? null,
    focalLengthMm: exif?.FocalLength ? Math.round(exif.FocalLength) : null,
  };
  return { width, height, durationMs: null, dominantColor, capturedAt, metadata };
}

export function probe(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data))));
}

/** "30000/1001" -> 29.97 ; "0/0" -> null */
export function parseFrameRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 100) / 100;
}

export function summarizeProbe(data: ffmpeg.FfprobeData): MetadataResult {
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('No video stream found in file');

  // Phone footage is often stored landscape with a rotation flag; swap so
  // the reported size matches what players display.
  const rotation = Math.abs(Number((v.tags as any)?.rotate ?? (v as any).side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? 0));
  const swap = rotation === 90 || rotation === 270;
  const w = v.width ?? null;
  const h = v.height ?? null;

  const durationSec = Number(data.format.duration ?? v.duration);
  const created = (data.format.tags as any)?.creation_time;
  const capturedAt = created && !Number.isNaN(Date.parse(created)) ? new Date(created) : null;
  const bitRate = Number(data.format.bit_rate);

  return {
    width: swap ? h : w,
    height: swap ? w : h,
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
    dominantColor: null,
    capturedAt,
    metadata: {
      container: data.format.format_name ?? null,
      videoCodec: v.codec_name ?? null,
      audioCodec: a?.codec_name ?? null,
      audioChannels: a?.channels ?? null,
      fps: parseFrameRate(v.avg_frame_rate) ?? parseFrameRate(v.r_frame_rate),
      bitrateKbps: Number.isFinite(bitRate) && bitRate > 0 ? Math.round(bitRate / 1000) : null,
      rotation: rotation || 0,
      hasAudio: Boolean(a),
    },
  };
}

export async function extractVideoMetadata(filePath: string): Promise<MetadataResult> {
  return summarizeProbe(await probe(filePath));
}
