import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const BCRYPT_ROUNDS = 12;

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role?: Role;
}

const publicUserSelect = { id: true, email: true, displayName: true, role: true, createdAt: true } as const;

@Injectable()
export class AuthService {
  private readonly adminEmails: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.adminEmails = new Set((config.get<string[]>('adminEmails') ?? []).map((e) => e.toLowerCase()));
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        displayName: dto.displayName?.trim() || null,
        role: this.isConfiguredAdmin(dto.email) ? Role.ADMIN : Role.USER,
      },
      select: publicUserSelect,
    });
    return { user, ...(await this.issueToken(user.id, user.email, user.role)) };
  }

  async login(dto: LoginDto) {
    let user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Deliberately identical error for "no such user" and "wrong password"
    // so the API doesn't leak which emails are registered.
    if (!user) throw new UnauthorizedException('Invalid email or password');
    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    // ADMIN_EMAILS is the bootstrap path for the first admin (and for
    // accounts that existed before roles did): promote on login.
    if (user.role !== Role.ADMIN && this.isConfiguredAdmin(user.email)) {
      user = await this.prisma.user.update({ where: { id: user.id }, data: { role: Role.ADMIN } });
    }
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        role: user.role ?? Role.USER,
        createdAt: user.createdAt,
      },
      ...(await this.issueToken(user.id, user.email, user.role ?? Role.USER)),
    };
  }

  private isConfiguredAdmin(email: string): boolean {
    return this.adminEmails.has(email.toLowerCase());
  }

  private async issueToken(userId: string, email: string, role: Role) {
    const payload: JwtPayload = { sub: userId, email, role };
    return { accessToken: await this.jwt.signAsync(payload) };
  }
}
