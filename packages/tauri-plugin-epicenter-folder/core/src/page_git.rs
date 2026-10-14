//! `git`, run for a page that opens a folder with its own engine.
//!
//! A page-engine folder (`FolderConfig::page_engine`) keeps its history with
//! the system `git`, so it shares Git's lock files, packed refs, and
//! configuration with every other Git program in the repository. The page
//! decides which Git operation to run; this module decides how it runs:
//!
//! - only in the folder's granted root, with discovery stopped there;
//! - only as one of the exact operations the folder engine runs
//!   (`validate`): every option spelled as the engine spells it, and every
//!   value checked for its kind (an object ID, a branch, a ref, an
//!   attribute name, paths after `--`), so no argument names another
//!   directory, another program, or another repository;
//! - pushing and fetching only `origin`, the remote Git's own configuration
//!   names, which a page may set only to a network URL (`is_network_url`):
//!   never a local path, so a push cannot write another repository on disk;
//! - only while the root's `.git` is its own directory, not a link or a
//!   `gitdir:` file;
//! - with no hook and no fsmonitor, whatever the repository configures:
//!   `core.hooksPath` names an empty directory under `.git/epicenter` that
//!   only this crate writes;
//! - with the inherited variables that would point Git at another
//!   repository, index, or object store removed, no terminal prompt, and no
//!   trace output. `GIT_INDEX_FILE` may name only a private index copy
//!   inside the folder's `.git`.
//!
//! Credentials come from the person's own Git configuration (a credential
//! helper or SSH), as for any `git` they run, unless the page passes an
//! `Authorization` value for a push or fetch to the folder's own `https` origin:
//! then Git sends that one header to that one URL, follows no redirect, and
//! asks no credential helper (`credential_config`). The credential reaches Git
//! through its environment, never its arguments, so a process list shows no
//! token. It goes to `origin`, which the push or fetch must name.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

/// The only configuration a page may read, with `config --get`.
const READABLE_CONFIG: &[&str] = &[
    "core.autocrlf",
    "remote.origin.url",
    "user.email",
    "user.name",
];

/// The one `log` format the folder engine reads.
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e";

/// What one `git` process ended with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct GitOutput {
    /// The exit code, or `None` when it was killed.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

fn refused(args: &[String]) -> String {
    format!(
        "this Git command is not one the folder engine runs, so it is not run for a page: git {}",
        args.join(" ")
    )
}

fn is_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A remote a page may name: `https://` or `ssh://` with a host, or SSH's
/// `user@host:path`. Never a local path, `file://`, or a `transport::address`
/// helper such as `ext::`, which would run a program or write another
/// repository on this computer; and never a URL that carries a password,
/// which Git would keep in the folder's configuration and put in its
/// arguments.
fn is_network_url(url: &str) -> bool {
    if url.is_empty()
        || url.starts_with('-')
        || url.contains("::")
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return false;
    }
    for scheme in ["https://", "ssh://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
            let (user, host) = authority.rsplit_once('@').unwrap_or(("", authority));
            return !host.is_empty() && !host.starts_with('-') && !user.contains(':');
        }
    }
    // `user@host:path`: Git reads it as SSH only with no slash before the colon.
    let Some((user, rest)) = url.split_once('@') else {
        return false;
    };
    let Some((host, path)) = rest.split_once(':') else {
        return false;
    };
    let name = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    name(user) && name(host) && !path.is_empty() && !path.starts_with('-')
}

/// A branch name as the folder records it: no option, no `..`, no glob or
/// revision syntax.
fn is_branch(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.starts_with('/')
        && !value.contains("..")
        && !value.contains("//")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
}

fn is_ref(value: &str) -> bool {
    value
        .strip_prefix("refs/")
        .is_some_and(|rest| is_branch(rest))
}

fn is_attribute(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Paths after `--`: literal pathspecs, which Git refuses outside the
/// repository. A path cannot carry a NUL.
fn are_paths(values: &[String]) -> bool {
    values.iter().all(|value| !value.is_empty() && !value.contains('\0'))
}

/// Refuse `args` unless they are, exactly, one of the operations the folder
/// engine runs (`git/native-backend.ts` and `git/native-checkpoint.ts`).
/// Every option is spelled as the engine spells it and every value is
/// checked for its kind, so no argument can name another directory, another
/// program, or another repository. Push and fetch reach only `origin`, the
/// remote Git's own configuration names; a page may set it only to a
/// network URL.
pub fn validate(
    root: &Path,
    args: &[String],
    index_file: Option<&str>,
    origin: Option<&str>,
) -> Result<(), String> {
    let deny = || Err(refused(args));
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let (literal, words) = match words.as_slice() {
        ["--literal-pathspecs", rest @ ..] => (true, rest),
        rest => (false, rest),
    };
    let (split_index, words) = match words {
        ["-c", "core.splitIndex=false", rest @ ..] => (true, rest),
        rest => (false, rest),
    };
    let tail = |from: usize| -> &[String] {
        let skip = args.len() - words.len() + from;
        &args[skip..]
    };
    let remote = |url: &str| origin.is_some_and(|origin| origin == url);
    let allowed = match words {
        ["init", "--quiet", initial] => initial
            .strip_prefix("--initial-branch=")
            .is_some_and(is_branch),
        ["rev-parse", "--verify", "--quiet", revision] => revision
            .strip_suffix("^{commit}")
            .is_some_and(|base| is_oid(base) || is_ref(base) || base == "HEAD"),
        ["reset", "--quiet", commit, "--pathspec-from-file=-", "--pathspec-file-nul"] => {
            literal && is_oid(commit)
        }
        ["write-tree"] => split_index && index_file.is_some(),
        ["update-ref", "-m", "epicenter: commit", name, next, expected] => {
            is_ref(name) && is_oid(next) && is_oid(expected)
        }
        ["update-ref", name, oid] => is_ref(name) && is_oid(oid),
        ["symbolic-ref", "--quiet", "HEAD"] => true,
        ["check-attr", source, "--stdin", "-z", attributes @ ..] => {
            source
                .strip_prefix("--source=")
                .is_some_and(is_oid)
                && attributes.iter().all(|value| is_attribute(value))
        }
        ["check-attr", "--stdin", "-z", attributes @ ..] => {
            attributes.iter().all(|value| is_attribute(value))
        }
        ["diff-index", "--cached", "--name-only", "--no-renames", "-z", commit] => {
            is_oid(commit)
        }
        ["check-ignore", "--no-index", "--stdin", "-z"] => true,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"] => true,
        ["add", "--all"] => true,
        ["add", "--all", "--", ..] => literal && are_paths(tail(3)),
        ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--", ..] => {
            literal && are_paths(tail(5))
        }
        ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--cached", "--", ..] => {
            literal && are_paths(tail(6))
        }
        ["log", depth, format, name] => {
            depth
                .strip_prefix("-n")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                && *format == LOG_FORMAT
                && is_ref(name)
        }
        ["push", "--porcelain", url, refspec] => {
            remote(url)
                && refspec.split_once(':').is_some_and(|(oid, target)| {
                    is_oid(oid) && target.strip_prefix("refs/heads/").is_some_and(is_branch)
                })
        }
        ["fetch", "--no-tags", "--quiet", url, refspec] => {
            remote(url)
                && refspec
                    .strip_prefix("+refs/heads/")
                    .and_then(|rest| rest.split_once(":refs/remotes/origin/"))
                    .is_some_and(|(from, to)| is_branch(from) && is_branch(to))
        }
        ["ls-files", "--stage", "-z"] => true,
        // Git names, checks, and stores each object itself; a page writes
        // none of `.git/objects`.
        ["hash-object", "-w", "-t", kind, "--stdin"] => {
            matches!(*kind, "blob" | "tree" | "commit" | "tag")
        }
        ["ls-tree", "-r", "-z", "--full-tree", commit] => is_oid(commit),
        ["config", "--get", key] => READABLE_CONFIG.contains(key),
        ["config", "remote.origin.url", url] => is_network_url(url),
        _ => false,
    };
    // The global options belong only to the operations that use them.
    let uses_literal = matches!(words.first(), Some(&"reset" | &"add" | &"diff"));
    let uses_split = matches!(words.first(), Some(&"write-tree"));
    if !allowed || (literal && !uses_literal) || (split_index && !uses_split) {
        return deny();
    }
    if let Some(index_file) = index_file {
        let private = root.join(".git");
        let path = Path::new(index_file);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if !uses_split
            || path.parent() != Some(private.as_path())
            || !name.starts_with("index.tmp-")
            || name.contains("..")
        {
            return Err(refused(args));
        }
    }
    Ok(())
}

/// Inherited variables that would point Git at another repository, index,
/// or object store, or record its arguments: removed from every page command.
fn is_removed_env(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("GIT_") else {
        return false;
    };
    const EXACT: [&str; 18] = [
        "DIR",
        "WORK_TREE",
        "IMPLICIT_WORK_TREE",
        "INDEX_FILE",
        "OBJECT_DIRECTORY",
        "ALTERNATE_OBJECT_DIRECTORIES",
        "COMMON_DIR",
        "NAMESPACE",
        "PREFIX",
        "GRAFT_FILE",
        "SHALLOW_FILE",
        "NO_REPLACE_OBJECTS",
        "REPLACE_REF_BASE",
        "CONFIG",
        "CONFIG_PARAMETERS",
        "CONFIG_COUNT",
        "CURL_VERBOSE",
        "SSH_COMMAND",
    ];
    EXACT.contains(&rest)
        || rest.starts_with("TRACE")
        || ["CONFIG_KEY_", "CONFIG_VALUE_"]
            .iter()
            .any(|prefix| rest.starts_with(prefix))
}

/// Refuse an `Authorization` value unless it goes with a push or fetch to the
/// folder's own `https` origin and is one `Basic` or `Bearer` header value.
/// The value is never repeated in the refusal.
pub fn validate_authorization(
    args: &[String],
    origin: Option<&str>,
    authorization: &str,
) -> Result<(), String> {
    let transfers = matches!(args.first().map(String::as_str), Some("push" | "fetch"));
    if !transfers {
        return Err(format!(
            "a credential goes only with a push or fetch: git {}",
            args.join(" ")
        ));
    }
    if !origin.is_some_and(|origin| origin.starts_with("https://")) {
        return Err(
            "a token is sent only to an https remote, and this folder's remote is not one; connect it with its https URL, or leave the token out so Git uses your own sign-in"
                .to_string(),
        );
    }
    let value = authorization
        .strip_prefix("Basic ")
        .or_else(|| authorization.strip_prefix("Bearer "));
    if !value.is_some_and(|value| {
        !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| b.is_ascii_graphic())
    }) {
        return Err("a credential must be one Basic or Bearer header value".to_string());
    }
    Ok(())
}

/// The Git configuration a credential adds to one run, as environment
/// variables: the header for exactly `origin`, no redirect to anywhere else,
/// and an empty credential helper list, so the person's helper is neither
/// asked for this server nor told its token.
fn credential_config(origin: &str, authorization: &str) -> [(String, String); 7] {
    [
        ("GIT_CONFIG_COUNT".into(), "3".into()),
        ("GIT_CONFIG_KEY_0".into(), format!("http.{origin}.extraHeader")),
        ("GIT_CONFIG_VALUE_0".into(), format!("Authorization: {authorization}")),
        ("GIT_CONFIG_KEY_1".into(), "http.followRedirects".into()),
        ("GIT_CONFIG_VALUE_1".into(), "false".into()),
        ("GIT_CONFIG_KEY_2".into(), "credential.helper".into()),
        ("GIT_CONFIG_VALUE_2".into(), String::new()),
    ]
}

/// Run `args` in `root` after `validate`, and `validate_authorization` when
/// an `Authorization` value is given. `cancel` kills the process when set.
pub fn run(
    root: &Path,
    args: &[String],
    input: Option<&[u8]>,
    index_file: Option<&str>,
    authorization: Option<&str>,
    cancel: &AtomicBool,
) -> Result<GitOutput, String> {
    // The repository is the root's own `.git` directory, as the grant found
    // it: never a link or a `gitdir:` file a page left in its place, which
    // would point every command at another repository.
    let initializing = args.first().map(String::as_str) == Some("init");
    match std::fs::symlink_metadata(root.join(".git")) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(missing) if missing.kind() == std::io::ErrorKind::NotFound && initializing => {}
        _ => {
            return Err(format!(
                "'{}' is not this folder's own Git directory, so no Git command runs there",
                root.join(".git").display()
            ))
        }
    }
    let transfers = matches!(args.first().map(String::as_str), Some("push" | "fetch"));
    let origin = if transfers {
        let read = execute(
            root,
            &["config".to_string(), "--get".to_string(), "remote.origin.url".to_string()],
            None,
            None,
            None,
            cancel,
        )?;
        (read.code == Some(0)).then(|| String::from_utf8_lossy(&read.stdout).trim().to_string())
    } else {
        None
    };
    validate(root, args, index_file, origin.as_deref())?;
    let credential = match (authorization, origin.as_deref()) {
        (Some(authorization), origin) => {
            validate_authorization(args, origin, authorization)?;
            // `validate` made the command name exactly this origin.
            origin.map(|origin| credential_config(origin, authorization))
        }
        (None, _) => None,
    };
    execute(root, args, input, index_file, credential, cancel)
}

/// Run one validated command with the fixed controls.
fn execute(
    root: &Path,
    args: &[String],
    input: Option<&[u8]>,
    index_file: Option<&str>,
    credential: Option<[(String, String); 7]>,
    cancel: &AtomicBool,
) -> Result<GitOutput, String> {
    // An empty directory only this crate writes: no hook is found there on
    // any platform, whatever the repository or the person configures.
    let no_hooks = root.join(".git/epicenter/no-hooks");
    if root.join(".git").is_dir() {
        std::fs::create_dir_all(&no_hooks)
            .map_err(|cause| format!("the folder's empty hooks directory could not be made: {cause}"))?;
    }
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(format!("core.hooksPath={}", no_hooks.display()))
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(args)
        .current_dir(root);
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(is_removed_env) {
            command.env_remove(&name);
        }
    }
    command
        .env(
            "GIT_CEILING_DIRECTORIES",
            root.parent().unwrap_or(Path::new("/")),
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_TRACE2", "0")
        .env("GIT_TRACE2_EVENT", "0")
        .env("GIT_TRACE2_PERF", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    // After the inherited `GIT_CONFIG_*` variables were removed above.
    if let Some(credential) = credential {
        command.envs(credential);
    }
    let mut child = command
        .spawn()
        .map_err(|cause| format!("git could not be started: {cause}"))?;
    let mut stdin = child.stdin.take();
    let input = input.map(<[u8]>::to_vec);
    let writer = std::thread::spawn(move || {
        if let (Some(stdin), Some(input)) = (stdin.as_mut(), input) {
            let _ = stdin.write_all(&input);
        }
        drop(stdin);
    });
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(cause) => return Err(format!("git could not be awaited: {cause}")),
        }
    };
    let _ = writer.join();
    let stdout = out.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    Ok(GitOutput {
        code: status.code(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";
    const ORIGIN: &str = "https://github.com/o/r.git";

    #[test]
    fn the_engine_operations_are_allowed() {
        let root = Path::new("/folders/todos");
        let push = format!("{OID}:refs/heads/main");
        let source = format!("--source={OID}");
        let verify = format!("{OID}^{{commit}}");
        for allowed in [
            vec!["init", "--quiet", "--initial-branch=main"],
            vec!["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"],
            vec!["rev-parse", "--verify", "--quiet", &verify],
            vec!["--literal-pathspecs", "reset", "--quiet", OID, "--pathspec-from-file=-", "--pathspec-file-nul"],
            vec!["update-ref", "-m", "epicenter: commit", "refs/heads/main", OID, OID],
            vec!["update-ref", "refs/remotes/origin/main", OID],
            vec!["symbolic-ref", "--quiet", "HEAD"],
            vec!["check-attr", &source, "--stdin", "-z", "text", "eol", "filter"],
            vec!["check-attr", "--stdin", "-z", "text"],
            vec!["diff-index", "--cached", "--name-only", "--no-renames", "-z", OID],
            vec!["check-ignore", "--no-index", "--stdin", "-z"],
            vec!["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            vec!["add", "--all"],
            vec!["--literal-pathspecs", "add", "--all", "--", "todos/a.md"],
            vec!["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--cached", "--", "todos/a.md"],
            vec!["log", "-n20", LOG_FORMAT, "refs/heads/main"],
            vec!["push", "--porcelain", ORIGIN, &push],
            vec!["fetch", "--no-tags", "--quiet", ORIGIN, "+refs/heads/main:refs/remotes/origin/main"],
            vec!["ls-files", "--stage", "-z"],
            vec!["hash-object", "-w", "-t", "blob", "--stdin"],
            vec!["ls-tree", "-r", "-z", "--full-tree", OID],
            vec!["config", "--get", "remote.origin.url"],
            vec!["config", "remote.origin.url", ORIGIN],
            vec!["config", "remote.origin.url", "ssh://git@github.com/o/r.git"],
            vec!["config", "remote.origin.url", "git@github.com:o/r.git"],
        ] {
            assert_eq!(validate(root, &args(&allowed), None, Some(ORIGIN)), Ok(()), "{allowed:?}");
        }
        assert_eq!(
            validate(
                root,
                &args(&["-c", "core.splitIndex=false", "write-tree"]),
                Some("/folders/todos/.git/index.tmp-1234"),
                None,
            ),
            Ok(())
        );
    }

    #[test]
    fn anything_else_is_refused() {
        let root = Path::new("/folders/todos");
        let elsewhere = format!("{OID}:refs/heads/main");
        for refused in [
            // Reading or writing outside the folder.
            vec!["diff", "--no-index", "/etc/passwd", "/dev/null"],
            vec!["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/etc/passwd"],
            vec!["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--cached", "--", "todos/a.md"],
            vec!["init", "--quiet", "--separate-git-dir=/tmp/x"],
            vec!["init", "--quiet", "--template=/folders/todos/tpl", "--initial-branch=main"],
            vec!["fetch", "--no-tags", "--quiet", "--upload-pac=touch X; git-upload-pack", ORIGIN, "+refs/heads/main:refs/remotes/origin/main"],
            vec!["push", "--porcelain", "--receive-pac=sh", ORIGIN],
            vec!["push", "--porcelain", "--exe=sh", ORIGIN],
            vec!["fetch", "--no-tags", "--quiet", "/any/local/repo", "+refs/heads/main:refs/remotes/origin/main"],
            vec!["init", "--quiet", "--initial-branch=main", "/tmp/elsewhere"],
            vec!["init", "--quiet", "--initial-branch=../x"],
            vec!["log", "-n1", "--output=/tmp/x", "refs/heads/main"],
            vec!["status", "-C", "/"],
            vec!["--git-dir=/other", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            // Running another program.
            vec!["-c", "core.sshCommand=touch /tmp/x", "fetch", "--no-tags", "--quiet", ORIGIN, "+refs/heads/main:refs/remotes/origin/main"],
            vec!["fetch", "--no-tags", "--quiet", "--upload-pack=touch /tmp/x", ORIGIN],
            vec!["fetch", "--no-tags", "--quiet", "ext::sh -c touch% /tmp/x", "+refs/heads/main:refs/remotes/origin/main"],
            vec!["log", "-n1", LOG_FORMAT, "--ext-diff"],
            vec!["check-attr", "--stdin", "-z", "--all"],
            // Sending the repository anywhere but origin.
            vec!["push", "--porcelain", "https://attacker.test/r.git", &elsewhere],
            vec!["push", "--porcelain", ORIGIN, "refs/heads/main:refs/heads/main"],
            // Options in the wrong place, or options the engine never uses.
            vec!["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            vec!["-c", "core.splitIndex=false", "add", "--all"],
            vec!["add", "--all", "--", "todos/a.md"],
            vec!["config", "--get", "credential.helper"],
            vec!["config", "core.sshCommand", "sh"],
            // A remote that is a local path, a local file URL, or a program.
            vec!["config", "remote.origin.url", "/Users/someone/other-repo"],
            vec!["config", "remote.origin.url", "../other-repo"],
            vec!["config", "remote.origin.url", "file:///Users/someone/other-repo"],
            vec!["config", "remote.origin.url", "ext::sh -c touch% /tmp/x"],
            vec!["config", "remote.origin.url", "https::/x"],
            vec!["config", "remote.origin.url", "--upload-pack=sh"],
            vec!["config", "remote.origin.url", "https://"],
            vec!["config", "remote.origin.url", "https://-oProxyCommand=sh/x"],
            vec!["config", "remote.origin.url", "ssh://-oProxyCommand=sh/x"],
            vec!["config", "remote.origin.url", "git@-oProxyCommand=sh:x"],
            vec!["config", "remote.origin.url", "https://github.com/o/r.git x"],
            vec!["config", "remote.origin.url", "c:/repo"],
            vec!["config", "remote.origin.fetch", "+refs/*:refs/*"],
            vec!["config", "remote.origin.url"],
            vec!["clone", "https://example.test/r.git"],
            vec!["gc"],
            vec!["hash-object", "-w", "-t", "blob", "--literally", "--stdin"],
            vec!["hash-object", "-w", "-t", "blob", "/etc/passwd"],
            vec![],
        ] {
            assert!(validate(root, &args(&refused), None, Some(ORIGIN)).is_err(), "{refused:?}");
        }
        for index in [
            "/elsewhere/index",
            "/folders/todos/.git/index",
            "/folders/todos/.git/sub/index.tmp-1",
        ] {
            assert!(
                validate(root, &args(&["-c", "core.splitIndex=false", "write-tree"]), Some(index), None).is_err(),
                "{index}"
            );
        }
        // Without an index copy, write-tree would write the live index's tree.
        assert!(validate(root, &args(&["-c", "core.splitIndex=false", "write-tree"]), None, None).is_err());
        // With no origin configured, nothing is pushed.
        let push = format!("{OID}:refs/heads/main");
        assert!(validate(root, &args(&["push", "--porcelain", ORIGIN, &push]), None, None).is_err());
    }

    /// Every call the folder engine made in its real-Git tests
    /// (`packages/folder/src/directory-folder.test.ts`, which keeps the
    /// fixture current) is one this crate runs for a page.
    #[test]
    fn every_call_the_folder_engine_makes_is_allowed() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Call {
            root: String,
            args: Vec<String>,
            index_file: Option<String>,
            origin: Option<String>,
        }
        let calls: Vec<Call> = serde_json::from_str(include_str!(
            "../../fixtures/page-git-calls.json"
        ))
        .expect("the recorded calls");
        assert!(calls.len() >= 20, "the fixture records the engine's calls");
        for call in calls {
            // The tests' remote is a local repository; it stands for the
            // network remote a person connects to.
            let args: Vec<String> = match &call.origin {
                Some(origin) => call.args.iter().map(|arg| arg.replace(origin, ORIGIN)).collect(),
                None => call.args.clone(),
            };
            assert_eq!(
                validate(
                    Path::new(&call.root),
                    &args,
                    call.index_file.as_deref(),
                    call.origin.as_ref().map(|_| ORIGIN),
                ),
                Ok(()),
                "{:?}",
                call.args
            );
        }
    }

    #[test]
    fn a_git_directory_a_page_replaced_refuses_every_command() {
        let temp = crate::testing::TempDir::new("page-git-gitdir");
        let elsewhere = temp.folder("elsewhere");
        let cancel = AtomicBool::new(false);
        let status = args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        // A `gitdir:` file pointing at another repository.
        let file = temp.folder("file");
        std::fs::write(file.join(".git"), format!("gitdir: {}\n", elsewhere.display())).unwrap();
        assert!(run(&file, &status, None, None, None, &cancel).is_err());
        // A link to another directory.
        #[cfg(unix)]
        {
            let linked = temp.folder("linked");
            std::os::unix::fs::symlink(&elsewhere, linked.join(".git")).unwrap();
            assert!(run(&linked, &status, None, None, None, &cancel).is_err());
        }
        // No repository yet: only `init` runs.
        let fresh = temp.folder("fresh");
        assert!(run(&fresh, &status, None, None, None, &cancel).is_err());
        let init = run(&fresh, &args(&["init", "--quiet", "--initial-branch=main"]), None, None, None, &cancel)
            .unwrap();
        assert_eq!(init.code, Some(0), "{}", init.stderr);
    }

    #[test]
    fn a_command_runs_in_the_root_with_no_hooks() {
        let temp = crate::testing::TempDir::new("page-git");
        let root = temp.folder("notes");
        let cancel = AtomicBool::new(false);
        let init = run(&root, &args(&["init", "--quiet", "--initial-branch=main"]), None, None, None, &cancel)
            .unwrap();
        assert_eq!(init.code, Some(0), "{}", init.stderr);
        // A hook the repository installs never runs.
        let hooks = root.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let marker = root.join("hook-ran");
        let hook = hooks.join("post-index-change");
        std::fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(root.join("a.md"), "a\n").unwrap();
        let added = run(&root, &args(&["add", "--all"]), None, None, None, &cancel).unwrap();
        assert_eq!(added.code, Some(0), "{}", added.stderr);
        assert!(!marker.exists(), "no hook runs for a page command");
        let status = run(
            &root,
            &args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
            None,
            None, None,
            &cancel,
        )
        .unwrap();
        assert_eq!(String::from_utf8(status.stdout).unwrap(), "A  a.md\0");
        // A push names only origin; with none configured it is refused.
        let push = run(
            &root,
            &args(&["push", "--porcelain", "/tmp/elsewhere.git", &format!("{OID}:refs/heads/main")]),
            None,
            None, None,
            &cancel,
        );
        assert!(push.is_err());
    }

    #[test]
    fn a_credential_goes_only_with_a_transfer_to_the_https_origin() {
        let push = args(&["push", "--porcelain", ORIGIN, &format!("{OID}:refs/heads/main")]);
        let fetch = args(&[
            "fetch",
            "--no-tags",
            "--quiet",
            ORIGIN,
            "+refs/heads/main:refs/remotes/origin/main",
        ]);
        for allowed in ["Basic eDpzZWNyZXQ=", "Bearer art_v2_abc?expires=1"] {
            assert_eq!(validate_authorization(&push, Some(ORIGIN), allowed), Ok(()));
            assert_eq!(validate_authorization(&fetch, Some(ORIGIN), allowed), Ok(()));
        }
        let good = "Basic eDpzZWNyZXQ=";
        // No origin, or not a transfer.
        assert!(validate_authorization(&push, None, good).is_err());
        let status = args(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        assert!(validate_authorization(&status, Some(ORIGIN), good).is_err());
        // Not https: refused with what to do instead.
        for url in ["ssh://git@github.com/o/r.git", "git@github.com:o/r.git", "http://192.168.1.2/r.git"] {
            let refused = validate_authorization(&push, Some(url), good).unwrap_err();
            assert!(refused.contains("only to an https remote"), "{url}: {refused}");
        }
        // One header value, nothing smuggled after it.
        for value in [
            "",
            "Basic ",
            "Token zzsecret",
            "basic zzsecret",
            "Basic zzsecret def",
            "Basic zzsecret\r\nX-Other: 1",
            "Basic zzsecret\nX-Other: 1",
            "Bearer zzsecreté",
        ] {
            let refused = validate_authorization(&push, Some(ORIGIN), value).unwrap_err();
            assert!(refused.contains("one Basic or Bearer header"), "{value:?}");
            assert!(!refused.contains("zzsecret"), "the value is never repeated");
        }
        // The configuration names exactly the origin.
        let config = credential_config(ORIGIN, good);
        assert!(config.contains(&("GIT_CONFIG_KEY_0".into(), format!("http.{ORIGIN}.extraHeader"))));
    }

    #[test]
    fn a_remote_that_carries_a_password_is_refused() {
        for url in [
            "https://me:pat@github.com/o/r.git",
            "ssh://me:pat@github.com/o/r.git",
        ] {
            assert!(!is_network_url(url), "{url}");
        }
        assert!(is_network_url("https://me@github.com/o/r.git"));
        assert!(is_network_url("ssh://git@github.com/o/r.git"));
    }

    /// Real `git` against two loopback listeners: the header reaches only the
    /// URL the credential names, and is not offered to another host.
    #[test]
    fn git_sends_the_header_only_to_the_credential_url() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        use std::sync::mpsc;

        fn listen() -> Option<(TcpListener, u16)> {
            let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
            let port = listener.local_addr().ok()?.port();
            Some((listener, port))
        }
        // Read one request's headers and answer 404, so Git stops there.
        fn serve(listener: TcpListener, seen: mpsc::Sender<Vec<String>>) {
            std::thread::spawn(move || {
                for stream in listener.incoming().take(1) {
                    let Ok(mut stream) = stream else { return };
                    let mut lines = Vec::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        lines.push(line.trim_end().to_string());
                    }
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    let _ = seen.send(lines);
                }
            });
        }
        let (Some((scoped, scoped_port)), Some((other, other_port))) = (listen(), listen()) else {
            eprintln!("SKIPPED git_sends_the_header_only_to_the_credential_url: no loopback listener");
            return;
        };
        let (scoped_seen, scoped_lines) = mpsc::channel();
        let (other_seen, other_lines) = mpsc::channel();
        serve(scoped, scoped_seen);
        serve(other, other_seen);
        let url = format!("http://127.0.0.1:{scoped_port}/git/r.git");
        let run = |target: &str| {
            std::process::Command::new("git")
                .args(["ls-remote", target])
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .envs(credential_config(&url, "Basic eDpzZWNyZXQ="))
                .output()
                .unwrap()
        };
        run(&url);
        run(&format!("http://127.0.0.1:{other_port}/git/r.git"));
        let timeout = Duration::from_secs(10);
        let scoped_request = scoped_lines.recv_timeout(timeout).unwrap();
        let other_request = other_lines.recv_timeout(timeout).unwrap();
        assert!(
            scoped_request.iter().any(|line| line == "Authorization: Basic eDpzZWNyZXQ="),
            "{scoped_request:?}"
        );
        assert!(
            !other_request.iter().any(|line| line.to_ascii_lowercase().starts_with("authorization")),
            "{other_request:?}"
        );
    }
}
