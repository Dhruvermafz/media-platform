import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, Matches, Max } from 'class-validator';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];

export class CreateUploadUrlDto {
  @ApiProperty({ example: 'vacation.mp4' })
  @IsNotEmpty()
  @Matches(/^[^/\\]+$/, { message: 'fileName must not contain path separators' })
  fileName!: string;

  @ApiProperty({ example: 'video/mp4' })
  @IsNotEmpty()
  @Matches(/^(image|video)\/[\w.+-]+$/, {
    message: `mimeType must start with one of: ${ALLOWED_MIME_PREFIXES.join(', ')}`,
  })
  mimeType!: string;

  @ApiProperty({ example: 52428800, description: 'File size in bytes' })
  @IsInt()
  @IsPositive()
  @Max(MAX_FILE_SIZE_BYTES)
  fileSize!: number;
}
