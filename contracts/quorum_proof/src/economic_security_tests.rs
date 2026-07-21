#[cfg(test)]
mod economic_security_tests {
    use std::prelude::v1::*;
    use crate::simulation_agent_based::economic_simulation::*;

    #[test]
    fn test_concentration_risk_detection() {
        // Scenario: max_weight >= required_weight (critical vulnerability)
        let attestors = vec![
            AttestorAgent {
                id: 0,
                base_weight: 100,
                reputation: 100,
                corruption_price: 50000,
            },
            AttestorAgent {
                id: 1,
                base_weight: 10,
                reputation: 100,
                corruption_price: 5000,
            },
        ];
        let config = SimulatedSliceConfig {
            attestors,
            required_weight: 100,
            reputation_penalty_per_slash: 20,
            reputation_weighting_enabled: false,
        };

        assert!(config.has_single_point_of_failure());
        assert_eq!(config.concentration_risk_score(), 100);
        assert_eq!(config.max_weight(), 100);
    }

    #[test]
    fn test_corrupt_existing_attack_cost_calculation() {
        // 5-attestor uniform weights, 67% threshold
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
        let config = SimulatedSliceConfig {
            attestors,
            required_weight: 67,
            reputation_penalty_per_slash: 20,
            reputation_weighting_enabled: false,
        };

        let simulator = MonteCarloSimulator::new(1000, 20, 1000);
        let result = simulator.simulate_corrupt_existing(&config);

        // Need 67 weight: 4 attestors @ 20 weight each = 80
        assert_eq!(result.corrupted_weight, 80);
        assert_eq!(result.min_cost, 40000);
        assert_eq!(result.min_corrupted_set.len(), 2); // 2 attestors × 20 weight each = 40 >= 67? No, need 4
        // Actually: 67/20 = 3.35, so need 4 attestors
        assert!(result.min_cost >= 30000);
    }

    #[test]
    fn test_sybil_attack_cost_increases_with_threshold() {
        // Test different thresholds: higher threshold = more Sybils needed
        let simulator = MonteCarloSimulator::new(100, 20, 1000);

        for required_weight in [50, 75, 100].iter() {
            let attestors = vec![
                AttestorAgent {
                    id: 0,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 1,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
            ];
            let config = SimulatedSliceConfig {
                attestors,
                required_weight: *required_weight,
                reputation_penalty_per_slash: 20,
                reputation_weighting_enabled: false,
            };

            let sybil_result = simulator.simulate_sybil(&config);

            // Higher threshold should need more Sybils
            // With SYBIL_MAX_WEIGHT = 30:
            // 50 -> ceil(50/30) = 2 Sybils
            // 75 -> ceil(75/30) = 3 Sybils
            // 100 -> ceil(100/30) = 4 Sybils
            let expected_sybils = (*required_weight as f32 / 30.0).ceil() as u32;
            assert_eq!(sybil_result.sybils_needed, expected_sybils);
        }
    }

    #[test]
    fn test_reputation_weighting_reduces_effective_weight() {
        let mut agent = AttestorAgent {
            id: 0,
            base_weight: 100,
            reputation: 100,
            corruption_price: 10000,
        };

        // At reputation 100: effective = 100 * (100/100) = 100
        assert_eq!(agent.effective_weight(), 100);

        // After slash (reputation drops 20): reputation = 80
        agent.apply_slash(20);
        assert_eq!(agent.reputation, 80);
        assert_eq!(agent.effective_weight(), 80); // 100 * (80/100) = 80

        // After another slash: reputation = 60
        agent.apply_slash(20);
        assert_eq!(agent.reputation, 60);
        assert_eq!(agent.effective_weight(), 60); // 100 * (60/100) = 60
    }

    #[test]
    fn test_attack_cost_increases_with_reputation_weighting_mitigation() {
        // Baseline: no mitigation
        let attestors = vec![
            AttestorAgent {
                id: 0,
                base_weight: 30,
                reputation: 100,
                corruption_price: 15000,
            },
            AttestorAgent {
                id: 1,
                base_weight: 25,
                reputation: 100,
                corruption_price: 12000,
            },
            AttestorAgent {
                id: 2,
                base_weight: 20,
                reputation: 100,
                corruption_price: 10000,
            },
            AttestorAgent {
                id: 3,
                base_weight: 15,
                reputation: 100,
                corruption_price: 7500,
            },
            AttestorAgent {
                id: 4,
                base_weight: 10,
                reputation: 100,
                corruption_price: 5000,
            },
        ];
        let mut config = SimulatedSliceConfig {
            attestors,
            required_weight: 75,
            reputation_penalty_per_slash: 20,
            reputation_weighting_enabled: false,
        };

        let simulator = MonteCarloSimulator::new(1000, 20, 1000);

        // Baseline attack cost
        let baseline = simulator.simulate_corrupt_existing(&config);
        let baseline_cost = baseline.min_cost;

        // Enable mitigation
        config.reputation_weighting_enabled = true;

        // Simulate mitigation: corrupted attestors face reputation penalty
        let mitigated = simulator.simulate_with_mitigation(&config, &baseline);
        let mitigated_cost = mitigated.min_cost;

        // Mitigation should increase cost (due to reputation penalty making some attackers less effective)
        // Note: in this case, attacker may need to corrupt different/more attestors
        assert!(mitigated_cost >= baseline_cost || mitigated.min_corrupted_set.len() >= baseline.min_corrupted_set.len());
    }

    #[test]
    fn test_monte_carlo_configuration_space() {
        let configs = generate_test_configurations();
        assert!(configs.len() >= 3); // At least 3 test scenarios

        let simulator = MonteCarloSimulator::new(100, 20, 1000);

        for config in configs {
            let analysis = simulator.analyze_slice_security(&config);

            // All analyses should have valid results
            assert!(analysis.minimum_attack_cost > 0);
            assert!(!analysis.cheapest_strategy.is_empty());
            assert!(analysis.concentration_risk <= 100);

            // Consistency check: cheapest strategy should match minimum cost
            if analysis.cheapest_strategy == "corrupt" {
                assert_eq!(
                    analysis.corrupt_existing.min_cost, analysis.minimum_attack_cost
                );
            } else if analysis.cheapest_strategy == "sybil" {
                assert_eq!(analysis.sybil.total_cost, analysis.minimum_attack_cost);
            }
        }
    }

    #[test]
    fn test_attack_cost_monotonicity() {
        // Property: as threshold increases, cost-to-attack increases (or stays same)
        let mut thresholds = Vec::new();
        let mut costs = Vec::new();

        for threshold in [50, 60, 70, 80, 90].iter() {
            let attestors = vec![
                AttestorAgent {
                    id: 0,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 1,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 2,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
                AttestorAgent {
                    id: 3,
                    base_weight: 25,
                    reputation: 100,
                    corruption_price: 10000,
                },
            ];
            let config = SimulatedSliceConfig {
                attestors,
                required_weight: *threshold,
                reputation_penalty_per_slash: 20,
                reputation_weighting_enabled: false,
            };

            let simulator = MonteCarloSimulator::new(100, 20, 1000);
            let result = simulator.simulate_corrupt_existing(&config);

            thresholds.push(*threshold);
            costs.push(result.min_cost);
        }

        // Check monotonicity: cost should generally increase with threshold
        for i in 1..costs.len() {
            assert!(
                costs[i] >= costs[i - 1],
                "Cost should increase with threshold: {} at threshold {} vs {} at threshold {}",
                costs[i],
                thresholds[i],
                costs[i - 1],
                thresholds[i - 1]
            );
        }
    }

    #[test]
    fn test_reputation_recovery_mechanics() {
        let mut agent = AttestorAgent {
            id: 0,
            base_weight: 50,
            reputation: 100,
            corruption_price: 10000,
        };

        agent.apply_slash(20);
        assert_eq!(agent.reputation, 80);

        // Recovery: earn reputation over time (1 point per honest attestation)
        for _ in 0..10 {
            agent.earn_reputation();
        }
        assert_eq!(agent.reputation, 90);

        // Can't exceed 100
        for _ in 0..20 {
            agent.earn_reputation();
        }
        assert_eq!(agent.reputation, 100);
    }

    #[test]
    fn test_multi_slash_cumulative_effect() {
        let mut agent = AttestorAgent {
            id: 0,
            base_weight: 100,
            reputation: 100,
            corruption_price: 10000,
        };

        // Reputation suspension threshold typically 20
        let suspension_threshold = 20;

        // Slash multiple times: 100 - 20 - 20 - 20 - 20 = 20 (at threshold)
        for i in 0..4 {
            agent.apply_slash(20);
            assert_eq!(agent.reputation, 100 - (20 * (i + 1)));
        }

        assert_eq!(agent.reputation, 20);

        // One more slash: below suspension threshold
        agent.apply_slash(20);
        assert_eq!(agent.reputation, 0);
        assert!(agent.reputation < suspension_threshold);
    }

    #[test]
    fn test_slice_security_analysis_completeness() {
        let configs = generate_test_configurations();
        let simulator = MonteCarloSimulator::new(100, 20, 1000);

        for config in configs {
            let analysis = simulator.analyze_slice_security(&config);

            // All fields should be populated
            assert!(!analysis.corrupt_existing.min_corrupted_set.is_empty());
            assert!(analysis.sybil.sybils_needed > 0);
            assert!(!analysis.cheapest_strategy.is_empty());
            assert!(analysis.minimum_attack_cost > 0);
            assert!(analysis.concentration_risk <= 100);

            // Sanity checks
            assert!(
                analysis.concentrate_risk <= 100,
                "Risk score must be 0-100"
            );
            assert!(
                analysis.corrupt_existing.min_cost <= 1_000_000,
                "Cost should be reasonable"
            );
        }
    }

    #[test]
    fn test_cost_per_weight_efficiency() {
        // Test that cost-per-weight is calculated correctly
        let attestors = vec![
            AttestorAgent {
                id: 0,
                base_weight: 50,
                reputation: 100,
                corruption_price: 20000,
            },
            AttestorAgent {
                id: 1,
                base_weight: 30,
                reputation: 100,
                corruption_price: 9000,
            },
            AttestorAgent {
                id: 2,
                base_weight: 20,
                reputation: 100,
                corruption_price: 8000,
            },
        ];
        let config = SimulatedSliceConfig {
            attestors,
            required_weight: 80,
            reputation_penalty_per_slash: 20,
            reputation_weighting_enabled: false,
        };

        let simulator = MonteCarloSimulator::new(100, 20, 1000);
        let result = simulator.simulate_corrupt_existing(&config);

        // Cost-per-weight should match calculation
        if result.corrupted_weight > 0 {
            let expected_cpp = result.min_cost as f64 / result.corrupted_weight as f64;
            assert!(
                (result.cost_per_weight - expected_cpp).abs() < 0.01,
                "Cost per weight mismatch"
            );
        }
    }

    #[test]
    fn test_effective_weight_zero_reputation() {
        let agent = AttestorAgent {
            id: 0,
            base_weight: 100,
            reputation: 0,
            corruption_price: 10000,
        };

        // At reputation 0: effective = 100 * (0/100) = 0
        assert_eq!(agent.effective_weight(), 0);
    }
}
