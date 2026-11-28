//! What the TypeScript gets from JavaScript itself, spelt out: white space
//! and trim, parseInt, Number, String(number), JSON.stringify of a string,
//! decodeURIComponent, URLSearchParams and TextDecoder.
//!
//! Each is checked against bun in the tests, on inputs recorded by
//! rs/parity/record.ts (rs/src/testdata/js.json). Where JavaScript's answer
//! would take more than this module does (a number whose shortest form has
//! more than 15 significant digits, where JavaScript and Rust may round a
//! tie differently), the function says `None` and the caller declines.

/// JavaScript's white space and line terminators: what `\s` matches and
/// what `trim()` removes (WhiteSpace and LineTerminator in ECMA-262). Not
/// U+0085 and not U+180E, which Rust's `char::is_whitespace` treats
/// differently; U+FEFF, which Rust does not count.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `.` in a JavaScript regular expression without the `s` flag matches
/// everything but these.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// `\w` without the `u` flag.
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `parseInt(s)` without a radix: leading white space, a sign, `0x` for
/// hexadecimal, then as many digits as there are. NaN when there are none.
/// Digits beyond what an f64 holds exactly are not rounded the way
/// JavaScript does, so more than 15 significant decimal digits (13 hex)
/// give `None`.
pub fn parse_int(s: &str) -> Option<f64> {
    let s = s.trim_start_matches(is_space);
    let (negative, s) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let (radix, s) = if s.len() >= 2 && (s.starts_with("0x") || s.starts_with("0X")) { (16, &s[2..]) } else { (10, s) };
    let digits: &str = &s[..s.find(|c: char| !c.is_digit(radix)).unwrap_or(s.len())];
    if digits.is_empty() {
        return Some(f64::NAN);
    }
    let significant = digits.trim_start_matches('0');
    let limit = if radix == 16 { 13 } else { 15 };
    if significant.len() > limit {
        return None;
    }
    let value = if significant.is_empty() { 0 } else { u64::from_str_radix(significant, radix).ok()? };
    let value = value as f64;
    Some(if negative { -value } else { value })
}

/// `String(x)` for a number: the shortest digits that read back as `x`,
/// written as ECMA-262's Number::toString writes them. `None` where the
/// shortest form has more than 15 significant digits (see the module).
pub fn number_to_string(x: f64) -> Option<String> {
    if x.is_nan() {
        return Some("NaN".into());
    }
    if x.is_infinite() {
        return Some(if x > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    if x == 0.0 {
        return Some("0".into());
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let x = x.abs();
    // An integer below 2^53: every digit is needed, and there is one answer.
    if x.fract() == 0.0 && x < 9_007_199_254_740_992.0 {
        return Some(format!("{sign}{}", x as u64));
    }
    // Rust's `{:e}` gives the shortest digits that read back: d.ddddde<exp>.
    let formatted = format!("{x:e}");
    let (mantissa, exponent) = formatted.split_once('e')?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    if digits.len() > 15 {
        return None;
    }
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().ok()? + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 { format!("+{e}") } else { format!("{e}") };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    Some(format!("{sign}{body}"))
}

/// `JSON.stringify(s)` for a string.
pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(x)` for a number: `null` for NaN and the infinities.
pub fn json_number(x: f64) -> Option<String> {
    if !x.is_finite() {
        return Some("null".into());
    }
    number_to_string(x)
}

/// `decodeURIComponent(s)`: `None` where JavaScript throws a URIError (a `%`
/// not followed by two hex digits, or escapes that are not UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let byte = hex_byte(bytes, i)?;
        i += 3;
        if byte < 0x80 {
            out.push(byte);
            continue;
        }
        // The number of bytes the lead byte announces; then that many escapes.
        let length = match byte {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut sequence = vec![byte];
        for _ in 1..length {
            if bytes.get(i) != Some(&b'%') {
                return None;
            }
            let next = hex_byte(bytes, i)?;
            if next & 0xc0 != 0x80 {
                return None;
            }
            sequence.push(next);
            i += 3;
        }
        // Overlong forms, surrogates and what lies above U+10FFFF are refused,
        // as Rust's own UTF-8 check refuses them.
        std::str::from_utf8(&sequence).ok()?;
        out.extend_from_slice(&sequence);
    }
    String::from_utf8(out).ok()
}

fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
    let hi = (*bytes.get(at + 1)? as char).to_digit(16)?;
    let lo = (*bytes.get(at + 2)? as char).to_digit(16)?;
    Some((hi * 16 + lo) as u8)
}

/// Percent-decoding as URLSearchParams does it: `%` with two hex digits is
/// that byte, anything else stays as it is.
fn percent_decode_bytes(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'%' {
            if let Some(byte) = hex_byte(s, i) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

/// `new URLSearchParams(query)` (application/x-www-form-urlencoded), the
/// pairs in order. A leading `?` is dropped, as URLSearchParams drops it.
pub fn search_params(query: &str) -> Vec<(String, String)> {
    let query = query.strip_prefix('?').unwrap_or(query);
    let mut pairs = Vec::new();
    for part in query.as_bytes().split(|b| *b == b'&') {
        if part.is_empty() {
            continue;
        }
        let (name, value) = match part.iter().position(|b| *b == b'=') {
            Some(at) => (&part[..at], &part[at + 1..]),
            None => (part, &b""[..]),
        };
        let decode = |bytes: &[u8]| {
            let plus: Vec<u8> = bytes.iter().map(|b| if *b == b'+' { b' ' } else { *b }).collect();
            String::from_utf8_lossy(&percent_decode_bytes(&plus)).into_owned()
        };
        pairs.push((decode(name), decode(value)));
    }
    pairs
}

/// `URLSearchParams.prototype.get`: the first value of that name.
pub fn search_param<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
}

/// `new TextDecoder().decode(bytes)`: UTF-8, a byte order mark at the start
/// dropped, each invalid sequence one U+FFFD.
pub fn text_decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// A `TextDecoder` used with `{ stream: true }`, as bun-pty decodes what it
/// reads from a terminal: a sequence cut at the end of one chunk is kept for
/// the next, and the byte order mark is dropped only at the very start.
#[derive(Default)]
pub struct StreamDecoder {
    pending: Vec<u8>,
    started: bool,
}

impl StreamDecoder {
    /// `decode(chunk, { stream: true })`.
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut bytes = std::mem::take(&mut self.pending);
        if !self.started {
            // The mark is looked for until three bytes have come.
            if b"\xef\xbb\xbf".starts_with(&bytes[..bytes.len().min(3)]) && bytes.len() < 3 {
                self.pending = bytes;
                return String::new();
            }
            self.started = true;
            if bytes.starts_with(b"\xef\xbb\xbf") {
                bytes.drain(..3);
            }
        }
        let keep = incomplete_tail(&bytes);
        self.pending = bytes.split_off(bytes.len() - keep);
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// `decode()`: whatever is left, an unfinished sequence as one U+FFFD.
    pub fn finish(&mut self) -> String {
        let bytes = std::mem::take(&mut self.pending);
        self.started = false;
        if bytes.starts_with(b"\xef\xbb\xbf") {
            return String::from_utf8_lossy(&bytes[3..]).into_owned();
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// How many bytes at the end of `bytes` begin a UTF-8 sequence that the next
/// bytes could still complete.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=3.min(bytes.len()) {
        let at = bytes.len() - back;
        let byte = bytes[at];
        if byte & 0xc0 == 0x80 {
            continue;
        }
        let need = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return 0,
        };
        if need <= back {
            return 0;
        }
        // The bytes so far must still be a possible start of that sequence.
        let tail = &bytes[at..];
        let second_ok = |second: u8| match byte {
            0xe0 => (0xa0..=0xbf).contains(&second),
            0xed => (0x80..=0x9f).contains(&second),
            0xf0 => (0x90..=0xbf).contains(&second),
            0xf4 => (0x80..=0x8f).contains(&second),
            _ => (0x80..=0xbf).contains(&second),
        };
        if tail.len() >= 2 && !second_ok(tail[1]) {
            return 0;
        }
        if tail[1..].iter().any(|b| b & 0xc0 != 0x80) {
            return 0;
        }
        return back;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdata::{self, bytes, double, list, text};

    #[test]
    fn trim_is_javascripts() {
        let data = testdata::js();
        for case in list(&data, "trim") {
            assert_eq!(trim(text(&case[0])), text(&case[1]), "trim {:?}", case[0]);
            assert_eq!(trim_end(text(&case[0])), text(&case[2]), "trimEnd {:?}", case[0]);
        }
    }

    #[test]
    fn parse_int_is_javascripts() {
        let data = testdata::js();
        let mut declined = 0;
        for case in list(&data, "parseInt") {
            match parse_int(text(&case[0])) {
                Some(x) => assert_eq!(testdata::shown(x), text(&case[1]), "parseInt({:?})", case[0]),
                None => declined += 1,
            }
        }
        assert!(declined < 200, "{declined} declined");
    }

    #[test]
    fn number_to_string_is_javascripts() {
        let data = testdata::js();
        let mut declined = 0;
        for case in list(&data, "numberToString") {
            let x = double(&case[0]);
            match number_to_string(x) {
                Some(s) => {
                    assert_eq!(s, text(&case[1]), "String({x:e})");
                    assert_eq!(json_number(x).unwrap(), text(&case[2]), "JSON.stringify({x:e})");
                }
                None => declined += 1,
            }
        }
        // Shortest forms of more than 15 digits: random doubles have 17.
        assert!(declined < 900, "{declined} declined");
    }

    #[test]
    fn json_string_is_javascripts() {
        let data = testdata::js();
        for case in list(&data, "jsonString") {
            assert_eq!(json_string(text(&case[0])), text(&case[1]));
        }
    }

    #[test]
    fn decode_uri_component_is_javascripts() {
        let data = testdata::js();
        for case in list(&data, "decodeURIComponent") {
            let expected = case[1].as_str().map(str::to_string);
            assert_eq!(decode_uri_component(text(&case[0])), expected, "decodeURIComponent({:?})", case[0]);
        }
    }

    #[test]
    fn search_params_are_javascripts() {
        let data = testdata::js();
        for case in list(&data, "searchParams") {
            let expected: Vec<(String, String)> = case[1].as_array().unwrap().iter().map(|p| (text(&p[0]).to_string(), text(&p[1]).to_string())).collect();
            assert_eq!(search_params(text(&case[0])), expected, "URLSearchParams({:?})", case[0]);
        }
    }

    #[test]
    fn text_decode_is_javascripts() {
        let data = testdata::js();
        for case in list(&data, "textDecode") {
            assert_eq!(text_decode(&bytes(&case[0])), text(&case[1]), "decode {}", text(&case[0]));
        }
        for case in list(&data, "streamDecode") {
            let mut decoder = StreamDecoder::default();
            let chunks = case[0].as_array().unwrap();
            let outputs = case[1].as_array().unwrap();
            for (chunk, output) in chunks.iter().zip(outputs) {
                assert_eq!(decoder.decode(&bytes(chunk)), text(output), "stream {:?}", case[0]);
            }
            assert_eq!(decoder.finish(), text(&case[2]), "flush {:?}", case[0]);
        }
    }
}
