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

/**
 * Field schema: which fields exist per resource and the permission required to
 * select each one. Used by the `?fields=` response-size optimization so that
 * callers can only request fields they are authorized to view.
 */
export type FieldSchema = Record<string, Record<string, Permission>>;

export const DEFAULT_FIELD_SCHEMA: FieldSchema = {
  credentials: {
    id: 'credentials:read',
    status: 'credentials:read',
    subject: 'credentials:read',
    issuer: 'credentials:read',
    issuedAt: 'credentials:read',
    revokedAt: 'credentials:revoke',
  },
  slices: {
    id: 'slices:read',
    status: 'slices:read',
    credentialId: 'slices:read',
    createdAt: 'slices:read',
  },
  attestations: {
    id: 'attestations:read',
    status: 'attestations:read',
    sliceId: 'attestations:read',
    attestor: 'attestations:read',
  },
  reports: {
    id: 'reports:read',
    status: 'reports:read',
    generatedAt: 'reports:read',
  },
};

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

  /**
   * Resolve the role from the request, or null when missing/invalid.
   */
  function resolveRole(req: Request): Role | null {
    const rawRole = req.headers[roleHeader];
    const role = typeof rawRole === 'string' ? rawRole.trim().toLowerCase() : '';
    return VALID_ROLES.has(role) ? (role as Role) : null;
  }

  /**
   * Parse a `?fields=id,status` query parameter into a list of requested field
   * names. Returns null when the parameter is absent (meaning: no selection).
   */
  function parseFields(raw: unknown): string[] | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const fields = raw
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    return fields.length > 0 ? fields : null;
  }

  /**
   * Validate requested fields against the field schema and the caller's
   * permissions. Returns the allowed field list, or an error describing the
   * first field that is unknown or not permitted.
   */
  function validateFields(
    resource: string,
    fields: string[],
    role: Role,
    schema: FieldSchema = DEFAULT_FIELD_SCHEMA,
  ): { fields: string[] } | { error: string; field: string } {
    const resourceSchema = schema[resource];
    if (!resourceSchema) {
      return { error: 'Unknown resource', field: resource };
    }
    for (const field of fields) {
      const required = resourceSchema[field];
      if (!required) {
        return { error: 'Unknown field', field };
      }
      if (!hasPermission(role, required)) {
        return { error: 'Field not permitted', field };
      }
    }
    return { fields };
  }

  /**
   * Project an object (or array of objects) down to the selected fields.
   * When `fields` is null the object is returned unchanged.
   */
  function selectFields<T extends Record<string, unknown>>(
    data: T | T[],
    fields: string[] | null,
  ): T | Partial<T> | Array<Partial<T>> {
    if (!fields) return data;
    const project = (item: T): Partial<T> => {
      const out: Partial<T> = {};
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(item, field)) {
          out[field as keyof T] = item[field as keyof T];
        }
      }
      return out;
    };
    return Array.isArray(data) ? data.map(project) : project(data);
  }

  /**
   * Express middleware factory that applies `?fields=` selection to the JSON
   * body produced by downstream handlers. Unknown or unauthorized fields are
   * rejected with 400/403 before the response is sent.
   */
  function fieldSelection(resource: string, schema: FieldSchema = DEFAULT_FIELD_SCHEMA) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const requested = parseFields(req.query.fields);
      if (!requested) {
        next();
        return;
      }

      const role = resolveRole(req);
      if (!role) {
        res.status(401).json({ error: 'Missing or invalid role header', header: roleHeader });
        return;
      }

      const result = validateFields(resource, requested, role, schema);
      if ('error' in result) {
        const status = result.error === 'Field not permitted' ? 403 : 400;
        res.status(status).json({ error: result.error, field: result.field });
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = (body: unknown): Response => {
        if (body && typeof body === 'object') {
          return originalJson(selectFields(body as Record<string, unknown>, result.fields));
        }
        return originalJson(body);
      };

      next();
    };
  }

  return {
    requirePermission,
    hasPermission,
    rolePermissions,
    resolveRole,
    parseFields,
    validateFields,
    selectFields,
    fieldSelection,
  };
}

export const rbac = createRbac();
