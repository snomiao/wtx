//! src/term-summary.ts: what `/summary` says about a terminal's screen.
//!
//! `summarize` takes the rendered screen text, as `summarizeTerminal` does,
//! and answers the same fields; `TermSummary::to_json` writes them as
//! `JSON.stringify` does. The regular expressions of the TypeScript are
//! matched by hand, with JavaScript's meaning: `\s` is JavaScript's white
//! space (crate::js::is_space), `\b` and `\w` are ASCII, `/i` folds ASCII
//! letters only (without the `u` flag, no other letter folds to one), and
//! `.` stops at a line terminator.
//!
//! Checked against summarizeTerminal itself, run by bun on generated screens
//! (rs/parity/record.ts, rs/src/testdata/summary.json).

use crate::js;

/// The TypeScript's `TermSummary`.
#[derive(Debug, Clone, PartialEq)]
pub struct TermSummary {
    pub state: &'static str,
    pub recap: Option<String>,
    pub last_assistant: Option<String>,
    pub error_count: usize,
    pub waiting_for_user: bool,
    /// A JavaScript number: `(minutes || 0) * 60 + (seconds || 0)`.
    pub worked_sec: Option<f64>,
}

/// A screen this module does not answer exactly: a count of minutes or
/// seconds with more digits than an f64 holds exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Declined;

impl TermSummary {
    /// `JSON.stringify(summary)`, the fields in the TypeScript's order.
    pub fn to_json(&self) -> Option<String> {
        Some(format!("{{{}}}", self.json_fields()?))
    }

    /// The fields without the braces, for `/summary`, which adds
    /// `sessionKey` and `lastActivity` after them.
    pub fn json_fields(&self) -> Option<String> {
        let text = |value: &Option<String>| value.as_deref().map_or("null".to_string(), js::json_string);
        let worked = match self.worked_sec {
            None => "null".to_string(),
            Some(x) => js::json_number(x)?,
        };
        Some(format!(
            "\"state\":{},\"recap\":{},\"lastAssistant\":{},\"errorCount\":{},\"waitingForUser\":{},\"workedSec\":{}",
            js::json_string(self.state),
            text(&self.recap),
            text(&self.last_assistant),
            self.error_count,
            self.waiting_for_user,
            worked
        ))
    }
}

/// `summarizeTerminal(renderedText)`.
pub fn summarize(rendered: &str) -> Result<TermSummary, Declined> {
    let lines: Vec<&str> = rendered.split('\n').collect();
    if lines.iter().all(|line| js::trim(line).is_empty()) {
        return Ok(TermSummary { state: "empty", recap: None, last_assistant: None, error_count: 0, waiting_for_user: false, worked_sec: None });
    }
    let recap = extract_recap(&lines);
    let last_assistant = extract_last_assistant(&lines);
    let state = detect_state(&lines);
    let waiting_for_user = state == "idle" && (is_question(recap.as_deref()) || is_question(last_assistant.as_deref()));
    Ok(TermSummary { state, recap, last_assistant, error_count: count_errors(&lines), waiting_for_user, worked_sec: extract_worked_sec(&lines)? })
}

fn skip_spaces(s: &str) -> &str {
    s.trim_start_matches(js::is_space)
}

/// `/^\s{2,}\S/.test(line)`: two or more leading spaces, then anything.
fn indented_text(line: &str) -> bool {
    let spaces = line.chars().take_while(|c| js::is_space(*c)).count();
    spaces >= 2 && line.chars().count() > spaces
}

/// `/^\s{2,}/.test(line)`.
fn indented(line: &str) -> bool {
    line.chars().take_while(|c| js::is_space(*c)).count() >= 2
}

/// `line.match(/^※\s*recap:\s*(.*)$/)?.[1]`.
fn recap_match(line: &str) -> Option<&str> {
    let rest = skip_spaces(line.strip_prefix('※')?).strip_prefix("recap:")?;
    let group = skip_spaces(rest);
    (!group.chars().any(js::is_line_terminator)).then_some(group)
}

/// `s.replace(/\s*\(disable recaps? in \/config\)\s*$/i, "")`.
fn strip_recap_trailer(s: &str) -> &str {
    let body = s.trim_end_matches(js::is_space);
    for trailer in ["(disable recaps in /config)", "(disable recap in /config)"] {
        if body.len() >= trailer.len() && body.is_char_boundary(body.len() - trailer.len()) && body[body.len() - trailer.len()..].eq_ignore_ascii_case(trailer) {
            return s[..body.len() - trailer.len()].trim_end_matches(js::is_space);
        }
    }
    s
}

fn extract_recap(lines: &[&str]) -> Option<String> {
    for i in (0..lines.len()).rev() {
        let Some(group) = recap_match(lines[i]) else { continue };
        let mut buf = js::trim(group).to_string();
        for next in &lines[i + 1..] {
            if indented_text(next) && !js::trim(next).is_empty() {
                buf.push(' ');
                buf.push_str(js::trim(next));
            } else {
                break;
            }
        }
        return Some(js::trim(strip_recap_trailer(&buf)).to_string());
    }
    None
}

/// `/^⏺\s+/`: what follows the mark and its spaces, if the line has them.
fn assistant_line(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('⏺')?;
    rest.starts_with(js::is_space).then(|| skip_spaces(rest))
}

fn extract_last_assistant(lines: &[&str]) -> Option<String> {
    for i in (0..lines.len()).rev() {
        let Some(rest) = assistant_line(lines[i]) else { continue };
        let mut buf = js::trim(rest).to_string();
        for next in &lines[i + 1..] {
            if js::trim(next).is_empty() {
                break;
            }
            // /^⏺\s+|^\s*⎿|^❯/
            if assistant_line(next).is_some() || skip_spaces(next).starts_with('⎿') || next.starts_with('❯') {
                break;
            }
            if indented(next) {
                buf.push(' ');
                buf.push_str(js::trim(next));
            } else {
                break;
            }
        }
        return Some(js::trim(&buf).to_string());
    }
    None
}

fn last<'a, 'b>(lines: &'a [&'b str], n: usize) -> &'a [&'b str] {
    &lines[lines.len().saturating_sub(n)..]
}

fn detect_state(lines: &[&str]) -> &'static str {
    let tail = last(lines, 15).join("\n");
    if ["esc to interrupt", "Actioning…", "Running…", "(ctrl+b to run in background)"].iter().any(|needle| tail.contains(needle)) {
        return "running";
    }
    if tail.contains("Command running in background") {
        return "bg";
    }
    "idle"
}

/// ASCII letters compared without case, everything else as it is.
fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.is_char_boundary(prefix.len()) && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `/\b(error|failed|NOT_FOUND|exit code [1-9])\b/i.test(line)`.
fn has_error(line: &str) -> bool {
    let mut previous: Option<char> = None;
    for (at, c) in line.char_indices() {
        let boundary_before = !previous.is_some_and(js::is_word);
        previous = Some(c);
        if !boundary_before || !js::is_word(c) {
            continue;
        }
        let rest = &line[at..];
        let mut ends = Vec::new();
        for word in ["error", "failed", "NOT_FOUND"] {
            if starts_with_ignore_case(rest, word) {
                ends.push(word.len());
            }
        }
        if starts_with_ignore_case(rest, "exit code ") && rest.as_bytes().get(10).is_some_and(|b| (b'1'..=b'9').contains(b)) {
            ends.push(11);
        }
        if ends.iter().any(|end| !rest[*end..].chars().next().is_some_and(js::is_word)) {
            return true;
        }
    }
    false
}

fn count_errors(lines: &[&str]) -> usize {
    last(lines, 80).iter().filter(|line| has_error(line)).count()
}

/// `isQuestion(s)`: after trim, it ends with ? or ？, or with ください (。).
fn is_question(s: Option<&str>) -> bool {
    let Some(s) = s.filter(|s| !s.is_empty()) else { return false };
    let s = js::trim(s);
    s.ends_with('?') || s.ends_with('？') || s.ends_with("ください") || s.ends_with("ください。")
}

fn digits(s: &str) -> &str {
    &s[..s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len())]
}

/// `(\d+)s`: the digits, if `s` starts with them and an s follows.
fn seconds(s: &str) -> Option<&str> {
    let d = digits(s);
    (!d.is_empty() && matches!(s.as_bytes().get(d.len()), Some(b's' | b'S'))).then_some(d)
}

/// At least one space, then what follows them.
fn spaces1(s: &str) -> Option<&str> {
    s.starts_with(js::is_space).then(|| skip_spaces(s))
}

/// `line.match(/✻\s+(?:Worked|Cogitated)\s+for\s+(?:(\d+)m\s+)?(\d+)s/i)`:
/// the minutes (if any) and the seconds of the first match.
fn worked_match(line: &str) -> Option<(Option<&str>, &str)> {
    for (at, _) in line.match_indices('✻') {
        let attempt = || -> Option<(Option<&str>, &str)> {
            let rest = spaces1(&line[at + '✻'.len_utf8()..])?;
            let rest = ["Worked", "Cogitated"].iter().find_map(|word| starts_with_ignore_case(rest, word).then(|| &rest[word.len()..]))?;
            let rest = spaces1(rest)?;
            let rest = starts_with_ignore_case(rest, "for").then(|| &rest[3..])?;
            let rest = spaces1(rest)?;
            // The optional (\d+)m\s+ first, as the expression tries it first.
            let minutes = digits(rest);
            if !minutes.is_empty() && matches!(rest.as_bytes().get(minutes.len()), Some(b'm' | b'M')) {
                if let Some(after) = spaces1(&rest[minutes.len() + 1..]) {
                    if let Some(s) = seconds(after) {
                        return Some((Some(minutes), s));
                    }
                }
            }
            seconds(rest).map(|s| (None, s))
        };
        if let Some(found) = attempt() {
            return Some(found);
        }
    }
    None
}

fn extract_worked_sec(lines: &[&str]) -> Result<Option<f64>, Declined> {
    let low = lines.len().saturating_sub(20);
    for i in (low..lines.len()).rev() {
        if let Some((minutes, seconds)) = worked_match(lines[i]) {
            // (parseInt(m[1] ?? "0", 10) || 0) * 60 + (parseInt(m[2], 10) || 0)
            let number = |d: &str| js::parse_int(d).ok_or(Declined).map(|x| if x.is_nan() || x == 0.0 { 0.0 } else { x });
            let minutes = number(minutes.unwrap_or("0"))?;
            let seconds = number(seconds)?;
            return Ok(Some(minutes * 60.0 + seconds));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdata::{self, list, text};

    #[test]
    fn summaries_are_the_typescripts() {
        let data = testdata::summary();
        let mut declined = 0;
        let screens = list(&data, "screens");
        for case in screens {
            let screen = text(&case[0]);
            match summarize(screen) {
                Ok(summary) => assert_eq!(summary.to_json().as_deref(), Some(text(&case[1])), "summarizeTerminal({screen:?})"),
                Err(Declined) => declined += 1,
            }
        }
        assert!(declined * 20 < screens.len(), "{declined} of {} declined", screens.len());
    }
}
