//! A system quit of the real Honeycrisp app, on a fixture page. macOS only.
//!
//!   quit [--root <empty or missing directory>] [--files <count>]
//!
//! The app is the one `run` starts (`honeycrisp_lib::build`): Tauri on Wry,
//! the quit guard, the Quit menu, the folder plugin and its scope, the close
//! gate, and the notes window with its navigation rule. Only the window's
//! page differs: its `index.html` is replaced by `page.html`, and the harness
//! evaluates `page.js` in it, a page-like voter that uses the window's real
//! IPC and capability. The folder is a fresh directory, never the default one,
//! with an empty repository, as the folder engine leaves a new folder.
//!
//! The harness asks AppKit to quit the way the Dock, a logout, or an Apple
//! Event does: `[NSApp terminate:]`, sent from the main run loop with
//! `performSelector:withObject:afterDelay:0`, outside every Tao callback.
//!
//! 1. The page takes the folder's grant and says it is open.
//! 2. First quit. The guard cancels it and asks for an exit; the exit request
//!    is held; the page is asked and declines, then writes to its folder. The
//!    process, the gate, and the folder's lock are still there.
//! 3. The page sends `--files` writes of new files, each its own command, and
//!    waits for none. Once the shell is writing them, second quit. The page
//!    is asked again, under a new request, and approves without settling.
//! 4. The approved exit goes ahead while writes are still running. On
//!    `RunEvent::Exit`, after the folder plugin's own shutdown, which refuses
//!    new page work and waits for the commands already running, every batch
//!    file that exists is whole, and the folder is unlocked. A write the
//!    shell refused at shutdown leaves no file; that is the page's loss, and
//!    the notes page never approves before its writes settle. Files left in
//!    `.git/epicenter/scratch` are counted, not failed: the engine clears
//!    scratch the next time it opens the folder.
//!
//! One JSON object per line on stdout; the last is the verdict. The exit
//! status is 0 only when every check held. The folder is kept for
//! inspection. This shows the app's own handling of `terminate:` on a fixture
//! page; it does not show the notes page, a person's dialog, the Dock, a
//! logout, or a bundled app.

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
    use std::borrow::Cow;
    use std::ffi::{c_char, c_void, CStr};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use epicenter_folder_core::lock::{LockError, RootLock};
    use std::process::Command;
    use serde_json::{json, Value};
    use tauri::http::header::CONTENT_LENGTH;
    use tauri::webview::PageLoadEvent;
    use tauri::{AppHandle, Listener, Manager, RunEvent};

    const PAGE_HTML: &str = include_str!("page.html");
    const PAGE_JS: &str = include_str!("page.js");
    /// `root::SCOPE` in `src/root.rs`, the one scope the shell registers.
    const SCOPE: &str = "so.epicenter.honeycrisp";
    const WINDOW: &str = "main";
    const CLOSE_REQUESTED: &str = "close-requested";
    /// How long any one step may take before the run fails.
    const WAIT: Duration = Duration::from_secs(60);

    // Where the run is. Each stage is entered before the action it names.
    const STARTING: u8 = 0;
    const FIRST_QUIT: u8 = 1;
    const DECLINED: u8 = 2;
    const SECOND_QUIT: u8 = 3;

    struct Run {
        start: Instant,
        root: PathBuf,
        files: usize,
        stage: AtomicU8,
        record: Mutex<Record>,
    }

    #[derive(Default)]
    struct Record {
        exit_requests: Vec<ExitRequest>,
        /// Every close request the shell sent the page, in order.
        asks: Vec<Value>,
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

    fn record() -> MutexGuard<'static, Record> {
        run()
            .record
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
                let send = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Sel) -> Id>(
                    objc_msgSend,
                );
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
    // The folder, as the harness sees it from outside the shell
    // ------------------------------------------------------------------

    fn batch_file(root: &Path, index: usize) -> PathBuf {
        root.join("batch").join(format!("{index:06}.md"))
    }

    fn landed(root: &Path) -> usize {
        fs::read_dir(root.join("batch")).map_or(0, |entries| entries.count())
    }

    /// Whether another holder has the folder's cross-process lock. The probe
    /// is the folder plugin's own lock; taken, it is released at once.
    fn locked(root: &Path) -> Result<bool, String> {
        match RootLock::acquire(root) {
            Ok(lock) => {
                drop(lock);
                Ok(false)
            }
            Err(LockError::Busy { .. }) => Ok(true),
            Err(LockError::Failed { message }) => Err(message),
        }
    }

    fn report(root: &Path, name: &str) -> Option<Value> {
        let text = fs::read(root.join("harness").join(format!("{name}.json"))).ok()?;
        serde_json::from_slice(&text).ok()
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
        root: Option<PathBuf>,
        files: usize,
    }

    fn options() -> Result<Options, String> {
        let mut options = Options {
            root: None,
            files: 4000,
        };
        let mut arguments = std::env::args_os().skip(1);
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| format!("{} needs a value", argument.to_string_lossy()))?;
            match argument.to_str() {
                Some("--root") => options.root = Some(PathBuf::from(value)),
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

    /// A fresh directory for the folder: the one named if it is missing or
    /// empty, else a new one under the temporary directory. Never another.
    fn fresh_root(named: Option<PathBuf>) -> Result<PathBuf, String> {
        let root = named.unwrap_or_else(|| {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0);
            std::env::temp_dir().join(format!("honeycrisp-quit-{}-{nanos:x}", std::process::id()))
        });
        if root.exists() {
            let empty = fs::read_dir(&root)
                .map_err(|cause| format!("{} cannot be read: {cause}", root.display()))?
                .next()
                .is_none();
            if !empty {
                return Err(format!(
                    "{} is not empty; the harness only uses a fresh directory",
                    root.display()
                ));
            }
        }
        fs::create_dir_all(&root)
            .map_err(|cause| format!("{} could not be created: {cause}", root.display()))?;
        // The engine makes the repository before its first write; the fixture
        // page does not run the engine, so the harness makes it.
        let initialized = Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(&root)
            .status()
            .map_err(|cause| format!("git could not run: {cause}"))?;
        if !initialized.success() {
            return Err(format!("git init failed in {}", root.display()));
        }
        fs::canonicalize(&root)
            .map_err(|cause| format!("{} could not be resolved: {cause}", root.display()))
    }

    pub fn main() -> ExitCode {
        let (root, files) = match options().and_then(|options| {
            Ok((fresh_root(options.root)?, options.files))
        }) {
            Ok(chosen) => chosen,
            Err(reason) => {
                eprintln!("quit: {reason}");
                return ExitCode::from(2);
            }
        };
        // Read by the shell's setup, which chooses the folder from it.
        std::env::set_var("HONEYCRISP_ROOT", &root);
        let _ = RUN.set(Run {
            start: Instant::now(),
            root: root.clone(),
            files,
            stage: AtomicU8::new(STARTING),
            record: Mutex::default(),
        });
        log(
            "start",
            json!({ "root": root, "files": files, "pid": std::process::id() }),
        );

        let (loaded, page_loaded) = mpsc::channel::<()>();
        let app = honeycrisp_lib::build(move |window| {
            window
                .on_web_resource_request(|request, response| {
                    if matches!(request.uri().path(), "/" | "/index.html") {
                        response.headers_mut().remove(CONTENT_LENGTH);
                        *response.body_mut() = Cow::Borrowed(PAGE_HTML.as_bytes());
                    }
                })
                .on_page_load(move |_, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = loaded.send(());
                    }
                })
        });
        let app = match app {
            Ok(app) => app,
            Err(cause) => fail(&format!("the app could not be built: {cause}")),
        };
        app.listen_any(CLOSE_REQUESTED, |event| {
            let ask = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            record().asks.push(ask);
        });
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            if let Err(reason) = drive(&handle, &page_loaded) {
                fail(&reason);
            }
            // The rest happens on the main thread, and it ends the process.
            std::thread::sleep(WAIT);
            fail("the app did not exit after the approval");
        });
        app.run(|handle, event| match &event {
            RunEvent::ExitRequested { code, .. } => {
                // The app's own handling, unchanged; then what it decided.
                let held = honeycrisp_lib::hold_exit(handle, &event);
                exit_requested(*code, held);
            }
            RunEvent::Exit => exited(),
            _ => {}
        });
        ExitCode::SUCCESS
    }

    /// Steps 1 to 3, off the main thread.
    fn drive(app: &AppHandle, page_loaded: &mpsc::Receiver<()>) -> Result<(), String> {
        let run = run();
        let root = &run.root;
        page_loaded
            .recv_timeout(WAIT)
            .map_err(|_| "the fixture page did not load".to_string())?;
        let guard = guard_encoding();
        log("page-loaded", json!({ "guard": guard }));
        if guard.as_deref() != Some("Q@:@") {
            return Err("the delegate does not answer applicationShouldTerminate: as Q@:@".into());
        }
        let page = PAGE_JS.replace("__SCOPE__", SCOPE);
        app.get_webview_window(WINDOW)
            .ok_or("the notes window is missing")?
            .eval(page.as_str())
            .map_err(|cause| format!("the fixture page could not be started: {cause}"))?;
        let ready = wait_for("the page opening its folder", || report(root, "ready"))?;
        let held = locked(root)?;
        log("ready", json!({ "page": ready, "folderLocked": held }));
        if !held {
            return Err("the folder is not locked while the page holds it".into());
        }

        // Step 2: the first quit is declined.
        run.stage.store(FIRST_QUIT, Ordering::SeqCst);
        quit_later(app)?;
        log("terminate-scheduled", json!({ "attempt": 1 }));
        let declined = wait_for("the page declining", || report(root, "declined"))?;
        let held = locked(root)?;
        {
            let record = record();
            let requests: Vec<Value> = record
                .exit_requests
                .iter()
                .map(|request| json!({ "code": request.code, "held": request.held }))
                .collect();
            log(
                "declined",
                json!({
                    "answer": declined,
                    "asks": record.asks,
                    "exitRequests": requests,
                    "folderLocked": held,
                    "pid": std::process::id(),
                }),
            );
            let asked_once = matches!(record.exit_requests.as_slice(), [only] if only.held && only.code == Some(0));
            if !asked_once {
                return Err("the first terminate: did not become exactly one held exit request".into());
            }
            if record.asks.first() != Some(&declined) {
                return Err("the page declined a request other than the one the shell sent".into());
            }
        }
        if !held {
            return Err("the folder was unlocked after the page declined".into());
        }
        run.stage.store(DECLINED, Ordering::SeqCst);

        // Step 3: writes the shell is running, then the second quit.
        app.get_webview_window(WINDOW)
            .ok_or("the notes window is missing")?
            .eval(format!("window.__quitFixture.startBatch({})", run.files).as_str())
            .map_err(|cause| format!("the batch could not be started: {cause}"))?;
        wait_for("the shell writing the batch", || (landed(root) > 0).then_some(()))?;
        if landed(root) >= run.files {
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
        record().exit_requests.push(request);
    }

    /// Step 4, on `RunEvent::Exit`: Tauri gives it to the folder plugin, which
    /// refuses new page work and waits for the running commands, before this
    /// callback.
    fn exited() {
        let run = run();
        let root = &run.root;
        let at = SystemTime::now();
        let record = record();
        let mut problems: Vec<String> = Vec::new();

        let stage = run.stage.load(Ordering::SeqCst);
        if stage != SECOND_QUIT {
            problems.push(format!(
                "the app exited at stage {stage}, before the second quit was scheduled"
            ));
        }
        let shape: Vec<(Option<i32>, bool, u8)> = record
            .exit_requests
            .iter()
            .map(|request| (request.code, request.held, request.stage))
            .collect();
        let expected = [
            (Some(0), true, FIRST_QUIT),
            (Some(0), true, SECOND_QUIT),
            (Some(0), false, SECOND_QUIT),
        ];
        if shape != expected {
            problems.push(format!(
                "exit requests were {shape:?}, not held after each terminate: and let through after the approval"
            ));
        }
        let request = |ask: &Value| ask["request"].as_u64();
        let generation = |ask: &Value| ask["generation"].as_u64();
        match record.asks.as_slice() {
            [first, second]
                if generation(first).is_some()
                    && generation(first) == generation(second)
                    && request(first).is_some()
                    && request(second) > request(first) => {}
            asks => problems.push(format!(
                "the page was asked {asks:?}, not twice by one page under a new request"
            )),
        }

        let approved = record.exit_requests.iter().find(|request| !request.held);
        if let Some(approved) = approved {
            if approved.landed >= run.files {
                problems.push(
                    "the batch had finished when the approved exit was requested".to_string(),
                );
            }
        }
        // Every file a write left is whole: a write either landed with its
        // bytes or left nothing at that path.
        let mut wrong = Vec::new();
        let mut present = 0;
        for index in 0..run.files {
            match fs::read(batch_file(root, index)) {
                Ok(bytes) if bytes == format!("{index}\n").as_bytes() => present += 1,
                Ok(_) => wrong.push(format!("{index}: other bytes")),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => wrong.push(format!("{index}: {cause}")),
            }
        }
        if !wrong.is_empty() {
            problems.push(format!(
                "{} of {} batch files are not whole at exit, first {}",
                wrong.len(),
                run.files,
                wrong[0]
            ));
        }
        let written_after_approval = approved.map_or(0, |approved| {
            (0..run.files)
                .filter_map(|index| fs::metadata(batch_file(root, index)).ok())
                .filter_map(|stats| stats.modified().ok())
                .filter(|written| *written > approved.at)
                .count()
        });
        let scratch = fs::read_dir(root.join(".git").join("epicenter").join("scratch"))
            .map_or(0, |entries| entries.count());
        let unlocked = match locked(root) {
            Ok(held) => !held,
            Err(cause) => {
                problems.push(format!("the lock could not be probed: {cause}"));
                false
            }
        };
        if !unlocked {
            problems.push("the folder is still locked at exit".to_string());
        }

        log(
            "exit",
            json!({
                "stage": stage,
                "landed": present,
                "of": run.files,
                "writtenAfterApproval": written_after_approval,
                "approvedExitRequestedAt": approved.map(|request| millis(request.at)),
                "exitAt": millis(at),
                "scratchFiles": scratch,
                "folderUnlocked": unlocked,
            }),
        );
        let pass = problems.is_empty();
        log("verdict", json!({ "pass": pass, "problems": problems }));
        if !pass {
            std::process::exit(1);
        }
    }
}
