import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { AssetsService } from './assets.service';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { ListAssetsQueryDto } from './dto/list-assets.query.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { SetTagsDto } from './dto/set-tags.dto';
import { BulkAssetsDto } from './dto/bulk-assets.dto';
import { CreateVariantDto } from './dto/create-variant.dto';

@ApiTags('assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post('upload-url')
  @ApiOperation({ summary: 'Get a presigned URL to PUT the file directly to object storage (checks quota)' })
  createUploadUrl(@CurrentUser() user: RequestUser, @Body() dto: CreateUploadUrlDto) {
    return this.assets.createUploadUrl(user.userId, dto);
  }

  @Post()
  @ApiOperation({ summary: 'Confirm an upload finished and register the asset; enqueues processing jobs' })
  confirmUpload(@CurrentUser() user: RequestUser, @Body() dto: ConfirmUploadDto) {
    return this.assets.confirmUpload(user.userId, dto);
  }

  // NOTE: literal routes (`bulk`) must be declared before `:id` routes.
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply one action to up to 200 assets (trash, restore, favorite, collections, tags, delete)' })
  bulk(@CurrentUser() user: RequestUser, @Body() dto: BulkAssetsDto) {
    return this.assets.bulk(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user\'s assets with search, filters and sorting' })
  findAll(@CurrentUser() user: RequestUser, @Query() query: ListAssetsQueryDto) {
    return this.assets.findAll(user.userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get asset details: variants, metadata, tags, collections' })
  findOne(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.findOne(user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, describe or (un)favourite an asset' })
  update(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssetDto) {
    return this.assets.update(user.userId, id, dto);
  }

  @Put(':id/tags')
  @ApiOperation({ summary: 'Replace the asset\'s tags' })
  setTags(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetTagsDto) {
    return this.assets.setTags(user.userId, id, dto.tags);
  }

  @Post(':id/trash')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Move to trash (kept until TRASH_RETENTION_DAYS, then purged)' })
  trash(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.trash(user.userId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Restore from trash' })
  restore(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.restore(user.userId, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Presigned attachment URL for the original (or a variant via ?variantId=)' })
  download(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Query('variantId') variantId?: string) {
    return this.assets.getDownload(user.userId, id, variantId);
  }

  @Post(':id/variants')
  @ApiOperation({ summary: 'Request an extra rendition (resize, format convert, transcode, preview clip)' })
  requestVariant(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateVariantDto) {
    return this.assets.requestVariant(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Permanently delete an asset and all its variants (irreversible; use /trash to keep a copy)' })
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.permanentlyDelete(user.userId, id);
  }
}
