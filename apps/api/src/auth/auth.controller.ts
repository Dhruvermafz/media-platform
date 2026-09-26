import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Create an account and receive a JWT' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for a JWT' })
  @ApiResponse({ status: 200, description: 'Login succeeded' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout (stateless JWT: client discards the token)',
    description:
      'Sessions are stateless JWTs (see docs/decisions.md). There is nothing to invalidate ' +
      'server-side without a token blocklist, which this project intentionally does not add — ' +
      'see decisions.md "Auth: stateless JWT over sessions" for the trade-off.',
  })
  logout() {
    return { message: 'Discard the token client-side; nothing to invalidate server-side.' };
  }
}
