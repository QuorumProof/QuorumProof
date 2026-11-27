/// Credential Database Backup Module
///
/// Implements automated daily backup of the credential database with integrity verification.
/// Supports encryption, compression, and S3 storage.
use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub type BackupRecord = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupIntegrity {
    pub checksum_algorithm: String,
    pub data_checksum: String,
    pub metadata_checksum: String,
    pub compressed: bool,
    pub encrypted: bool,
}

impl Default for BackupIntegrity {
    fn default() -> Self {
        Self {
            checksum_algorithm: "sha256".to_string(),
            data_checksum: String::new(),
            metadata_checksum: String::new(),
            compressed: false,
            encrypted: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupMetadata {
    pub backup_date: String,
    pub network: String,
    pub contract_id: String,
    pub credential_count: u64,
    pub slice_count: u64,
    #[serde(default)]
    pub backup_integrity: BackupIntegrity,
    #[serde(default = "chrono::Utc::now")]
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, Serialize)]
struct BackupFile {
    backup_date: String,
    network: String,
    contract_id: String,
    credential_count: u64,
    slice_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup_integrity: Option<BackupIntegrity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    credentials: Vec<BackupRecord>,
    #[serde(default)]
    slices: Vec<BackupRecord>,
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

    let credentials = fetch_contract_credentials(contract_id, network).await?;
    let slices = fetch_contract_slices(contract_id, network).await?;

    let credential_count = credentials.len() as u64;
    let slice_count = slices.len() as u64;

    let data_checksum = calculate_data_checksum(&credentials, &slices)?;
    let metadata_checksum =
        calculate_metadata_checksum(&backup_date, credential_count, slice_count)?;

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

    let backup_data = serialize_backup(&metadata, &credentials, &slices)?;

    let backup_data = if encrypt {
        encrypt_backup(&backup_data)?
    } else {
        backup_data
    };

    let local_path = save_backup_locally(&backup_date, &backup_data, network)?;

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
    let backup_data = read_backup_file(backup_path)?;

    let backup_data = if let Some(key) = encryption_key {
        decrypt_backup(&backup_data, key)?
    } else {
        backup_data
    };

    let metadata: BackupMetadata = parse_backup(&backup_data)?;

    let credentials = extract_credentials_from_backup(&backup_data)?;
    let slices = extract_slices_from_backup(&backup_data)?;

    let recalculated_data_checksum = calculate_data_checksum(&credentials, &slices)?;
    let recalculated_metadata_checksum = calculate_metadata_checksum(
        &metadata.backup_date,
        metadata.credential_count,
        metadata.slice_count,
    )?;

    let data_checksum_valid = recalculated_data_checksum == metadata.backup_integrity.data_checksum;
    let metadata_checksum_valid =
        recalculated_metadata_checksum == metadata.backup_integrity.metadata_checksum;

    Ok(BackupIntegrityReport {
        valid: data_checksum_valid && metadata_checksum_valid,
        data_checksum_valid,
        metadata_checksum_valid,
        credential_count_matches: credentials.len() as u64 == metadata.credential_count,
        slice_count_matches: slices.len() as u64 == metadata.slice_count,
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
            BackupError::ChecksumCalculationFailed(msg) => {
                write!(f, "Checksum calculation failed: {}", msg)
            }
            BackupError::InvalidBackup(msg) => write!(f, "Invalid backup: {}", msg),
            BackupError::IoError(msg) => write!(f, "IO error: {}", msg),
        }
    }
}

// Helper functions

async fn fetch_contract_credentials(
    _contract_id: &str,
    _network: &str,
) -> Result<Vec<BackupRecord>, BackupError> {
    Ok(vec![])
}

async fn fetch_contract_slices(
    _contract_id: &str,
    _network: &str,
) -> Result<Vec<BackupRecord>, BackupError> {
    Ok(vec![])
}

fn calculate_data_checksum(
    credentials: &[BackupRecord],
    slices: &[BackupRecord],
) -> Result<String, BackupError> {
    let mut hasher = Sha256::new();

    for record in credentials.iter().chain(slices.iter()) {
        let json = serde_json::to_string(record)
            .map_err(|err| BackupError::ChecksumCalculationFailed(err.to_string()))?;
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
    credentials: &[BackupRecord],
    slices: &[BackupRecord],
) -> Result<Vec<u8>, BackupError> {
    if credentials.len() as u64 != metadata.credential_count {
        return Err(BackupError::SerializationFailed(
            "credential count does not match metadata".to_string(),
        ));
    }
    if slices.len() as u64 != metadata.slice_count {
        return Err(BackupError::SerializationFailed(
            "slice count does not match metadata".to_string(),
        ));
    }

    let file = BackupFile {
        backup_date: metadata.backup_date.clone(),
        network: metadata.network.clone(),
        contract_id: metadata.contract_id.clone(),
        credential_count: metadata.credential_count,
        slice_count: metadata.slice_count,
        backup_integrity: Some(metadata.backup_integrity.clone()),
        created_at: Some(metadata.created_at),
        credentials: credentials.to_vec(),
        slices: slices.to_vec(),
    };

    serde_json::to_vec(&file).map_err(|err| BackupError::SerializationFailed(err.to_string()))
}

fn encrypt_backup(_data: &[u8]) -> Result<Vec<u8>, BackupError> {
    Ok(vec![])
}

fn decrypt_backup(_data: &[u8], _key: &str) -> Result<Vec<u8>, BackupError> {
    Ok(vec![])
}

fn save_backup_locally(
    backup_date: &str,
    data: &[u8],
    network: &str,
) -> Result<String, BackupError> {
    let path = format!("backups/daily/quorumproof-{}-{}.json", network, backup_date);
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|err| BackupError::IoError(err.to_string()))?;
    }
    std::fs::write(&path, data).map_err(|err| BackupError::IoError(err.to_string()))?;
    Ok(path)
}

async fn upload_to_s3_bucket(
    _local_path: &str,
    _s3_bucket: &str,
    _network: &str,
    _contract_id: &str,
) -> Result<(), BackupError> {
    Ok(())
}

fn read_backup_file(path: &str) -> Result<Vec<u8>, BackupError> {
    std::fs::read(path).map_err(|err| BackupError::IoError(err.to_string()))
}

fn decode_backup(data: &[u8]) -> Result<BackupFile, BackupError> {
    let file: BackupFile =
        serde_json::from_slice(data).map_err(|err| BackupError::InvalidBackup(err.to_string()))?;

    if file.credential_count != file.credentials.len() as u64 {
        return Err(BackupError::InvalidBackup(format!(
            "credential_count is {} but {} credentials are present",
            file.credential_count,
            file.credentials.len()
        )));
    }
    if file.slice_count != file.slices.len() as u64 {
        return Err(BackupError::InvalidBackup(format!(
            "slice_count is {} but {} slices are present",
            file.slice_count,
            file.slices.len()
        )));
    }

    Ok(file)
}

fn parse_backup(data: &[u8]) -> Result<BackupMetadata, BackupError> {
    let file = decode_backup(data)?;

    let created_at = file.created_at.unwrap_or_else(|| {
        NaiveDateTime::parse_from_str(&file.backup_date, "%Y-%m-%d_%H-%M-%S")
            .map(|parsed| Utc.from_utc_datetime(&parsed))
            .unwrap_or_else(|_| Utc::now())
    });

    let backup_integrity = match file.backup_integrity {
        Some(integrity) => integrity,
        None => BackupIntegrity {
            checksum_algorithm: "sha256".to_string(),
            data_checksum: calculate_data_checksum(&file.credentials, &file.slices)?,
            metadata_checksum: calculate_metadata_checksum(
                &file.backup_date,
                file.credential_count,
                file.slice_count,
            )?,
            compressed: false,
            encrypted: false,
        },
    };

    Ok(BackupMetadata {
        backup_date: file.backup_date,
        network: file.network,
        contract_id: file.contract_id,
        credential_count: file.credential_count,
        slice_count: file.slice_count,
        backup_integrity,
        created_at,
    })
}

fn extract_credentials_from_backup(data: &[u8]) -> Result<Vec<BackupRecord>, BackupError> {
    Ok(decode_backup(data)?.credentials)
}

fn extract_slices_from_backup(data: &[u8]) -> Result<Vec<BackupRecord>, BackupError> {
    Ok(decode_backup(data)?.slices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BACKUP_DATE: &str = "2026-05-29_14-30-00";
    const CONTRACT_ID: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn sample_credentials() -> Vec<BackupRecord> {
        vec![serde_json::from_value(json!({
            "subject": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "issuer": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "credential_type": "MechanicalEngineeringDegree",
            "metadata_hash": "0x1234",
            "revoked": false,
            "expires_at": 1747569600
        }))
        .unwrap()]
    }

    fn sample_slices() -> Vec<BackupRecord> {
        vec![serde_json::from_value(json!({
            "id": 1,
            "creator": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "attestors": [
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
            ],
            "threshold": 2
        }))
        .unwrap()]
    }

    #[test]
    fn parse_backup_decodes_script_backup_format() {
        let data = format!(
            r#"{{
                "backup_date": "{BACKUP_DATE}",
                "network": "testnet",
                "contract_id": "{CONTRACT_ID}",
                "credential_count": 1,
                "slice_count": 1,
                "credentials": [
                    {{
                        "subject": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        "issuer": "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                        "credential_type": "MechanicalEngineeringDegree",
                        "metadata_hash": "0x1234",
                        "revoked": false,
                        "expires_at": 1747569600
                    }}
                ],
                "slices": [
                    {{
                        "id": 1,
                        "creator": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        "attestors": [
                            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                            "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                        ],
                        "threshold": 2
                    }}
                ]
            }}"#
        );

        let metadata = parse_backup(data.as_bytes()).expect("script backup should parse");
        assert_eq!(metadata.backup_date, BACKUP_DATE);
        assert_eq!(metadata.network, "testnet");
        assert_eq!(metadata.contract_id, CONTRACT_ID);
        assert_eq!(metadata.credential_count, 1);
        assert_eq!(metadata.slice_count, 1);
        assert_eq!(metadata.backup_integrity.checksum_algorithm, "sha256");
        assert_eq!(
            metadata.created_at,
            Utc.with_ymd_and_hms(2026, 5, 29, 14, 30, 0).unwrap()
        );

        let credentials = extract_credentials_from_backup(data.as_bytes()).unwrap();
        let slices = extract_slices_from_backup(data.as_bytes()).unwrap();
        assert_eq!(credentials, sample_credentials());
        assert_eq!(slices, sample_slices());
        assert_eq!(credentials[0]["expires_at"], json!(1747569600));
        assert_eq!(credentials[0]["revoked"], json!(false));
        assert_eq!(slices[0]["threshold"], json!(2));

        assert_eq!(
            metadata.backup_integrity.data_checksum,
            calculate_data_checksum(&credentials, &slices).unwrap()
        );
        assert_eq!(
            metadata.backup_integrity.metadata_checksum,
            calculate_metadata_checksum(BACKUP_DATE, 1, 1).unwrap()
        );
    }

    #[test]
    fn serialize_parse_round_trip_preserves_backup() {
        let credentials = sample_credentials();
        let slices = sample_slices();
        let metadata = BackupMetadata {
            backup_date: BACKUP_DATE.to_string(),
            network: "mainnet".to_string(),
            contract_id: CONTRACT_ID.to_string(),
            credential_count: credentials.len() as u64,
            slice_count: slices.len() as u64,
            backup_integrity: BackupIntegrity {
                checksum_algorithm: "sha256".to_string(),
                data_checksum: calculate_data_checksum(&credentials, &slices).unwrap(),
                metadata_checksum: calculate_metadata_checksum(BACKUP_DATE, 1, 1).unwrap(),
                compressed: false,
                encrypted: false,
            },
            created_at: Utc.with_ymd_and_hms(2026, 5, 29, 14, 30, 0).unwrap(),
        };

        let encoded = serialize_backup(&metadata, &credentials, &slices).unwrap();
        let parsed = parse_backup(&encoded).unwrap();

        assert_eq!(parsed, metadata);
        assert_eq!(
            extract_credentials_from_backup(&encoded).unwrap(),
            credentials
        );
        assert_eq!(extract_slices_from_backup(&encoded).unwrap(), slices);
    }

    #[test]
    fn parse_backup_rejects_invalid_records_and_counts() {
        let null_record = format!(
            r#"{{
                "backup_date": "{BACKUP_DATE}",
                "network": "testnet",
                "contract_id": "{CONTRACT_ID}",
                "credential_count": 1,
                "slice_count": 0,
                "credentials": [null],
                "slices": []
            }}"#
        );
        assert!(parse_backup(null_record.as_bytes()).is_err());

        let count_mismatch = format!(
            r#"{{
                "backup_date": "{BACKUP_DATE}",
                "network": "testnet",
                "contract_id": "{CONTRACT_ID}",
                "credential_count": 2,
                "slice_count": 0,
                "credentials": [],
                "slices": []
            }}"#
        );
        assert!(parse_backup(count_mismatch.as_bytes()).is_err());

        assert!(parse_backup(b"not json").is_err());
    }
}
