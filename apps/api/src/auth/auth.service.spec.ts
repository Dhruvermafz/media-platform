import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { user: { findUnique: jest.Mock; create: jest.Mock } };
  let jwt: { signAsync: jest.Mock };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn(), create: jest.fn() } };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-token') };
    service = new AuthService(prisma as unknown as PrismaService, jwt as unknown as JwtService);
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
        Promise.resolve({ id: 'new-user', email: data.email, createdAt: new Date() }),
      );

      await service.register({ email: 'new@example.com', password: 'plaintext-password' });

      const storedHash = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(storedHash).not.toBe('plaintext-password');
      expect(await bcrypt.compare('plaintext-password', storedHash)).toBe(true);
    });

    it('returns a signed access token on success', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'new-user', email: 'new@example.com', createdAt: new Date() });

      const result = await service.register({ email: 'new@example.com', password: 'password123' });

      expect(result.accessToken).toBe('signed-token');
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'new-user', email: 'new@example.com' });
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
});
