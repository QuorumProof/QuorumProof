use soroban_sdk::{contracttype, Env, Symbol};

/// Semantic versioning for contracts
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Version { major, minor, patch }
    }

    pub fn current() -> Self {
        Version::new(1, 0, 0)
    }

    pub fn is_compatible_with(&self, other: &Version) -> bool {
        // Same major version = compatible
        self.major == other.major
    }

    pub fn to_string(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Contract version metadata stored in persistent storage
#[contracttype]
#[derive(Clone)]
pub struct ContractVersionMetadata {
    pub version: Version,
    pub deployed_at: u64,
    pub previous_version: Option<Version>,
}

const CONTRACT_VERSION_KEY: &str = "contract_version";
const VERSION_HISTORY_KEY: &str = "version_history";

pub fn get_contract_version(env: &Env) -> Version {
    let key = Symbol::new(env, CONTRACT_VERSION_KEY);
    env.storage()
        .persistent()
        .get::<Symbol, Version>(&key)
        .unwrap_or_else(|| Version::current())
}

pub fn set_contract_version(env: &Env, version: Version) {
    let key = Symbol::new(env, CONTRACT_VERSION_KEY);
    env.storage().persistent().set(&key, &version);
}

pub fn get_version_history(env: &Env) -> soroban_sdk::Vec<ContractVersionMetadata> {
    let key = Symbol::new(env, VERSION_HISTORY_KEY);
    env.storage()
        .persistent()
        .get::<Symbol, soroban_sdk::Vec<ContractVersionMetadata>>(&key)
        .unwrap_or_else(|| soroban_sdk::Vec::new(env))
}

pub fn add_version_to_history(env: &Env, version: Version, previous_version: Option<Version>) {
    let mut history = get_version_history(env);
    let metadata = ContractVersionMetadata {
        version: version.clone(),
        deployed_at: env.ledger().timestamp(),
        previous_version,
    };
    history.push_back(metadata);
    let key = Symbol::new(env, VERSION_HISTORY_KEY);
    env.storage().persistent().set(&key, &history);
}

/// Upgrade compatibility matrix
#[contracttype]
#[derive(Clone)]
pub struct UpgradeCompatibility {
    pub from_version: Version,
    pub to_version: Version,
    pub is_compatible: bool,
    pub migration_required: bool,
}

const COMPATIBILITY_MATRIX_KEY: &str = "upgrade_compatibility";

pub fn check_upgrade_compatibility(env: &Env, from: &Version, to: &Version) -> bool {
    // Same major version is always compatible
    if from.major == to.major {
        return true;
    }
    
    // Check custom compatibility matrix
    let key = Symbol::new(env, COMPATIBILITY_MATRIX_KEY);
    if let Some(matrix) = env.storage()
        .persistent()
        .get::<Symbol, soroban_sdk::Vec<UpgradeCompatibility>>(&key)
    {
        for compat in matrix.iter() {
            if compat.from_version == *from && compat.to_version == *to {
                return compat.is_compatible;
            }
        }
    }
    
    false
}

pub fn register_compatibility(
    env: &Env,
    from: Version,
    to: Version,
    is_compatible: bool,
    migration_required: bool,
) {
    let mut matrix = env.storage()
        .persistent()
        .get::<Symbol, soroban_sdk::Vec<UpgradeCompatibility>>(
            &Symbol::new(env, COMPATIBILITY_MATRIX_KEY),
        )
        .unwrap_or_else(|| soroban_sdk::Vec::new(env));

    let compat = UpgradeCompatibility {
        from_version: from,
        to_version: to,
        is_compatible,
        migration_required,
    };
    matrix.push_back(compat);

    let key = Symbol::new(env, COMPATIBILITY_MATRIX_KEY);
    env.storage().persistent().set(&key, &matrix);
}
