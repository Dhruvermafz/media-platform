import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { SharesService } from './shares.service';
import { CreateShareDto } from './shares.dto';

@ApiTags('shares')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('shares')
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Post() @ApiOperation({ summary: 'Create a public link to an asset or collection' })
  create(@CurrentUser() u: RequestUser, @Body() dto: CreateShareDto) { return this.shares.create(u.userId, dto); }

  @Get() @ApiOperation({ summary: 'List your share links (optionally for one target)' })
  list(@CurrentUser() u: RequestUser, @Query('assetId') assetId?: string, @Query('collectionId') collectionId?: string) {
    return this.shares.list(u.userId, { assetId, collectionId });
  }

  @Delete(':id') @HttpCode(HttpStatus.NO_CONTENT) @ApiOperation({ summary: 'Revoke a link immediately' })
  revoke(@CurrentUser() u: RequestUser, @Param('id', ParseUUIDPipe) id: string) { return this.shares.revoke(u.userId, id); }
}

/** Unauthenticated. Throttled per client IP by RateLimitGuard, with an
 * additional wrong-password limiter inside SharesService. */
@ApiTags('public')
@UseGuards(RateLimitGuard)
@Controller('public/shares')
export class PublicSharesController {
  constructor(private readonly shares: SharesService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Open a share link (send the password in the x-share-password header if required)' })
  async view(
    @Param('token') token: string,
    @Headers('x-share-password') password: string | undefined,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Contains presigned URLs and a revocable capability: never cache.
    res.setHeader('Cache-Control', 'no-store');
    return this.shares.view(token, password, ip);
  }
}
