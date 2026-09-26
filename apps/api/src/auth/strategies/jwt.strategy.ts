import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from '../auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwtSecret')!,
    });
  }

  // Whatever this returns becomes `req.user`. Tokens minted before roles
  // existed have no `role` claim and are treated as plain users.
  async validate(payload: JwtPayload) {
    return { userId: payload.sub, email: payload.email, role: payload.role ?? 'USER' };
  }
}
