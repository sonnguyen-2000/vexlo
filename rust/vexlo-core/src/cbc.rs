//! Streaming AES-CBC decryption with PKCS#7 padding (the HLS "AES-128" method), independent of the block cipher itself:
//! the caller supplies a function that decrypts one 16-byte block. Data can arrive in any chunk sizes.

pub struct CbcDecryptor<F: FnMut(&[u8; 16]) -> [u8; 16]> {
    dec: F,
    prev: [u8; 16],
    pending: Vec<u8>,
}

impl<F: FnMut(&[u8; 16]) -> [u8; 16]> CbcDecryptor<F> {
    pub fn new(dec: F, iv: [u8; 16]) -> Self {
        CbcDecryptor { dec, prev: iv, pending: Vec::new() }
    }

    /// Feed ciphertext; returns the plaintext that is certain not to contain padding yet.
    /// The last 16..31 bytes are always held back until `finish`.
    pub fn update(&mut self, data: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(data);
        let mut out = Vec::new();
        let mut used = 0;
        while self.pending.len() - used >= 32 {
            let mut block = [0u8; 16];
            block.copy_from_slice(&self.pending[used..used + 16]);
            self.decrypt_block(&block, &mut out);
            used += 16;
        }
        self.pending.drain(..used);
        out
    }

    fn decrypt_block(&mut self, block: &[u8; 16], out: &mut Vec<u8>) {
        let mut plain = (self.dec)(block);
        for i in 0..16 {
            plain[i] ^= self.prev[i];
        }
        self.prev = *block;
        out.extend_from_slice(&plain);
    }

    /// The rest of the plaintext, without the padding. `Err` when the data is not a whole number of blocks or the padding is wrong.
    pub fn finish(mut self) -> Result<Vec<u8>, String> {
        if self.pending.is_empty() {
            return Ok(Vec::new());
        }
        if self.pending.len() % 16 != 0 {
            return Err("wrong final block length".into());
        }
        let mut out = Vec::new();
        let mut used = 0;
        let total = self.pending.len();
        while used < total {
            let mut block = [0u8; 16];
            block.copy_from_slice(&self.pending[used..used + 16]);
            self.decrypt_block(&block, &mut out);
            used += 16;
        }
        let n = *out.last().unwrap() as usize;
        if n == 0 || n > 16 || n > out.len() || out[out.len() - n..].iter().any(|&b| b as usize != n) {
            return Err("bad decrypt".into());
        }
        out.truncate(out.len() - n);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A toy block cipher (not secure): enough to check the chaining, chunking and padding logic.
    fn toy_enc(b: &[u8; 16]) -> [u8; 16] {
        let mut o = [0u8; 16];
        for i in 0..16 {
            o[(i + 5) % 16] = b[i] ^ (0x5a + i as u8);
        }
        o
    }
    fn toy_dec(b: &[u8; 16]) -> [u8; 16] {
        let mut o = [0u8; 16];
        for i in 0..16 {
            o[i] = b[(i + 5) % 16] ^ (0x5a + i as u8);
        }
        o
    }

    fn cbc_encrypt(plain: &[u8], iv: [u8; 16]) -> Vec<u8> {
        let pad = 16 - plain.len() % 16;
        let mut data = plain.to_vec();
        data.extend(std::iter::repeat(pad as u8).take(pad));
        let mut prev = iv;
        let mut out = Vec::new();
        for chunk in data.chunks(16) {
            let mut b = [0u8; 16];
            for i in 0..16 {
                b[i] = chunk[i] ^ prev[i];
            }
            let c = toy_enc(&b);
            out.extend_from_slice(&c);
            prev = c;
        }
        out
    }

    #[test]
    fn round_trip_in_any_chunking() {
        let iv = [7u8; 16];
        for len in [0usize, 1, 15, 16, 17, 31, 32, 33, 100, 4096, 5000] {
            let plain: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
            let enc = cbc_encrypt(&plain, iv);
            for chunk in [1usize, 3, 16, 17, 100, 100000] {
                let mut d = CbcDecryptor::new(toy_dec, iv);
                let mut got = Vec::new();
                for c in enc.chunks(chunk) {
                    got.extend(d.update(c));
                }
                got.extend(d.finish().unwrap());
                assert_eq!(got, plain, "len {} chunk {}", len, chunk);
            }
        }
    }

    #[test]
    fn rejects_bad_length_and_bad_padding() {
        let iv = [1u8; 16];
        let enc = cbc_encrypt(b"hello world", iv);
        let mut d = CbcDecryptor::new(toy_dec, iv);
        d.update(&enc[..enc.len() - 1]);
        assert!(d.finish().is_err());
        let mut bad = enc.clone();
        let n = bad.len();
        bad[n - 1] ^= 0x55;
        let mut d = CbcDecryptor::new(toy_dec, iv);
        let mut out = d.update(&bad);
        match d.finish() { Ok(v) => { out.extend(v); assert_ne!(out, b"hello world".to_vec()); } Err(_) => {} }
    }

    #[test]
    fn empty_input_gives_empty_output() {
        let d = CbcDecryptor::new(toy_dec, [0u8; 16]);
        assert!(d.finish().unwrap().is_empty());
    }
}
