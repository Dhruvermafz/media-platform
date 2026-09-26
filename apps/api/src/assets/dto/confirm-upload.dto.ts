import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

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
}
