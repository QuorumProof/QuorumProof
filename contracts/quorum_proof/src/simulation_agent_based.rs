#[cfg(test)]
pub mod economic_simulation {
    use std::prelude::v1::*;
    use std::collections::{HashMap, BTreeMap};

    /// Represents an attestor agent with economic parameters
    #[derive(Clone, Debug)]
    pub struct AttestorAgent {
        pub id: u32,
        pub base_weight: u32,
        pub reputation: u32,
        pub corruption_price: u64,
    }

    impl AttestorAgent {
        /// Effective weight considering reputation: weight * (reputation / 100)
        pub fn effective_weight(&self) -> u32 {
            ((self.base_weight as u64 * self.reputation as u64) / 100) as u32
        }

        /// Simulate reputation penalty from being detected in equivocation
        pub fn apply_slash(&mut self, penalty: u32) {
            self.reputation = self.reputation.saturating_sub(penalty);
        }

        /// Simulate reputation recovery over time (1 point per honest attestation)
        pub fn earn_reputation(&mut self) {
            if self.reputation < 100 {
                self.reputation += 1;
            }
        }
    }

    /// Configuration for a simulated slice
    #[derive(Clone, Debug)]
    pub struct SimulatedSliceConfig {
        pub attestors: Vec<AttestorAgent>,
        pub required_weight: u32,
        pub reputation_penalty_per_slash: u32,
        pub reputation_weighting_enabled: bool,
    }

    impl SimulatedSliceConfig {
        /// Total base weight across all attestors
        pub fn total_base_weight(&self) -> u32 {
            self.attestors.iter().map(|a| a.base_weight).sum()
        }

        /// Total effective weight (considering reputation)
        pub fn total_effective_weight(&self) -> u32 {
            self.attestors.iter().map(|a| a.effective_weight()).sum()
        }

        /// Maximum weight of any single attestor
        pub fn max_weight(&self) -> u32 {
            self.attestors
                .iter()
                .map(|a| a.base_weight)
                .max()
                .unwrap_or(0)
        }

        /// Concentration risk score: 0-100, higher = more vulnerable
        pub fn concentration_risk_score(&self) -> u32 {
            if self.max_weight() >= self.required_weight {
                100
            } else {
                ((self.max_weight() as f64 / self.required_weight as f64) * 100.0).min(100.0)
                    as u32
            }
        }

        /// Has single point of failure: one attestor can decide consensus alone
        pub fn has_single_point_of_failure(&self) -> bool {
            self.max_weight() >= self.required_weight
        }
    }

    /// Result of a corrupt-existing attack simulation
    #[derive(Clone, Debug)]
    pub struct CorruptExistingResult {
        /// Minimum cost to corrupt enough attestors to reach threshold
        pub min_cost: u64,
        /// Attestor IDs needed to corrupt (indices into slice.attestors)
        pub min_corrupted_set: Vec<usize>,
        /// Total weight of corrupted set (before reputation penalty)
        pub corrupted_weight: u32,
        /// Cost per unit weight
        pub cost_per_weight: f64,
    }

    /// Result of a Sybil attack simulation
    #[derive(Clone, Debug)]
    pub struct SybilAttackResult {
        /// Number of Sybils needed to reach threshold
        pub sybils_needed: u32,
        /// Total cost to bootstrap reputation for one Sybil
        pub cost_per_sybil: u64,
        /// Time (in rounds) to bootstrap one Sybil to full weight
        pub time_to_bootstrap_rounds: u32,
        /// Total cost for full Sybil attack
        pub total_cost: u64,
    }

    /// Combined attack cost analysis
    #[derive(Clone, Debug)]
    pub struct AttackCostAnalysis {
        pub corrupt_existing: CorruptExistingResult,
        pub sybil: SybilAttackResult,
        /// Recommended strategy: "corrupt" or "sybil"
        pub cheapest_strategy: String,
        /// Minimum of the two attack costs
        pub minimum_attack_cost: u64,
        /// Concentration risk score (0-100)
        pub concentration_risk: u32,
        /// Has single point of failure
        pub has_spof: bool,
    }

    /// Monte Carlo simulator for attack cost analysis
    pub struct MonteCarloSimulator {
        num_iterations: usize,
        reputation_penalty: u32,
        sybil_bootstrap_cost_per_day: u64,
        max_reputation_per_attestor: u32,
    }

    impl MonteCarloSimulator {
        pub fn new(
            num_iterations: usize,
            reputation_penalty: u32,
            sybil_bootstrap_cost_per_day: u64,
        ) -> Self {
            MonteCarloSimulator {
                num_iterations,
                reputation_penalty,
                sybil_bootstrap_cost_per_day,
                max_reputation_per_attestor: 100,
            }
        }

        /// Greedy algorithm to find minimum-cost corrupt-existing attack
        pub fn simulate_corrupt_existing(
            &self,
            config: &SimulatedSliceConfig,
        ) -> CorruptExistingResult {
            // Sort by cost-per-weight ratio (greedy approximation of weighted set cover)
            let mut sorted: Vec<(usize, &AttestorAgent, f64)> = config
                .attestors
                .iter()
                .enumerate()
                .map(|(i, a)| (i, a, a.corruption_price as f64 / a.base_weight as f64))
                .collect();
            sorted.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

            let mut total_cost: u64 = 0;
            let mut total_weight: u32 = 0;
            let mut corrupted_set: Vec<usize> = Vec::new();

            for (idx, attestor, _) in sorted {
                if total_weight >= config.required_weight {
                    break;
                }
                total_cost += attestor.corruption_price;
                total_weight += attestor.base_weight;
                corrupted_set.push(idx);
            }

            let cost_per_weight = if total_weight > 0 {
                total_cost as f64 / total_weight as f64
            } else {
                0.0
            };

            CorruptExistingResult {
                min_cost: total_cost,
                min_corrupted_set: corrupted_set,
                corrupted_weight: total_weight,
                cost_per_weight,
            }
        }

        /// Simulate Sybil attack: how many new attestors needed + cost
        pub fn simulate_sybil(&self, config: &SimulatedSliceConfig) -> SybilAttackResult {
            // Sybil attestors start at reputation 100 with max_individual_weight
            // Assume max individual weight is 30 for Sybils (to prevent domination)
            const SYBIL_MAX_WEIGHT: u32 = 30;

            let sybils_needed = {
                let mut count = 0;
                let mut weight = 0;
                while weight < config.required_weight {
                    weight += SYBIL_MAX_WEIGHT;
                    count += 1;
                }
                count
            };

            // Bootstrap cost: time to build reputation + identity setup
            // Assume 7 days to bootstrap reputation for one Sybil
            let bootstrap_days: u32 = 7;
            let cost_per_sybil = self.sybil_bootstrap_cost_per_day * bootstrap_days as u64;

            SybilAttackResult {
                sybils_needed,
                cost_per_sybil,
                time_to_bootstrap_rounds: bootstrap_days * 24, // rounds = hours in 7 days
                total_cost: cost_per_sybil * sybils_needed as u64,
            }
        }

        /// Simulate attack cost with reputation-weighting mitigation enabled
        pub fn simulate_with_mitigation(
            &self,
            config: &SimulatedSliceConfig,
            base_corrupt_result: &CorruptExistingResult,
        ) -> CorruptExistingResult {
            if !config.reputation_weighting_enabled {
                return base_corrupt_result.clone();
            }

            // Apply reputation penalty to corrupted attestors
            let mut mitigated_config = config.clone();
            for &idx in &base_corrupt_result.min_corrupted_set {
                if idx < mitigated_config.attestors.len() {
                    mitigated_config.attestors[idx].apply_slash(self.reputation_penalty);
                }
            }

            // Re-evaluate: need more attestors now to reach threshold (due to reduced effective weight)
            let mut sorted: Vec<(usize, &AttestorAgent, f64)> = mitigated_config
                .attestors
                .iter()
                .enumerate()
                .map(|(i, a)| (i, a, a.corruption_price as f64 / a.base_weight as f64))
                .collect();
            sorted.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

            let mut total_cost: u64 = 0;
            let mut total_weight: u32 = 0;
            let mut corrupted_set: Vec<usize> = Vec::new();

            for (idx, attestor, _) in sorted {
                if total_weight >= mitigated_config.required_weight {
                    break;
                }
                total_cost += attestor.corruption_price;
                total_weight += attestor.base_weight;
                corrupted_set.push(idx);
            }

            let cost_per_weight = if total_weight > 0 {
                total_cost as f64 / total_weight as f64
            } else {
                0.0
            };

            CorruptExistingResult {
                min_cost: total_cost,
                min_corrupted_set: corrupted_set,
                corrupted_weight: total_weight,
                cost_per_weight,
            }
        }

        /// Full analysis: both attack strategies + mitigation impact
        pub fn analyze_slice_security(
            &self,
            config: &SimulatedSliceConfig,
        ) -> AttackCostAnalysis {
            let corrupt_existing = self.simulate_corrupt_existing(config);
            let sybil = self.simulate_sybil(config);

            let cheapest_strategy = if corrupt_existing.min_cost <= sybil.total_cost {
                "corrupt".to_string()
            } else {
                "sybil".to_string()
            };

            let minimum_attack_cost = corrupt_existing.min_cost.min(sybil.total_cost);

            AttackCostAnalysis {
                corrupt_existing,
                sybil,
                cheapest_strategy,
                minimum_attack_cost,
                concentration_risk: config.concentration_risk_score(),
                has_spof: config.has_single_point_of_failure(),
            }
        }

        /// Monte Carlo sweep: vary reputation distributions and measure attack cost variance
        pub fn monte_carlo_sweep(
            &self,
            base_config: &SimulatedSliceConfig,
            reputation_distributions: Vec<Vec<u32>>,
        ) -> Vec<AttackCostAnalysis> {
            let mut results = Vec::new();

            for reputation_dist in reputation_distributions {
                if reputation_dist.len() != base_config.attestors.len() {
                    continue;
                }

                let mut trial_config = base_config.clone();
                for (i, &rep) in reputation_dist.iter().enumerate() {
                    if i < trial_config.attestors.len() {
                        trial_config.attestors[i].reputation = rep;
                    }
                }

                let analysis = self.analyze_slice_security(&trial_config);
                results.push(analysis);
            }

            results
        }
    }

    /// Helper to generate test configurations spanning varied scenarios
    pub fn generate_test_configurations() -> Vec<SimulatedSliceConfig> {
        let mut configs = Vec::new();

        // Scenario 1: 5-attestor uniform weights, 67% threshold
        {
            let attestors = vec![
                AttestorAgent {
                    id: 0,
                    base_weight: 20,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 1,
                    base_weight: 20,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 2,
                    base_weight: 20,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 3,
                    base_weight: 20,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 4,
                    base_weight: 20,
                    reputation: 100,
                    corruption_price: 10000,
                },
            ];
            configs.push(SimulatedSliceConfig {
                attestors,
                required_weight: 67,
                reputation_penalty_per_slash: 20,
                reputation_weighting_enabled: false,
            });
        }

        // Scenario 2: 10-attestor Zipfian weights, 90% threshold
        {
            let weights = vec![30, 20, 15, 10, 8, 6, 4, 3, 2, 2];
            let attestors: Vec<AttestorAgent> = weights
                .into_iter()
                .enumerate()
                .map(|(id, w)| AttestorAgent {
                    id: id as u32,
                    base_weight: w,
                    reputation: 100,
                    corruption_price: 10000,
                })
                .collect();
            configs.push(SimulatedSliceConfig {
                attestors,
                required_weight: 90,
                reputation_penalty_per_slash: 20,
                reputation_weighting_enabled: false,
            });
        }

        // Scenario 3: 7-attestor, 75% threshold with mixed reputation
        {
            let attestors = vec![
                AttestorAgent {
                    id: 0,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 15000,
                },
                AttestorAgent {
                    id: 1,
                    base_weight: 20,
                    reputation: 80,
                    corruption_price: 12000,
                },
                AttestorAgent {
                    id: 2,
                    base_weight: 18,
                    reputation: 100,
                    corruption_price: 11000,
                },
                AttestorAgent {
                    id: 3,
                    base_weight: 15,
                    reputation: 60,
                    corruption_price: 9000,
                },
                AttestorAgent {
                    id: 4,
                    base_weight: 12,
                    reputation: 100,
                    corruption_price: 8000,
                },
                AttestorAgent {
                    id: 5,
                    base_weight: 10,
                    reputation: 70,
                    corruption_price: 7000,
                },
                AttestorAgent {
                    id: 6,
                    base_weight: 8,
                    reputation: 100,
                    corruption_price: 5000,
                },
            ];
            configs.push(SimulatedSliceConfig {
                attestors,
                required_weight: 75,
                reputation_penalty_per_slash: 20,
                reputation_weighting_enabled: false,
            });
        }

        configs
    }
}
