import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssetStatus } from '@media-platform/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { AssetsService } from './assets.service';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';

@ApiTags('assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Get a presigned URL to PUT the file directly to object storage' })
  createUploadUrl(@CurrentUser() user: RequestUser, @Body() dto: CreateUploadUrlDto) {
    return this.assets.createUploadUrl(user.userId, dto);
  }

  @Post()
  @ApiOperation({ summary: 'Confirm an upload finished and register the asset; enqueues processing jobs' })
  confirmUpload(@CurrentUser() user: RequestUser, @Body() dto: ConfirmUploadDto) {
    return this.assets.confirmUpload(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user\'s assets' })
  findAll(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: AssetStatus,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.assets.findAll(user.userId, {
      status,
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get asset details including ready variants' })
  findOne(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.assets.findOne(user.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an asset and its variants' })
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.assets.remove(user.userId, id);
  }
}
