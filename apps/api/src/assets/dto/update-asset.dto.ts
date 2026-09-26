import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAssetDto {
  @ApiPropertyOptional({ description: 'Display name. Empty string clears it (falls back to the file name).' })
  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Empty string clears it.' })
  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isFavorite?: boolean;
}
