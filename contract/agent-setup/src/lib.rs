//! The one-time setup of an agent's account, for wallets that refuse to add a full-access key.
//!
//! "Connect your agent" has the owner's wallet create the agent's account, `<name>.<owner>`, with
//! the key the agent made where it runs. Some wallets refuse any transaction that adds a
//! full-access key (an AddKey action). So the owner's one transaction to the new account is
//! CreateAccount, Transfer, DeployContract (this code) and a call of
//!
//!     setup({"public_key":"ed25519:<base58>"})
//!
//! and `setup` adds the key from inside the account, with a promise to the account itself. The
//! wallet sees no AddKey.
//!
//! `setup` is refused (it panics, and a panic undoes every action of its transaction, the
//! CreateAccount and the Transfer with it):
//! - `E_AUTH` unless the caller (the predecessor) is the account's parent, the account id after its
//!   first dot. Only the parent can create a sub-account, so only the account's creator sets it up;
//! - `E_ARGS` unless its argument is exactly `{"public_key":"ed25519:<base58 of 32 bytes>"}`, with
//!   JSON whitespace allowed between the tokens and the key in its one base58 spelling;
//! - `E_DONE` once it has run: it writes a flag to storage the first time, and refuses when the flag
//!   is there. It runs in the transaction that creates the account and never again, so the parent
//!   cannot add a key to the agent's account later.
//!
//! The code stays on the account and can do nothing more. Every agent account made this way pays
//! for its bytes in storage, so it is raw no_std wasm: no near-sdk, no allocator.

#![cfg_attr(target_arch = "wasm32", no_std)]

/// The longest argument `setup` reads: the exact form is at most 69 bytes, and the rest is room for
/// whitespace. A longer one is refused unread.
#[cfg(any(target_arch = "wasm32", test))]
const MAX_INPUT: usize = 128;

/// Bitcoin's base58 alphabet, as NEAR writes keys.
const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Whether `caller` is the parent of `account`: the account id after its first dot. An account with
/// no dot (a top-level or implicit account) has no parent.
pub fn is_parent(account: &[u8], caller: &[u8]) -> bool {
    match account.iter().position(|&byte| byte == b'.') {
        Some(dot) => &account[dot + 1..] == caller,
        None => false,
    }
}

/// `text` without its leading JSON whitespace.
fn skip_ws(text: &[u8]) -> &[u8] {
    let start = text
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        .unwrap_or(text.len());
    &text[start..]
}

/// The 32 bytes of the key that `input` names, if `input` is exactly
/// `{"public_key":"ed25519:<base58>"}` (whitespace allowed between the tokens, never inside the
/// string). Anything else, such as another key, an escape or a key of another curve, is `None`.
pub fn public_key_of(input: &[u8]) -> Option<[u8; 32]> {
    let mut rest = input;
    for token in [&b"{"[..], b"\"public_key\"", b":", b"\"ed25519:"] {
        rest = skip_ws(rest).strip_prefix(token)?;
    }
    let end = rest.iter().position(|&byte| byte == b'"')?;
    let key = decode_base58(&rest[..end])?;
    rest = skip_ws(&rest[end + 1..]).strip_prefix(b"}")?;
    skip_ws(rest).is_empty().then_some(key)
}

/// The 32 bytes that `text` spells in base58, if it spells exactly 32 in the one way base58 does:
/// one leading `1` for each leading zero byte, and no more.
pub fn decode_base58(text: &[u8]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut ones = 0;
    for (index, &char) in text.iter().enumerate() {
        let mut carry = ALPHABET.iter().position(|&digit| digit == char)? as u32;
        if carry == 0 && ones == index {
            ones += 1;
        }
        for byte in out.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = carry as u8;
            carry >>= 8;
        }
        // More than 32 bytes.
        if carry != 0 {
            return None;
        }
    }
    let zeros = out.iter().take_while(|&&byte| byte == 0).count();
    (!text.is_empty() && zeros == ones).then_some(out)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{is_parent, public_key_of, MAX_INPUT};

    /// The longest account id NEAR takes.
    const MAX_ACCOUNT: usize = 64;

    const E_AUTH: &str = "E_AUTH: only the parent account can set this account up";
    const E_ARGS: &str = "E_ARGS: expected {\"public_key\":\"ed25519:<base58 of 32 bytes>\"}";
    const E_DONE: &str = "E_DONE: this account is set up already";

    // The host functions of the NEAR runtime that `setup` uses (near-sys has them all).
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn input(register_id: u64);
        fn register_len(register_id: u64) -> u64;
        fn read_register(register_id: u64, ptr: u64);
        fn current_account_id(register_id: u64);
        fn predecessor_account_id(register_id: u64);
        fn storage_write(
            key_len: u64,
            key_ptr: u64,
            value_len: u64,
            value_ptr: u64,
            register_id: u64,
        ) -> u64;
        fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
        fn promise_batch_action_add_key_with_full_access(
            promise_index: u64,
            public_key_len: u64,
            public_key_ptr: u64,
            nonce: u64,
        );
        fn panic_utf8(len: u64, ptr: u64) -> !;
    }

    fn fail(message: &str) -> ! {
        unsafe { panic_utf8(message.len() as u64, message.as_ptr() as u64) }
    }

    /// Copies register 0 into `buf` and gives its length, or fails with `too_long` if it does not fit.
    fn take<const N: usize>(buf: &mut [u8; N], too_long: &str) -> usize {
        let len = unsafe { register_len(0) };
        if len > N as u64 {
            fail(too_long);
        }
        unsafe { read_register(0, buf.as_mut_ptr() as u64) };
        len as usize
    }

    /// The flag that says `setup` has run: its key in storage.
    const DONE: &[u8] = b"done";

    #[no_mangle]
    pub extern "C" fn setup() {
        let mut account = [0u8; MAX_ACCOUNT];
        let mut caller = [0u8; MAX_ACCOUNT];
        let mut args = [0u8; MAX_INPUT];

        unsafe { current_account_id(0) };
        let account_len = take(&mut account, E_AUTH);
        unsafe { predecessor_account_id(0) };
        let caller_len = take(&mut caller, E_AUTH);
        if !is_parent(&account[..account_len], &caller[..caller_len]) {
            fail(E_AUTH);
        }

        unsafe { input(0) };
        let args_len = take(&mut args, E_ARGS);
        let Some(key) = public_key_of(&args[..args_len]) else {
            fail(E_ARGS);
        };

        // `storage_write` says 1 when the key held a value already: setup has run.
        let ran = unsafe {
            storage_write(
                DONE.len() as u64,
                DONE.as_ptr() as u64,
                1,
                b"1".as_ptr() as u64,
                0,
            )
        };
        if ran != 0 {
            fail(E_DONE);
        }

        // The key as the runtime reads it (Borsh): 0 for ed25519, then its 32 bytes.
        let mut public_key = [0u8; 33];
        public_key[1..].copy_from_slice(&key);
        unsafe {
            let promise = promise_batch_create(account_len as u64, account.as_ptr() as u64);
            promise_batch_action_add_key_with_full_access(
                promise,
                public_key.len() as u64,
                public_key.as_ptr() as u64,
                0,
            );
        }
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Base58 the long way, for checking `decode_base58` against: a leading `1` per leading zero
    /// byte, then the number in base 58.
    fn encode(bytes: &[u8]) -> String {
        let mut digits: Vec<u8> = Vec::new();
        for &byte in bytes {
            let mut carry = u32::from(byte);
            for digit in digits.iter_mut() {
                carry += u32::from(*digit) << 8;
                *digit = (carry % 58) as u8;
                carry /= 58;
            }
            while carry > 0 {
                digits.push((carry % 58) as u8);
                carry /= 58;
            }
        }
        let zeros = bytes.iter().take_while(|&&byte| byte == 0).count();
        let mut text = "1".repeat(zeros);
        text.extend(digits.iter().rev().map(|&d| ALPHABET[d as usize] as char));
        text
    }

    /// 32 bytes that differ from run to run of `seed`, with no dependency.
    fn bytes_of(seed: u64) -> [u8; 32] {
        let mut state = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut out = [0u8; 32];
        for byte in out.iter_mut() {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *byte = (state >> 33) as u8;
        }
        out
    }

    fn args(key: &str) -> Vec<u8> {
        format!("{{\"public_key\":\"{key}\"}}").into_bytes()
    }

    #[test]
    fn decodes_keys_with_and_without_leading_zero_bytes() {
        for seed in 0..500u64 {
            let mut key = bytes_of(seed);
            // A few with one, two and all leading bytes zero.
            let zeros = match seed % 10 {
                0 => 1,
                1 => 2,
                2 => 5,
                _ => 0,
            };
            key[..zeros].fill(0);
            assert_eq!(
                decode_base58(encode(&key).as_bytes()),
                Some(key),
                "seed {seed}"
            );
        }
        assert_eq!(decode_base58("1".repeat(32).as_bytes()), Some([0; 32]));
        assert_eq!(
            decode_base58(encode(&[0xff; 32]).as_bytes()),
            Some([0xff; 32])
        );
    }

    #[test]
    fn refuses_anything_but_32_bytes_in_their_one_spelling() {
        let key = bytes_of(7);
        let text = encode(&key);
        // Empty, one byte short, one byte over.
        assert_eq!(decode_base58(b""), None);
        assert_eq!(decode_base58(encode(&key[1..]).as_bytes()), None);
        assert_eq!(decode_base58(encode(&[0xff; 33]).as_bytes()), None);
        // A leading 1 too many, and one too few.
        assert_eq!(decode_base58(format!("1{text}").as_bytes()), None);
        let mut zeroed = key;
        zeroed[0] = 0;
        assert_eq!(decode_base58(&encode(&zeroed).as_bytes()[1..]), None);
        assert_eq!(decode_base58("1".repeat(33).as_bytes()), None);
        // Characters base58 leaves out.
        for bad in ["0", "O", "I", "l", "+", "/", " ", "\""] {
            assert_eq!(
                decode_base58(format!("{}{bad}", &text[1..]).as_bytes()),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn reads_the_key_from_the_exact_argument() {
        let key = bytes_of(11);
        let text = format!("ed25519:{}", encode(&key));
        assert_eq!(public_key_of(&args(&text)), Some(key));
        // JSON whitespace between the tokens.
        let spaced = format!("\n {{ \"public_key\"\t:\r\n \"{text}\" }} \n");
        assert_eq!(public_key_of(spaced.as_bytes()), Some(key));
        // The longest exact form fits in what `setup` reads.
        let longest = args(&format!("ed25519:{}", encode(&[0xff; 32])));
        assert!(longest.len() <= MAX_INPUT, "{}", longest.len());
    }

    #[test]
    fn refuses_any_other_argument() {
        let text = format!("ed25519:{}", encode(&bytes_of(3)));
        let refused = [
            String::new(),
            "{}".to_string(),
            format!("\"{text}\""),
            format!("[\"{text}\"]"),
            format!("{{\"public_key\":\"{text}\",\"other\":1}}"),
            format!("{{\"other\":1,\"public_key\":\"{text}\"}}"),
            format!("{{\"public_key\":\"{text}\"}}x"),
            format!("{{\"public_key\":\"{text}\"}}{{}}"),
            format!("{{\"public_key\":\"{text}\""),
            format!("{{\"public_key\":\" {text}\"}}"),
            format!("{{\"public_key\":\"{text} \"}}"),
            format!("{{\"publicKey\":\"{text}\"}}"),
            format!(
                "{{\"public_key\":\"{}\"}}",
                text.replace("ed25519:", "secp256k1:")
            ),
            format!("{{\"public_key\":\"{}\"}}", text.replace("ed25519:", "")),
            format!(
                "{{\"public_key\":\"{}\"}}",
                text.replace("ed25519:", "ed25519\\u003a")
            ),
            format!("{{\"public_key\":\"{}\\\"\"}}", text),
            "{\"public_key\":null}".to_string(),
        ];
        for input in refused {
            assert_eq!(public_key_of(input.as_bytes()), None, "{input}");
        }
    }

    #[test]
    fn the_parent_is_the_account_after_the_first_dot() {
        assert!(is_parent(b"writer.alice.testnet", b"alice.testnet"));
        assert!(is_parent(b"a.b", b"b"));
        // Not the grandparent, the account itself, a stranger, or a prefix or suffix of the parent.
        assert!(!is_parent(b"writer.alice.testnet", b"testnet"));
        assert!(!is_parent(b"writer.alice.testnet", b"writer.alice.testnet"));
        assert!(!is_parent(b"writer.alice.testnet", b"bob.testnet"));
        assert!(!is_parent(b"writer.alice.testnet", b"alice.testne"));
        assert!(!is_parent(b"writer.alice.testnet", b"xalice.testnet"));
        assert!(!is_parent(b"writer.alice.testnet", b""));
        // An account with no dot has no parent.
        let implicit = "ab".repeat(32);
        assert!(!is_parent(implicit.as_bytes(), b""));
        assert!(!is_parent(b"near", b""));
    }
}
