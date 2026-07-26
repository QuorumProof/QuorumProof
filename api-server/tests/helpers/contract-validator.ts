/**
 * Contract Validator Helper
 *
 * Utilities for validating API responses against expected contract.
 * Used in consumer-driven contract tests to ensure API stability.
 */

export interface ContractField {
  name: string;
  type: string | string[];
  required?: boolean;
  pattern?: RegExp;
  enum?: any[];
  min?: number;
  max?: number;
}

export interface ApiContract {
  endpoint: string;
  method: string;
  statusCode: number;
  fields: ContractField[];
}

/**
 * Validate response against contract specification
 */
export function validateContract(response: any, contract: ApiContract): ValidationResult {
  const errors: string[] = [];

  if (!response) {
    errors.push("Response is null or undefined");
    return { valid: false, errors };
  }

  // Validate each field in contract
  for (const field of contract.fields) {
    const value = response[field.name];

    // Check if field is required
    if (field.required !== false && value === undefined) {
      errors.push(`Missing required field: ${field.name}`);
      continue;
    }

    if (value === undefined || value === null) {
      continue;
    }

    // Validate type
    if (field.type && !validateType(value, field.type)) {
      errors.push(
        `Field ${field.name} has wrong type. Expected ${field.type}, got ${typeof value}`
      );
    }

    // Validate pattern
    if (field.pattern && typeof value === "string" && !field.pattern.test(value)) {
      errors.push(`Field ${field.name} does not match expected pattern: ${field.pattern}`);
    }

    // Validate enum
    if (field.enum && !field.enum.includes(value)) {
      errors.push(`Field ${field.name} has invalid value. Expected one of ${field.enum}`);
    }

    // Validate min/max
    if (typeof value === "number") {
      if (field.min !== undefined && value < field.min) {
        errors.push(`Field ${field.name} is below minimum value: ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        errors.push(`Field ${field.name} exceeds maximum value: ${field.max}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateType(value: any, expectedType: string | string[]): boolean {
  const types = Array.isArray(expectedType) ? expectedType : [expectedType];

  for (const type of types) {
    if (type === "string" && typeof value === "string") return true;
    if (type === "number" && typeof value === "number") return true;
    if (type === "boolean" && typeof value === "boolean") return true;
    if (type === "array" && Array.isArray(value)) return true;
    if (type === "object" && typeof value === "object" && !Array.isArray(value)) return true;
  }

  return false;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Contract definitions for QuorumProof API
 */
export const CREDENTIAL_CONTRACT: ApiContract = {
  endpoint: "/credentials/:id",
  method: "GET",
  statusCode: 200,
  fields: [
    { name: "id", type: "string", required: true, pattern: /^\d+$/ },
    {
      name: "subject",
      type: "string",
      required: true,
      pattern: /^G[A-Z2-7]{55}$/,
    },
    { name: "credential_type", type: "string", required: true },
    { name: "created_at", type: "number", required: true, min: 0 },
    { name: "metadata_hash", type: "string", required: false },
    { name: "revoked", type: "boolean", required: true },
    { name: "expires_at", type: "number", required: false },
  ],
};

export const CREDENTIALS_LIST_CONTRACT: ApiContract = {
  endpoint: "/credentials",
  method: "GET",
  statusCode: 200,
  fields: [
    { name: "items", type: "array", required: true },
    { name: "pagination", type: "object", required: true },
  ],
};

export const PAGINATION_CONTRACT: ApiContract = {
  endpoint: "/",
  method: "GET",
  statusCode: 200,
  fields: [
    { name: "page", type: "number", required: true, min: 1 },
    { name: "limit", type: "number", required: true, min: 1, max: 1000 },
    { name: "total", type: "number", required: true, min: 0 },
    { name: "pages", type: "number", required: true, min: 0 },
  ],
};

export const ATTESTATION_CONTRACT: ApiContract = {
  endpoint: "/credentials/:id/attestors",
  method: "GET",
  statusCode: 200,
  fields: [
    { name: "items", type: "array", required: true },
  ],
};

export const VERIFICATION_CONTRACT: ApiContract = {
  endpoint: "/verify",
  method: "POST",
  statusCode: 200,
  fields: [
    { name: "verified", type: "boolean", required: true },
    { name: "credential_id", type: "string", required: true },
  ],
};

export const ERROR_RESPONSE_CONTRACT: ApiContract = {
  endpoint: "/",
  method: "GET",
  statusCode: 400,
  fields: [
    { name: "error", type: "object", required: true },
  ],
};

/**
 * Validate error response structure
 */
export function validateErrorResponse(response: any): boolean {
  if (!response.error) return false;
  if (typeof response.error.code !== "string") return false;
  if (typeof response.error.message !== "string") return false;
  return true;
}

/**
 * Validate Stellar address format
 */
export function isStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}

/**
 * Validate credential ID format
 */
export function isValidCredentialId(id: string | number): boolean {
  return /^\d+$/.test(String(id));
}

/**
 * Validate Unix timestamp
 */
export function isValidTimestamp(timestamp: number): boolean {
  return Number.isInteger(timestamp) && timestamp > 0;
}

/**
 * Validate pagination parameters
 */
export function validatePaginationParams(page: number, limit: number): boolean {
  return page >= 1 && limit >= 1 && limit <= 1000;
}
