# API Contract Testing Guide

This guide explains how QuorumProof uses consumer-driven contract testing to ensure API stability and prevent breaking changes.

## Overview

**Contract Testing** verifies that an API's behavior matches the expectations of its consumers. Unlike traditional end-to-end tests that check implementation details, contract tests focus on the published API contract: request/response shapes, data types, status codes, and error formats.

### Benefits

- **Breaking Change Detection**: Catch API changes before they break clients
- **Consumer-Driven**: Tests reflect actual consumer expectations, not implementation
- **Fast Feedback**: Run without external dependencies (no network calls)
- **Version Compatibility**: Validate API behavior across versions

## Contract Test Structure

### 1. Endpoint Contract

Defines expected request/response format for each endpoint.

```typescript
const CREDENTIAL_CONTRACT: ApiContract = {
  endpoint: "/credentials/:id",
  method: "GET",
  statusCode: 200,
  fields: [
    { name: "id", type: "string", required: true, pattern: /^\d+$/ },
    { name: "subject", type: "string", required: true, pattern: /^G[A-Z2-7]{55}$/ },
    { name: "credential_type", type: "string", required: true },
    { name: "created_at", type: "number", required: true, min: 0 },
    { name: "revoked", type: "boolean", required: true },
  ],
};
```

### 2. Error Contract

Defines expected error response format.

```typescript
{
  "error": {
    "code": "INVALID_ADDRESS",
    "message": "Invalid Stellar address format"
  }
}
```

### 3. Data Type Contract

Validates data types and formats:
- Credential IDs: Numeric strings (`"123"`)
- Timestamps: Unix epoch seconds (number)
- Stellar addresses: 56-char base32 strings (`G[A-Z2-7]{55}`)

### 4. Pagination Contract

Ensures consistent pagination across list endpoints:
```typescript
{
  "items": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "pages": 5
  }
}
```

## Running Contract Tests

### Run All Contract Tests
```bash
cd api-server
npm test -- contract-tests.test.ts
```

### Run Specific Contract Group
```bash
npm test -- contract-tests.test.ts -t "Credentials Endpoint Contract"
```

### Run in Watch Mode
```bash
npm test -- contract-tests.test.ts --watch
```

## Writing New Contract Tests

### 1. Define the Contract
```typescript
const MY_ENDPOINT_CONTRACT: ApiContract = {
  endpoint: "/my-endpoint/:id",
  method: "POST",
  statusCode: 201,
  fields: [
    { name: "id", type: "string", required: true },
    { name: "created_at", type: "number", required: true },
  ],
};
```

### 2. Write the Test
```typescript
it("should return credential with correct contract", async () => {
  const response = await request(app).get("/credentials/123");
  
  const result = validateContract(response.body, CREDENTIAL_CONTRACT);
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});
```

### 3. Validate in CI
Contract tests run automatically on every PR to catch breaking changes.

## Common Patterns

### Required vs Optional Fields
```typescript
{ name: "id", type: "string", required: true }      // Must be present
{ name: "extra", type: "string", required: false }  // May be absent
{ name: "note", type: "string" }                    // Defaults to required: true
```

### Type Validation
```typescript
{ name: "id", type: "string" }           // Single type
{ name: "data", type: ["string", "null"] } // Multiple types
```

### Format Validation
```typescript
{ name: "id", type: "string", pattern: /^\d+$/ }              // Regex pattern
{ name: "status", type: "string", enum: ["active", "inactive"] } // Enum
{ name: "age", type: "number", min: 0, max: 150 }            // Range
```

## Contract Evolution

### Adding New Fields (Non-Breaking)
If adding an optional field, existing clients won't break:
```typescript
// OLD
{ name: "status", type: "string", required: true }

// NEW - Add optional field
[
  { name: "status", type: "string", required: true },
  { name: "description", type: "string", required: false }, // OK to add
]
```

### Removing Fields (Breaking)
If removing a field, clients expecting it will fail:
```typescript
// OLD
{ name: "status", type: "string", required: true }

// NEW - Removing required field
[] // Breaking change! Clients fail.
```

### Changing Types (Breaking)
Changing a field's type breaks clients:
```typescript
// OLD
{ name: "created_at", type: "number" }  // Unix seconds

// NEW
{ name: "created_at", type: "string" }  // ISO format - Breaking!
```

### Adding Required Fields (Breaking)
Clients that don't provide new required fields will fail:
```typescript
// OLD - No phone field required
[]

// NEW - Phone now required
{ name: "phone", type: "string", required: true }  // Breaking!
```

## Migration Strategy for Breaking Changes

When you must make a breaking change:

1. **Add New Endpoint** (Non-breaking)
   ```
   POST /v2/credentials  (new contract)
   POST /credentials     (old contract, deprecated)
   ```

2. **Maintain Backward Compatibility**
   - Old endpoint continues to work
   - New endpoint has improved contract
   - Clients have time to migrate

3. **Deprecation Period**
   - Mark old endpoint as deprecated in docs
   - Return `Deprecation` header in responses
   - Set migration deadline (e.g., 6 months)

4. **Remove Old Endpoint**
   - After migration deadline, remove old endpoint
   - Return 410 Gone with migration info

## Validating Against Contracts

Use the `contract-validator.ts` helper to validate responses:

```typescript
import { validateContract, CREDENTIAL_CONTRACT } from "../helpers/contract-validator";

const response = await request(app).get("/credentials/123");
const result = validateContract(response.body, CREDENTIAL_CONTRACT);

if (!result.valid) {
  console.error("Contract violations:", result.errors);
}
expect(result.valid).toBe(true);
```

## CI/CD Integration

Contract tests run in CI pipeline:

1. **On Every PR**: Verify no breaking changes
2. **On Merge**: Update contract snapshots
3. **On Release**: Final validation before deployment

Configuration: `.github/workflows/ci.yml`

## Monitoring Breaking Changes in Production

After deployment, monitor for breaking changes:

```bash
# Check API schema for unexpected changes
curl https://api.quorumproof.com/schema

# Review error logs for contract violations
grep "contract violation" logs/
```

## Common Contract Violations

### Missing Required Field
```
Contract violation: Missing required field: subject
```
**Fix**: Ensure all required fields are returned.

### Wrong Data Type
```
Contract violation: Field created_at has wrong type. Expected number, got string
```
**Fix**: Return numbers for timestamps, not strings.

### Invalid Format
```
Contract violation: Field subject does not match expected pattern: /^G[A-Z2-7]{55}$/
```
**Fix**: Validate Stellar addresses before returning.

### Inconsistent Pagination
```
Contract violation: Field pages has wrong type. Expected number, got string
```
**Fix**: Return pagination metadata as numbers.

## Best Practices

1. **Document Contracts**
   - Write contracts alongside API documentation
   - Make contracts discoverable to clients
   - Include examples

2. **Version Your API**
   - Use URL versioning (`/v1/`, `/v2/`)
   - Or use Content-Type headers (`application/vnd.quorum.v1+json`)

3. **Change Gradually**
   - Add new fields as optional first
   - Make them required in next major version
   - Give clients time to migrate

4. **Test Contracts in CI**
   - Run contract tests on every PR
   - Fail fast on breaking changes
   - Prevent unintended regressions

5. **Monitor Production**
   - Track API usage patterns
   - Alert on contract violations
   - Measure client migration progress

## References

- [Consumer-Driven Contracts Pattern](https://martinfowler.com/articles/consumerDrivenContracts.html)
- [API Design Best Practices](https://swagger.io/resources/articles/best-practices-in-api-design/)
- [Semantic Versioning](https://semver.org/)

## Support

For contract violations or API changes, contact the API team:
- GitHub Issues: Use label `api-contract`
- Slack: `#api-support`
- Email: api@quorumproof.com
