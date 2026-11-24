//! Native messaging framing (port of the loop in `native/host.js`): every message is a 4-byte little-endian length
//! followed by that many bytes of JSON, on stdin and stdout.

/// Largest message accepted; Firefox itself never sends more than 1 MB.
pub const MAX_MESSAGE: usize = 8 * 1024 * 1024;

pub fn encode(body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + body.len());
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(body);
    v
}

/// Collects bytes as they arrive and hands out whole messages.
#[derive(Debug, Default)]
pub struct Frames { buf: Vec<u8> }

impl Frames {
    pub fn new() -> Frames { Frames::default() }

    /// Add received bytes; returns every message that is complete now, or `Err` when a length is absurd (the stream is broken).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        loop {
            if self.buf.len() < 4 { break; }
            let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if len > MAX_MESSAGE { self.buf.clear(); return Err(format!("message of {} bytes is too large", len)); }
            if self.buf.len() < 4 + len { break; }
            out.push(self.buf[4..4 + len].to_vec());
            self.buf.drain(..4 + len);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_in_odd_pieces() {
        let a = encode(b"{\"cmd\":\"config\"}");
        let b = encode(b"{}");
        let mut all = a.clone();
        all.extend_from_slice(&b);
        for step in [1usize, 2, 3, 5, 7, 100] {
            let mut f = Frames::new();
            let mut got = vec![];
            for piece in all.chunks(step) { got.extend(f.push(piece).unwrap()); }
            assert_eq!(got, vec![b"{\"cmd\":\"config\"}".to_vec(), b"{}".to_vec()], "step {}", step);
        }
    }

    #[test]
    fn empty_message_and_absurd_length() {
        let mut f = Frames::new();
        assert_eq!(f.push(&encode(b"")).unwrap(), vec![Vec::<u8>::new()]);
        let mut g = Frames::new();
        assert!(g.push(&[0xff, 0xff, 0xff, 0xff]).is_err());
    }

    #[test]
    fn little_endian_length() {
        assert_eq!(&encode(&[0u8; 300])[..4], &[44, 1, 0, 0]);
    }
}
