import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminService } from './admin.service';

/**
 * Auth note (see docs/decisions.md "Auth: no RBAC in v1"): any logged-in
 * user can view the admin dashboard. There is no role/permission system
 * yet — this is explicitly documented as a future enhancement rather
 * than faked with a hardcoded "isAdmin" flag that isn't backed by
 * anything real.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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
}
