# Metadata Schema Versioning — Solution Plan

## What Exists Today

The codebase already has:

| Mechanism | What it tracks | Storage Key |
|-----------|---------------|-------------|
| `Credential.version` | Update count per credential (bumped on `update_metadata`) | `DataKey::Credential(id).version` |
| `CredentialVersion` history | Full history of metadata changes per credential | `DataKey2::CredentialVersionHistory(id)` |
| `StateVersion` | Contract-level **state schema** version (for storage layout migrations) | `DataKey::StateVersion` |
| `migrate_state()` | Admin function for state schema migration (v0→v1 baseline exists) | — |

**What's missing:** There is no tracking of the **metadata schema version** — the format/structure of the `CredentialMetadata.data` bytes themselves. This means:
- You cannot tell which format version a credential's metadata uses
- There is no migration path when the metadata schema changes
- No validation that metadata conforms to the expected schema
- No schema registry or version distribution metrics

---

## Key Distinction

| Concept | What it models | Example |
|---------|---------------|---------|
| `Credential.version` | How many times this **specific credential** was updated | 1, 2, 3... |
| `StateVersion` | Which version of the **contract storage layout** is active | 0, 1... |
| **`MetadataSchemaVersion`** (NEW) | Which **schema/format** the credential's metadata bytes conform to | v1 (flat), v2 (nested fields) |

These are independent: a credential can be on v1 metadata schema with `Credential.version = 42`.

---

## Architecture

### 1. New Types & Storage Keys

Add to `lib.rs`:

```rust
// ---- Metadata Schema Types ----

#[contracttype]
#[derive(Clone)]
pub struct MetadataSchema {
    pub version: u32,
    pub schema_hash: soroban_sdk::Bytes,   // hash of schema definition
    pub created_at: u64,
    pub description: soroban_sdk::Bytes,   // e.g. "v1: flat key-value metadata"
}

// ---- New Storage Key Variants ----

// Add to DataKey:
//   MetadataSchemaVersion,          // u32 — current active metadata schema version
//   MetadataSchema(u32),            // MetadataSchema — schema definition for version N

// Add to DataKey2:
//   CredentialMetadataSchema(u64),  // u32 — which schema version a credential's metadata uses
//   MetadataSchemaMigration(u32),   // MigrationRecord — migration log for schema transitions
```

### 2. Schema Registry

Three storage locations:

```
DataKey::MetadataSchemaVersion     -> u32            (current schema version for NEW metadata)
DataKey::MetadataSchema(1)         -> MetadataSchema (v1 definition)  
DataKey::MetadataSchema(2)         -> MetadataSchema (v2 definition, added later)
DataKey2::CredentialMetadataSchema(credential_id) -> u32  (which schema version this credential uses)
```

On initial deploy: register v1 schema. On schema upgrade: admin registers v2+.

### 3. How It Works End-to-End

**Writing metadata (on issue or update):**
1. Read `DataKey::MetadataSchemaVersion` for current version
2. Validate input metadata bytes against that schema version's rules
3. Store `DataKey2::CredentialMetadataSchema(credential_id) = current_version`
4. Store metadata as before in `DataKey2::CredentialMetadataStore(id)`

**Reading metadata:**
1. Read `DataKey2::CredentialMetadataSchema(credential_id)` → **schema_version**
2. If `schema_version == current_version`: read and return as-is
3. If `schema_version < current_version`: read, apply migration functions for each version gap, return transformed data (lazy migration — do NOT rewrite storage unless admin-initiated)

**Lazy migration on access:**
- When reading old-format metadata, transform it in-memory
- The stored bytes remain unchanged until explicitly migrated
- A `migrate()` call can rewrite storage to upgrade permanently

---

## Implementation Plan (Fastest Approach)

### Phase 1: Schema Registry & Tracking (~1 day)

Add to `lib.rs`:

**New storage key variants:**
- `DataKey::MetadataSchemaVersion` → `u32`
- `DataKey::MetadataSchema(u32)` → `MetadataSchema`
- `DataKey2::CredentialMetadataSchema(u64)` → `u32`

**New admin function — `register_metadata_schema`:**
- Takes `version`, `description`, `schema_hash`
- Validates: version > current max
- Sets `DataKey::MetadataSchema(version) = schema`
- Admin-only

**New admin function — `set_active_metadata_schema`:**
- Takes `version`
- Validates: schema exists, transition is sequential
- Sets `DataKey::MetadataSchemaVersion = version`

**Modify `issue_credential` / `issue_inner`:**
- After creating metadata, set `CredentialMetadataSchema(id) = current_active_version`

**Modify `update_metadata` / `renew_credential_with_grace`:**
- After updating metadata, set `CredentialMetadataSchema(id) = current_active_version`

**New read function — `get_credential_metadata_schema`:**
- Returns the schema version for a credential's metadata
- Returns 0 for credentials issued before this feature

### Phase 2: Migration System (~1.5 days)

**New type:**

```rust
#[contracttype]
#[derive(Clone)]
pub struct MetadataMigration {
    pub from_version: u32,
    pub to_version: u32,
    pub migrated_count: u32,  // credentials migrated in this batch
    pub completed: bool,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}
```

**New function — `migrate_metadata_schema(to_version, start_id, end_id)`:**
- Admin-only
- Reads batch of credentials in ID range [start_id, end_id]
- For each credential whose `CredentialMetadataSchema(id) < to_version`:
  - Read `CredentialMetadataStore(id)`
  - Apply migration transforms for each version gap
  - Write transformed data back to `CredentialMetadataStore(id)`
  - Set `CredentialMetadataSchema(id) = to_version`
- Records a `MetadataMigration` entry for audit
- Returns count of migrated credentials

**Migration transform functions (extensible per version gap):**
- `migrate_v1_to_v2(old_bytes) -> new_bytes`
- `migrate_v2_to_v3(old_bytes) -> new_bytes`
- Each function is a pure byte transformation + schema validation

**Lazy migration helper — `resolve_metadata(credential_id)`:**
- Called by `get_credential_metadata` and other read paths
- If `CredentialMetadataSchema(id) < current_active_version`:
  - Apply migration transforms in-memory (no storage write)
  - Return transformed metadata
- If schema matches current: return directly

### Phase 3: Validation & Backward Compatibility (~1 day)

**Per-schema validators:**

```rust
fn validate_metadata_v1(env: &Env, metadata: &Bytes) -> Result<(), ContractError>
fn validate_metadata_v2(env: &Env, metadata: &Bytes) -> Result<(), ContractError>
```

Each validator checks:
- Size bounds
- Required field presence (if using structured format)
- Encoding rules

**Hooks in `set_credential_metadata`:**
- Before writing, call `validate_metadata_V{current_version}(env, &metadata)`
- Reject with `ContractError::InvalidInput` on failure

**Backward compatibility guarantee:**
- Old metadata bytes are never transformed on read unless explicitly requested
- `get_credential_metadata` always returns the original bytes, regardless of schema version
- A new `get_credential_metadata_v2` (or similar) returns the transformed/upgraded version
- This means old readers continue to work unchanged

### Phase 4: Metrics & Distribution (~0.5 day)

**New read function — `get_metadata_schema_distribution`:**
```rust
pub fn get_metadata_schema_distribution(env: &Env) -> Map<u32, u32>
```
Scans a sample or full set of credentials and returns counts per schema version.

**New event — `MetadataSchemaUpgraded`:**
```rust
env.events().publish(
    ("MetadataSchemaUpgraded", admin, to_version),
    (migrated_count,),
);
```

**Integrate with existing metrics:**
- The `MetadataMigration` record provides audit history
- Schema version distribution is available via the read function

---

## Fastest Implementation Order

| Step | Effort | What |
|------|--------|------|
| 1 | ~2h | Add `MetadataSchemaVersion`, `MetadataSchema(N)`, `CredentialMetadataSchema(id)` storage keys |
| 2 | ~2h | Add `register_metadata_schema` + `set_active_metadata_schema` admin functions |
| 3 | ~1h | Wire `CredentialMetadataSchema(id)` writes into `issue_credential`, `update_metadata`, `renew_credential_with_grace` |
| 4 | ~1h | Register v1 schema on contract init (in `__constructor`) |
| 5 | ~2h | Add `migrate_metadata_schema` batch function |
| 6 | ~2h | Add `resolve_metadata` lazy migration helper |
| 7 | ~2h | Add per-schema validators + validation hooks in `set_credential_metadata` |
| 8 | ~1h | Add `get_metadata_schema_distribution` + events |

**Total: ~13h of coding (~2 days)**

### Where to start for maximum impact

If you want the **fastest path to value**, skip lazy migration (step 6) and metrics (step 8) initially. Core changes (steps 1–5 + 7) give you:

- Schema registry + version tracking
- Admin-driven batch migration
- Write-time validation
- Full backward compatibility (old data is never rewritten)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema version stored **per credential** | Yes (`CredentialMetadataSchema(id)`) | Enables gradual migration — credentials migrate individually |
| Lazy migration rewrites storage? | No, only in-memory transform | Avoids gas cost on reads; storage migration is admin-triggered |
| Validation on **write only** | Yes | Old metadata is presumed valid (it passed validation when written) |
| Schema registry mutable? | Immutable (append-only) | Once registered, a schema version cannot be changed; only superseded |
| Migration sequential? | Yes, `vN → vN+1` only | Each migration function is small and composable |
| New storage under `DataKey2`? | Yes | Avoids disrupting existing `DataKey` layout |

---

## Testing Strategy

| Test | What it covers |
|------|---------------|
| `test_register_schema` | Admin registers v1, v2; non-admin rejected |
| `test_set_active_schema` | Activating sequential versions; invalid version rejected |
| `test_new_credentials_use_active_schema` | Issued credential has correct `CredentialMetadataSchema` |
| `test_updated_credentials_use_active_schema` | After metadata update, schema version updated |
| `test_old_credentials_readable_v1` | Pre-migration credential still returns metadata |
| `test_metadata_migration_batch` | Batch of credentials migrated from v1→v2, data verified |
| `test_migration_preserves_data` | After migration, metadata content matches expected v2 format |
| `test_metadata_validation_v1` | Invalid v1 metadata rejected on write |
| `test_metadata_validation_v2` | Invalid v2 metadata rejected on write |
| `test_lazy_resolve_old_schema` | Reading v1 credential returns correct v2-transformed data |
| `test_schema_distribution` | Distribution counts correct after mixed migration |
| `test_migration_performance` | Batch of 100 credentials migrated within gas limits |
| `test_credential_version_independence` | `Credential.version` unchanged by schema migration |
| `test_backward_compat_old_readers` | Old `get_credential_metadata` still works after migration |
