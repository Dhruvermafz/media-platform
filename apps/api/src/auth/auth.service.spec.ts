import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { user: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let jwt: { signAsync: jest.Mock };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() } };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-token') };
    const config = { get: jest.fn().mockReturnValue(['boss@example.com']) };
    service = new AuthService(prisma as unknown as PrismaService, jwt as unknown as JwtService, config as unknown as ConfigService);
  });

  describe('register', () => {
    it('rejects a duplicate email with 409', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing-user' });
      await expect(service.register({ email: 'taken@example.com', password: 'password123' })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('hashes the password before storing it', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'new-user', email: data.email, role: data.role, createdAt: new Date() }),
      );

      await service.register({ email: 'new@example.com', password: 'plaintext-password' });

      const storedHash = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(storedHash).not.toBe('plaintext-password');
      expect(await bcrypt.compare('plaintext-password', storedHash)).toBe(true);
    });

    it('returns a signed access token on success', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'new-user', email: 'new@example.com', role: 'USER', createdAt: new Date() });

      const result = await service.register({ email: 'new@example.com', password: 'password123' });

      expect(result.accessToken).toBe('signed-token');
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'new-user', email: 'new@example.com', role: 'USER' });
    });

    it('promotes emails listed in ADMIN_EMAILS to ADMIN at registration (case-insensitive)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'u', email: data.email, role: data.role, createdAt: new Date() }),
      );
      await service.register({ email: 'Boss@Example.com', password: 'password123' });
      expect(prisma.user.create.mock.calls[0][0].data.role).toBe('ADMIN');
    });

    it('does not grant ADMIN to other emails', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'u', email: data.email, role: data.role, createdAt: new Date() }),
      );
      await service.register({ email: 'someone@example.com', password: 'password123' });
      expect(prisma.user.create.mock.calls[0][0].data.role).toBe('USER');
    });
  });

  describe('login', () => {
    it('rejects an unknown email with 401 (not 404, to avoid leaking which emails exist)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: 'ghost@example.com', password: 'anything' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a wrong password with the same 401 as an unknown email', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@example.com', passwordHash });

      await expect(service.login({ email: 'a@example.com', password: 'wrong-password' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('succeeds and returns a token for correct credentials', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@example.com',
        passwordHash,
        createdAt: new Date(),
      });

      const result = await service.login({ email: 'a@example.com', password: 'correct-password' });
      expect(result.accessToken).toBe('signed-token');
      expect(result.user.email).toBe('a@example.com');
    });
  });

  describe('login role promotion', () => {
    it('promotes a pre-existing account that is now listed in ADMIN_EMAILS', async () => {
      const passwordHash = await bcrypt.hash('pw-123456', 12);
      const base = { id: 'u1', email: 'boss@example.com', passwordHash, role: 'USER', createdAt: new Date() };
      prisma.user.findUnique.mockResolvedValue(base);
      prisma.user.update.mockResolvedValue({ ...base, role: 'ADMIN' });
      const res = await service.login({ email: 'boss@example.com', password: 'pw-123456' });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { role: 'ADMIN' } });
      expect(res.user.role).toBe('ADMIN');
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'u1', email: 'boss@example.com', role: 'ADMIN' });
    });
  });
});
