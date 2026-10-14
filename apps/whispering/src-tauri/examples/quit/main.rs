//! A system quit of the real Whispering shell and host, on a fixture page.
//! macOS only.
//!
//!   quit [--scenario approve|early|host-gone|no-page]
//!        [--dir <missing or empty directory>] [--files <count>]
//!
//! The app is the one `run` starts (`whispering_lib::build` and
//! `whispering_lib::on_run_event`): Tauri on Wry, the quit guard, the Quit
//! menu, the folder plugin and the folder's registration, the Bun host
//! started from `native/main.ts` with the per-launch credential, the
//! capability, the main window and its navigation rule, and the shell's
//! handling of every exit request. Only the page differs: the host serves
//! `page.html` and `page.js` in place of the built page. The fixture uses the
//! window's real IPC and the host's real bridge: it is granted the folder's
//! directory and writes as the page's engine does, it hears the close
//! question on `/bridge/events` and answers it with
//! `POST /bridge/app { op: "close" }`, and the host prints the approval line
//! the shell reads.
//!
//! Each quit is AppKit's own: `[NSApp performSelector:@selector(terminate:)
//! withObject:nil afterDelay:0]`, posted from a main-thread task, so AppKit
//! sends `terminate:` on a later turn of the main run loop, outside every Tao
//! callback. This is what the Dock's Quit, a logout, or an Apple Event sends.
//!
//! `approve` (the default):
//!
//! 1. The page is granted the folder and listens to the host. The folder's
//!    lock is held and the host is running.
//! 2. First quit. The guard cancels it and asks for an exit; the exit request
//!    is held; the shell asks the host, the host asks the page, and the page
//!    answers `cancel` and then writes a file. The process, the host, and the
//!    folder's lock are all still there.
//! 3. The page starts a batch of `--files` new files, one after another. Once
//!    it is being written, second quit. The page waits until the batch has
//!    settled, as Whispering's page does, then answers `proceed`; the host
//!    prints its approval and the shell exits.
//! 4. On `RunEvent::Exit`, after the folder plugin's own shutdown and after
//!    the shell stopped the host: the approved exit request came after the
//!    whole batch was there, every file has its bytes, nothing is left in
//!    scratch, the folder is unlocked, and the host is gone.
//!
//! `early`: as `approve`, but the page answers `proceed` at once, with the
//! batch still being written, which Whispering's page never does. Nothing
//! drains it after the approval. On `RunEvent::Exit` every batch file that is
//! there is whole and in order, at least one is missing, and scratch holds
//! at most the one staged copy whose rename never ran, itself whole. The next
//! open of the folder removes it (`directory-adapter.ts` in `packages/folder`,
//! tested there).
//!
//! `host-gone`: the harness kills the host after the page opened. The first
//! quit is held and the page is told (`whispering:close-blocked`); it keeps
//! the window and writes a file. The second quit is held too, and the page
//! answers it by navigating to the quit address, which the shell honors only
//! because its host is gone.
//!
//! `no-page`: the data folder cannot be a directory, so the app starts on its
//! failure page with no host and nothing granted. One quit is held, and the
//! shell exits on its own because no app page was ever opened.
//!
//! The run's directory holds the folder (`data`), its lock beside it, and the
//! fixture page (`page`). It is kept for inspection. One JSON object per line
//! on stdout; the last is the verdict. The exit status is 0 only when every
//! check held. This does not show Whispering's page, a person's dialog, the
//! Dock, a logout, or a bundled app.

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("examples/quit drives AppKit's terminate: and runs only on macOS");
    std::process::ExitCode::from(2)
}

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    mac::main()
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CStr};
    use std::fs;
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitCode};
    use std::sync::atomic::{AtomicU16, AtomicU8, Ordering};
    use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use serde_json::{json, Value};
    use tauri::{AppHandle, Manager, RunEvent};

    const PAGE_HTML: &str = include_str!("page.html");
    const PAGE_JS: &str = include_str!("page.js");
    const LOCK_PROBE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/examples/quit/lock-probe.ts");
    /// `FOLDER_SCOPE` in `src/lib.rs`, the one folder the shell registers.
    const SCOPE: &str = "so.epicenter.whispering";
    /// `MAIN_WINDOW` in `src/lib.rs`.
    const WINDOW: &str = "main";
    /// How long any one step may take before the run fails.
    const WAIT: Duration = Duration::from_secs(60);
    /// What the unusable data folder holds in `no-page`, unchanged at exit.
    const NOT_A_FOLDER: &[u8] = b"not a directory\n";

    // Where the run is. Each stage is entered before the action it names.
    const STARTING: u8 = 0;
    const FIRST_QUIT: u8 = 1;
    const KEPT: u8 = 2;
    const SECOND_QUIT: u8 = 3;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Scenario {
        Approve,
        Early,
        HostGone,
        NoPage,
    }

    impl Scenario {
        fn name(self) -> &'static str {
            match self {
                Scenario::Approve => "approve",
                Scenario::Early => "early",
                Scenario::HostGone => "host-gone",
                Scenario::NoPage => "no-page",
            }
        }
    }

    struct Run {
        start: Instant,
        scenario: Scenario,
        root: PathBuf,
        lock: PathBuf,
        files: usize,
        bun: String,
        stage: AtomicU8,
        /// The host's port, once the page reported it.
        port: AtomicU16,
        exit_requests: Mutex<Vec<ExitRequest>>,
    }

    struct ExitRequest {
        code: Option<i32>,
        held: bool,
        stage: u8,
        landed: usize,
        at: SystemTime,
    }

    static RUN: OnceLock<Run> = OnceLock::new();

    fn run() -> &'static Run {
        RUN.get().expect("the run is set before the app starts")
    }

    fn exit_requests() -> MutexGuard<'static, Vec<ExitRequest>> {
        run()
            .exit_requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn log(event: &str, mut fields: Value) {
        fields["event"] = json!(event);
        fields["ms"] = json!(run().start.elapsed().as_millis() as u64);
        println!("{fields}");
    }

    /// End the run as failed, from any thread.
    fn fail(reason: &str) -> ! {
        log("verdict", json!({ "pass": false, "problems": [reason] }));
        std::process::exit(1)
    }

    fn millis(at: SystemTime) -> u128 {
        at.duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0)
    }

    // ------------------------------------------------------------------
    // AppKit, through the Objective-C runtime's C functions
    // ------------------------------------------------------------------

    type Id = *mut c_void;
    type Sel = *const c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn class_getInstanceMethod(class: Id, selector: Sel) -> *mut c_void;
        fn method_getTypeEncoding(method: *mut c_void) -> *const c_char;
        fn objc_msgSend();
    }

    fn selector(name: &CStr) -> Sel {
        // SAFETY: a NUL-terminated selector name.
        unsafe { sel_registerName(name.as_ptr()) }
    }

    /// The type encoding of `applicationShouldTerminate:` on Tao's delegate
    /// class, or `None` when the class does not answer it.
    fn guard_encoding() -> Option<String> {
        // SAFETY: runtime lookups with NUL-terminated names; the encoding is
        // a NUL-terminated string the runtime owns.
        unsafe {
            let class = objc_getClass(c"TaoAppDelegateParent".as_ptr());
            if class.is_null() {
                return None;
            }
            let method = class_getInstanceMethod(class, selector(c"applicationShouldTerminate:"));
            if method.is_null() {
                return None;
            }
            let encoding = method_getTypeEncoding(method);
            if encoding.is_null() {
                return None;
            }
            Some(CStr::from_ptr(encoding).to_string_lossy().into_owned())
        }
    }

    /// `[NSApp performSelector:@selector(terminate:) withObject:nil
    /// afterDelay:0]`, from a main-thread task: AppKit sends `terminate:` on
    /// a later turn of the main run loop, outside the Tao callback that runs
    /// this.
    fn quit_later(app: &AppHandle) -> Result<(), String> {
        app.run_on_main_thread(|| {
            // SAFETY: on the main thread; each send is cast to the exact
            // signature of the method it sends.
            unsafe {
                let send = std::mem::transmute::<
                    unsafe extern "C" fn(),
                    unsafe extern "C" fn(Id, Sel) -> Id,
                >(objc_msgSend);
                let application = send(
                    objc_getClass(c"NSApplication".as_ptr()),
                    selector(c"sharedApplication"),
                );
                let perform = std::mem::transmute::<
                    unsafe extern "C" fn(),
                    unsafe extern "C" fn(Id, Sel, Sel, Id, f64),
                >(objc_msgSend);
                perform(
                    application,
                    selector(c"performSelector:withObject:afterDelay:"),
                    selector(c"terminate:"),
                    std::ptr::null_mut(),
                    0.0,
                );
            }
        })
        .map_err(|cause| format!("the quit could not be scheduled: {cause}"))
    }

    // ------------------------------------------------------------------
    // The folder and the host, as the harness sees them from outside
    // ------------------------------------------------------------------

    fn batch_file(root: &Path, index: usize) -> PathBuf {
        root.join("batch").join(format!("{index:06}.md"))
    }

    fn landed(root: &Path) -> usize {
        fs::read_dir(root.join("batch")).map_or(0, |entries| entries.count())
    }

    fn report(root: &Path, name: &str) -> Option<Value> {
        let text = fs::read(root.join("harness").join(format!("{name}.json"))).ok()?;
        serde_json::from_slice(&text).ok()
    }

    /// Whether another process holds the folder's lock, asked from a separate
    /// Bun process with the same SQLite transaction the folder plugin holds.
    fn locked(run: &Run) -> Result<bool, String> {
        let output = Command::new(&run.bun)
            .arg(LOCK_PROBE)
            .arg(&run.lock)
            .output()
            .map_err(|cause| format!("the lock probe could not be started: {cause}"))?;
        match String::from_utf8_lossy(&output.stdout).trim() {
            "busy" if output.status.success() => Ok(true),
            "free" if output.status.success() => Ok(false),
            _ => Err(format!(
                "the lock probe failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
        }
    }

    /// This process's own child processes. The host is the only one the app
    /// starts.
    fn children() -> Result<Vec<u32>, String> {
        let output = Command::new("/usr/bin/pgrep")
            .arg("-P")
            .arg(std::process::id().to_string())
            .output()
            .map_err(|cause| format!("pgrep could not be started: {cause}"))?;
        // pgrep exits 1 when nothing matched.
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(format!("pgrep failed: {}", output.status));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect())
    }

    /// Whether anything accepts connections on the host's port.
    fn serving(port: u16) -> bool {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok()
    }

    fn wait_for<T>(what: &str, mut found: impl FnMut() -> Option<T>) -> Result<T, String> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(value) = found() {
                return Ok(value);
            }
            if Instant::now() > deadline {
                return Err(format!("{what} did not happen within {}s", WAIT.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    // ------------------------------------------------------------------
    // The run
    // ------------------------------------------------------------------

    struct Options {
        scenario: Scenario,
        dir: Option<PathBuf>,
        files: usize,
    }

    fn options() -> Result<Options, String> {
        let mut options = Options {
            scenario: Scenario::Approve,
            dir: None,
            files: 4000,
        };
        let mut arguments = std::env::args_os().skip(1);
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| format!("{} needs a value", argument.to_string_lossy()))?;
            match argument.to_str() {
                Some("--scenario") => {
                    options.scenario = match value.to_str() {
                        Some("approve") => Scenario::Approve,
                        Some("early") => Scenario::Early,
                        Some("host-gone") => Scenario::HostGone,
                        Some("no-page") => Scenario::NoPage,
                        _ => {
                            return Err("--scenario is approve, early, host-gone, or no-page".into())
                        }
                    }
                }
                Some("--dir") => options.dir = Some(PathBuf::from(value)),
                Some("--files") => {
                    options.files = value
                        .to_str()
                        .and_then(|text| text.parse().ok())
                        .filter(|files| *files >= 2)
                        .ok_or("--files needs a whole number of at least 2")?
                }
                _ => return Err(format!("unknown argument {}", argument.to_string_lossy())),
            }
        }
        Ok(options)
    }

    /// A fresh directory for the run: the one named if it is missing or
    /// empty, else a new one under the temporary directory. Never another.
    fn fresh_dir(named: Option<PathBuf>) -> Result<PathBuf, String> {
        let dir = named.unwrap_or_else(|| {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            std::env::temp_dir().join(format!("whispering-quit-{}-{nanos:x}", std::process::id()))
        });
        if dir.exists() {
            let empty = fs::read_dir(&dir)
                .map_err(|cause| format!("{} cannot be read: {cause}", dir.display()))?
                .next()
                .is_none();
            if !empty {
                return Err(format!(
                    "{} is not empty; the harness only uses a fresh directory",
                    dir.display()
                ));
            }
        }
        fs::create_dir_all(&dir)
            .map_err(|cause| format!("{} could not be created: {cause}", dir.display()))?;
        fs::canonicalize(&dir)
            .map_err(|cause| format!("{} could not be resolved: {cause}", dir.display()))
    }

    /// The folder and the fixture page inside the run's directory.
    fn prepare(dir: &Path, scenario: Scenario) -> Result<(PathBuf, PathBuf), String> {
        let written = |path: &Path, bytes: &[u8]| {
            fs::write(path, bytes)
                .map_err(|cause| format!("{} could not be written: {cause}", path.display()))
        };
        let root = dir.join("data");
        if scenario == Scenario::NoPage {
            written(&root, NOT_A_FOLDER)?;
        } else {
            fs::create_dir(&root)
                .map_err(|cause| format!("{} could not be created: {cause}", root.display()))?;
        }
        let page = dir.join("page");
        fs::create_dir(&page)
            .map_err(|cause| format!("{} could not be created: {cause}", page.display()))?;
        written(&page.join("index.html"), PAGE_HTML.as_bytes())?;
        let script = PAGE_JS
            .replace("__SCOPE__", SCOPE)
            .replace("__SCENARIO__", scenario.name());
        written(&page.join("fixture.js"), script.as_bytes())?;
        Ok((root, page))
    }

    /// The environment the shell and its host start from: the run's folder,
    /// no inherited Whispering setting other than which Bun to run, and no
    /// Git configuration of this machine's user.
    fn isolate(root: &Path) {
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if name.starts_with("WHISPERING_") && name != "WHISPERING_BUN" {
                std::env::remove_var(&key);
            }
        }
        std::env::set_var("WHISPERING_DATA_ROOT", root);
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    }

    pub fn main() -> ExitCode {
        let prepared = options().and_then(
            |Options {
                 scenario,
                 dir,
                 files,
             }| {
                let dir = fresh_dir(dir)?;
                let (root, page) = prepare(&dir, scenario)?;
                Ok((scenario, files, dir, root, page))
            },
        );
        let (scenario, files, dir, root, page) = match prepared {
            Ok(prepared) => prepared,
            Err(reason) => {
                eprintln!("quit: {reason}");
                return ExitCode::from(2);
            }
        };
        isolate(&root);
        let bun = std::env::var("WHISPERING_BUN").unwrap_or_else(|_| "bun".to_string());
        let _ = RUN.set(Run {
            start: Instant::now(),
            scenario,
            lock: dir.join(".data.epicenter-lock"),
            root: root.clone(),
            files,
            bun,
            stage: AtomicU8::new(STARTING),
            port: AtomicU16::new(0),
            exit_requests: Mutex::default(),
        });
        log(
            "start",
            json!({
                "scenario": scenario.name(),
                "dir": dir,
                "files": files,
                "pid": std::process::id(),
            }),
        );

        let app = match whispering_lib::build(Some(page)) {
            Ok(app) => app,
            Err(cause) => fail(&format!("the app could not be built: {cause}")),
        };
        // Tauri runs the app's setup (the guard, the menu, the host, the
        // window) inside `run`, once the event loop is ready, and only then
        // sends `RunEvent::Ready`. Nothing is driven before that.
        let (set_up, setup_done) = mpsc::channel::<()>();
        let mut set_up = Some(set_up);
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let driven = setup_done
                .recv_timeout(WAIT)
                .map_err(|_| {
                    format!(
                        "the app's setup did not finish (no RunEvent::Ready) within {}s",
                        WAIT.as_secs()
                    )
                })
                .and_then(|()| match run().scenario {
                    Scenario::Approve | Scenario::Early => drive_batch(&handle),
                    Scenario::HostGone => drive_host_gone(&handle),
                    Scenario::NoPage => drive_no_page(&handle),
                });
            if let Err(reason) = driven {
                fail(&reason);
            }
            // The rest happens on the main thread, and it ends the process.
            std::thread::sleep(WAIT);
            fail("the app did not exit after the last quit");
        });
        app.run(move |handle, event| {
            // The app's own handling, unchanged; then what it decided.
            let held = whispering_lib::on_run_event(handle, &event);
            match &event {
                RunEvent::Ready => {
                    if let Some(set_up) = set_up.take() {
                        log("setup-done", json!({}));
                        let _ = set_up.send(());
                    }
                }
                RunEvent::ExitRequested { code, .. } => exit_requested(*code, held),
                RunEvent::Exit => exited(),
                _ => {}
            }
        });
        ExitCode::SUCCESS
    }

    /// Run `read` on the main thread, where the app's setup ran and AppKit is
    /// used, and wait for its answer.
    fn on_main<T: Send + 'static>(
        app: &AppHandle,
        what: &str,
        read: impl FnOnce(&AppHandle) -> T + Send + 'static,
    ) -> Result<T, String> {
        let handle = app.clone();
        let (answer, answered) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = answer.send(read(&handle));
        })
        .map_err(|cause| format!("{what} could not be asked on the main thread: {cause}"))?;
        answered
            .recv_timeout(WAIT)
            .map_err(|_| format!("{what} was not answered within {}s", WAIT.as_secs()))
    }

    /// The guard's type encoding and whether the main window exists, read on
    /// the main thread.
    fn guard_and_window(app: &AppHandle) -> Result<(Option<String>, bool), String> {
        on_main(app, "the guard and the window", |app| {
            (guard_encoding(), app.get_webview_window(WINDOW).is_some())
        })
    }

    /// The page was granted the folder and listens to the host. Returns the
    /// host's process.
    fn opened(app: &AppHandle) -> Result<u32, String> {
        let run = run();
        let root = &run.root;
        let ready = wait_for("the page opening its folder", || report(root, "ready"))?;
        let (guard, window) = guard_and_window(app)?;
        let held = locked(run)?;
        let port = ready["port"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok());
        let hosts = children()?;
        log(
            "ready",
            json!({
                "page": ready,
                "guard": guard,
                "window": window,
                "folderLocked": held,
                "children": hosts,
            }),
        );
        if guard.as_deref() != Some("Q@:@") {
            return Err("the delegate does not answer applicationShouldTerminate: as Q@:@".into());
        }
        if !window {
            return Err("the main window is missing".into());
        }
        if ready["root"].as_str() != root.to_str() {
            return Err("the page was granted a folder other than the run's".into());
        }
        let Some(port) = port.filter(|port| *port != 0) else {
            return Err("the page did not report the host's port".into());
        };
        run.port.store(port, Ordering::SeqCst);
        if !held {
            return Err("the folder is not locked while the page holds it".into());
        }
        let [host] = hosts.as_slice() else {
            return Err(format!(
                "expected the host as the one child process, found {hosts:?}"
            ));
        };
        if !serving(port) {
            return Err("the host is not serving while the page is open".into());
        }
        Ok(*host)
    }

    fn held_once(stage: u8) -> Result<(), String> {
        let requests = exit_requests();
        let shape: Vec<(Option<i32>, bool, u8)> = requests
            .iter()
            .map(|request| (request.code, request.held, request.stage))
            .collect();
        if shape != [(Some(0), true, stage)] {
            return Err(format!(
                "the first terminate: became exit requests {shape:?}, not exactly one held request"
            ));
        }
        Ok(())
    }

    /// `approve` and `early`, steps 1 to 3, off the main thread.
    fn drive_batch(app: &AppHandle) -> Result<(), String> {
        let run = run();
        let root = &run.root;
        let host = opened(app)?;

        // Step 2: the first quit is declined.
        run.stage.store(FIRST_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log("terminate-scheduled", json!({ "attempt": 1 }));
        let declined = wait_for("the page declining", || report(root, "declined"))?;
        let held = locked(run)?;
        let hosts = children()?;
        let port = run.port.load(Ordering::SeqCst);
        log(
            "declined",
            json!({
                "answer": declined,
                "folderLocked": held,
                "children": hosts,
                "hostServing": serving(port),
            }),
        );
        held_once(FIRST_QUIT)?;
        if declined != json!({ "asked": 1 }) {
            return Err(format!(
                "the page wrote {declined} after declining, not its first answer"
            ));
        }
        if !held {
            return Err("the folder was unlocked after the page declined".into());
        }
        if hosts != [host] || !serving(port) {
            return Err("the host is gone after the page declined".into());
        }
        run.stage.store(KEPT, Ordering::SeqCst);

        // Step 3: a batch the page is writing, then the second quit.
        app.get_webview_window(WINDOW)
            .ok_or("the main window is missing")?
            .eval(format!("window.__quitFixture.startBatch({})", run.files).as_str())
            .map_err(|cause| format!("the batch could not be started: {cause}"))?;
        let last = batch_file(root, run.files - 1);
        wait_for("the page writing the batch", || {
            batch_file(root, 0).exists().then_some(())
        })?;
        if last.exists() {
            return Err("the batch finished before the quit; run with more --files".into());
        }
        run.stage.store(SECOND_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log(
            "terminate-scheduled",
            json!({ "attempt": 2, "landed": landed(root), "of": run.files }),
        );
        Ok(())
    }

    /// `host-gone`, off the main thread.
    fn drive_host_gone(app: &AppHandle) -> Result<(), String> {
        let run = run();
        let root = &run.root;
        let host = opened(app)?;
        let port = run.port.load(Ordering::SeqCst);

        let killed = Command::new("/bin/kill")
            .arg("-KILL")
            .arg(host.to_string())
            .status()
            .map_err(|cause| format!("kill could not be started: {cause}"))?;
        if !killed.success() {
            return Err(format!("the host could not be killed: {killed}"));
        }
        wait_for("the host to stop serving", || {
            (!serving(port)).then_some(())
        })?;
        log("host-killed", json!({ "pid": host }));

        // The first quit is held, and the page keeps the window.
        run.stage.store(FIRST_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log("terminate-scheduled", json!({ "attempt": 1 }));
        let blocked = wait_for("the page hearing the close was blocked", || {
            report(root, "blocked")
        })?;
        let held = locked(run)?;
        log("kept", json!({ "answer": blocked, "folderLocked": held }));
        held_once(FIRST_QUIT)?;
        if blocked != json!({ "blocked": 1 }) {
            return Err(format!(
                "the page wrote {blocked}, not its first blocked close"
            ));
        }
        if !held {
            return Err("the folder was unlocked while the page kept the window".into());
        }

        // The second quit: the page answers with the quit address.
        run.stage.store(SECOND_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log("terminate-scheduled", json!({ "attempt": 2 }));
        Ok(())
    }

    /// `no-page`, off the main thread.
    fn drive_no_page(app: &AppHandle) -> Result<(), String> {
        let run = run();
        // Setup has finished: the failure page's window was built in it.
        let (guard, window) = guard_and_window(app)?;
        let hosts = children()?;
        log(
            "failure-page",
            json!({ "guard": guard, "children": hosts, "window": window }),
        );
        if guard.as_deref() != Some("Q@:@") {
            return Err("the delegate does not answer applicationShouldTerminate: as Q@:@".into());
        }
        if !hosts.is_empty() {
            return Err(format!("a failed start left child processes {hosts:?}"));
        }
        if !window {
            return Err("the failure page's window is missing".into());
        }
        run.stage.store(FIRST_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log("terminate-scheduled", json!({ "attempt": 1 }));
        Ok(())
    }

    fn exit_requested(code: Option<i32>, held: bool) {
        let run = run();
        let request = ExitRequest {
            code,
            held,
            stage: run.stage.load(Ordering::SeqCst),
            landed: landed(&run.root),
            at: SystemTime::now(),
        };
        log(
            "exit-requested",
            json!({
                "code": request.code,
                "held": request.held,
                "stage": request.stage,
                "landed": request.landed,
                "of": run.files,
            }),
        );
        exit_requests().push(request);
    }

    /// On `RunEvent::Exit`. Tauri gives it to the folder plugin, which refuses
    /// new page work, waits for what is running, and releases the folder's
    /// lock, before the app's callback; the app's own handling, which stops
    /// the host, ran just before this.
    fn exited() {
        let run = run();
        let root = &run.root;
        let at = SystemTime::now();
        let requests = exit_requests();
        let mut problems: Vec<String> = Vec::new();

        let stage = run.stage.load(Ordering::SeqCst);
        let last_stage = match run.scenario {
            Scenario::NoPage => FIRST_QUIT,
            _ => SECOND_QUIT,
        };
        if stage != last_stage {
            problems.push(format!(
                "the app exited at stage {stage}, before the last quit"
            ));
        }
        let shape: Vec<(Option<i32>, bool, u8)> = requests
            .iter()
            .map(|request| (request.code, request.held, request.stage))
            .collect();
        let expected: &[(Option<i32>, bool, u8)] = match run.scenario {
            Scenario::NoPage => &[(Some(0), true, FIRST_QUIT), (Some(0), false, FIRST_QUIT)],
            _ => &[
                (Some(0), true, FIRST_QUIT),
                (Some(0), true, SECOND_QUIT),
                (Some(0), false, SECOND_QUIT),
            ],
        };
        if shape != expected {
            problems.push(format!(
                "exit requests were {shape:?}, not {expected:?}: held after each terminate: and let through only on an answer"
            ));
        }

        let hosts = children().unwrap_or_else(|cause| {
            problems.push(cause);
            Vec::new()
        });
        if !hosts.is_empty() {
            problems.push(format!(
                "child processes {hosts:?} are still running at exit"
            ));
        }
        let port = run.port.load(Ordering::SeqCst);
        let host_serving = port != 0 && serving(port);
        if host_serving {
            problems.push("the host still accepts connections at exit".to_string());
        }

        let mut fields = json!({
            "stage": stage,
            "children": hosts,
            "hostServing": host_serving,
            "exitAt": millis(at),
        });
        match run.scenario {
            Scenario::NoPage => {
                if fs::read(root).ok().as_deref() != Some(NOT_A_FOLDER) {
                    problems.push("the unusable data folder was changed".to_string());
                }
                if run.lock.exists() {
                    problems.push("a lock was taken for a folder that never opened".to_string());
                }
            }
            Scenario::HostGone => {
                if report(root, "blocked") != Some(json!({ "blocked": 1 })) {
                    problems.push("the page's write after the blocked close is not there".into());
                }
                scratch_empty(run, &mut problems, &mut fields);
                folder_released(run, &mut problems, &mut fields);
            }
            Scenario::Approve => {
                if report(root, "declined") != Some(json!({ "asked": 1 })) {
                    problems.push("the page's write after declining is not there".into());
                }
                batch_settled_first(run, &requests, &mut problems, &mut fields);
                scratch_empty(run, &mut problems, &mut fields);
                folder_released(run, &mut problems, &mut fields);
            }
            Scenario::Early => {
                if report(root, "declined") != Some(json!({ "asked": 1 })) {
                    problems.push("the page's write after declining is not there".into());
                }
                batch_whole(run, &requests, &mut problems, &mut fields);
                folder_released(run, &mut problems, &mut fields);
            }
        }

        log("exit", fields);
        let pass = problems.is_empty();
        log("verdict", json!({ "pass": pass, "problems": problems }));
        if !pass {
            std::process::exit(1);
        }
    }

    /// The bytes of batch file `index`.
    fn batch_bytes(index: usize) -> Vec<u8> {
        format!("{index}\n").into_bytes()
    }

    /// The approved exit request came after the whole batch was there, and
    /// every file of it has its bytes.
    fn batch_settled_first(
        run: &Run,
        requests: &[ExitRequest],
        problems: &mut Vec<String>,
        fields: &mut Value,
    ) {
        let root = &run.root;
        let approved = requests.iter().find(|request| !request.held);
        if let Some(approved) = approved {
            if approved.landed < run.files {
                problems.push(format!(
                    "the exit was approved with {} of {} batch files written",
                    approved.landed, run.files
                ));
            }
        }
        let mut wrong = Vec::new();
        for index in 0..run.files {
            match fs::read(batch_file(root, index)) {
                Ok(bytes) if bytes == batch_bytes(index) => {}
                Ok(_) => wrong.push(format!("{index}: other bytes")),
                Err(cause) => wrong.push(format!("{index}: {cause}")),
            }
        }
        if !wrong.is_empty() {
            problems.push(format!(
                "{} of {} batch files are missing or wrong at exit, first {}",
                wrong.len(),
                run.files,
                wrong[0]
            ));
        }
        fields["landed"] = json!(landed(root));
        fields["of"] = json!(run.files);
        fields["approvedWithLanded"] = json!(approved.map(|request| request.landed));
        fields["approvedExitRequestedAt"] = json!(approved.map(|request| millis(request.at)));
    }

    /// After an approval that did not wait: the batch files that are there
    /// are whole and in order, the rest are absent, and scratch holds at
    /// most one staged copy, itself whole.
    fn batch_whole(
        run: &Run,
        requests: &[ExitRequest],
        problems: &mut Vec<String>,
        fields: &mut Value,
    ) {
        let root = &run.root;
        let approved = requests.iter().find(|request| !request.held);
        if let Some(approved) = approved {
            if approved.landed >= run.files {
                problems.push("the batch had finished when the approved exit was requested".into());
            }
        }
        let present = (0..run.files)
            .take_while(|index| batch_file(root, *index).exists())
            .count();
        if landed(root) != present {
            problems.push("the batch files at exit are not one unbroken run from the first".into());
        }
        if present == run.files {
            problems.push(
                "the whole batch was written after an early approval; run with more --files".into(),
            );
        }
        for index in 0..present {
            if fs::read(batch_file(root, index)).ok() != Some(batch_bytes(index)) {
                problems.push(format!("batch file {index} is not whole at exit"));
                break;
            }
        }
        let staged: Vec<Vec<u8>> = fs::read_dir(scratch_dir(root))
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| fs::read(entry.path()).ok())
                    .collect()
            })
            .unwrap_or_default();
        if staged.len() > 1 {
            problems.push(format!(
                "{} files are left in scratch, not at most one",
                staged.len()
            ));
        }
        if staged.iter().any(|bytes| *bytes != batch_bytes(present)) {
            problems.push("a copy left in scratch is not the next batch file's whole bytes".into());
        }
        fields["landed"] = json!(present);
        fields["of"] = json!(run.files);
        fields["approvedWithLanded"] = json!(approved.map(|request| request.landed));
        fields["approvedExitRequestedAt"] = json!(approved.map(|request| millis(request.at)));
        fields["scratchFiles"] = json!(staged.len());
    }

    fn scratch_dir(root: &Path) -> PathBuf {
        root.join(".git").join("epicenter").join("scratch")
    }

    /// Nothing left in scratch.
    fn scratch_empty(run: &Run, problems: &mut Vec<String>, fields: &mut Value) {
        let scratch = fs::read_dir(scratch_dir(&run.root)).map_or(0, |entries| entries.count());
        if scratch != 0 {
            problems.push(format!("{scratch} files are left in scratch"));
        }
        fields["scratchFiles"] = json!(scratch);
    }

    /// The folder's lock free.
    fn folder_released(run: &Run, problems: &mut Vec<String>, fields: &mut Value) {
        let unlocked = match locked(run) {
            Ok(held) => !held,
            Err(cause) => {
                problems.push(cause);
                false
            }
        };
        if !unlocked {
            problems.push("the folder is still locked at exit".to_string());
        }
        fields["folderUnlocked"] = json!(unlocked);
    }
}
