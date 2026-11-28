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
#[derive(Debug, Default)]
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

/// A value `JSON.parse` gives.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    /// The members in the order written; a name written twice keeps its
    /// first place and its last value, as JSON.parse keeps it.
    Object(Vec<(String, Json)>),
}

/// What `JSON.parse(text)` does with a text.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Value(Json),
    /// JSON.parse throws (a SyntaxError).
    Invalid,
    /// Not reproduced: a lone surrogate in a string (a JavaScript string can
    /// hold one, a Rust one cannot), or nesting deeper than 400.
    Unsupported,
}

/// `JSON.parse(text)`.
pub fn json_parse(text: &str) -> Parsed {
    let mut parser = JsonParser { b: text.as_bytes(), at: 0, depth: 0 };
    parser.space();
    let value = match parser.value() {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    parser.space();
    if parser.at != parser.b.len() {
        return Parsed::Invalid;
    }
    Parsed::Value(value)
}

struct JsonParser<'a> {
    b: &'a [u8],
    at: usize,
    depth: usize,
}

impl JsonParser<'_> {
    fn space(&mut self) {
        while matches!(self.b.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, word: &str) -> Result<(), Parsed> {
        if self.b[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(())
        } else {
            Err(Parsed::Invalid)
        }
    }

    fn value(&mut self) -> Result<Json, Parsed> {
        match self.b.get(self.at) {
            Some(b'n') => self.eat("null").map(|_| Json::Null),
            Some(b't') => self.eat("true").map(|_| Json::Bool(true)),
            Some(b'f') => self.eat("false").map(|_| Json::Bool(false)),
            Some(b'"') => self.string().map(Json::String),
            Some(b'[') => {
                self.nest()?;
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.b.get(self.at) == Some(&b']') {
                    self.at += 1;
                } else {
                    loop {
                        self.space();
                        items.push(self.value()?);
                        self.space();
                        match self.b.get(self.at) {
                            Some(b',') => self.at += 1,
                            Some(b']') => {
                                self.at += 1;
                                break;
                            }
                            _ => return Err(Parsed::Invalid),
                        }
                    }
                }
                self.depth -= 1;
                Ok(Json::Array(items))
            }
            Some(b'{') => {
                self.nest()?;
                self.at += 1;
                let mut members: Vec<(String, Json)> = Vec::new();
                self.space();
                if self.b.get(self.at) == Some(&b'}') {
                    self.at += 1;
                } else {
                    loop {
                        self.space();
                        if self.b.get(self.at) != Some(&b'"') {
                            return Err(Parsed::Invalid);
                        }
                        let name = self.string()?;
                        self.space();
                        self.eat(":")?;
                        self.space();
                        let value = self.value()?;
                        match members.iter_mut().find(|(n, _)| *n == name) {
                            Some(member) => member.1 = value,
                            None => members.push((name, value)),
                        }
                        self.space();
                        match self.b.get(self.at) {
                            Some(b',') => self.at += 1,
                            Some(b'}') => {
                                self.at += 1;
                                break;
                            }
                            _ => return Err(Parsed::Invalid),
                        }
                    }
                }
                self.depth -= 1;
                Ok(Json::Object(members))
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(Parsed::Invalid),
        }
    }

    fn nest(&mut self) -> Result<(), Parsed> {
        self.depth += 1;
        if self.depth > 400 {
            return Err(Parsed::Unsupported);
        }
        Ok(())
    }

    fn number(&mut self) -> Result<Json, Parsed> {
        let start = self.at;
        let digits = |p: &mut Self| {
            let from = p.at;
            while matches!(p.b.get(p.at), Some(b'0'..=b'9')) {
                p.at += 1;
            }
            p.at - from
        };
        if self.b.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        match self.b.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(Parsed::Invalid),
        }
        if self.b.get(self.at) == Some(&b'.') {
            self.at += 1;
            if digits(self) == 0 {
                return Err(Parsed::Invalid);
            }
        }
        if matches!(self.b.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.b.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if digits(self) == 0 {
                return Err(Parsed::Invalid);
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.at]).map_err(|_| Parsed::Invalid)?;
        text.parse::<f64>().map(Json::Number).map_err(|_| Parsed::Invalid)
    }

    fn string(&mut self) -> Result<String, Parsed> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let Some(&byte) = self.b.get(self.at) else { return Err(Parsed::Invalid) };
            match byte {
                b'"' => {
                    self.at += 1;
                    return Ok(out);
                }
                0x00..=0x1f => return Err(Parsed::Invalid),
                b'\\' => {
                    self.at += 1;
                    let Some(&escape) = self.b.get(self.at) else { return Err(Parsed::Invalid) };
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            if (0xd800..0xdc00).contains(&unit) {
                                // A pair, or a lone surrogate (which a Rust string cannot hold).
                                if self.b[self.at..].starts_with(b"\\u") {
                                    self.at += 2;
                                    let low = self.hex4()?;
                                    if (0xdc00..0xe000).contains(&low) {
                                        let c = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                                        out.push(char::from_u32(c).ok_or(Parsed::Invalid)?);
                                        continue;
                                    }
                                }
                                return Err(Parsed::Unsupported);
                            }
                            if (0xdc00..0xe000).contains(&unit) {
                                return Err(Parsed::Unsupported);
                            }
                            out.push(char::from_u32(unit).ok_or(Parsed::Invalid)?);
                        }
                        _ => return Err(Parsed::Invalid),
                    }
                }
                _ => {
                    // The text is a Rust string: a whole character at a time.
                    let rest = std::str::from_utf8(&self.b[self.at..]).map_err(|_| Parsed::Invalid)?;
                    let c = rest.chars().next().ok_or(Parsed::Invalid)?;
                    out.push(c);
                    self.at += c.len_utf8();
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, Parsed> {
        let digits = self.b.get(self.at..self.at + 4).ok_or(Parsed::Invalid)?;
        let text = std::str::from_utf8(digits).map_err(|_| Parsed::Invalid)?;
        if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Parsed::Invalid);
        }
        self.at += 4;
        u32::from_str_radix(text, 16).map_err(|_| Parsed::Invalid)
    }
}

impl Json {
    /// `value.name` for an object; `undefined` (None) for anything else and
    /// for a name it does not have. (No object here has a prototype member
    /// of the names the server looks up: cmd, cwd, cols, rows, type, t.)
    pub fn get(&self, name: &str) -> Option<&Json> {
        match self {
            Json::Object(members) => members.iter().find(|(n, _)| n == name).map(|(_, v)| v),
            _ => None,
        }
    }

    /// ToBoolean.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Number(x) => !(*x == 0.0 || x.is_nan()),
            Json::String(s) => !s.is_empty(),
            Json::Array(_) | Json::Object(_) => true,
        }
    }

    /// `Number(value)` (ToNumber). `None` for an array or an object, whose
    /// conversion goes through their own methods.
    pub fn to_number(&self) -> Option<f64> {
        match self {
            Json::Null => Some(0.0),
            Json::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Json::Number(x) => Some(*x),
            Json::String(s) => string_to_number(s),
            Json::Array(_) | Json::Object(_) => None,
        }
    }
}

/// `Number(s)` for a string (StringToNumber): white space around it,
/// nothing for 0, Infinity, 0x, 0o and 0b integers, or a decimal literal;
/// NaN for anything else. `None` for a 0x, 0o or 0b integer of more than 53
/// bits, which this does not round.
pub fn string_to_number(s: &str) -> Option<f64> {
    let t = trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let digits = &t[2..];
            if !digits.chars().all(|c| c.is_digit(radix)) {
                return Some(f64::NAN);
            }
            let value = u128::from_str_radix(digits.trim_start_matches('0').get(..).filter(|d| !d.is_empty()).unwrap_or("0"), radix).ok()?;
            return (value < (1u128 << 53)).then_some(value as f64);
        }
    }
    // [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let int = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    i += int;
    let mut frac = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        frac = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac;
    }
    if int + frac == 0 {
        return Some(f64::NAN);
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let exp = b[j..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp == 0 {
            return Some(f64::NAN);
        }
        i = j + exp;
    }
    if i != b.len() {
        return Some(f64::NAN);
    }
    t.parse::<f64>().ok().or(Some(f64::NAN))
}

/// `JSON.stringify(value)`. `None` for a number whose spelling this module
/// does not reproduce.
pub fn json_stringify(value: &Json) -> Option<String> {
    Some(match value {
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(x) => json_number(*x)?,
        Json::String(s) => json_string(s),
        Json::Array(items) => format!("[{}]", items.iter().map(json_stringify).collect::<Option<Vec<_>>>()?.join(",")),
        Json::Object(members) => {
            // Names that are array indices come first, in numeric order, as
            // JavaScript orders an object's own keys.
            let index = |name: &str| -> Option<u32> { (name == "0" || (!name.starts_with('0') && !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()))).then(|| name.parse::<u32>().ok()).flatten().filter(|n| *n != u32::MAX) };
            let mut ordered: Vec<&(String, Json)> = members.iter().filter(|(n, _)| index(n).is_some()).collect();
            ordered.sort_by_key(|(n, _)| index(n));
            ordered.extend(members.iter().filter(|(n, _)| index(n).is_none()));
            let parts = ordered.iter().map(|(n, v)| Some(format!("{}:{}", json_string(n), json_stringify(v)?))).collect::<Option<Vec<_>>>()?;
            format!("{{{}}}", parts.join(","))
        }
    })
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

    #[test]
    fn json_parse_is_javascripts() {
        let data = testdata::js();
        let mut unsupported = 0;
        for case in list(&data, "jsonParse") {
            match json_parse(text(&case[0])) {
                Parsed::Value(value) => assert_eq!(json_stringify(&value).as_deref(), case[1].as_str(), "JSON.parse({:?})", case[0]),
                Parsed::Invalid => assert!(case[1].is_null(), "JSON.parse({:?}) does not throw", case[0]),
                Parsed::Unsupported => unsupported += 1,
            }
        }
        assert!(unsupported < 150, "{unsupported} unsupported");
    }

    #[test]
    fn to_number_is_javascripts() {
        let data = testdata::js();
        for case in list(&data, "toNumber") {
            if let Some(x) = string_to_number(text(&case[0])) {
                assert_eq!(testdata::shown(x), text(&case[1]), "Number({:?})", case[0]);
            }
        }
    }
}
