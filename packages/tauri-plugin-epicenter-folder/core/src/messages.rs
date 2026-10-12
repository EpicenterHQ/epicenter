//! Subjects for commits of the whole folder.
//!
//! A port of `packages/app/src/files/git/messages.ts`, pinned to it by the
//! golden vectors in `fixtures/commit-subjects.txt`. The 72 limit counts
//! UTF-16 code units, as JavaScript's `String.length` does, so a browser
//! folder and a native folder write the same subject for the same change.

use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Add,
    Modify,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct PathChange {
    pub path: String,
    pub kind: ChangeKind,
}

const SUBJECT_LIMIT: usize = 72;

/// Escape control characters and backslashes so a path cannot forge message structure.
pub fn escape_path(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for character in path.chars() {
        let code = character as u32;
        if character == '\\' {
            escaped.push_str("\\\\");
        } else if code < 0x20 || code == 0x7f || (0x80..0xa0).contains(&code) {
            escaped.push_str(&format!("\\x{code:02x}"));
        } else if code == 0x2028 || code == 0x2029 {
            escaped.push_str(&format!("\\u{code:x}"));
        } else {
            escaped.push(character);
        }
    }
    escaped
}

/// The subject for a nonempty change set, or `None` when nothing changed.
pub fn commit_subject(changes: &[PathChange]) -> Option<String> {
    let [change] = changes else {
        return match changes.len() {
            0 => None,
            count => Some(format!("Update {count} files")),
        };
    };
    let verb = match change.kind {
        ChangeKind::Add => "Add",
        ChangeKind::Delete => "Delete",
        ChangeKind::Modify => "Update",
    };
    let subject = format!("{verb} {}", escape_path(&change.path));
    Some(if subject.encode_utf16().count() <= SUBJECT_LIMIT {
        subject
    } else {
        "Update 1 file".to_string()
    })
}

/// Why a user-authored commit message is refused, or `None` when it is usable.
pub fn message_problem(message: &str) -> Option<&'static str> {
    // What JavaScript's `trim` removes: Rust's `trim` differs on U+0085 and U+FEFF.
    let blank = |c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    };
    if message.chars().all(blank) {
        return Some("the commit message is empty");
    }
    let control = |c: char| {
        let code = c as u32;
        code <= 0x08 || (0x0b..=0x1f).contains(&code) || code == 0x7f
    };
    if message.chars().any(control) {
        return Some("the commit message contains a control character");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(hex: &str) -> String {
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex"))
            .collect();
        String::from_utf8(bytes).expect("fixture strings are UTF-8")
    }

    /// One case per line: the expected subject in hex (`-` for none), a tab,
    /// then `kind:hexpath` changes separated by commas.
    #[test]
    fn commit_subject_matches_the_shared_golden_vectors() {
        let fixture = include_str!("../../fixtures/commit-subjects.txt");
        let mut cases = 0;
        for line in fixture.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (expected, changes) = line.split_once('\t').expect("tab-separated case");
            let changes: Vec<PathChange> = changes
                .split(',')
                .filter(|change| !change.is_empty())
                .map(|change| {
                    let (kind, path) = change.split_once(':').expect("kind:hexpath");
                    PathChange {
                        path: unhex(path),
                        kind: match kind {
                            "add" => ChangeKind::Add,
                            "modify" => ChangeKind::Modify,
                            "delete" => ChangeKind::Delete,
                            other => panic!("unknown kind {other}"),
                        },
                    }
                })
                .collect();
            let expected = (expected != "-").then(|| unhex(expected));
            assert_eq!(commit_subject(&changes), expected, "{line}");
            cases += 1;
        }
        assert!(cases >= 20, "the fixture has {cases} cases");
    }

    #[test]
    fn message_problem_allows_tabs_and_newlines_only() {
        assert_eq!(message_problem("  \n"), Some("the commit message is empty"));
        assert_eq!(message_problem("Fix\n\n\tbody"), None);
        assert_eq!(
            message_problem("a\u{0}b"),
            Some("the commit message contains a control character")
        );
        assert_eq!(
            message_problem("a\rb"),
            Some("the commit message contains a control character")
        );
    }
}
