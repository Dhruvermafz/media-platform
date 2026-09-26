import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { TagsService } from './tags.service';

class RenameTagDto {
  @IsString() @IsNotEmpty() @MaxLength(32)
  name!: string;
}

@ApiTags('tags')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get() @ApiOperation({ summary: 'All tags with usage counts' })
  list(@CurrentUser() u: RequestUser) { return this.tags.list(u.userId); }

  @Patch(':id') @ApiOperation({ summary: 'Rename a tag everywhere it is used' })
  rename(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameTagDto) { return this.tags.rename(u.userId, id, dto.name); }

  @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) @ApiOperation({ summary: 'Delete a tag (removes it from all assets)' })
  remove(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string) { return this.tags.remove(u.userId, id); }
}
