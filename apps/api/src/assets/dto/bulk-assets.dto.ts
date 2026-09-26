import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export const BULK_ACTIONS = [
  'trash', 'restore', 'delete', 'favorite', 'unfavorite', 'addToCollection', 'removeFromCollection', 'addTags',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export class BulkAssetsDto {
  @ApiProperty({ type: [String], maximum: 200 })
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @IsUUID('all', { each: true })
  ids!: string[];

  @ApiProperty({ enum: BULK_ACTIONS })
  @IsIn([...BULK_ACTIONS])
  action!: BulkAction;

  @ApiPropertyOptional({ description: 'Required for addToCollection / removeFromCollection' })
  @IsOptional() @IsUUID()
  collectionId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Required for addTags' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  tags?: string[];
}
