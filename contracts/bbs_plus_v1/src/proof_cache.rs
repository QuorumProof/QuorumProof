/// # BBS+ Proof Template Cache — Issue #1291
///
/// Common disclosure patterns (e.g. "just prove you have a degree") are
/// identical in structure across many credential holders. Rather than
/// regenerating the full Fiat-Shamir proof parameters each time, a *proof
/// template* captures the verifying-key fingerprint plus the set of indices
/// that are revealed/hidden, and a cached template can be retrieved by any
/// caller that matches the same pattern.
///
/// ## Design
/// - A `ProofTemplate` encodes the reusable skeleton: which message indices
///   are revealed, and a hash of the verifying key that gates the match.
/// - The `ProofTemplateRegistry` is an in-process, `no_std`-compatible
///   store backed by a `BTreeMap` keyed on a pattern identifier (`Bytes`).
/// - Cache invalidation is explicit: call `invalidate(pattern)` whenever the
///   credential that underlies a pattern is updated.
/// - The API surface mirrors the issue requirements exactly:
///   - `register_template`  — store a named pattern template
///   - `get_cached_proof_template` — retrieve `Option<ProofTemplate>`
///   - `invalidate_on_credential_update` — evict related templates
///
/// ## Benchmark surface
/// Cache hit rates can be measured by wrapping the registry in a
/// `CacheStats`-decorated newtype (see below).

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::errors::BbsResult;

/// A stable, ordered byte string used as a cache key.
pub type PatternKey = Vec<u8>;

/// Bit-packed flag set describing which message slots are revealed.
///
/// The set stores up to 256 revealed indices as a sorted `Vec<u32>` that is
/// kept deduplicated and ordered on insertion so equality checks are O(n).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevealedSet(pub Vec<u32>);

impl RevealedSet {
    /// Create a new set from an unordered, possibly-duplicate slice.
    pub fn from_indices(indices: &[u32]) -> Self {
        let mut v: Vec<u32> = indices.to_vec();
        v.sort_unstable();
        v.dedup();
        RevealedSet(v)
    }

    /// True if `index` is marked for disclosure.
    pub fn contains(&self, index: u32) -> bool {
        self.0.binary_search(&index).is_ok()
    }

    /// Sorted revealed indices.
    pub fn indices(&self) -> &[u32] {
        &self.0
    }
}

/// A proof template captures the reusable, credential-type-level parameters
/// for a common disclosure pattern.
///
/// Templates are *not* proofs — they carry no witness material.  They encode
/// *which* fields a standard presentation for this pattern reveals, bound to
/// a specific verifying-key via `vk_fingerprint` (SHA-256 of the key's wire
/// encoding).  A presentation engine can use a matching template to skip the
/// per-request setup work (generator selection, index validation) that would
/// otherwise be repeated for every holder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofTemplate {
    /// Human-readable name for the pattern (e.g. `"degree-only"`).
    pub name: Vec<u8>,
    /// SHA-256 of the `VerifyingKey::to_bytes()` this template was built
    /// against.  Prevents silently applying a template to the wrong key after
    /// a key rotation.
    pub vk_fingerprint: [u8; 32],
    /// The set of message indices revealed in this pattern.
    pub revealed: RevealedSet,
    /// Total message count the verifying key was derived for.  Used during
    /// validation to detect mismatch without loading the full key.
    pub message_count: u32,
    /// Optional human-readable description of what each revealed index
    /// represents (index → label).
    pub field_labels: BTreeMap<u32, Vec<u8>>,
}

impl ProofTemplate {
    /// Construct a new template.
    pub fn new(
        name: &[u8],
        vk_fingerprint: [u8; 32],
        revealed_indices: &[u32],
        message_count: u32,
    ) -> Self {
        ProofTemplate {
            name: name.to_vec(),
            vk_fingerprint,
            revealed: RevealedSet::from_indices(revealed_indices),
            message_count,
            field_labels: BTreeMap::new(),
        }
    }

    /// Attach a human-readable label to a revealed field index.
    pub fn with_label(mut self, index: u32, label: &[u8]) -> Self {
        self.field_labels.insert(index, label.to_vec());
        self
    }

    /// Validate that this template is compatible with a credential having
    /// `msg_count` messages.  Returns `false` if any revealed index would be
    /// out-of-bounds or the stored message count does not match.
    pub fn is_compatible(&self, msg_count: u32, vk_fingerprint: &[u8; 32]) -> bool {
        if self.message_count != msg_count {
            return false;
        }
        if &self.vk_fingerprint != vk_fingerprint {
            return false;
        }
        self.revealed.indices().iter().all(|&i| i < msg_count)
    }
}

/// Cache statistics for benchmarking hit rates.
#[derive(Clone, Debug, Default)]
pub struct CacheStats {
    /// Number of successful cache lookups (`get_cached_proof_template`
    /// returned `Some`).
    pub hits: u64,
    /// Number of failed lookups (`get_cached_proof_template` returned
    /// `None`).
    pub misses: u64,
    /// Number of entries evicted via `invalidate_on_credential_update`.
    pub invalidations: u64,
    /// Total number of templates currently stored.
    pub stored_count: u64,
}

impl CacheStats {
    /// Compute hit rate as a percentage (0–100).  Returns 0 if no lookups
    /// have been made yet.
    pub fn hit_rate_pct(&self) -> u64 {
        let total = self.hits + self.misses;
        if total == 0 {
            return 0;
        }
        (self.hits * 100) / total
    }
}

/// In-process proof template registry.
///
/// Keys are arbitrary `PatternKey` byte strings chosen by the caller
/// (e.g. `b"degree-only"`, `b"employer-and-year"`, …).
///
/// Thread-safety: this type is `!Sync` by design — it is meant to be held
/// per-request or per-session, not shared across threads.  Soroban contract
/// calls are single-threaded, so this is not a restriction in practice.
pub struct ProofTemplateRegistry {
    store: BTreeMap<PatternKey, ProofTemplate>,
    /// Credential-ID → list of pattern keys that depend on it.
    /// Used to bulk-invalidate on credential update.
    credential_index: BTreeMap<Vec<u8>, Vec<PatternKey>>,
    stats: CacheStats,
}

impl ProofTemplateRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        ProofTemplateRegistry {
            store: BTreeMap::new(),
            credential_index: BTreeMap::new(),
            stats: CacheStats::default(),
        }
    }

    /// Store a proof template under `pattern`.
    ///
    /// If `credential_id` is `Some`, the template is associated with that
    /// credential so it can be invalidated when the credential changes.
    ///
    /// Overwrites any existing template for the same `pattern` key.
    pub fn register_template(
        &mut self,
        pattern: &[u8],
        template: ProofTemplate,
        credential_id: Option<&[u8]>,
    ) {
        let key: PatternKey = pattern.to_vec();

        if let Some(cred) = credential_id {
            self.credential_index
                .entry(cred.to_vec())
                .or_insert_with(Vec::new)
                .push(key.clone());
        }

        let is_new = !self.store.contains_key(&key);
        self.store.insert(key, template);
        if is_new {
            self.stats.stored_count = self.stats.stored_count.saturating_add(1);
        }
    }

    /// Retrieve a cached proof template.
    ///
    /// Returns `Some(&ProofTemplate)` on a cache hit, `None` on a miss.
    /// Updates internal hit/miss counters.
    pub fn get_cached_proof_template(&mut self, pattern: &[u8]) -> Option<&ProofTemplate> {
        let result = self.store.get(pattern as &[u8]);
        if result.is_some() {
            self.stats.hits = self.stats.hits.saturating_add(1);
        } else {
            self.stats.misses = self.stats.misses.saturating_add(1);
        }
        result
    }

    /// Invalidate (remove) a single pattern from the cache.
    ///
    /// Returns `true` if an entry was present and has been evicted.
    pub fn invalidate(&mut self, pattern: &[u8]) -> bool {
        if self.store.remove(pattern as &[u8]).is_some() {
            self.stats.invalidations = self.stats.invalidations.saturating_add(1);
            self.stats.stored_count = self.stats.stored_count.saturating_sub(1);
            true
        } else {
            false
        }
    }

    /// Invalidate all templates associated with `credential_id`.
    ///
    /// This must be called whenever a credential is updated (e.g. re-issued,
    /// attribute changed, or revoked) so that stale templates are not reused.
    ///
    /// Returns the number of entries evicted.
    pub fn invalidate_on_credential_update(&mut self, credential_id: &[u8]) -> usize {
        let patterns = match self.credential_index.remove(credential_id as &[u8]) {
            Some(p) => p,
            None => return 0,
        };
        let mut evicted = 0usize;
        for key in &patterns {
            if self.store.remove(key).is_some() {
                evicted += 1;
                self.stats.invalidations = self.stats.invalidations.saturating_add(1);
                self.stats.stored_count = self.stats.stored_count.saturating_sub(1);
            }
        }
        evicted
    }

    /// Return a reference to the current statistics snapshot.
    pub fn stats(&self) -> &CacheStats {
        &self.stats
    }

    /// Current number of templates in the registry.
    pub fn len(&self) -> usize {
        self.store.len()
    }

    /// True if the registry holds no templates.
    pub fn is_empty(&self) -> bool {
        self.store.is_empty()
    }
}

impl Default for ProofTemplateRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute a 32-byte SHA-256 fingerprint of a verifying-key byte string.
///
/// Used by callers to produce the `vk_fingerprint` stored in a
/// `ProofTemplate` without depending on the `signature` module directly.
pub fn vk_fingerprint(vk_bytes: &[u8]) -> BbsResult<[u8; 32]> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(vk_bytes);
    let out = hasher.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(&out);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_fingerprint(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    #[test]
    fn test_register_and_get_template() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(1);
        let template = ProofTemplate::new(b"degree-only", fp, &[1], 3);
        registry.register_template(b"degree-only", template.clone(), None);

        let cached = registry.get_cached_proof_template(b"degree-only");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().name, b"degree-only");
    }

    #[test]
    fn test_cache_miss_increments_counter() {
        let mut registry = ProofTemplateRegistry::new();
        let _ = registry.get_cached_proof_template(b"nonexistent");
        assert_eq!(registry.stats().misses, 1);
        assert_eq!(registry.stats().hits, 0);
    }

    #[test]
    fn test_cache_hit_increments_counter() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(2);
        let template = ProofTemplate::new(b"employer-year", fp, &[2, 3], 5);
        registry.register_template(b"employer-year", template, None);

        let _ = registry.get_cached_proof_template(b"employer-year");
        let _ = registry.get_cached_proof_template(b"employer-year");
        assert_eq!(registry.stats().hits, 2);
        assert_eq!(registry.stats().misses, 0);
    }

    #[test]
    fn test_invalidate_removes_entry() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(3);
        let template = ProofTemplate::new(b"test", fp, &[0], 2);
        registry.register_template(b"test", template, None);

        assert!(registry.invalidate(b"test"));
        assert!(registry.get_cached_proof_template(b"test").is_none());
        assert_eq!(registry.stats().invalidations, 1);
    }

    #[test]
    fn test_invalidate_on_credential_update_evicts_all_associated() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(4);

        let cred_id = b"cred-42";
        registry.register_template(
            b"pat-a",
            ProofTemplate::new(b"pat-a", fp, &[0], 3),
            Some(cred_id),
        );
        registry.register_template(
            b"pat-b",
            ProofTemplate::new(b"pat-b", fp, &[1, 2], 3),
            Some(cred_id),
        );
        // A template not linked to this credential.
        registry.register_template(b"pat-c", ProofTemplate::new(b"pat-c", fp, &[0], 3), None);

        let evicted = registry.invalidate_on_credential_update(cred_id);
        assert_eq!(evicted, 2);
        assert!(registry.get_cached_proof_template(b"pat-a").is_none());
        assert!(registry.get_cached_proof_template(b"pat-b").is_none());
        // Unrelated template must survive.
        assert!(registry.get_cached_proof_template(b"pat-c").is_some());
    }

    #[test]
    fn test_hit_rate_calculation() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(5);
        let template = ProofTemplate::new(b"rate-test", fp, &[0], 1);
        registry.register_template(b"rate-test", template, None);

        // 3 hits, 1 miss
        for _ in 0..3 {
            registry.get_cached_proof_template(b"rate-test");
        }
        registry.get_cached_proof_template(b"no-such");

        assert_eq!(registry.stats().hit_rate_pct(), 75);
    }

    #[test]
    fn test_template_compatibility_check() {
        let fp = make_fingerprint(6);
        let template = ProofTemplate::new(b"compat", fp, &[0, 2], 4);

        assert!(template.is_compatible(4, &fp));
        // Wrong message count.
        assert!(!template.is_compatible(3, &fp));
        // Wrong fingerprint.
        assert!(!template.is_compatible(4, &make_fingerprint(99)));
    }

    #[test]
    fn test_revealed_set_deduplication_and_order() {
        let rs = RevealedSet::from_indices(&[3, 1, 2, 1, 3]);
        assert_eq!(rs.indices(), &[1, 2, 3]);
        assert!(rs.contains(1));
        assert!(rs.contains(3));
        assert!(!rs.contains(0));
    }

    #[test]
    fn test_overwrite_existing_template() {
        let mut registry = ProofTemplateRegistry::new();
        let fp = make_fingerprint(7);
        let t1 = ProofTemplate::new(b"v1", fp, &[0], 2);
        let t2 = ProofTemplate::new(b"v2", fp, &[1], 2);

        registry.register_template(b"key", t1, None);
        registry.register_template(b"key", t2, None);

        // stored_count should still be 1 (overwrite, not add).
        assert_eq!(registry.stats().stored_count, 1);
        let cached = registry.get_cached_proof_template(b"key").unwrap();
        assert_eq!(cached.name, b"v2");
    }

    #[test]
    fn test_vk_fingerprint_is_deterministic() {
        let bytes = b"test-vk-bytes";
        let fp1 = vk_fingerprint(bytes).unwrap();
        let fp2 = vk_fingerprint(bytes).unwrap();
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn test_vk_fingerprint_differs_for_different_inputs() {
        let fp1 = vk_fingerprint(b"key-a").unwrap();
        let fp2 = vk_fingerprint(b"key-b").unwrap();
        assert_ne!(fp1, fp2);
    }
}
