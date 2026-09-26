import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobStatus } from '@media-platform/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get('jobs')
  @ApiOperation({ summary: 'Recent processing jobs across the caller\'s assets, with counts by status' })
  list(@CurrentUser() user: RequestUser, @Query('status') status?: JobStatus, @Query('limit') limit?: string) {
    return this.jobs.list(user.userId, {
      status: Object.values(JobStatus).includes(status as JobStatus) ? status : undefined,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
  }

  @Get('assets/:id/jobs')
  @ApiOperation({ summary: 'List processing jobs for an asset' })
  findForAsset(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) assetId: string) {
    return this.jobs.findForAsset(user.userId, assetId);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get a single job, including failure reason and attempt count' })
  findOne(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.findOne(user.userId, id);
  }

  @Post('jobs/:id/retry')
  @ApiOperation({ summary: 'Manually retry a FAILED or DEAD_LETTER job' })
  retry(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.retry(user.userId, id);
  }
}
