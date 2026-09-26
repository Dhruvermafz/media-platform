import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, RequestUser } from '../auth/decorators/current-user.decorator';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { MeService } from './me.service';
import { ChangePasswordDto, UpdateProfileDto } from './me.dto';

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in user\'s profile' })
  profile(@CurrentUser() user: RequestUser) {
    return this.me.getProfile(user.userId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update display name' })
  update(@CurrentUser() user: RequestUser, @Body() dto: UpdateProfileDto) {
    return this.me.updateProfile(user.userId, dto);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (requires the current one)' })
  password(@CurrentUser() user: RequestUser, @Body() dto: ChangePasswordDto) {
    return this.me.changePassword(user.userId, dto);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Storage used vs quota, with counts by kind' })
  usage(@CurrentUser() user: RequestUser) {
    return this.me.getUsage(user.userId);
  }
}
