import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restricts a route (or whole controller) to the given roles. Must be
 * used together with JwtAuthGuard and RolesGuard, in that order. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
