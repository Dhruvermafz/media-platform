import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'at-least-8-characters', minLength: 8 })
  @MinLength(8)
  // bcrypt silently ignores everything past 72 bytes; reject rather than
  // let two different long passwords hash identically.
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({ example: 'Ada' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;
}
