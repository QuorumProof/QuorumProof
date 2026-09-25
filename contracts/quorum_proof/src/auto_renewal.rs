//! Credential Auto-Renewal Module — Issue #1584
//!
//! Enables automatic credential renewal when approaching expiry, with owner approval flow.
//! Reduces manual renewal burden while maintaining security through explicit opt-in.
//!
//! ## Features
//! - `auto_renew` flag on credentials enables automatic renewal triggering
//! - Renewal confirmation flow prevents surprise renewals
//! - Hooks trigger when credential enters renewal window
//! - Renewal events logged for audit trail

use soroban_sdk::{Address, Env};

/// Auto-renewal configuration for a credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutoRenewalConfig {
    /// If true, credential may be auto-renewed by issuer without explicit holder request
    pub enabled: bool,
    /// Maximum number of automatic renewals before requiring explicit action
    pub max_auto_renewals: u32,
}

impl AutoRenewalConfig {
    pub fn enabled() -> Self {
        AutoRenewalConfig {
            enabled: true,
            max_auto_renewals: 3,
        }
    }

    pub fn disabled() -> Self {
        AutoRenewalConfig {
            enabled: false,
            max_auto_renewals: 0,
        }
    }

    pub fn with_limit(max_renewals: u32) -> Self {
        AutoRenewalConfig {
            enabled: true,
            max_auto_renewals: max_renewals,
        }
    }
}

/// Record of auto-renewal confirmation from holder.
#[derive(Clone, Debug)]
pub struct RenewalConfirmation {
    pub credential_id: u64,
    pub confirmed_at: u64,
    pub confirmed_by: Address,
    pub new_expiry: u64,
}

impl RenewalConfirmation {
    pub fn new(credential_id: u64, confirmed_at: u64, confirmed_by: Address, new_expiry: u64) -> Self {
        RenewalConfirmation {
            credential_id,
            confirmed_at,
            confirmed_by,
            new_expiry,
        }
    }
}

/// Auto-renewal state for a credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoRenewalState {
    /// Auto-renewal not enabled for this credential
    Disabled = 0,
    /// Auto-renewal enabled and ready to trigger
    Enabled = 1,
    /// Awaiting holder confirmation for renewal
    AwaitingConfirmation = 2,
    /// Auto-renewal completed
    Completed = 3,
    /// Auto-renewal limit reached, manual renewal required
    LimitReached = 4,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auto_renewal_config_enabled() {
        let config = AutoRenewalConfig::enabled();
        assert!(config.enabled);
        assert_eq!(config.max_auto_renewals, 3);
    }

    #[test]
    fn test_auto_renewal_config_disabled() {
        let config = AutoRenewalConfig::disabled();
        assert!(!config.enabled);
        assert_eq!(config.max_auto_renewals, 0);
    }

    #[test]
    fn test_auto_renewal_config_with_limit() {
        let config = AutoRenewalConfig::with_limit(5);
        assert!(config.enabled);
        assert_eq!(config.max_auto_renewals, 5);
    }
}
