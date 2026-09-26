import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../common/roles/roles.decorator';
import { RolesGuard } from '../common/roles/roles.guard';
import { JobsService } from '../jobs/jobs.service';
import { AdminService } from './admin.service';

class UpdateUserDto {
  @IsOptional() @IsIn(['USER', 'ADMIN'])
  role?: Role;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  storageQuotaBytes?: number;
}

/**
 * Admin-only (RolesGuard). Previously any signed-in user could open these
 * endpoints - the "no RBAC" gap called out in docs/decisions.md.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly jobs: JobsService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate counts for the operations dashboard' })
  getStats() {
    return this.admin.getStats();
  }

  @Get('jobs/failed')
  @ApiOperation({ summary: 'Recent FAILED/DEAD_LETTER jobs for inspection' })
  getFailedJobs(@Query('limit') limit?: string) {
    return this.admin.getFailedJobs(limit ? parseInt(limit, 10) : undefined);
  }

  @Post('jobs/:id/retry')
  @ApiOperation({ summary: 'Retry any user\'s FAILED/DEAD_LETTER job' })
  retryJob(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.retry(user.userId, id, { admin: true });
  }

  @Get('users')
  @ApiOperation({ summary: 'All users with storage usage' })
  listUsers() {
    return this.admin.listUsers();
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Change a user\'s role or storage quota' })
  updateUser(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.admin.updateUser(user.userId, id, dto);
  }
}
