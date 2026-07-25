# Snapshot Testing Guide for APIs

This guide explains how to use snapshot testing to automatically detect unintended API changes and maintain response consistency.

## Overview

**Snapshot Testing** captures API responses and compares them against expected snapshots. Any change to the response (intentional or not) is flagged for review, preventing silent regressions.

### When to Use Snapshots

✅ **Good Uses:**
- Large API responses (many fields)
- Complex nested structures
- Response headers and metadata
- Error response formats
- Pagination structures

❌ **Bad Uses:**
- Constantly changing timestamps (use masking instead)
- Random data or IDs
- Test-specific dynamic values

## Running Snapshot Tests

### First Time: Create Snapshots
```bash
cd api-server
npm test -- snapshots.test.ts
```

First run creates baseline snapshots in `tests/__snapshots__/`.

### Subsequent Runs: Compare Against Snapshots
```bash
npm test -- snapshots.test.ts
```

Tests compare current responses against stored snapshots.

### Update Snapshots (Review First!)
```bash
npm test -- snapshots.test.ts -u
```

Updates snapshots after you've reviewed changes.

### Specific Snapshot
```bash
npm test -- snapshots.test.ts -t "Credential Endpoints"
```

## Snapshot Workflow

### Step 1: Make an API Change
```typescript
// routes/credentials.ts
res.json({
  id: credential.id,
  subject: credential.subject,
  // Added new field
  created_at_iso: credential.created_at.toISOString(),
});
```

### Step 2: Run Tests
```bash
npm test -- snapshots.test.ts
```

Test fails with snapshot mismatch:
```
Snapshot name: `credential-detail`

Expected:
{
  "id": "123",
  "subject": "G...",
}

Received:
{
  "id": "123",
  "subject": "G...",
  "created_at_iso": "2024-01-01T00:00:00Z"
}

Snapshot mismatch found. Review changes before updating.
```

### Step 3: Review Changes
Look at the diff and decide:
- **Intended change?** → Update snapshot
- **Bug?** → Fix the API
- **Dynamic field?** → Mask before storing

### Step 4: Update Snapshot
```bash
npm test -- snapshots.test.ts -u
```

Snapshots are updated and committed.

## Common Patterns

### Masking Dynamic Data

Some API responses contain data that changes per request (timestamps, IDs, etc.). Use masking:

```typescript
import { maskSensitiveData } from "../helpers/snapshot-manager";

it("GET /credentials snapshot", async () => {
  const response = await request(app).get("/credentials/123");
  const masked = maskSensitiveData(response.body);
  expect(masked).toMatchSnapshot("credentials-masked");
});
```

Masked snapshot:
```json
{
  "id": "123",
  "created_at": "***MASKED***",
  "token": "***MASKED***"
}
```

### Partial Snapshots

Test only specific fields that should remain stable:

```typescript
it("credential structure snapshot", async () => {
  const response = await request(app).get("/credentials/123");
  
  // Only snapshot important structure
  const structure = {
    id: response.body.id,
    fields: Object.keys(response.body),
  };
  
  expect(structure).toMatchSnapshot("credential-structure");
});
```

### Snapshot with Multiple Variants

Test different response states:

```typescript
describe("Credential Response Variants", () => {
  it("active credential snapshot", async () => {
    const response = await request(app).get("/credentials/active-123");
    expect(response.body).toMatchSnapshot("credential-active");
  });

  it("revoked credential snapshot", async () => {
    const response = await request(app).get("/credentials/revoked-456");
    expect(response.body).toMatchSnapshot("credential-revoked");
  });

  it("expired credential snapshot", async () => {
    const response = await request(app).get("/credentials/expired-789");
    expect(response.body).toMatchSnapshot("credential-expired");
  });
});
```

## Snapshot File Organization

Snapshots are stored in `api-server/tests/__snapshots__/`:

```
__snapshots__/
├── snapshots.test.ts.snap
├── contract-tests.test.ts.snap
└── e2e.test.ts.snap
```

Vitest automatically names snapshot files after test files.

### Viewing Snapshots

```bash
# View all snapshots
cat api-server/tests/__snapshots__/snapshots.test.ts.snap

# View specific snapshot
grep -A 20 "credential-detail" api-server/tests/__snapshots__/snapshots.test.ts.snap
```

## CI/CD Integration

### Running in CI

```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: npm test -- snapshots.test.ts
    # Fail if snapshots need updating
    - run: npm test -- snapshots.test.ts --run
```

### Reviewing Snapshot Changes in PR

1. GitHub shows snapshot changes in the PR diff
2. Reviewer checks if changes are intentional
3. If yes, approver runs: `npm test -- snapshots.test.ts -u`
4. Updated snapshots are committed to the PR

### Auto-Updating Snapshots

To allow snapshots to be updated in CI:

```bash
# In CI pipeline
npm test -- snapshots.test.ts -u
git add api-server/tests/__snapshots__/
git commit -m "chore: update API snapshots"
git push
```

## Best Practices

### 1. Review Before Updating
Always review snapshot diffs before updating:

```bash
# See what changed
npm test -- snapshots.test.ts 2>&1 | head -100

# Only then update
npm test -- snapshots.test.ts -u
```

### 2. Keep Snapshots Readable
Avoid huge snapshots. Test small, focused responses:

```typescript
// GOOD: Small, focused snapshot
expect({
  id: response.body.id,
  status: response.body.status,
}).toMatchSnapshot("credential-status");

// BAD: Entire huge response
expect(response.body).toMatchSnapshot("everything");
```

### 3. Version Snapshots
Include snapshots in version control:

```bash
# Commit snapshots with changes
git add api-server/tests/__snapshots__/
git commit -m "feat: add new endpoint + snapshots"
```

### 4. Mask Sensitive Data
Never snapshot credentials, tokens, or secrets:

```typescript
const masked = {
  ...response.body,
  token: "***MASKED***",
  secret: "***MASKED***",
};
expect(masked).toMatchSnapshot();
```

### 5. Use Descriptive Names
Snapshot names should be clear:

```typescript
expect(response.body).toMatchSnapshot("credential-with-full-details");
// Not:
expect(response.body).toMatchSnapshot("resp1");
```

## Handling Intentional Breaking Changes

When you intentionally change an API response:

### 1. Update Snapshots
```bash
npm test -- snapshots.test.ts -u
```

### 2. Document the Change
Add a comment to the test:

```typescript
it("GET /credentials updated response format", async () => {
  // BREAKING: Changed created_at from Unix timestamp to ISO 8601
  // Migration period: 3 months (until 2024-04-01)
  // Old format: created_at (number)
  // New format: created_at_iso (string)
  
  const response = await request(app).get("/credentials/123");
  expect(response.body).toMatchSnapshot("credential-new-format");
});
```

### 3. Deprecate Old Format
Run both old and new formats during migration:

```typescript
res.json({
  id: credential.id,
  created_at: credential.createdAt.getTime(), // Old format (deprecated)
  created_at_iso: credential.createdAt.toISOString(), // New format
  "X-Deprecated": "created_at. Use created_at_iso instead.",
});
```

### 4. Remove Old Format
After migration period, remove:

```typescript
res.json({
  id: credential.id,
  created_at_iso: credential.createdAt.toISOString(), // Only new format
});
```

## Troubleshooting

### Snapshot Not Found
```
Error: Snapshot not found: credential-detail
```

First run creates snapshots. Run with `-u` flag:
```bash
npm test -- snapshots.test.ts -u
```

### Snapshot Has Changed Many Times
If a snapshot changes frequently, it may not be a good candidate:

- Consider masking dynamic fields
- Test structure instead of values
- Move to contract testing if testing behavior

### Snapshots Too Large
If snapshots exceed 10KB, consider:

1. Test smaller responses
2. Split into multiple snapshots
3. Test only important fields

### Merge Conflicts in Snapshots
If two branches modify the same snapshot:

```
<<<<<<< HEAD
  "id": "old-response"
========
  "id": "new-response"
>>>>>>> feature-branch
```

Resolve by running tests on both branches separately, then merge manually.

## Snapshot Comparison Tools

### View Differences
```bash
# Show snapshot diff
npm test -- snapshots.test.ts 2>&1 | grep -A 50 "Snapshot Diff"
```

### Generate Report
```typescript
import { generateSnapshotReport } from "../helpers/snapshot-manager";

const report = generateSnapshotReport(snapshotsDir, currentSnapshots);
console.log(report);
```

## Advanced: Custom Matchers

Create custom snapshot matchers for API-specific validation:

```typescript
expect.extend({
  toMatchCredentialSnapshot(received, expectedFields) {
    const pass = expectedFields.every(
      (field: string) => field in received
    );
    
    return {
      pass,
      message: () => `Credential snapshot ${pass ? "passes" : "fails"}`,
    };
  },
});

// Usage
expect(response.body).toMatchCredentialSnapshot([
  "id",
  "subject",
  "credential_type",
]);
```

## References

- [Vitest Snapshots](https://vitest.dev/guide/snapshot.html)
- [Jest Snapshots](https://jestjs.io/docs/snapshot-testing)
- [API Testing Best Practices](https://swagger.io/tools/swagger-ui/)

## Support

For snapshot testing questions:
- Check the snapshots in `api-server/tests/__snapshots__/`
- Review test examples in `api-server/tests/snapshots.test.ts`
- File an issue with label `snapshot-testing`
