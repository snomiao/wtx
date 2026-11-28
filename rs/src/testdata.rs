//! What rs/parity/record.ts recorded from the TypeScript under bun, for the
//! tests of the other modules. `bun rs/parity/record.ts --check` (run by
//! rs/parity/proof.sh) fails when these files are not what the bun at hand
//! records.

use serde_json::Value;

pub fn js() -> Value {
    serde_json::from_str(include_str!("testdata/js.json")).unwrap()
}

pub fn summary() -> Value {
    serde_json::from_str(include_str!("testdata/summary.json")).unwrap()
}

pub fn server() -> Value {
    serde_json::from_str(include_str!("testdata/server.json")).unwrap()
}

/// A list of the fixture, by name.
pub fn list<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value[name].as_array().unwrap_or_else(|| panic!("no list {name} in the fixture"))
}

pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_else(|| panic!("not a string: {value}"))
}

/// Bytes recorded as hex.
pub fn bytes(value: &Value) -> Vec<u8> {
    let hex = text(value);
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// A double recorded as the hex of its eight bytes.
pub fn double(value: &Value) -> f64 {
    let b = bytes(value);
    f64::from_be_bytes(b.try_into().unwrap())
}

/// A number written as record.ts's `num` writes it (String(x), and -0).
pub fn shown(x: f64) -> String {
    if x == 0.0 && x.is_sign_negative() {
        return "-0".into();
    }
    crate::js::number_to_string(x).expect("a number this module writes")
}
