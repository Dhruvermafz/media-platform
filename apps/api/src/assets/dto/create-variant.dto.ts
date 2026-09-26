import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, Max, Min } from 'class-validator';

/** Renditions a user may request on demand (the default set is created at upload). */
export const REQUESTABLE_TYPES = [
  'IMAGE_RESIZE', 'IMAGE_COMPRESS', 'IMAGE_FORMAT_CONVERT', 'VIDEO_TRANSCODE', 'VIDEO_PREVIEW',
] as const;
export type RequestableType = (typeof REQUESTABLE_TYPES)[number];

export class CreateVariantDto {
  @ApiProperty({ enum: REQUESTABLE_TYPES })
  @IsIn([...REQUESTABLE_TYPES])
  type!: RequestableType;

  @ApiPropertyOptional({
    description:
      'IMAGE_RESIZE {width 64-8000} | IMAGE_COMPRESS {quality 10-100} | IMAGE_FORMAT_CONVERT {format webp|jpeg|png|avif} | ' +
      'VIDEO_TRANSCODE {resolution 1080p|720p|480p|360p} | VIDEO_PREVIEW {startSeconds, durationSeconds 1-30}',
  })
  @IsOptional() @IsObject()
  params?: Record<string, unknown>;
}

// Kept beside the DTO so the whitelist and the docs above can't drift apart.
export function sanitizeVariantParams(type: RequestableType, raw: Record<string, unknown> = {}): Record<string, unknown> {
  const int = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Number(v ?? dflt);
    if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`must be an integer between ${min} and ${max}`);
    return n;
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => {
    const s = String(v ?? dflt);
    if (!allowed.includes(s as T)) throw new RangeError(`must be one of: ${allowed.join(', ')}`);
    return s as T;
  };
  switch (type) {
    case 'IMAGE_RESIZE': return { width: int(raw.width, 64, 8000, 1024) };
    case 'IMAGE_COMPRESS': return { quality: int(raw.quality, 10, 100, 75) };
    case 'IMAGE_FORMAT_CONVERT': return { format: oneOf(raw.format, ['webp', 'jpeg', 'png', 'avif'] as const, 'webp') };
    case 'VIDEO_TRANSCODE': return { resolution: oneOf(raw.resolution, ['1080p', '720p', '480p', '360p'] as const, '720p') };
    case 'VIDEO_PREVIEW':
      return { startSeconds: int(raw.startSeconds, 0, 86_400, 0), durationSeconds: int(raw.durationSeconds, 1, 30, 5) };
  }
}
