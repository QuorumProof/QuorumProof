# Slice Migration Guide — Issue #1253

## Overview

This guide provides operators and developers with procedures for migrating existing credential quorum slices when the slice schema changes. Slices define the set of attestors required to validate a credential holder's qualifications, and schema upgrades may require adjusting how slices are structured or validated.

## Table of Contents

1. [Migration Concepts](#migration-concepts)
2. [Schema Change Types](#schema-change-types)
3. [Migration Patterns](#migration-patterns)
4. [Backward Compatibility](#backward-compatibility)
5. [Code Examples](#code-examples)
6. [Troubleshooting](#troubleshooting)
7. [Rollback Procedures](#rollback-procedures)

---

## Migration Concepts

### What is a Slice?

A slice (quorum slice) is a personal trust network that specifies which attestors must validate a credential holder's qualifications. Example:

```
┌─────────────────┐
│ Credential      │
│ Holder          │
│                 │
│ Quorum Slice:   │
│ ─ University    │ (must validate degree)
│ ─ Employer      │ (must validate employment)
│ ─ Regulator     │ (must validate license)
└─────────────────┘
```

### Schema Definition

A slice schema defines:
- **Required attestor types** (e.g., educational institution, employer)
- **Minimum number of attestations** (quorum threshold)
- **Credential attributes** (degree type, job title, etc.)
- **Validation rules** (e.g., employment start date must be before end date)

### Why Migrations Happen

Slice schema changes may occur due to:
1. **New credential types** (e.g., adding certifications to existing degree credentials)
2. **New attestor types** (e.g., adding professional societies)
3. **Validation rule updates** (e.g., stricter credential verification)
4. **Attribute changes** (e.g., adding credential expiration dates)
5. **Regulatory requirements** (e.g., mandatory background checks)

---

## Schema Change Types

### 1. Additive Changes (Backward Compatible)

**Definition**: Adding new optional fields or attestor types.

**Examples**:
- Add optional `expirationDate` field to credentials
- Add optional `certifications` attestor type
- Increase `minimumQuorumSize` but make old minimum still acceptable

**Migration Difficulty**: ⭐ (Easiest)

**Compatibility**: ✅ Old slices continue to work without modification

```typescript
// Before
interface Credential {
  degree: string
  issueDate: Date
}

// After (additive)
interface Credential {
  degree: string
  issueDate: Date
  expirationDate?: Date  // Optional, backward compatible
}
```

### 2. Lenient Changes (Backward Compatible with Caveats)

**Definition**: Relaxing validation rules or reducing quorum requirements.

**Examples**:
- Lower minimum quorum threshold (5→3 attestors)
- Remove required attestor type (e.g., regulator no longer required)
- Extend expiration period

**Migration Difficulty**: ⭐⭐ (Easy)

**Compatibility**: ✅ Old slices accepted; new slices use relaxed rules

---

### 3. Structural Changes (Backward Incompatible)

**Definition**: Modifying required fields or attestor types.

**Examples**:
- Rename `degree` → `degreeType`
- Change credential structure (flatten nested objects)
- Reorder required fields

**Migration Difficulty**: ⭐⭐⭐⭐ (Hard)

**Compatibility**: ⚠️ Old slices must be migrated or will fail validation

### 4. Restrictive Changes (Backward Incompatible)

**Definition**: Tightening validation rules or increasing quorum requirements.

**Examples**:
- Increase minimum quorum threshold (2→3)
- Add new required attestor type
- Add credential expiration enforcement

**Migration Difficulty**: ⭐⭐⭐⭐⭐ (Hardest)

**Compatibility**: ❌ Old slices may no longer meet requirements; migration required

---

## Migration Patterns

### Pattern 1: Dual-Schema Support (Recommended)

**Approach**: Support both old and new schemas during transition period.

**Timeline**:
```
Phase 1: Develop & Test
├─ Develop new schema
├─ Write backward-compatible validation
└─ Deploy to testnet

Phase 2: Gradual Rollout (2-4 weeks)
├─ Deploy to production with old schema as default
├─ Enable new schema for opt-in users
├─ Monitor for issues

Phase 3: Migration Window (1-2 months)
├─ Broadcast migration deadline
├─ Provide automated migration tools
├─ Assist operators with manual migrations
└─ Log all non-migrated slices

Phase 4: Cutover
├─ Enforce new schema
└─ Archive old schema documentation
```

**Advantages**:
- ✅ No forced downtime
- ✅ Operators can plan migrations
- ✅ Rollback option available

**Disadvantages**:
- ⚠️ Requires maintaining dual-schema logic
- ⚠️ More complex code

**Best for**: Structural or restrictive changes

---

### Pattern 2: Automated Migration (For Additive Changes)

**Approach**: Automatically migrate old slices to new schema.

**Requirements**:
- Schema change is additive or lenient
- No data loss during migration
- Clear migration function

**Implementation**:

```typescript
// Automatic migration on credential validation
function validateCredential(credential: Credential, slice: Slice): boolean {
  // Auto-upgrade slice if needed
  const upgradedSlice = migrateSliceSchema(slice, currentSchema)
  
  // Validate against current schema
  return validateWithSchema(credential, upgradedSlice, currentSchema)
}
```

**Advantages**:
- ✅ Transparent to operators
- ✅ No migration steps required
- ✅ Fast rollout

**Disadvantages**:
- ⚠️ Only works for safe changes
- ⚠️ Cannot handle data loss

**Best for**: Additive changes only

---

### Pattern 3: Batch Migration (For Restrictive Changes)

**Approach**: Run scheduled migration job to update existing slices.

**Timeline**:
```
Week 1: Announcement
├─ Notify all operators
├─ Distribute migration checklist
└─ Provide migration toolkit

Week 2: Test Migration
├─ Operators test in staging
├─ Report issues
└─ Fix migration bugs

Week 3: Staged Cutover
├─ Day 1-3: Migrate 20% of slices
├─ Day 4-7: Migrate 50% of slices
├─ Day 8-14: Migrate remaining slices
└─ Rollback any failures

Week 4: Completion
├─ Verify all slices migrated
├─ Archive old schema
└─ Close migration window
```

**Advantages**:
- ✅ Controlled, staged approach
- ✅ Time for testing and troubleshooting

**Disadvantages**:
- ⚠️ Operator effort required
- ⚠️ Longer transition period
- ⚠️ Risk of incomplete migrations

**Best for**: Major structural or restrictive changes

---

### Pattern 4: Versioned Schemas (For Long-term Support)

**Approach**: Support multiple schema versions in parallel.

**Implementation**:

```typescript
interface SliceV1 {
  schemaVersion: 1
  attestors: Attestor[]
  minimumQuorum: number
}

interface SliceV2 {
  schemaVersion: 2
  attestorTypes: AttestorType[]  // Changed structure
  minimumQuorum: number
  expirationDate?: Date           // New field
}

function validateSlice(credential: Credential, slice: SliceV1 | SliceV2): boolean {
  switch (slice.schemaVersion) {
    case 1:
      return validateSliceV1(credential, slice)
    case 2:
      return validateSliceV2(credential, slice)
    default:
      throw new UnsupportedSchemaVersion()
  }
}
```

**Advantages**:
- ✅ Permanent backward compatibility
- ✅ Operators choose upgrade timing
- ✅ Easy rollback

**Disadvantages**:
- ⚠️ Ongoing maintenance of multiple schemas
- ⚠️ Increased complexity

**Best for**: Long-lived platforms with many operators

---

## Backward Compatibility Strategy

### Compatibility Matrix

```
Change Type          | Backward Compatible | Forced Migration
─────────────────────┼────────────────────┼──────────────
Additive             | ✅ Yes             | ✅ Optional
Lenient              | ✅ Yes             | ✅ Optional
Structural           | ❌ No              | ⚠️ Required
Restrictive          | ❌ No              | ⚠️ Required
```

### Compatibility Rules

1. **Never remove required fields** without a 6-month deprecation period
2. **Always provide a migration function** for breaking changes
3. **Support old schema** for at least 90 days after new schema launch
4. **Document all changes** in migration guide
5. **Maintain audit trail** of schema versions and migration dates

### Versioning Convention

Use semantic versioning for schemas:

```
schemaVersion: "1.0.0"
                │ │ │
                │ │ └─ Patch (bug fixes, backward compatible)
                │ └─── Minor (additive changes, backward compatible)
                └───── Major (breaking changes)

v1.0.0 → v1.1.0 = Additive change (backward compatible)
v1.1.0 → v2.0.0 = Structural change (breaking change)
```

---

## Code Examples

### Example 1: Adding Optional Field

**Scenario**: Add optional `expirationDate` to credentials.

**Before**:
```typescript
interface Credential {
  id: string
  degree: string
  issueDate: Date
  issuerAddress: string
}

interface Slice {
  schemaVersion: "1.0.0"
  credentialType: "degree"
  issuer: string
}
```

**After**:
```typescript
interface Credential {
  id: string
  degree: string
  issueDate: Date
  expirationDate?: Date  // New optional field
  issuerAddress: string
}

interface Slice {
  schemaVersion: "1.1.0"  // Minor version bump
  credentialType: "degree"
  issuer: string
  requiresExpiration?: boolean  // Optional validation rule
}
```

**Migration**:
```typescript
// Auto-upgrade credentials without expiration date
function ensureExpirationDate(credential: Credential): Credential {
  if (!credential.expirationDate) {
    // Default: 4 years after issue
    credential.expirationDate = addYears(credential.issueDate, 4)
  }
  return credential
}

// Validation handles both versions automatically
function validateDegreeCredential(credential: Credential, slice: Slice): boolean {
  if (slice.schemaVersion >= "1.1.0" && slice.requiresExpiration) {
    return isBeforeDate(new Date(), credential.expirationDate)
  }
  return true
}
```

**Operator Action**: None required. Old and new slices work seamlessly.

---

### Example 2: Adding Required Attestor Type

**Scenario**: Require background check attestor in addition to employer.

**Before**:
```typescript
interface Slice {
  schemaVersion: "1.0.0"
  requiredAttestors: ["employer"]
  minimumQuorum: 1
}
```

**After**:
```typescript
interface Slice {
  schemaVersion: "2.0.0"
  requiredAttestors: ["employer", "backgroundCheck"]  // NEW
  minimumQuorum: 2  // Increased
}
```

**Migration Strategy**: Dual-schema support with 30-day window.

**Migration Steps**:

1. **Announcement Phase** (Day 0):
```
"On August 1, background check verification will become required. 
Current slices without background check will be invalid after this date."
```

2. **Transition Phase** (Day 0-30):
- Accept both old and new slices
- Log warnings for non-upgraded slices
- Provide migration script

3. **Migration Script**:
```typescript
async function migrateSliceV1toV2(sliceV1: SliceV1): Promise<SliceV2> {
  // Find background check attestor
  const bgCheckAttestor = await findBackgroundCheckAttestor()
  
  return {
    schemaVersion: "2.0.0",
    requiredAttestors: [...sliceV1.requiredAttestors, bgCheckAttestor],
    minimumQuorum: sliceV1.minimumQuorum + 1,
    migratedFrom: "1.0.0",
    migratedAt: new Date(),
  }
}
```

4. **Enforcement Phase** (Day 31):
```
// Only accept v2.0.0 slices
if (slice.schemaVersion < "2.0.0") {
  throw new MigrationRequiredError(
    "Please upgrade your slice to v2.0.0. " +
    "See: https://docs.quorumproof.io/slice-migration"
  )
}
```

**Operator Action**:
- Run migration script on slices
- Verify background check attestor is configured
- Test updated slices in staging

---

### Example 3: Renaming Fields (Structural Change)

**Scenario**: Rename `issuerAddress` → `issuerAccount` for clarity.

**Before**:
```typescript
interface Credential {
  issuerAddress: string  // Old name
}
```

**After**:
```typescript
interface Credential {
  issuerAccount: string  // New name
}
```

**Migration with Mapping**:
```typescript
function migrateCredentialV1toV2(credV1: CredentialV1): CredentialV2 {
  return {
    ...credV1,
    issuerAccount: credV1.issuerAddress,  // Map old field to new
    // Remove old field
    issuerAddress: undefined,
  }
}

// Accept both field names during transition
function getIssuerAccount(cred: any): string {
  return cred.issuerAccount ?? cred.issuerAddress
}
```

**Operator Action**:
- Use migration script to rename fields in all credentials
- Update configuration to use new field name
- Run tests against updated credentials

---

## Troubleshooting

### Issue 1: Migration Script Fails Partway

**Symptoms**:
- Some slices migrated, others not
- Unclear which ones are pending
- Inconsistent schema versions

**Solution**:

```typescript
// Log migration progress
const migrationLog = {
  startTime: new Date(),
  totalSlices: allSlices.length,
  migratedSlices: [],
  failedSlices: [],
  errors: [],
}

for (const slice of allSlices) {
  try {
    const migrated = await migrateSlice(slice)
    migrationLog.migratedSlices.push(slice.id)
  } catch (error) {
    migrationLog.failedSlices.push(slice.id)
    migrationLog.errors.push({ sliceId: slice.id, error: error.message })
  }
}

// Save progress
await saveMigrationLog(migrationLog)

// Resume from last checkpoint
if (migrationLog.failedSlices.length > 0) {
  console.log(`Failed: ${migrationLog.failedSlices.join(', ')}`)
  console.log("Run migration again after fixing issues")
}
```

**Prevention**:
- Use transaction-style operations (all-or-nothing per slice)
- Maintain detailed logs
- Implement checkpoints for large migrations

---

### Issue 2: Old Slices Still Being Used After Cutover

**Symptoms**:
- Validation failures for old schema
- Operators confused by errors
- High support ticket volume

**Solution**:

```typescript
// Clear error message indicating migration needed
function validateSliceVersion(slice: Slice): void {
  if (slice.schemaVersion < MINIMUM_REQUIRED_VERSION) {
    throw new MigrationRequiredError(
      `This slice uses schema v${slice.schemaVersion}. ` +
      `Minimum required version is v${MINIMUM_REQUIRED_VERSION}. ` +
      `Please run the migration guide: ${MIGRATION_GUIDE_URL}`
    )
  }
}

// Provide migration assistance
function suggestMigrationPath(slice: Slice): string {
  const changes = detectSchemaChanges(slice, CURRENT_SCHEMA)
  return `
Your slice needs updates for:
${changes.map(c => `  - ${c.description}`).join('\n')}

Run this script: npx quorumproof migrate-slice --id ${slice.id}
  `
}
```

---

### Issue 3: Data Loss During Migration

**Symptoms**:
- Migrated slices missing data
- Custom fields disappeared
- Validation errors after migration

**Solution**:

```typescript
interface MigrationOptions {
  preserveUnknownFields?: boolean  // Default: true
  validateAfterMigration?: boolean  // Default: true
  backupBeforeMigration?: boolean  // Default: true
}

async function migrateSliceV1toV2(
  sliceV1: SliceV1,
  options: MigrationOptions = {}
): Promise<SliceV2> {
  // Backup before migration
  if (options.backupBeforeMigration) {
    await saveBackup(sliceV1)
  }

  // Preserve unknown fields
  const preservedFields = options.preserveUnknownFields
    ? Object.fromEntries(
        Object.entries(sliceV1).filter(([key]) => !KNOWN_FIELDS.has(key))
      )
    : {}

  const sliceV2: SliceV2 = {
    ...preservedFields,
    schemaVersion: "2.0.0",
    // ... new fields
  }

  // Validate after migration
  if (options.validateAfterMigration) {
    await validateSlice(sliceV2)
  }

  return sliceV2
}
```

**Prevention**:
- Always backup before migration
- Test migration on non-production data first
- Run validation after migration
- Keep detailed logs of what changed

---

## Rollback Procedures

### When to Rollback

- New schema has critical bugs
- Operators report widespread migration failures
- Performance degradation observed
- Data corruption detected

### Rollback Steps

**1. Immediate Actions**:
```bash
# Stop new schema validation
export ENFORCE_NEW_SCHEMA=false

# Fall back to old schema
export CURRENT_SCHEMA_VERSION=1.0.0

# Restart services
docker-compose restart api-server
```

**2. Assess Damage**:
```typescript
async function assessRollback() {
  const incompleteMigrations = await db.query(
    "SELECT * FROM slices WHERE schema_version LIKE '2.0.%'"
  )
  
  const dataInconsistencies = await checkDataIntegrity()
  
  return {
    migratedSlices: incompleteMigrations.length,
    inconsistencies: dataInconsistencies.length,
  }
}
```

**3. Restore from Backup**:
```bash
# If data corruption detected
pg_restore -d quorumproof /backups/pre-migration.sql
```

**4. Communicate**:
```
We've identified issues with the v2.0.0 schema update and are 
rolling back to v1.0.0. This does not affect existing data.

Status: ROLLING BACK
ETA: 30 minutes
Updates: #quorumproof-incidents
```

### Rollback Timeline

```
T+0 min   : Issue detected, rollback initiated
T+10 min  : Services downgraded to old schema
T+20 min  : Data integrity check complete
T+25 min  : Resume credential verification
T+30 min  : All systems nominal

Post-incident:
- Root cause analysis
- Identify failed schema changes
- Plan corrected migration
- Retry in 1 week
```

---

## Slice Migration Checklist

Use this checklist when migrating slices to a new schema:

### Pre-Migration (1 week before)
- [ ] Document all schema changes clearly
- [ ] Announce timeline and requirements
- [ ] Distribute migration guide and scripts
- [ ] Set up test environment with new schema
- [ ] Operators test migration in staging
- [ ] Identify and resolve any blockers

### Migration Execution
- [ ] Backup all slice data
- [ ] Run migration script (or manual steps)
- [ ] Verify data integrity post-migration
- [ ] Validate all migrated slices
- [ ] Test credential verification with new schema
- [ ] Monitor error rates and performance

### Post-Migration
- [ ] Confirm 100% of slices migrated
- [ ] Archive old schema documentation
- [ ] Update integration tests
- [ ] Document lessons learned
- [ ] Plan deprecation of old schema (if removing)

---

## References

- **Slice Schema Definition**: [docs/architecture.md](./architecture.md)
- **Credential Verification**: [API Documentation](../api-server/docs/)
- **Deployment Runbook**: [ops/OPERATOR_RUNBOOK.md](./OPERATOR_RUNBOOK.md)
- **Stellar Protocol**: https://stellar.org/papers/stellar-consensus-protocol.pdf

---

**Document Version**: 1.0  
**Last Updated**: July 2026  
**Next Review**: October 2026  
**Owner**: Architecture & Operations Team
