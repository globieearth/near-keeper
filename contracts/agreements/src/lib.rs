//! Globie agreement registry.
//!
//! One shared contract for every group. It holds no funds and has no access
//! keys; it only records that a given account signed a given terms digest.
//!
//! The trust anchor is `predecessor_account_id`: only the account named in an
//! acceptance can write it, so a frontier cannot forge somebody else's row.
//! Storage for each row is staked by this contract's own balance (~0.002 NEAR
//! per acceptance) — the deployer pays, the members do not.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};

const EVENT_STANDARD: &str = "globie_agreement";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Acceptance {
    pub agreement_id: String,
    pub terms_hash: String,
    pub account_id: AccountId,
    pub public_key: String,
    pub signature: String,
    pub nonce: String,
    pub recorded_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct GlobieAgreements {
    /// agreement_id -> one acceptance per account, in the order first recorded.
    acceptances: LookupMap<String, Vec<Acceptance>>,
}

#[near]
impl GlobieAgreements {
    #[init]
    pub fn new() -> Self {
        Self {
            acceptances: LookupMap::new(b"acceptances".to_vec()),
        }
    }

    /// Record that `account_id` accepted the terms whose digest is `terms_hash`.
    ///
    /// Re-recording replaces the row for that account, which is how a re-signed
    /// agreement moves its on-chain proof. Nothing else can overwrite a row.
    pub fn record_acceptance(
        &mut self,
        agreement_id: String,
        terms_hash: String,
        account_id: AccountId,
        public_key: String,
        signature: String,
        nonce: String,
    ) -> Acceptance {
        let predecessor = env::predecessor_account_id();
        assert_eq!(
            predecessor, account_id,
            "Only the account named in the acceptance can record it"
        );
        assert_eq!(
            terms_hash.len(),
            64,
            "terms_hash must be a 64-character hex sha256 digest"
        );
        assert!(
            terms_hash.chars().all(|c| c.is_ascii_hexdigit()),
            "terms_hash must be hex"
        );
        assert!(!signature.is_empty(), "signature must not be empty");
        assert!(!nonce.is_empty(), "nonce must not be empty");
        assert!(!agreement_id.is_empty(), "agreement_id must not be empty");

        let record = Acceptance {
            agreement_id: agreement_id.clone(),
            terms_hash,
            account_id: predecessor.clone(),
            public_key,
            signature,
            nonce,
            recorded_at: env::block_timestamp(),
        };

        let mut rows = self.acceptances.get(&agreement_id).cloned().unwrap_or_default();
        match rows.iter_mut().find(|row| row.account_id == predecessor) {
            Some(existing) => *existing = record.clone(),
            None => rows.push(record.clone()),
        }
        self.acceptances.insert(agreement_id, rows);

        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({
                "standard": EVENT_STANDARD,
                "version": EVENT_VERSION,
                "event": "acceptance",
                "data": [record],
            })
        ));

        record
    }

    pub fn get_acceptances(&self, agreement_id: String) -> Vec<Acceptance> {
        self.acceptances.get(&agreement_id).cloned().unwrap_or_default()
    }

    pub fn get_acceptance(&self, agreement_id: String, account_id: AccountId) -> Option<Acceptance> {
        self.acceptances
            .get(&agreement_id)
            .and_then(|rows| rows.iter().find(|row| row.account_id == account_id).cloned())
    }

    pub fn acceptance_count(&self, agreement_id: String) -> u32 {
        self.acceptances
            .get(&agreement_id)
            .map(|rows| rows.len() as u32)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DIGEST: &str = "24af5201a3c5f0d9b2e6c1f4a7d0b3e6c9f2a5d8b1e4c7f0a3d6b9e2c5f8a1b4";

    fn as_account(account: &str) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account.parse().unwrap())
            .block_timestamp(1_700_000_000_000_000_000)
            .build());
    }

    fn record(contract: &mut GlobieAgreements, account: &str, digest: &str) -> Acceptance {
        as_account(account);
        contract.record_acceptance(
            "agr-1".to_string(),
            digest.to_string(),
            account.parse().unwrap(),
            "ed25519:3J6s9tNE4zhjvVQiQkCdiq8wMUHJmqayEAxe7FF9cDrQ".to_string(),
            "c2lnbmF0dXJl".to_string(),
            "bm9uY2U=".to_string(),
        )
    }

    #[test]
    fn records_one_row_per_account() {
        let mut contract = GlobieAgreements::new();
        record(&mut contract, "alice.testnet", DIGEST);
        record(&mut contract, "bob.testnet", DIGEST);

        assert_eq!(contract.acceptance_count("agr-1".to_string()), 2);
        let alice = contract
            .get_acceptance("agr-1".to_string(), "alice.testnet".parse().unwrap())
            .expect("alice is recorded");
        assert_eq!(alice.terms_hash, DIGEST);
        assert_eq!(alice.recorded_at, 1_700_000_000_000_000_000);
    }

    #[test]
    fn re_recording_replaces_that_account_only() {
        let mut contract = GlobieAgreements::new();
        record(&mut contract, "alice.testnet", DIGEST);
        record(&mut contract, "bob.testnet", DIGEST);
        record(&mut contract, "alice.testnet", &"a".repeat(64));

        assert_eq!(contract.acceptance_count("agr-1".to_string()), 2);
        let alice = contract
            .get_acceptance("agr-1".to_string(), "alice.testnet".parse().unwrap())
            .unwrap();
        assert_eq!(alice.terms_hash, "a".repeat(64));
    }

    #[test]
    fn prevents_a_third_party_from_recording_for_someone_else() {
        let mut contract = GlobieAgreements::new();
        as_account("mallory.testnet");
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.record_acceptance(
                "agr-1".to_string(),
                DIGEST.to_string(),
                "alice.testnet".parse().unwrap(),
                "ed25519:3J6s9tNE4zhjvVQiQkCdiq8wMUHJmqayEAxe7FF9cDrQ".to_string(),
                "c2lnbmF0dXJl".to_string(),
                "bm9uY2U=".to_string(),
            );
        }));
        assert!(outcome.is_err());
        assert_eq!(contract.acceptance_count("agr-1".to_string()), 0);
    }

    #[test]
    fn rejects_a_digest_that_is_not_sha256_hex() {
        let mut contract = GlobieAgreements::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            record(&mut contract, "alice.testnet", "not-a-digest");
        }));
        assert!(outcome.is_err());
        assert_eq!(contract.acceptance_count("agr-1".to_string()), 0);
    }

    #[test]
    fn unknown_agreement_answers_empty() {
        let contract = GlobieAgreements::new();
        assert!(contract
            .get_acceptances("nobody-here".to_string())
            .is_empty());
        assert_eq!(contract.acceptance_count("nobody-here".to_string()), 0);
    }
}
