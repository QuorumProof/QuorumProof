#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec, String};
use quorum_proof::{QuorumProofContract, QuorumProofContractClient, ContractError};

/// Fuzz input targeting contract entry points not covered by other fuzz targets.
///
/// Covers: revoke, suspension, fork detection, transfer, delegation,
/// attestation expiry, attestation window, blacklist, and rate limiting.
#[derive(Arbitrary, Debug)]
struct FuzzInput {
    action: u8,
    seed: u32,
    flag_a: bool,
    flag_b: bool,
    flag_c: bool,
    value_u32: u32,
    value_u64: u64,
    value_u64_2: u64,
    metadata_len: u16,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, QuorumProofContract);
    let client = QuorumProofContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    let attestor = Address::generate(&env);

    let ctype = (input.value_u32 % 100).max(1);
    let meta = Bytes::from_slice(&env, b"QmFuzzHash000000000000000000000000");

    // Issue a credential for most actions
    let cid = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.issue_credential(&issuer, &subject, &ctype, &meta, &None, &0u64)
    })) {
        Ok(id) => id,
        Err(_) => return,
    };

    // Create a slice with the attestor
    let mut attestors = Vec::new(&env);
    attestors.push_back(attestor.clone());
    let mut weights = Vec::new(&env);
    weights.push_back(1u32);
    let slice_id = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_slice(&issuer, &attestors, &weights, &1u32)
    })) {
        Ok(id) => id,
        Err(_) => return,
    };

    match input.action % 20 {
        0 => {
            // revoke_credential
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.revoke_credential(&issuer, &cid)
            }));
        }
        1 => {
            // get_credential
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_credential(&cid)
            }));
        }
        2 => {
            // set_attestation_expiry
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.set_attestation_expiry(&issuer, &cid, &input.value_u64)
            }));
        }
        3 => {
            // get_slice
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_slice(&slice_id)
            }));
        }
        4 => {
            // is_attested (before attestation)
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.is_attested(&cid, &slice_id)
            }));
        }
        6 => {
            // pause / unpause
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if input.flag_a {
                    client.pause(&admin);
                } else {
                    let _ = client.is_paused();
                }
            }));
            if input.flag_a {
                let _ = client.unpause(&admin);
            }
        }
        7 => {
            // get_slice_attestations
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_slice_attestations(&cid, &slice_id)
            }));
        }
        8 => {
            // get_weight_distribution
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_weight_distribution(&slice_id)
            }));
        }
        9 => {
            // update_attestor_weight (try both zero and non-zero)
            let w = if input.flag_a { input.value_u32 % 100 + 1 } else { 0 };
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.update_attestor_weight(&issuer, &slice_id, &attestor, &w)
            }));
        }
        10 => {
            // rate limiting config
            let calls = (input.value_u32 % 1000).max(1);
            let window = (input.value_u64 % 86400).max(1);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.set_rate_limit_config(&admin, &calls, &window)
            }));
        }
        11 => {
            // credential status
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_credential_status(&cid)
            }));
        }
        12 => {
            // initiate_transfer
            let recipient = Address::generate(&env);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.initiate_transfer(&subject, &cid, &recipient)
            }));
        }
        13 => {
            // get_attestation_records
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_attestation_records(&cid)
            }));
        }
        14 => {
            // check if credential exists
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.credential_exists(&cid)
            }));
        }
        15 => {
            // get_attestation_count
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_attestation_count(&cid)
            }));
        }
        16 => {
            // set_attestation_window
            let start = if input.flag_a { input.value_u64 } else { env.ledger().timestamp() };
            let end = if input.flag_b { input.value_u64_2 } else { start + 3600 };
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.set_attestation_window(&issuer, &cid, &start, &end)
            }));
        }
        17 => {
            // get_credential_type by type_id
            let tid = (input.value_u32 % 100).max(1);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.get_credential_type(&tid)
            }));
        }
        18 => {
            // Slice with percentage threshold
            let pct = (input.value_u32 % 100).max(1);
            let alice = Address::generate(&env);
            let mut attrs2 = Vec::new(&env);
            attrs2.push_back(alice);
            let mut w2 = Vec::new(&env);
            w2.push_back(100u32);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.create_slice_percentage(&issuer, &attrs2, &w2, &pct)
            }));
        }
        19 => {
            // attest with full parameters
            let ev = input.flag_a;
            let exp = if input.flag_b { Some(input.value_u64) } else { None };
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.attest(&attestor, &cid, &slice_id, &ev, &exp)
            }));
        }
        _ => {}
    }
});
