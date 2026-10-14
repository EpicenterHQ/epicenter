//! The desktop terminal: one command at a time in `/bin/sh`, starting in the
//! notes directory. It is the real directory and the real `git`, so anything a
//! command does is exactly what an outside program would do. No commit is
//! requested; the page reads the folder again after each command, as it does
//! after any outside write.
//!
//! It is a command runner, not a terminal emulator: a command gets no input
//! and no TTY, and its output arrives when it ends. The working directory
//! carries from one command to the next; environment changes do not.
//!
//! The shell holds the root and the working directory. The page supplies the
//! command and nothing else. The command reaches `sh` in an environment
//! variable and is never spliced into the script.

use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::process::capture;

const OUTPUT_LIMIT: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

/// `eval` keeps a `cd` in the command visible to the `pwd` that records it.
const SCRIPT: &str = concat!(
    "cd -- \"$HONEYCRISP_CWD\" 2>/dev/null || cd -- \"$HONEYCRISP_ROOT\" || exit 1\n",
    "eval \"$HONEYCRISP_COMMAND\"\n",
    "honeycrisp_status=$?\n",
    "pwd -P > \"$HONEYCRISP_CWD_FILE\" 2>/dev/null\n",
    "exit $honeycrisp_status\n",
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalReply {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// The working directory after the command, absolute.
    pub cwd: PathBuf,
}

/// A new empty file for the script to write its final directory into. Created
/// here, exclusively, so the script never follows a name someone else placed
/// in the temporary directory.
fn cwd_file() -> io::Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let mut last = None;
    for _ in 0..8 {
        let path = std::env::temp_dir().join(format!(
            "honeycrisp-cwd-{}-{}-{nanos:08x}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst),
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(cause) if cause.kind() == io::ErrorKind::AlreadyExists => last = Some(cause),
            Err(cause) => return Err(cause),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("no free name for the directory file")))
}

/// The directory `pwd -P` wrote, without the line ending. Empty when the
/// script never got that far.
fn recorded_directory(file: &Path) -> Option<PathBuf> {
    let mut bytes = std::fs::read(file).ok()?;
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    if bytes.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    #[cfg(not(unix))]
    {
        Some(PathBuf::from(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

/// Run one command. `cwd` is where it starts; a directory that no longer
/// exists falls back to `root`.
pub fn run_command(root: &Path, cwd: &Path, command: &str, timeout: Duration) -> TerminalReply {
    let recorded = cwd_file().ok();
    let shell = if cfg!(windows) { "sh" } else { "/bin/sh" };
    let captured = capture(
        Command::new(shell)
            .arg("-c")
            .arg(SCRIPT)
            .current_dir(root)
            .env("HONEYCRISP_ROOT", root)
            .env("HONEYCRISP_CWD", cwd)
            .env("HONEYCRISP_COMMAND", command)
            .env(
                "HONEYCRISP_CWD_FILE",
                recorded
                    .as_deref()
                    .map_or(OsStr::new("/dev/null"), Path::as_os_str),
            )
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat")
            .env("TERM", "dumb"),
        OUTPUT_LIMIT,
        timeout,
    );
    let next = recorded.as_deref().and_then(recorded_directory);
    if let Some(file) = &recorded {
        let _ = std::fs::remove_file(file);
    }
    let captured = match captured {
        Ok(captured) => captured,
        Err(cause) => {
            return TerminalReply {
                stdout: String::new(),
                stderr: format!("{cause}\n"),
                exit_code: 127,
                cwd: cwd.to_path_buf(),
            }
        }
    };
    let mut stderr = String::from_utf8_lossy(&captured.stderr).into_owned();
    if captured.truncated {
        stderr.push_str("Output was cut off after 1 MB.\n");
    }
    if captured.timed_out {
        stderr.push_str(&format!(
            "Stopped after {} seconds.\n",
            (timeout.as_millis() + 500) / 1000
        ));
    }
    TerminalReply {
        stdout: String::from_utf8_lossy(&captured.stdout).into_owned(),
        stderr,
        exit_code: captured.code.unwrap_or(1),
        cwd: next.unwrap_or_else(|| cwd.to_path_buf()),
    }
}

/// The window's terminal: the trusted root and the directory the next command
/// starts in.
pub struct Terminal {
    root: PathBuf,
    cwd: Mutex<PathBuf>,
    turn: Mutex<()>,
    timeout: Duration,
}

impl Terminal {
    /// `root` is the canonical notes directory the shell registered.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            cwd: Mutex::new(root.clone()),
            turn: Mutex::new(()),
            root,
            timeout: TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn held(&self) -> MutexGuard<'_, PathBuf> {
        self.cwd
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where the next command starts.
    pub fn cwd(&self) -> PathBuf {
        self.held().clone()
    }

    /// Run one command and remember where it ended. A second caller waits:
    /// commands run one at a time, each starting where the last one stopped.
    pub fn run(&self, command: &str) -> TerminalReply {
        let _turn = self
            .turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cwd = self.cwd();
        let reply = run_command(&self.root, &cwd, command, self.timeout);
        *self.held() = reply.cwd.clone();
        reply
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::testing::{git, repository, temp};
    use std::time::Instant;

    #[test]
    fn a_command_runs_in_the_root_and_reports_output_and_status() {
        let directory = temp("terminal-root");
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run("pwd -P; echo problem >&2; exit 3");
        assert_eq!(reply.stdout.trim(), directory.path().to_str().unwrap());
        assert_eq!(reply.stderr, "problem\n");
        assert_eq!(reply.exit_code, 3);
        assert_eq!(reply.cwd, directory.path());
    }

    #[test]
    fn cd_carries_to_the_next_command_and_environment_changes_do_not() {
        let directory = temp("terminal-cd");
        std::fs::create_dir(directory.path().join("notes")).unwrap();
        let terminal = Terminal::new(directory.path());
        let moved = terminal.run("cd notes && export HONEYCRISP_TEST_MARK=kept");
        assert_eq!(moved.exit_code, 0);
        assert_eq!(moved.cwd, directory.path().join("notes"));
        assert_eq!(terminal.cwd(), directory.path().join("notes"));
        let next = terminal.run("pwd -P; echo \"mark=${HONEYCRISP_TEST_MARK-unset}\"");
        assert_eq!(
            next.stdout,
            format!("{}/notes\nmark=unset\n", directory.path().display())
        );
        // A command may leave the notes directory, as any shell may.
        let left = terminal.run("cd ..; cd ..");
        assert_eq!(left.cwd, directory.path().parent().unwrap());
    }

    #[test]
    fn a_failed_command_still_records_where_it_ended() {
        let directory = temp("terminal-fail");
        std::fs::create_dir(directory.path().join("notes")).unwrap();
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run("cd notes; false");
        assert_eq!(reply.exit_code, 1);
        assert_eq!(terminal.cwd(), directory.path().join("notes"));
    }

    #[test]
    fn a_working_directory_that_was_removed_falls_back_to_the_root() {
        let directory = temp("terminal-gone");
        std::fs::create_dir(directory.path().join("gone")).unwrap();
        let terminal = Terminal::new(directory.path());
        terminal.run("cd gone");
        std::fs::remove_dir(directory.path().join("gone")).unwrap();
        let reply = terminal.run("pwd -P");
        assert_eq!(reply.stdout.trim(), directory.path().to_str().unwrap());
        assert_eq!(terminal.cwd(), directory.path());
    }

    #[test]
    fn the_command_is_passed_whole_and_never_spliced_into_the_script() {
        let directory = temp("terminal-quoting");
        let terminal = Terminal::new(directory.path());
        let reply = terminal
            .run("printf '%s\\n' \"a \\\"b\\\" $((1 + 2))\" 'single $HOME'\necho second line");
        assert_eq!(reply.stdout, "a \"b\" 3\nsingle $HOME\nsecond line\n");
        assert_eq!(reply.exit_code, 0);
    }

    #[test]
    fn a_command_gets_no_input_and_no_pager() {
        let directory = temp("terminal-input");
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run("cat; echo \"$TERM $PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT\"");
        assert_eq!(reply.stdout, "dumb cat cat 0\n");
        assert_eq!(reply.exit_code, 0);
    }

    #[test]
    fn the_real_git_sees_the_same_repository_and_a_write_is_an_outside_write() {
        let directory = repository("terminal-git");
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run(
            "printf 'from the shell\\n' >> notes/a.md && git log --format=%s && git status --porcelain",
        );
        assert_eq!(
            reply.stdout,
            "Update notes/a.md\nAdd notes/a.md\n M notes/a.md\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("notes/a.md")).unwrap(),
            "second\nfrom the shell\n"
        );
        // Nothing was committed on the command's behalf.
        assert_eq!(git(directory.path(), &["rev-list", "--count", "HEAD"]), "2");
    }

    #[test]
    fn output_past_one_megabyte_is_cut_off_and_says_so() {
        let directory = temp("terminal-limit");
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run("head -c 3000000 /dev/zero | tr '\\0' 'a'; echo done >&2");
        assert_eq!(reply.exit_code, 0);
        assert!(reply.stdout.len() >= OUTPUT_LIMIT, "{}", reply.stdout.len());
        assert!(
            reply.stdout.len() < OUTPUT_LIMIT + 64 * 1024,
            "{}",
            reply.stdout.len()
        );
        assert!(
            reply.stderr.ends_with("Output was cut off after 1 MB.\n"),
            "{}",
            reply.stderr
        );
    }

    #[test]
    fn a_command_that_outlives_its_time_is_stopped_with_what_it_wrote() {
        let directory = temp("terminal-timeout");
        let terminal = Terminal::new(directory.path()).with_timeout(Duration::from_millis(400));
        let started = Instant::now();
        let reply = terminal.run("echo before; sleep 30; echo after");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(reply.stdout, "before\n");
        assert_eq!(reply.stderr, "Stopped after 0 seconds.\n");
        assert_eq!(reply.exit_code, 1);
        // The script never recorded a directory; the next command starts where this one did.
        assert_eq!(terminal.cwd(), directory.path());
    }

    #[test]
    fn a_background_job_holding_the_output_is_stopped_at_the_time_limit() {
        let directory = temp("terminal-background");
        let terminal = Terminal::new(directory.path()).with_timeout(Duration::from_millis(400));
        let started = Instant::now();
        let reply = terminal.run("sleep 30 & echo started");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(reply.stdout, "started\n");
        assert_eq!(reply.exit_code, 0);
        assert_eq!(reply.stderr, "Stopped after 0 seconds.\n");
    }

    #[test]
    fn a_command_that_cannot_be_passed_to_the_shell_is_reported_not_run() {
        let directory = temp("terminal-nul");
        let terminal = Terminal::new(directory.path());
        let reply = terminal.run("echo a\0b");
        assert_eq!(reply.exit_code, 127);
        assert_eq!(reply.stdout, "");
        assert!(!reply.stderr.is_empty());
        assert_eq!(terminal.cwd(), directory.path());
    }

    #[test]
    fn the_directory_file_is_removed_after_every_command() {
        let directory = temp("terminal-scratch");
        let terminal = Terminal::new(directory.path());
        // The script reads the name from its environment; a command can see it.
        let reply = terminal.run("echo \"$HONEYCRISP_CWD_FILE\"");
        let file = PathBuf::from(reply.stdout.trim());
        assert!(file.is_absolute(), "{}", reply.stdout);
        assert!(!file.exists());
    }
}
