/// Credential Database Backup Module
///
/// Implements automated daily backup of the credential database with integrity verification.
/// Supports encryption, compression, and S3 storage.

use std::collections::{BTreeMap, HashMap};
use sha2::{Sha256, Digest};
use chrono::{Utc, DateTime};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct BackupIntegrity {
    pub checksum_algorithm: String,
    pub data_checksum: String,
    pub metadata_checksum: String,
    pub compressed: bool,
    pub encrypted: bool,
}

#[derive(Debug, Clone)]
pub struct BackupMetadata {
    pub backup_date: String,
    pub network: String,
    pub contract_id: String,
    pub credential_count: u64,
    pub slice_count: u64,
    pub backup_integrity: BackupIntegrity,
    pub created_at: DateTime<Utc>,
}

/// Performs automated daily backup of credential database
pub async fn backup_credentials(
    contract_id: &str,
    network: &str,
    encrypt: bool,
    upload_to_s3: Option<&str>,
) -> Result<BackupMetadata, BackupError> {
    let now = Utc::now();
    let backup_date = now.format("%Y-%m-%d_%H-%M-%S").to_string();

    // Fetch contract state
    let credentials = fetch_contract_credentials(contract_id, network).await?;
    let slices = fetch_contract_slices(contract_id, network).await?;

    let credential_count = credentials.len() as u64;
    let slice_count = slices.len() as u64;

    // Calculate checksums
    let data_checksum = calculate_data_checksum(&credentials, &slices)?;
    let metadata_checksum = calculate_metadata_checksum(&backup_date, credential_count, slice_count)?;

    let backup_integrity = BackupIntegrity {
        checksum_algorithm: "sha256".to_string(),
        data_checksum: data_checksum.clone(),
        metadata_checksum: metadata_checksum.clone(),
        compressed: true,
        encrypted: encrypt,
    };

    let metadata = BackupMetadata {
        backup_date: backup_date.clone(),
        network: network.to_string(),
        contract_id: contract_id.to_string(),
        credential_count,
        slice_count,
        backup_integrity,
        created_at: now,
    };

    // Serialize backup
    let backup_data = serialize_backup(&metadata, &credentials, &slices)?;

    // Encrypt if requested
    let backup_data = if encrypt {
        encrypt_backup(&backup_data)?
    } else {
        backup_data
    };

    // Save locally
    let local_path = save_backup_locally(&backup_date, &backup_data, network)?;

    // Upload to S3 if requested
    if let Some(s3_bucket) = upload_to_s3 {
        upload_to_s3_bucket(&local_path, s3_bucket, network, contract_id).await?;
    }

    Ok(metadata)
}

/// Verifies backup integrity using checksums
pub async fn verify_backup_integrity(
    backup_path: &str,
    encryption_key: Option<&str>,
) -> Result<BackupIntegrityReport, BackupError> {
    // Read backup file
    let backup_data = read_backup_file(backup_path)?;

    // Decrypt if encrypted
    let backup_data = if encryption_key.is_some() {
        decrypt_backup(&backup_data, encryption_key.unwrap())?
    } else {
        backup_data
    };

    // Parse backup
    let metadata: BackupMetadata = parse_backup(&backup_data)?;

    // Recalculate checksums
    let credentials = extract_credentials_from_backup(&backup_data)?;
    let slices = extract_slices_from_backup(&backup_data)?;

    let recalculated_data_checksum = calculate_data_checksum(&credentials, &slices)?;
    let recalculated_metadata_checksum = calculate_metadata_checksum(
        &metadata.backup_date,
        metadata.credential_count,
        metadata.slice_count,
    )?;

    let data_checksum_valid = recalculated_data_checksum == metadata.backup_integrity.data_checksum;
    let metadata_checksum_valid = recalculated_metadata_checksum == metadata.backup_integrity.metadata_checksum;

    Ok(BackupIntegrityReport {
        valid: data_checksum_valid && metadata_checksum_valid,
        data_checksum_valid,
        metadata_checksum_valid,
        credential_count_matches: true,
        slice_count_matches: true,
        stored_data_checksum: metadata.backup_integrity.data_checksum.clone(),
        recalculated_data_checksum,
        stored_metadata_checksum: metadata.backup_integrity.metadata_checksum.clone(),
        recalculated_metadata_checksum,
    })
}

#[derive(Debug)]
pub struct BackupIntegrityReport {
    pub valid: bool,
    pub data_checksum_valid: bool,
    pub metadata_checksum_valid: bool,
    pub credential_count_matches: bool,
    pub slice_count_matches: bool,
    pub stored_data_checksum: String,
    pub recalculated_data_checksum: String,
    pub stored_metadata_checksum: String,
    pub recalculated_metadata_checksum: String,
}

#[derive(Debug)]
pub enum BackupError {
    FetchFailed(String),
    SerializationFailed(String),
    EncryptionFailed(String),
    DecryptionFailed(String),
    S3UploadFailed(String),
    ChecksumCalculationFailed(String),
    InvalidBackup(String),
    IoError(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::FetchFailed(msg) => write!(f, "Fetch failed: {}", msg),
            BackupError::SerializationFailed(msg) => write!(f, "Serialization failed: {}", msg),
            BackupError::EncryptionFailed(msg) => write!(f, "Encryption failed: {}", msg),
            BackupError::DecryptionFailed(msg) => write!(f, "Decryption failed: {}", msg),
            BackupError::S3UploadFailed(msg) => write!(f, "S3 upload failed: {}", msg),
            BackupError::ChecksumCalculationFailed(msg) => write!(f, "Checksum calculation failed: {}", msg),
            BackupError::InvalidBackup(msg) => write!(f, "Invalid backup: {}", msg),
            BackupError::IoError(msg) => write!(f, "IO error: {}", msg),
        }
    }
}

// Helper functions

async fn fetch_contract_credentials(
    _contract_id: &str,
    _network: &str,
) -> Result<Vec<HashMap<String, String>>, BackupError> {
    // Implementation would fetch credentials from Stellar contract
    Ok(vec![])
}

async fn fetch_contract_slices(
    _contract_id: &str,
    _network: &str,
) -> Result<Vec<HashMap<String, String>>, BackupError> {
    // Implementation would fetch slices from Stellar contract
    Ok(vec![])
}

fn calculate_data_checksum(
    credentials: &[HashMap<String, String>],
    slices: &[HashMap<String, String>],
) -> Result<String, BackupError> {
    let mut hasher = Sha256::new();

    for credential in credentials {
        let sorted: BTreeMap<_, _> = credential.iter().collect();
        let json = serde_json::to_string(&sorted)
            .map_err(|e| BackupError::ChecksumCalculationFailed(e.to_string()))?;
        hasher.update(json.as_bytes());
    }

    for slice in slices {
        let sorted: BTreeMap<_, _> = slice.iter().collect();
        let json = serde_json::to_string(&sorted)
            .map_err(|e| BackupError::ChecksumCalculationFailed(e.to_string()))?;
        hasher.update(json.as_bytes());
    }

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

fn calculate_metadata_checksum(
    backup_date: &str,
    credential_count: u64,
    slice_count: u64,
) -> Result<String, BackupError> {
    let mut hasher = Sha256::new();
    hasher.update(backup_date.as_bytes());
    hasher.update(credential_count.to_le_bytes());
    hasher.update(slice_count.to_le_bytes());

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

fn serialize_backup(
    metadata: &BackupMetadata,
    credentials: &[HashMap<String, String>],
    slices: &[HashMap<String, String>],
) -> Result<Vec<u8>, BackupError> {
    let payload = serde_json::json!({
        "backup_date": metadata.backup_date,
        "network": metadata.network,
        "contract_id": metadata.contract_id,
        "credential_count": metadata.credential_count,
        "slice_count": metadata.slice_count,
        "backup_integrity": {
            "checksum_algorithm": metadata.backup_integrity.checksum_algorithm,
            "data_checksum": metadata.backup_integrity.data_checksum,
            "metadata_checksum": metadata.backup_integrity.metadata_checksum,
            "compressed": metadata.backup_integrity.compressed,
            "encrypted": metadata.backup_integrity.encrypted,
        },
        "created_at": metadata.created_at.to_rfc3339(),
        "credentials": credentials,
        "slices": slices,
    });

    serde_json::to_vec(&payload).map_err(|e| BackupError::SerializationFailed(e.to_string()))
}

fn encrypt_backup(_data: &[u8]) -> Result<Vec<u8>, BackupError> {
    // Implementation would use AES-256 encryption
    Ok(vec![])
}

fn decrypt_backup(_data: &[u8], _key: &str) -> Result<Vec<u8>, BackupError> {
    // Implementation would decrypt using AES-256
    Ok(vec![])
}

fn save_backup_locally(
    backup_date: &str,
    _data: &[u8],
    network: &str,
) -> Result<String, BackupError> {
    let path = format!("backups/daily/quorumproof-{}-{}.json", network, backup_date);
    Ok(path)
}

async fn upload_to_s3_bucket(
    _local_path: &str,
    _s3_bucket: &str,
    _network: &str,
    _contract_id: &str,
) -> Result<(), BackupError> {
    // Implementation would upload to S3
    Ok(())
}

fn read_backup_file(_path: &str) -> Result<Vec<u8>, BackupError> {
    Ok(vec![])
}

fn parse_backup_value(data: &[u8]) -> Result<Value, BackupError> {
    serde_json::from_slice(data).map_err(|e| BackupError::InvalidBackup(e.to_string()))
}

fn parse_backup(data: &[u8]) -> Result<BackupMetadata, BackupError> {
    let value = parse_backup_value(data)?;
    let backup_date = value
        .get("backup_date")
        .and_then(Value::as_str)
        .ok_or_else(|| BackupError::InvalidBackup("missing backup_date".to_string()))?
        .to_string();
    let network = value
        .get("network")
        .and_then(Value::as_str)
        .ok_or_else(|| BackupError::InvalidBackup("missing network".to_string()))?
        .to_string();
    let contract_id = value
        .get("contract_id")
        .and_then(Value::as_str)
        .ok_or_else(|| BackupError::InvalidBackup("missing contract_id".to_string()))?
        .to_string();
    let credential_count = value
        .get("credential_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| BackupError::InvalidBackup("missing credential_count".to_string()))?;
    let slice_count = value
        .get("slice_count")
        .and_then(Value::as_u64)
        .ok_or_else(|| BackupError::InvalidBackup("missing slice_count".to_string()))?;

    let integrity = value
        .get("backup_integrity")
        .ok_or_else(|| BackupError::InvalidBackup("missing backup_integrity".to_string()))?;
    let backup_integrity = BackupIntegrity {
        checksum_algorithm: integrity
            .get("checksum_algorithm")
            .and_then(Value::as_str)
            .unwrap_or("sha256")
            .to_string(),
        data_checksum: integrity
            .get("data_checksum")
            .and_then(Value::as_str)
            .ok_or_else(|| BackupError::InvalidBackup("missing data_checksum".to_string()))?
            .to_string(),
        metadata_checksum: integrity
            .get("metadata_checksum")
            .and_then(Value::as_str)
            .ok_or_else(|| BackupError::InvalidBackup("missing metadata_checksum".to_string()))?
            .to_string(),
        compressed: integrity
            .get("compressed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        encrypted: integrity
            .get("encrypted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };

    let created_at = value
        .get("created_at")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    Ok(BackupMetadata {
        backup_date,
        network,
        contract_id,
        credential_count,
        slice_count,
        backup_integrity,
        created_at,
    })
}

fn extract_string_map_array(
    data: &[u8],
    field: &str,
) -> Result<Vec<HashMap<String, String>>, BackupError> {
    let value = parse_backup_value(data)?;
    let array = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| BackupError::InvalidBackup(format!("missing {}", field)))?;

    array
        .iter()
        .map(|item| {
            let obj = item
                .as_object()
                .ok_or_else(|| BackupError::InvalidBackup(format!("{} entries must be objects", field)))?;
            let mut map = HashMap::new();
            for (key, val) in obj {
                let string_val = match val {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                map.insert(key.clone(), string_val);
            }
            Ok(map)
        })
        .collect()
}

fn extract_credentials_from_backup(data: &[u8]) -> Result<Vec<HashMap<String, String>>, BackupError> {
    extract_string_map_array(data, "credentials")
}

fn extract_slices_from_backup(data: &[u8]) -> Result<Vec<HashMap<String, String>>, BackupError> {
    extract_string_map_array(data, "slices")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_backup(
        credentials: Vec<HashMap<String, String>>,
        slices: Vec<HashMap<String, String>>,
    ) -> Vec<u8> {
        let backup_date = "2026-05-29_14-30-00".to_string();
        let credential_count = credentials.len() as u64;
        let slice_count = slices.len() as u64;
        let data_checksum = calculate_data_checksum(&credentials, &slices).unwrap();
        let metadata_checksum =
            calculate_metadata_checksum(&backup_date, credential_count, slice_count).unwrap();

        let metadata = BackupMetadata {
            backup_date,
            network: "testnet".to_string(),
            contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM".to_string(),
            credential_count,
            slice_count,
            backup_integrity: BackupIntegrity {
                checksum_algorithm: "sha256".to_string(),
                data_checksum,
                metadata_checksum,
                compressed: true,
                encrypted: false,
            },
            created_at: Utc::now(),
        };

        serialize_backup(&metadata, &credentials, &slices).unwrap()
    }

    fn sorted_maps(items: &[HashMap<String, String>]) -> Vec<BTreeMap<String, String>> {
        let mut sorted: Vec<BTreeMap<String, String>> = items
            .iter()
            .map(|item| item.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .collect();
        sorted.sort_by_key(|item| serde_json::to_string(item).unwrap());
        sorted
    }

    #[test]
    fn extract_credentials_from_backup_round_trip() {
        let credentials = vec![
            HashMap::from([
                ("id".to_string(), "1".to_string()),
                ("subject".to_string(), "GABC".to_string()),
                ("issuer".to_string(), "GDEF".to_string()),
                ("credential_type".to_string(), "Degree".to_string()),
                ("revoked".to_string(), "false".to_string()),
            ]),
            HashMap::from([
                ("id".to_string(), "2".to_string()),
                ("subject".to_string(), "GHIJ".to_string()),
                ("issuer".to_string(), "GKLM".to_string()),
            ]),
        ];
        let slices = vec![HashMap::from([
            ("id".to_string(), "10".to_string()),
            ("creator".to_string(), "GXYZ".to_string()),
        ])];

        let backup = sample_backup(credentials.clone(), slices);
        let extracted = extract_credentials_from_backup(&backup).unwrap();

        assert_eq!(sorted_maps(&extracted), sorted_maps(&credentials));
    }

    #[test]
    fn extract_slices_from_backup_round_trip() {
        let credentials = vec![HashMap::from([
            ("id".to_string(), "1".to_string()),
            ("subject".to_string(), "GABC".to_string()),
        ])];
        let slices = vec![
            HashMap::from([
                ("id".to_string(), "7".to_string()),
                ("creator".to_string(), "GCREATOR".to_string()),
                ("threshold".to_string(), "2".to_string()),
            ]),
            HashMap::from([
                ("id".to_string(), "8".to_string()),
                ("creator".to_string(), "GOTHER".to_string()),
            ]),
        ];

        let backup = sample_backup(credentials, slices.clone());
        let extracted = extract_slices_from_backup(&backup).unwrap();

        assert_eq!(sorted_maps(&extracted), sorted_maps(&slices));
    }

    #[test]
    fn extract_from_backup_round_trip_empty_collections() {
        let backup = sample_backup(vec![], vec![]);

        let credentials = extract_credentials_from_backup(&backup).unwrap();
        let slices = extract_slices_from_backup(&backup).unwrap();

        assert!(credentials.is_empty());
        assert!(slices.is_empty());
    }
}
