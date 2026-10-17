//! Literal folder-relative paths.
//!
//! The same rules as `pathProblem` in `packages/folder/src/paths.ts`; both are
//! held to `fixtures/path-rules.json`. Paths are never normalized, case folded,
//! or aliased: a path that would need rewriting to be usable is refused.

/// A Windows 8.3 short name such as `GIT~1` or `NOTES~12.MD`, which can name
/// another entry, `.git` itself among them: a stem of one to six characters
/// without a space or dot, `~` and digits, then optionally a dot and an
/// extension of one to three characters without a space or dot. `Notes ~2.md`
/// and `version~2-final.md` are not this shape. The same shape as
/// `SHORT_NAME` in `paths.ts`.
pub(crate) fn is_short_name(name: &str) -> bool {
    let plain = |part: &str, most: usize| {
        let count = part.chars().count();
        (1..=most).contains(&count) && !part.contains([' ', '.'])
    };
    let (base, extension) = match name.split_once('.') {
        Some((base, extension)) => (base, Some(extension)),
        None => (name, None),
    };
    let Some((stem, digits)) = base.rsplit_once('~') else {
        return false;
    };
    plain(stem, 6)
        && !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && extension.is_none_or(|extension| plain(extension, 3))
}

/// C0 controls, DEL, and C1 controls (U+0080 to U+009F), the same set as
/// `CONTROL` in `paths.ts`.
fn is_control(c: char) -> bool {
    matches!(u32::from(c), 0x00..=0x1F | 0x7F..=0x9F)
}

/// A code point HFS+ ignores when it compares names, or that Unicode marks
/// default-ignorable: a name holding one can resolve to a name without it.
fn is_ignorable(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x034F | 0x061C | 0x115F..=0x1160 | 0x17B4..=0x17B5
        | 0x180B..=0x180F | 0x200B..=0x200F | 0x202A..=0x202E
        | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0
        | 0xFFF0..=0xFFF8 | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A
        | 0xE0000..=0xE0FFF)
}

/// A name Windows reserves for a device, with or without an extension: the
/// part before the first dot, without trailing spaces (` `, U+0020 only), is a
/// device name in any case. Windows drops trailing dots too, but the part
/// before the first dot holds none.
fn is_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|rest| {
                matches!(rest, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
            })
        })
}

/// Whether `name` means only itself on every disk a folder can live on. A
/// name Windows rewrites (a trailing dot or space, a reserved character, a
/// device name, a short name) or that HFS+ compares without an ignorable
/// character could resolve to another entry, `.git` among them.
pub(crate) fn names_only_itself(name: &str) -> bool {
    !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') || is_ignorable(c))
        && !is_device_name(name)
        && !is_short_name(name)
}

/// Why a literal path is unusable, or `None` when it is a valid
/// folder-relative path: nonempty `/`-separated segments, no `.` or `..`, no
/// leading slash, backslash, or control character; no segment that is `.git`
/// or `HEAD` in any case; and every segment a name that means only itself on
/// every disk. Leading dots are ordinary.
pub fn path_problem(path: &str) -> Option<&'static str> {
    if path.is_empty() {
        return Some("the path is empty");
    }
    if path.starts_with('/') {
        return Some("the path must be folder-relative");
    }
    if path.contains('\\') {
        return Some("the path contains a backslash");
    }
    if path.chars().any(is_control) {
        return Some("the path contains a control character");
    }
    for segment in path.split('/') {
        if segment.is_empty() {
            return Some("the path contains an empty segment");
        }
        if segment == "." || segment == ".." {
            return Some("the path contains a relative segment");
        }
        // Git refuses `.git` at any depth, in any case, as a tracked path.
        if segment.to_lowercase() == ".git" {
            return Some("the path is inside private Git state");
        }
        if segment.eq_ignore_ascii_case("head") {
            return Some("the path contains a segment named HEAD, which Git reads as a repository");
        }
        if !names_only_itself(segment) {
            return Some("the path contains a name that can name another file on some disks");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Rules {
        refused: Vec<String>,
        allowed: Vec<String>,
    }

    /// The vectors `paths.test.ts` reads too, so both languages agree.
    #[test]
    fn path_problem_follows_the_shared_vectors() {
        let rules: Rules =
            serde_json::from_str(include_str!("../../fixtures/path-rules.json")).unwrap();
        for path in &rules.refused {
            assert!(path_problem(path).is_some(), "{path:?} allowed");
        }
        for path in &rules.allowed {
            assert_eq!(path_problem(path), None, "{path:?}");
        }
    }

    #[test]
    fn path_problem_refuses_what_paths_ts_refuses() {
        for (path, problem) in [
            ("", "the path is empty"),
            ("/a", "the path must be folder-relative"),
            ("a\\b", "the path contains a backslash"),
            ("a\nb", "the path contains a control character"),
            ("a\u{7f}", "the path contains a control character"),
            ("a\u{85}.md", "the path contains a control character"),
            ("a//b", "the path contains an empty segment"),
            ("a/", "the path contains an empty segment"),
            ("a/../b", "the path contains a relative segment"),
            ("./a", "the path contains a relative segment"),
            (".git/config", "the path is inside private Git state"),
            ("sub/.GIT/x", "the path is inside private Git state"),
        ] {
            assert_eq!(path_problem(path), Some(problem), "{path:?}");
        }
        for path in [
            "a",
            "a/b.md",
            ".gitignore",
            "a/.gitkeep",
            "naïve/日本.md",
            "a b",
        ] {
            assert_eq!(path_problem(path), None, "{path:?}");
        }
    }
}
