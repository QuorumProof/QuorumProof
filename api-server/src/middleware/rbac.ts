import { Request, Response, NextFunction } from 'express';

export type Role = 'admin' | 'issuer' | 'attestor' | 'verifier';

export type Permission =
  | 'credentials:read'
  | 'credentials:write'
  | 'credentials:revoke'
  | 'slices:read'
  | 'slices:write'
  | 'attestations:read'
  | 'attestations:write'
  | 'reports:read'
  | 'admin:all';

export type RbacConfig = {
  rolePermissions?: Partial<Record<Role, Permission[]>>;
  roleHeader?: string;
};

const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'credentials:read', 'credentials:write', 'credentials:revoke',
    'slices:read', 'slices:write',
    'attestations:read', 'attestations:write',
    'reports:read', 'admin:all',
  ],
  issuer: [
    'credentials:read', 'credentials:write',
    'slices:read',
  ],
  attestor: [
    'credentials:read',
    'slices:read',
    'attestations:read', 'attestations:write',
  ],
  verifier: [
    'credentials:read',
    'slices:read',
    'attestations:read',
    'reports:read',
  ],
};

const VALID_ROLES = new Set<string>(['admin', 'issuer', 'attestor', 'verifier']);

export function createRbac(config: RbacConfig = {}) {
  const roleHeader = config.roleHeader ?? 'x-role';
  const rolePermissions: Record<Role, Permission[]> = {
    ...DEFAULT_ROLE_PERMISSIONS,
    ...(config.rolePermissions ?? {}),
  };

  function hasPermission(role: Role, permission: Permission): boolean {
    const perms = rolePermissions[role] ?? [];
    return perms.includes('admin:all') || perms.includes(permission);
  }

  function requirePermission(permission: Permission) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const rawRole = req.headers[roleHeader];
      const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';

      if (!VALID_ROLES.has(role)) {
        res.status(401).json({ error: 'Missing or invalid role header', header: roleHeader });
        return;
      }

      if (!hasPermission(role as Role, permission)) {
        res.status(403).json({
          error: 'Insufficient permissions',
          role,
          required: permission,
        });
        return;
      }

      next();
    };
  }

  return { requirePermission, hasPermission, rolePermissions };
}

export const rbac = createRbac();
