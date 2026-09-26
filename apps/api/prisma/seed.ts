import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * Intentionally minimal and non-destructive: creates one demo account if
 * it doesn't already exist, and nothing else. Seeding synthetic assets
 * would require real files sitting in object storage for jobs to
 * process against, which a seed script can't fabricate meaningfully —
 * use the actual upload flow (docs/api.md) to create test data instead.
 */
async function main() {
  const email = 'demo@example.com';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Seed: ${email} already exists, nothing to do.`);
    return;
  }

  const passwordHash = await bcrypt.hash('demo-password-123', 12);
  const user = await prisma.user.create({ data: { email, passwordHash } });
  console.log(`Seed: created demo user ${user.email} (password: demo-password-123)`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
