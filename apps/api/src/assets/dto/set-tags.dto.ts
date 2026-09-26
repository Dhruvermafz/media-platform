import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class SetTagsDto {
  @ApiProperty({ type: [String], description: 'The complete tag list for the asset (replaces existing tags)' })
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  tags!: string[];
}
