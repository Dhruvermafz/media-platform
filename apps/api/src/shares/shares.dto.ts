import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateShareDto {
  @ApiPropertyOptional({ description: 'Share a single asset (exactly one of assetId / collectionId)' })
  @IsOptional() @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ description: 'Share a whole collection' })
  @IsOptional() @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional({ description: 'Hours until the link expires; omit for no expiry', maximum: 8760 })
  @IsOptional() @IsInt() @Min(1) @Max(8760)
  expiresInHours?: number;

  @ApiPropertyOptional({ description: 'Require this password to open the link' })
  @IsOptional() @IsString() @MinLength(4) @MaxLength(72)
  password?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional() @IsBoolean()
  allowDownload?: boolean;
}
