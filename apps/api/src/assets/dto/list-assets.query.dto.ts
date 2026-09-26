import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const SORT_FIELDS = ['createdAt', 'updatedAt', 'fileName', 'fileSize'] as const;

/**
 * Query parameters for GET /assets. Booleans are declared as 'true'|'false'
 * strings on purpose: class-transformer's implicit conversion would turn the
 * string "false" into boolean true (Boolean("false")).
 */
export class ListAssetsQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search over name, title, description and tags' })
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['IMAGE', 'VIDEO'] })
  @IsOptional() @IsIn(['IMAGE', 'VIDEO'])
  kind?: 'IMAGE' | 'VIDEO';

  @ApiPropertyOptional({ enum: ['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED'] })
  @IsOptional() @IsIn(['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED'])
  status?: 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional() @IsIn(['true', 'false'])
  favorite?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'true = list the trash instead of the library' })
  @IsOptional() @IsIn(['true', 'false'])
  trashed?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional({ description: 'Tag name' }) @IsOptional() @IsString() @MaxLength(40)
  tag?: string;

  @ApiPropertyOptional({ enum: SORT_FIELDS }) @IsOptional() @IsIn([...SORT_FIELDS])
  sort?: (typeof SORT_FIELDS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'] }) @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number;
}
