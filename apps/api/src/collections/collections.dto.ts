import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCollectionDto {
  @ApiProperty({ example: 'Lisbon trip' })
  @IsString() @IsNotEmpty() @MaxLength(80)
  name!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  description?: string;
}

export class UpdateCollectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'Empty string clears it' }) @IsOptional() @IsString() @MaxLength(500)
  description?: string;
}
