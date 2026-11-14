//! Attested picks: a pick that also carries signatures by a model that runs in a TEE.
//!
//! NEAR AI Cloud signs each completion of a TEE-hosted model with a key that the model's
//! attestation report binds to the enclave. The signed text is
//! `"{model}:{sha256 of the request body}:{sha256 of the response body}"`, and the signature is
//! EIP-191 `personal_sign` over it with an ECDSA (secp256k1) key, named by its Ethereum address.
//!
//! The owner registers such a signer with `set_attested_signer`, after checking the attestation
//! report off chain: the contract cannot check an Intel TDX quote itself. `pick_attested` is then
//! `pick` with up to `MAX_ATTESTATIONS` of these signatures attached: it runs every rule of `pick`
//! (they share `settle_pick`), then checks each signature, and pays only if all of them hold.
//!
//! What this proves: a registered key signed these request and response hashes. It does not prove
//! that the request was about this task, nor that the score is correct; the scorecard, whose hash
//! the pick stores, carries the bodies so that anyone can recompute the hashes.
//!
//! Signers are raw records under their own storage prefix, outside the `Tender` struct, so a
//! deployed state gains them without a `migrate`. Attestations are not stored: the `attested_pick`
//! events are the record, and settling never grows storage.

use near_sdk::json_types::U64;
use near_sdk::{borsh, env, near};

use crate::events::{emit, AttestedPick};
use crate::types::{err, hex32, WinnerArg};
use crate::{StorageKey, Tender, TenderExt};

/// Most attestations one `pick_attested` takes. Each costs one `ecrecover`.
pub const MAX_ATTESTATIONS: usize = 12;
/// Longest signer id, in bytes.
pub const MAX_SIGNER_ID_LEN: usize = 64;
/// Longest model name, in bytes.
pub const MAX_MODEL_BYTES: usize = 128;
/// The algorithm names `set_attested_signer` takes. Only ECDSA is built.
const ALGO_ECDSA: &str = "ecdsa";
/// What EIP-191 `personal_sign` puts before the decimal length of the message and the message.
const EIP191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n";

/// How a signer signs. Stored with the signer, so that another algorithm can be added later
/// without changing the records that exist.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignerAlgo {
    /// EIP-191 `personal_sign` with a secp256k1 key, named by its 20-byte Ethereum address.
    Ecdsa,
}

/// A registered signer, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
struct AttestedSigner {
    algo: SignerAlgo,
    /// The last 20 bytes of the keccak-256 of the signing key.
    address: [u8; 20],
    /// The model the signer signs for. Every text it signs must start with it.
    model: String,
    /// A disabled signer's attestations are refused.
    enabled: bool,
}

/// A registered signer, as `get_attested_signer` shows it. `algo` is `"ecdsa"` and `address` is
/// `0x` and 40 lowercase hex characters.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestedSignerView {
    pub signer_id: String,
    pub algo: String,
    pub address: String,
    pub model: String,
    pub enabled: bool,
}

/// One attestation of a `pick_attested`: the text that the registered signer `signer_id` signed,
/// `"{model}:{request_hash}:{response_hash}"`, and its 65-byte signature in hex (`r`, `s`, `v`;
/// `0x` optional). An unknown key fails to parse.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationArg {
    pub signer_id: String,
    pub text: String,
    pub signature: String,
}

fn bad_attestation(detail: String) -> ! {
    env::panic_str(&format!("{}: {detail}", err::E_ATTESTATION))
}

/// The storage key of signer `signer_id`'s record: the prefix, then the id's bytes. Ids are
/// checked to be `[a-z0-9._-]` before anything is written, and the key holds the whole id, so two
/// ids never share a key.
fn signer_key(signer_id: &str) -> Vec<u8> {
    let mut key = borsh::to_vec(&StorageKey::AttestedSigners)
        .unwrap_or_else(|_| env::panic_str("the storage prefix did not serialize"));
    key.extend_from_slice(signer_id.as_bytes());
    key
}

fn read_signer(signer_id: &str) -> Option<AttestedSigner> {
    let bytes = env::storage_read(&signer_key(signer_id))?;
    Some(
        borsh::from_slice(&bytes)
            .unwrap_or_else(|_| env::panic_str("a stored attested signer did not deserialize")),
    )
}

/// `0x` and 40 lowercase hex characters.
fn address_text(address: &[u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

/// Whether `signer_id` is 1 to 64 characters of `[a-z0-9._-]`.
fn valid_signer_id(signer_id: &str) -> bool {
    (1..=MAX_SIGNER_ID_LEN).contains(&signer_id.len())
        && signer_id
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// Panics `E_ATTESTATION` unless `signer_id` is 1 to 64 characters of `[a-z0-9._-]`.
fn check_signer_id(signer_id: &str) {
    if !valid_signer_id(signer_id) {
        bad_attestation(format!(
            "signer_id must be 1 to {MAX_SIGNER_ID_LEN} characters of a-z, 0-9, '.', '_' and '-'"
        ));
    }
}

/// Parses `0x` and 40 hex characters, of either case, into an address. Panics `E_ATTESTATION`
/// otherwise.
fn parse_address(text: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    let parsed = text
        .strip_prefix("0x")
        .is_some_and(|digits| digits.len() == 40 && hex::decode_to_slice(digits, &mut out).is_ok());
    if !parsed {
        bad_attestation(
            "public_key_or_address must be an Ethereum address: 0x and 40 hex characters"
                .to_string(),
        );
    }
    out
}

/// Panics `E_ATTESTATION` unless `model` is 1 to 128 bytes with no `:`, which separates the model
/// from the hashes in a signed text.
fn check_model(model: &str) {
    if !(1..=MAX_MODEL_BYTES).contains(&model.len()) || model.contains(':') {
        bad_attestation(format!(
            "model must be 1 to {MAX_MODEL_BYTES} bytes with no ':'"
        ));
    }
}

/// Parses 64 lowercase hex characters, or returns `None`.
fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let lowercase = text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    (lowercase && hex::decode_to_slice(text, &mut out).is_ok()).then_some(out)
}

/// The request and response hashes of attestation `i`, whose `text` must be exactly
/// `"{model}:{64 lowercase hex}:{64 lowercase hex}"`. Panics `E_ATTESTATION` otherwise.
fn parse_text(i: usize, text: &str, signer_id: &str, model: &str) -> ([u8; 32], [u8; 32]) {
    let Some((text_model, hashes)) = text.split_once(':') else {
        bad_attestation(format!(
            "attestation {i}: text must be model:request_hash:response_hash"
        ));
    };
    if text_model != model {
        bad_attestation(format!(
            "attestation {i}: text does not name the model {model} that signer {signer_id} signs for"
        ));
    }
    let parsed = hashes
        .split_once(':')
        .and_then(|(request, response)| Some((parse_hex32(request)?, parse_hex32(response)?)));
    parsed.unwrap_or_else(|| {
        bad_attestation(format!(
            "attestation {i}: text must be model:request_hash:response_hash, each hash 64 \
             lowercase hex characters"
        ))
    })
}

/// The 65 bytes of attestation `i`'s signature, `0x` optional, with `v` normalised to 0 or 1 from
/// 27, 28, 0 or 1. Panics `E_ATTESTATION` otherwise.
fn parse_signature(i: usize, signature: &str) -> ([u8; 64], u8) {
    let digits = signature.strip_prefix("0x").unwrap_or(signature);
    let mut bytes = [0u8; 65];
    if digits.len() != 130 || hex::decode_to_slice(digits, &mut bytes).is_err() {
        bad_attestation(format!(
            "attestation {i}: signature must be 65 bytes in hex (130 hex characters, 0x optional)"
        ));
    }
    let v = match bytes[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        other => bad_attestation(format!(
            "attestation {i}: signature recovery id must be 27, 28, 0 or 1, got {other}"
        )),
    };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&bytes[..64]);
    (rs, v)
}

/// The keccak-256 that EIP-191 `personal_sign` signs for `text`:
/// `keccak256("\x19Ethereum Signed Message:\n" + decimal byte length of text + text)`.
fn eip191_digest(text: &str) -> [u8; 32] {
    let length = text.len().to_string();
    let mut message = Vec::with_capacity(EIP191_PREFIX.len() + length.len() + text.len());
    message.extend_from_slice(EIP191_PREFIX);
    message.extend_from_slice(length.as_bytes());
    message.extend_from_slice(text.as_bytes());
    env::keccak256_array(&message)
}

/// Checks every attestation of a `pick_attested` of task `task_id`, and returns the
/// `attested_pick` event of each, in order. Panics `E_ATTESTATION` on the first that fails:
/// - there are 1 to `MAX_ATTESTATIONS` of them;
/// - no two have the same `text`;
/// - the signer is registered and enabled;
/// - the text is exactly `"{model}:{64 lowercase hex}:{64 lowercase hex}"`, with the signer's
///   model;
/// - the signature is 65 bytes with a recovery id of 27, 28, 0 or 1, and recovers, from the
///   EIP-191 digest of the text, the key whose address is the signer's.
///
/// It reads the signers and changes nothing.
pub(crate) fn check_attestations(
    task_id: U64,
    attestations: &[AttestationArg],
) -> Vec<AttestedPick> {
    if !(1..=MAX_ATTESTATIONS).contains(&attestations.len()) {
        bad_attestation(format!(
            "a pick_attested takes 1 to {MAX_ATTESTATIONS} attestations, got {}",
            attestations.len()
        ));
    }
    attestations
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if let Some(j) = attestations[..i].iter().position(|b| b.text == a.text) {
                bad_attestation(format!(
                    "attestation {i} repeats the text of attestation {j}"
                ));
            }
            let signer_id = a.signer_id.as_str();
            // An id that could never be registered is not looked up, nor repeated in the message:
            // it may be longer than a storage key can be.
            if !valid_signer_id(signer_id) {
                bad_attestation(format!(
                    "attestation {i}: signer_id is not a registrable signer id"
                ));
            }
            let signer = read_signer(signer_id).unwrap_or_else(|| {
                bad_attestation(format!(
                    "attestation {i}: no signer is registered as {signer_id}"
                ))
            });
            if !signer.enabled {
                bad_attestation(format!("attestation {i}: signer {signer_id} is disabled"));
            }
            let (request_hash, response_hash) = parse_text(i, &a.text, signer_id, &signer.model);
            let (rs, v) = parse_signature(i, &a.signature);
            match signer.algo {
                SignerAlgo::Ecdsa => {
                    let key = env::ecrecover(&eip191_digest(&a.text), &rs, v, false)
                        .unwrap_or_else(|| {
                            bad_attestation(format!(
                                "attestation {i}: the signature recovers no key"
                            ))
                        });
                    let hash = env::keccak256_array(key);
                    if hash[12..] != signer.address {
                        bad_attestation(format!(
                            "attestation {i}: the signature is not by signer {signer_id} ({})",
                            address_text(&signer.address)
                        ));
                    }
                }
            }
            AttestedPick {
                task_id,
                signer_id: a.signer_id.clone(),
                model: signer.model,
                request_hash: hex32(&request_hash),
                response_hash: hex32(&response_hash),
            }
        })
        .collect()
}

#[near]
impl Tender {
    /// Registers `signer_id` as an attested signer, or replaces its record: the key it signs with,
    /// the model it signs for, and whether its attestations are accepted. Owner only, with exactly
    /// 1 yoctoNEAR, like the other admin methods, and the checks run in their order: the deposit,
    /// the caller (`E_OWNER`), the arguments (`E_ATTESTATION`), and last the storage.
    ///
    /// - `signer_id` is 1 to 64 characters of `a-z`, `0-9`, `.`, `_` and `-`;
    /// - `algo` is `"ecdsa"`; no other algorithm is built;
    /// - `public_key_or_address` is the signer's Ethereum address, `0x` and 40 hex characters of
    ///   either case, stored lowercase;
    /// - `model` is 1 to 128 bytes with no `:`.
    ///
    /// The owner pays for the record out of its storage balance (`E_STORAGE`; `storage_deposit`
    /// first), and gets back what a smaller replacement frees. Disable a signer with
    /// `enabled: false`; its record stays. Logs no event, like the other admin methods.
    ///
    /// The contract cannot check a TDX quote: the owner checks the model's attestation report off
    /// chain before registering the address it names.
    #[payable]
    #[deny_unknown_arguments]
    pub fn set_attested_signer(
        &mut self,
        signer_id: String,
        algo: String,
        public_key_or_address: String,
        model: String,
        enabled: bool,
    ) {
        let owner = self.assert_owner();
        check_signer_id(&signer_id);
        if algo != ALGO_ECDSA {
            bad_attestation(format!(
                "algo must be \"{ALGO_ECDSA}\"; no other algorithm is built"
            ));
        }
        let address = parse_address(&public_key_or_address);
        check_model(&model);
        let record = AttestedSigner {
            algo: SignerAlgo::Ecdsa,
            address,
            model,
            enabled,
        };
        let bytes = borsh::to_vec(&record)
            .unwrap_or_else(|_| env::panic_str("an attested signer did not serialize"));
        let before = self.storage_mark();
        env::storage_write(&signer_key(&signer_id), &bytes);
        self.settle_storage(&owner, before);
    }

    /// The attested signer registered as `signer_id`, or `null`.
    pub fn get_attested_signer(&self, signer_id: String) -> Option<AttestedSignerView> {
        // An id that could never be registered is never looked up.
        if !valid_signer_id(&signer_id) {
            return None;
        }
        let signer = read_signer(&signer_id)?;
        Some(AttestedSignerView {
            signer_id,
            algo: match signer.algo {
                SignerAlgo::Ecdsa => ALGO_ECDSA.to_string(),
            },
            address: address_text(&signer.address),
            model: signer.model,
            enabled: signer.enabled,
        })
    }

    /// `pick`, with 1 to `MAX_ATTESTATIONS` attestations by registered signers. It checks every
    /// rule of `pick`, in `pick`'s order and with its codes (the two share `settle_pick`), then
    /// every attestation (`E_ATTESTATION`; see `check_attestations`), and only then settles,
    /// exactly as `pick` does: winners are paid, or an empty `winners` voids the task as
    /// `no_award`. Each attestation is `{"signer_id": ..., "text": ..., "signature": ...}`.
    ///
    /// Logs `picked` (or `voided`), then one `attested_pick` per attestation, in order. Stores
    /// nothing beyond what `pick` stores: the events are the record of the attestations.
    #[deny_unknown_arguments]
    pub fn pick_attested(
        &mut self,
        task_id: U64,
        winners: Vec<WinnerArg>,
        scorecard_hash: String,
        scorecard_uri: String,
        attestations: Vec<AttestationArg>,
    ) {
        let events = self.settle_pick(task_id, winners, scorecard_hash, scorecard_uri, || {
            check_attestations(task_id, &attestations)
        });
        for event in &events {
            emit("attested_pick", event);
        }
    }
}
