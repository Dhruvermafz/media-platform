import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ConfirmUploadDto {
  @ApiProperty({ description: 'storageKey returned by POST /assets/upload-url' })
  @IsNotEmpty()
  storageKey!: string;

  @ApiProperty({ example: 'vacation.mp4' })
  @IsNotEmpty()
  fileName!: string;

  @ApiProperty({ example: 'video/mp4' })
  @IsNotEmpty()
  mimeType!: string;

  @ApiPropertyOptional({ description: 'Add the new asset to this collection' })
  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];
}
