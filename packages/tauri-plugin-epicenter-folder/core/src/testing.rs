//! Disposable folders and a plain `git` for tests.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::time::Duration;

use crate::files::FileChange;
use crate::git::Author;
use crate::owner::{FolderConfig, FolderOwner};

static NEXT: AtomicU64 = AtomicU64::new(0);
static ENVIRONMENT: Once = Once::new();

/// This machine's Git configuration must not change outcomes.
fn isolate_git() {
    ENVIRONMENT.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        isolate_git();
        let path = std::env::temp_dir().join(format!(
            "epicenter-folder-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create a temporary directory");
        Self(std::fs::canonicalize(&path).expect("canonical temporary directory"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// A new empty directory inside this one.
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(&path).expect("create a folder");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn author() -> Author {
    Author {
        name: "Test Author".to_string(),
        email: "test@example.com".to_string(),
    }
}

/// A configuration with event watching and the periodic comparison off, so
/// tests decide when the owner looks for outside changes.
pub fn config(root: &Path) -> FolderConfig {
    FolderConfig {
        watch_events: false,
        watch_interval: None,
        ..FolderConfig::new(root, author())
    }
}

pub fn open(root: &Path) -> FolderOwner {
    FolderOwner::open(config(root)).expect("open the folder")
}

/// Run plain `git` in `root`, as another program would.
pub fn git(root: &Path, args: &[&str]) -> String {
    isolate_git();
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_AUTHOR_NAME", "Outside")
        .env("GIT_AUTHOR_EMAIL", "outside@example.com")
        .env("GIT_COMMITTER_NAME", "Outside")
        .env("GIT_COMMITTER_EMAIL", "outside@example.com")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub fn create(path: &str, content: &str) -> FileChange {
    FileChange::Create {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
    }
}

pub fn overwrite(path: &str, content: &str) -> FileChange {
    FileChange::Overwrite {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
    }
}

/// A replacement conditional on the hash a read returned.
pub fn replace(path: &str, content: &str, expected_sha256: &str) -> FileChange {
    FileChange::Replace {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
        expected_sha256: Some(expected_sha256.to_string()),
    }
}

/// A replacement of whatever file is at the path; it never creates one.
pub fn replace_existing(path: &str, content: &str) -> FileChange {
    FileChange::Replace {
        path: path.to_string(),
        bytes: content.as_bytes().to_vec(),
        expected_sha256: None,
    }
}

/// A loopback Git smart-HTTP server over `git http-backend`: what a relayed
/// transfer reaches in these tests, through the production transport (HTTP
/// only, every control on). It serves each bare repository under its project
/// directory at `http://127.0.0.1:<port>/<path>`, records every request line,
/// and can stall requests to hold a transfer in flight.
pub struct GitHttp {
    port: u16,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stall: std::sync::Arc<std::sync::atomic::AtomicBool>,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    accepting: Option<std::thread::JoinHandle<()>>,
}

/// Note a test that needs a loopback listener this environment refuses, or
/// fail it when `EPICENTER_REQUIRE_LOOPBACK` is set, as an acceptance run sets.
pub fn loopback_unavailable(test: &str, cause: &std::io::Error) {
    if std::env::var_os("EPICENTER_REQUIRE_LOOPBACK").is_some() {
        panic!("{test} needs a loopback listener: {cause}");
    }
    eprintln!("SKIPPED {test}: no loopback listener here ({cause})");
}

impl GitHttp {
    /// Serve `project`, or `None` (after [`loopback_unavailable`]) where no
    /// listener can be bound.
    pub fn start(test: &str, project: &Path) -> Option<Self> {
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Mutex};

        isolate_git();
        let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(cause) => {
                loopback_unavailable(test, &cause);
                return None;
            }
        };
        let port = listener.local_addr().expect("a bound address").port();
        let stop = Arc::new(AtomicBool::new(false));
        let stall = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let project = project.to_path_buf();
        let (stopping, stalling, recording) =
            (Arc::clone(&stop), Arc::clone(&stall), Arc::clone(&requests));
        let accepting = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                let (project, stopping, stalling, recording) = (
                    project.clone(),
                    Arc::clone(&stopping),
                    Arc::clone(&stalling),
                    Arc::clone(&recording),
                );
                std::thread::spawn(move || {
                    let _ = serve_git(stream, &project, &stopping, &stalling, &recording);
                });
            }
        });
        Some(Self {
            port,
            stop,
            stall,
            requests,
            accepting: Some(accepting),
        })
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/{path}", self.port)
    }

    /// Hold every later request open, unanswered, until the server stops.
    pub fn stall(&self) {
        self.stall.store(true, Ordering::SeqCst);
    }

    /// A relay's retirement closes stalled requests before Git is killed,
    /// as the real host's relay does when it aborts its upstream requests.
    pub fn retirement(&self) -> impl FnOnce() + Send + 'static {
        let stop = std::sync::Arc::clone(&self.stop);
        move || stop.store(true, Ordering::SeqCst)
    }

    /// `METHOD path?query` of every request received, in order.
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for GitHttp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
        if let Some(accepting) = self.accepting.take() {
            let _ = accepting.join();
        }
    }
}

/// Answer one HTTP/1.1 request with `git http-backend`.
fn serve_git(
    stream: std::net::TcpStream,
    project: &Path,
    stop: &std::sync::atomic::AtomicBool,
    stall: &std::sync::atomic::AtomicBool,
    requests: &std::sync::Mutex<Vec<String>>,
) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader, Read, Write};

    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
    );
    let mut headers = std::collections::BTreeMap::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        loop {
            line.clear();
            reader.read_line(&mut line)?;
            let size =
                usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16).unwrap_or(0);
            if size == 0 {
                line.clear();
                reader.read_line(&mut line)?;
                break;
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
            line.clear();
            reader.read_line(&mut line)?;
        }
    } else if let Some(length) = headers.get("content-length") {
        body.resize(length.parse().unwrap_or(0), 0);
        reader.read_exact(&mut body)?;
    }
    requests.lock().unwrap().push(format!("{method} {target}"));
    if stall.load(Ordering::SeqCst) {
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(20));
        }
        return Ok(());
    }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let header = |name: &str| headers.get(name).cloned().unwrap_or_default();
    let mut backend = Command::new("git")
        .arg("http-backend")
        .env("GIT_PROJECT_ROOT", project)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", path)
        .env("REQUEST_METHOD", &method)
        .env("QUERY_STRING", query)
        .env("CONTENT_TYPE", header("content-type"))
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("HTTP_CONTENT_ENCODING", header("content-encoding"))
        .env("GIT_PROTOCOL", header("git-protocol"))
        .env("REMOTE_USER", "tester")
        .env("REMOTE_ADDR", "127.0.0.1")
        .env("SERVER_PROTOCOL", "HTTP/1.1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut input = backend.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || input.write_all(&body));
    let output = backend.wait_with_output()?;
    let _ = writer.join();
    let raw = output.stdout;
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| (at, 4))
        .or_else(|| {
            raw.windows(2)
                .position(|window| window == b"\n\n")
                .map(|at| (at, 2))
        });
    let (head, content) = match split {
        Some((at, gap)) => (
            String::from_utf8_lossy(&raw[..at]).into_owned(),
            &raw[at + gap..],
        ),
        None => (String::new(), &raw[..]),
    };
    let mut status = "200 OK".to_string();
    let mut response = String::new();
    for header in head.lines() {
        match header.split_once(':') {
            Some((name, value)) if name.eq_ignore_ascii_case("status") => {
                status = value.trim().to_string();
            }
            Some(_) => {
                response.push_str(header.trim_end());
                response.push_str("\r\n");
            }
            None => {}
        }
    }
    let mut stream = stream;
    stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\n{response}Content-Length: {}\r\nConnection: close\r\n\r\n",
            content.len()
        )
        .as_bytes(),
    )?;
    stream.write_all(content)?;
    stream.flush()
}

/// Wait for a condition another thread brings about.
pub fn eventually(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..2000 {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

/// Every file below `root`, with its bytes, for before-and-after comparisons.
pub fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .expect("read a directory")
            .flatten()
        {
            let kind = entry.file_type().expect("file type");
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .display()
                    .to_string();
                files.push((relative, std::fs::read(entry.path()).expect("read a file")));
            }
        }
    }
    files.sort();
    files
}
