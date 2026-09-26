import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto, UpdateCollectionDto } from './collections.dto';

/** Membership is managed through POST /assets/bulk (addToCollection /
 * removeFromCollection) and the collectionId field on upload confirm; list a
 * collection's items with GET /assets?collectionId=. */
@ApiTags('collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get() @ApiOperation({ summary: 'List collections with item counts and cover thumbnails' })
  list(@CurrentUser() u: RequestUser) { return this.collections.list(u.userId); }

  @Post() @ApiOperation({ summary: 'Create a collection' })
  create(@CurrentUser() u: RequestUser, @Body() dto: CreateCollectionDto) { return this.collections.create(u.userId, dto); }

  @Get(':id') @ApiOperation({ summary: 'Get one collection' })
  get(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string) { return this.collections.get(u.userId, id); }

  @Patch(':id') @ApiOperation({ summary: 'Rename / describe a collection' })
  update(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCollectionDto) { return this.collections.update(u.userId, id, dto); }

  @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) @ApiOperation({ summary: 'Delete a collection (its assets are kept)' })
  remove(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string) { return this.collections.remove(u.userId, id); }
}
