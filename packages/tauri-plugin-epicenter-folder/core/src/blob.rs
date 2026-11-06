//! A file's Git blob id (ADR-0808): SHA-1 over `blob <length>\0` and its
//! bytes, as `git hash-object` names it and as `gitBlobId` in
//! `packages/folder/src/hash.ts` does. A note's version, and any hidden
//! file's, is its blob id; an attachment's is its Git LFS pointer's, which
//! the page computes from the attachment's hash.
//!
//! SHA-1 is written out here (FIPS 180-4) rather than taken from a crate:
//! it is only a name for bytes, never a security boundary, and it is short.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// A streaming SHA-1.
struct Sha1 {
    state: [u32; 5],
    block: [u8; 64],
    filled: usize,
    length: u64,
}

impl Sha1 {
    fn new() -> Self {
        Self {
            state: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
            block: [0; 64],
            filled: 0,
            length: 0,
        }
    }

    fn update(&mut self, mut bytes: &[u8]) {
        self.length += bytes.len() as u64;
        while !bytes.is_empty() {
            let take = (64 - self.filled).min(bytes.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&bytes[..take]);
            self.filled += take;
            bytes = &bytes[take..];
            if self.filled == 64 {
                let block = self.block;
                self.compress(&block);
                self.filled = 0;
            }
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = self.state;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (value, add) in self.state.iter_mut().zip([a, b, c, d, e]) {
            *value = value.wrapping_add(add);
        }
    }

    fn finish(mut self) -> String {
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.filled != 56 {
            self.update(&[0]);
        }
        let block = {
            let mut block = self.block;
            block[56..].copy_from_slice(&bits.to_be_bytes());
            block
        };
        self.compress(&block);
        self.state
            .iter()
            .map(|word| format!("{word:08x}"))
            .collect()
    }
}

/// The Git blob id of `bytes`.
pub fn blob_id(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hasher.finish()
}

/// The Git blob id of the file at `target`, read whole: a file that changed
/// length while it was read is named by the bytes read.
pub fn file_blob_id(target: &Path) -> io::Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(target)?.read_to_end(&mut bytes)?;
    Ok(blob_id(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_bytes_as_git_hash_object_does() {
        // `printf '' | git hash-object --stdin` and `printf 'hello\n' | git hash-object --stdin`.
        assert_eq!(blob_id(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(
            blob_id(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        // Across many blocks.
        assert_eq!(
            blob_id(&[b'a'; 1000]),
            "a50be72b20f0e3f078d252e8e56b11b4bec67509"
        );
    }
}
