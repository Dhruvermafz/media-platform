import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { ActivityService } from './activity.service';

@ApiTags('activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @ApiOperation({ summary: 'Recent account activity, newest first (cursor-paginated)' })
  list(@CurrentUser() user: RequestUser, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.activity.list(user.userId, limit ? parseInt(limit, 10) || 50 : 50, cursor);
  }
}
