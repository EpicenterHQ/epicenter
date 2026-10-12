//! The Whispering desktop shell.
//!
//! The shell owns a window, the data folder, and one child process.
//!
//! The folder has one owner, `tauri-plugin-epicenter-folder`, in this process.
//! The shell chooses the folder's directory once, registers it with that owner
//! for the main window, and lets that window's page call the owner's commands.
//! The page names the folder and never a path. This crate registers no command
//! of its own.
//!
//! The child is the Bun host (`native/main.ts`): it serves the page on loopback
//! and does what a page cannot, such as running the terminal and sending
//! transcription requests. The shell starts it with the directory it chose,
//! waits for the port it reports, loads the page from it, and stops it on
//! exit. The host is told where the folder is; it is never asked.
//!
//! Work that is not saved yet lives only in the page, so the shell never closes
//! on its own judgement. A window close, Command-Q, or any other exit request
//! is held back and turned into a question: the shell writes a close request to
//! the host's standard input, the host asks the page, and the host prints an
//! approval line when the window may close. On macOS a quit from the system
//! itself (the Dock, a logout, an Apple Event) is turned into such an exit
//! request first; see `quit.rs`.
//!
//! A host that has stopped approves nothing: the page still holds its unsaved
//! work. The shell then keeps the window, raises an event in the page, and
//! exits only when the page navigates to the quit address, which the shell
//! refuses to load and reads as the person's choice to quit. The one exit
//! without any answer is when no app page was ever opened.
//!
//! On exit the folder's owner refuses new work, lets the saves and commits it
//! had admitted finish, and releases the folder. It commits nothing of its own.
//!
//! A debug shell tells the host it may use fixture audio and failure
//! injection. A release shell never does, whatever the environment says.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::CapabilityBuilder;
use tauri::{
    App, AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

#[cfg(target_os = "macos")]
mod quit;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// What the shell writes to the host's standard input to ask whether it may close.
const CLOSE_REQUEST: &str = "{\"type\":\"close-requested\"}";
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "quit";

/// The one window. The folder is registered for this label and no other.
const MAIN_WINDOW: &str = "main";
/// The folder's ID, which is all the page names. Also its default directory name.
const FOLDER_SCOPE: &str = "so.epicenter.whispering";
const FOLDER_CAPABILITY: &str = "whispering-main-folder";

/// The running host. Its standard input is held open for as long as the shell
/// lives; the host stops when that pipe closes.
struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
}

/// Raised in the page when a close was attempted and the host could not be
/// asked. The page keeps the window and explains (`src/lib/workspace/desktop.ts`).
const CLOSE_BLOCKED_SCRIPT: &str = "window.dispatchEvent(new Event('whispering:close-blocked'));";
/// The address the page navigates to, once the host is gone, to say "quit".
/// The shell never loads it.
const QUIT_PATH: &str = "/__whispering__/quit";

#[derive(Default)]
struct HostState {
    process: Mutex<Option<HostProcess>>,
    /// Set only by an explicit answer: the page's approval relayed by the host,
    /// the page's own quit signal once the host is gone, or a close before any
    /// page was opened. A host that stopped is never an approval.
    close_approved: AtomicBool,
    /// The host's output ended or it no longer accepts a request.
    host_gone: AtomicBool,
    /// The app page was opened, so unsaved work may exist in it.
    page_opened: AtomicBool,
}

/// The app's embedded configuration and permissions. One expansion, shared by
/// the shell and by the tests that drive it on the mock runtime.
fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    build(None)
        .expect("failed to build Whispering")
        .run(|app, event| {
            on_run_event(app, &event);
        });
}

/// The app, built and not yet running. Its setup (the quit guard first, then
/// the menu, the folder and its owner, the host, and the window) runs once
/// `App::run` starts the event loop, before Tauri sends `RunEvent::Ready`.
///
/// `page` is what the host serves as the page. `run` passes `None`, so the
/// host serves the page it is built with. `examples/quit` passes its fixture
/// page and changes nothing else.
pub fn build(page: Option<PathBuf>) -> tauri::Result<App> {
    tauri::Builder::default()
        // Shuts the folder down when the app exits; see the module comment.
        .plugin(tauri_plugin_epicenter_folder::init())
        .manage(HostState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !close_is_approved(app) {
                    api.prevent_close();
                    request_close(app);
                }
            }
        })
        .setup(move |app| {
            // First, before anything a quit could lose exists.
            #[cfg(target_os = "macos")]
            quit::install(app.handle())?;
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            match start(app, page.as_deref()) {
                Ok(started) => open_app_window(app, started.port, &started.token)?,
                Err(error) => {
                    eprintln!("[whispering] could not start: {error}");
                    open_failure_window(app, &error)?;
                }
            }
            Ok(())
        })
        .build(context())
}

/// The app's handling of its run events. Returns whether it held back an exit
/// request; `examples/quit` reports that.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) -> bool {
    match event {
        // Every `AppHandle::exit` arrives here, approved or not. On macOS a
        // quit from the system does too, through `quit.rs`.
        RunEvent::ExitRequested { api, .. } => {
            if close_is_approved(app) {
                return false;
            }
            api.prevent_exit();
            request_close(app);
            true
        }
        RunEvent::Exit => {
            stop_host(app);
            false
        }
        _ => false,
    }
}

/// Everything the page depends on, settled before the page exists: where the
/// folder is, the host that serves the page, the folder registered for the
/// main window, and that window's page allowed to call the owner.
///
/// When any of it fails the host is stopped and no window is granted anything.
/// The window that opens then is the failure page, which can reach no folder.
fn start(app: &App, page: Option<&Path>) -> Result<StartedHost, String> {
    let root = data_root(app)?;
    let started = start_host(app, &root, page)?;
    let granted = register_folder(app.handle(), root).and_then(|()| {
        app.add_capability(folder_capability(started.port))
            .map_err(|error| format!("let the window use the folder: {error}"))
    });
    if let Err(error) = granted {
        stop_host(app.handle());
        return Err(error);
    }
    Ok(started)
}

/// The data folder, chosen here and nowhere else: `WHISPERING_DATA_ROOT` when
/// it is set, otherwise `~/Epicenter/local/so.epicenter.whispering`. It is
/// created when absent and resolved once; the owner and the host are both
/// given the resolved path.
fn data_root(app: &App) -> Result<PathBuf, String> {
    let configured = std::env::var("WHISPERING_DATA_ROOT").ok();
    let selected = match configured_root(configured.as_deref()) {
        Some(path) => path,
        None => default_root(
            &app.path()
                .home_dir()
                .map_err(|error| format!("find the home directory: {error}"))?,
        ),
    };
    resolve_root(&selected)
}

/// The directory `WHISPERING_DATA_ROOT` names, or none when it is unset or blank.
fn configured_root(value: Option<&str>) -> Option<PathBuf> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn default_root(home: &Path) -> PathBuf {
    home.join("Epicenter").join("local").join(FOLDER_SCOPE)
}

/// Create the directory when absent and resolve it to the one spelling every
/// part of the app uses.
fn resolve_root(selected: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(selected)
        .map_err(|error| format!("create the data folder at {}: {error}", selected.display()))?;
    let root = fs::canonicalize(selected)
        .map_err(|error| format!("resolve the data folder at {}: {error}", selected.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "the data folder at {} is not a directory",
            root.display()
        ));
    }
    // The owner reports the path to the page as text, and the host is handed
    // it as text. A path that is not text could not be compared between them.
    if root.to_str().is_none() {
        return Err(format!(
            "the data folder at {} has a name that is not valid Unicode",
            root.display()
        ));
    }
    Ok(root)
}

/// Register the folder for the main window, and for that window only.
///
/// History is local and recorded as the app: the repository's own `user.name`
/// and `origin` are not read, so a save never pushes anywhere.
fn register_folder<R: Runtime>(app: &AppHandle<R>, root: PathBuf) -> Result<(), String> {
    app.folders().register(ScopeConfig {
        scope: FOLDER_SCOPE.to_string(),
        folder: FolderConfig::new(
            root,
            Author {
                name: "Whispering".to_string(),
                email: "whispering@localhost".to_string(),
            },
        ),
        windows: vec![MAIN_WINDOW.to_string()],
    })
}

/// What lets the page call the folder's owner: the main window, while it shows
/// a page of the host on this launch's port, and nothing else. The page is
/// served from loopback, which Tauri treats as a remote origin, so it has no
/// command at all without this. A page from any other origin or port, a local
/// page such as the failure page, and any other window are not covered.
///
/// The permissions are the owner's commands and listening for its events.
fn folder_capability(port: u16) -> CapabilityBuilder {
    CapabilityBuilder::new(FOLDER_CAPABILITY)
        .local(false)
        .remote(format!("http://127.0.0.1:{port}/*"))
        .window(MAIN_WINDOW)
        .permission("epicenter-folder:default")
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten")
}

/// The default macOS menu's Quit item can end the process without asking. This
/// menu's Quit goes through the same close request as the window, and keeps
/// the Edit and Window items a text field and a window need.
#[cfg(target_os = "macos")]
fn install_menu(app: &App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "Quit Whispering")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Whispering").item(&quit).build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == QUIT_MENU_ID {
            request_close(app);
        }
    });
    Ok(())
}

fn close_is_approved(app: &AppHandle) -> bool {
    app.state::<HostState>()
        .close_approved
        .load(Ordering::SeqCst)
}

/// What a close request does when the host cannot relay it.
#[derive(Debug, PartialEq, Eq)]
enum WithoutHost {
    /// No app page was ever opened, so nothing unsaved exists anywhere.
    Exit,
    /// A page is open and may hold unsaved work: keep the window and tell it.
    KeepWindowAndTellPage,
}

fn without_host(page_opened: bool) -> WithoutHost {
    if page_opened {
        WithoutHost::KeepWindowAndTellPage
    } else {
        WithoutHost::Exit
    }
}

/// Ask the page, through the host, whether the shell may close.
///
/// A host that is gone approves nothing. The page still holds whatever was not
/// saved, so the window stays and the page is told a close was attempted; it
/// shows its own confirmation and answers with the quit address. Only when no
/// page was ever opened (the host never started) does the shell exit directly.
fn request_close(app: &AppHandle) {
    let state = app.state::<HostState>();
    if state.close_approved.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    let asked = !state.host_gone.load(Ordering::SeqCst) && {
        let mut process = state.process.lock().expect("host state lock poisoned");
        match process.as_mut().and_then(|host| host.stdin.as_mut()) {
            Some(stdin) => writeln!(stdin, "{CLOSE_REQUEST}")
                .and_then(|()| stdin.flush())
                .is_ok(),
            None => false,
        }
    };
    if asked {
        return;
    }
    state.host_gone.store(true, Ordering::SeqCst);
    match without_host(state.page_opened.load(Ordering::SeqCst)) {
        WithoutHost::Exit => {
            state.close_approved.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        WithoutHost::KeepWindowAndTellPage => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                if let Err(error) = window.eval(CLOSE_BLOCKED_SCRIPT) {
                    eprintln!("[whispering] could not tell the page a close was blocked: {error}");
                }
            }
        }
    }
}

/// Whether the page is saying "quit" by navigating to the quit address.
fn is_quit_signal(url: &tauri::Url, port: u16) -> bool {
    is_host_url(url, port) && url.path() == QUIT_PATH
}

/// Whether a line the host printed is its approval to close.
fn is_close_approval(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()
        .and_then(|value| {
            value
                .get("closeApproved")
                .and_then(serde_json::Value::as_bool)
        })
        == Some(true)
}

struct StartedHost {
    port: u16,
    token: String,
}

/// Start the host with the folder the shell chose. The host is given that
/// directory and reports only its port: where the folder is was never its to
/// decide, so nothing it prints is read as a path.
fn start_host(app: &App, root: &Path, page: Option<&Path>) -> Result<StartedHost, String> {
    let token = launch_token()?;
    let mut command = host_command(app)?;
    if let Some(page) = page {
        command.env("WHISPERING_UI_DIST", page);
    }
    command
        .env("WHISPERING_DATA_ROOT", root)
        .env("WHISPERING_HOST_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if cfg!(debug_assertions) {
        command.env("WHISPERING_DEBUG", "1");
    } else {
        // A release shell never enables fixture audio or failure injection.
        command
            .env_remove("WHISPERING_DEBUG")
            .env_remove("WHISPERING_DEBUG_FAIL_ROW_WRITES")
            .env_remove("WHISPERING_DEBUG_FAIL_AUDIO_WRITES")
            .env_remove("WHISPERING_DEBUG_BLOCK_COMMITS");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("start the Whispering host: {error}"))?;
    let stdin = child.stdin.take();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the Whispering host has no standard output".into());
        }
    };

    // The host prints one JSON line when it is listening. After that the only
    // line that means anything is its approval to close; the rest is drained
    // so the host can never block on a full pipe.
    let handle = app.handle().clone();
    let (sender, receiver) = mpsc::sync_channel::<Result<String, String>>(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let first = match reader.read_line(&mut line) {
            Ok(0) => Err("the Whispering host exited before it was ready".to_string()),
            Ok(_) => Ok(line.clone()),
            Err(error) => Err(format!("read the Whispering host's ready line: {error}")),
        };
        let _ = sender.send(first);
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    // The host is gone. That approves nothing: the page may
                    // still hold unsaved work.
                    handle
                        .state::<HostState>()
                        .host_gone
                        .store(true, Ordering::SeqCst);
                    break;
                }
                Ok(_) if is_close_approval(&line) => {
                    handle
                        .state::<HostState>()
                        .close_approved
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                Ok(_) => {}
            }
        }
    });

    let ready = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(line)) => parse_ready(&line),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the Whispering host did not become ready within 20 seconds".to_string()),
    };
    let port = match ready {
        Ok(port) => port,
        Err(error) => {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    let state = app.state::<HostState>();
    *state.process.lock().expect("host state lock poisoned") = Some(HostProcess { child, stdin });
    Ok(StartedHost { port, token })
}

/// The port from the host's `{"ready":true,"port":N}` line. Anything else on
/// the line is ignored.
fn parse_ready(line: &str) -> Result<u16, String> {
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("the Whispering host's ready line is not JSON: {error}"))?;
    if value.get("ready").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("the Whispering host's first line is not a ready line".into());
    }
    value
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "the Whispering host reported no port".to_string())
}

fn launch_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("generate the per-launch credential: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A debug shell runs the host from source with Bun and serves this app's
/// `build/` directory. `WHISPERING_BUN` names the Bun executable when it is
/// not on `PATH`.
#[cfg(debug_assertions)]
fn host_command(_app: &App) -> Result<Command, String> {
    let app_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "the src-tauri directory has no parent".to_string())?;
    let bun = std::env::var("WHISPERING_BUN").unwrap_or_else(|_| "bun".to_string());
    let mut command = Command::new(bun);
    command
        .current_dir(&app_dir)
        .arg(app_dir.join("native").join("main.ts"))
        .env("WHISPERING_UI_DIST", app_dir.join("build"));
    Ok(command)
}

/// A release shell runs the compiled host bundled beside its own executable
/// and serves the page bundled as a resource.
#[cfg(not(debug_assertions))]
fn host_command(app: &App) -> Result<Command, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve the Whispering executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "the Whispering executable has no parent directory".to_string())?;
    let filename = if cfg!(windows) {
        "whispering-host.exe"
    } else {
        "whispering-host"
    };
    let ui = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve the bundled page: {error}"))?
        .join("ui");
    let mut command = Command::new(directory.join(filename));
    command.env("WHISPERING_UI_DIST", ui);
    Ok(command)
}

fn is_host_url(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

/// Open the app page. `start` has already registered the folder and granted
/// this window's page the owner's commands, so the page can attach as soon as
/// it runs.
fn open_app_window(app: &App, port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
    let origin = format!("http://127.0.0.1:{port}");
    let url: tauri::Url = format!("{origin}/").parse()?;
    // Only the host's own page receives the token.
    let script = format!(
        "(() => {{ if (window.location.origin !== {origin}) return; \
         Object.defineProperty(window, '__WHISPERING_BRIDGE__', {{ value: Object.freeze({{ token: {token} }}), enumerable: false }}); }})();",
        origin = serde_json::to_string(&origin)?,
        token = serde_json::to_string(token)?,
    );
    let handle = app.handle().clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
        .title("Whispering")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(script)
        .on_navigation(move |url| {
            if is_quit_signal(url, port) {
                // Honored only once the host is gone; while it lives, the page
                // answers through it. The address is never loaded either way.
                let state = handle.state::<HostState>();
                if state.host_gone.load(Ordering::SeqCst) {
                    state.close_approved.store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
                return false;
            }
            is_host_url(url, port)
        })
        .build()?;
    app.state::<HostState>()
        .page_opened
        .store(true, Ordering::SeqCst);
    Ok(())
}

/// Shown when the app could not start, so the reason is on screen and not only
/// in a log. It is a local page and nothing was granted when this opens, so it
/// can call no command and reach no folder.
fn open_failure_window(app: &App, error: &str) -> Result<(), Box<dyn std::error::Error>> {
    let script = format!(
        "window.addEventListener('DOMContentLoaded', () => {{ \
         const target = document.getElementById('reason'); \
         if (target) target.textContent = {reason}; }});",
        reason = serde_json::to_string(error)?,
    );
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Whispering")
        .inner_size(720.0, 420.0)
        .initialization_script(script)
        .build()?;
    Ok(())
}

/// Close the host's standard input, which asks it to exit, then make sure it
/// is gone. The folder is not the host's: its owner settles its own saves and
/// commits when the app exits.
fn stop_host(app: &AppHandle) {
    let state = app.state::<HostState>();
    let Some(mut process) = state
        .process
        .lock()
        .expect("host state lock poisoned")
        .take()
    else {
        return;
    };
    drop(process.stdin.take());
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => break,
        }
    }
    let _ = process.child.kill();
    let _ = process.child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody, RuntimeCapability};
    use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::capability::CapabilityFile;
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindow;

    #[test]
    fn ready_line_yields_its_port() {
        assert_eq!(parse_ready("{\"ready\":true,\"port\":49321}\n"), Ok(49321));
    }

    #[test]
    fn a_path_on_the_ready_line_is_not_read() {
        // The host is told where the folder is. Whatever it prints about one
        // changes nothing: only the port is taken from the line.
        assert_eq!(
            parse_ready("{\"ready\":true,\"port\":49321,\"root\":\"/somewhere/else\"}\n"),
            Ok(49321)
        );
    }

    #[test]
    fn anything_else_is_not_ready() {
        assert!(parse_ready("starting").is_err());
        assert!(parse_ready("{\"ready\":false,\"port\":1}").is_err());
        assert!(parse_ready("{\"ready\":true,\"port\":0}").is_err());
        assert!(parse_ready("{\"ready\":true,\"port\":70000}").is_err());
    }

    #[test]
    fn only_an_explicit_approval_line_closes() {
        assert!(is_close_approval("{\"closeApproved\":true}\n"));
        assert!(!is_close_approval("{\"closeApproved\":false}"));
        assert!(!is_close_approval("{\"ready\":true,\"port\":4000}"));
        assert!(!is_close_approval("closeApproved"));
        assert!(!is_close_approval(""));
    }

    #[test]
    fn a_missing_host_exits_only_before_any_page_was_opened() {
        assert_eq!(without_host(false), WithoutHost::Exit);
        assert_eq!(without_host(true), WithoutHost::KeepWindowAndTellPage);
    }

    #[test]
    fn only_the_quit_address_on_the_host_origin_is_a_quit_signal() {
        let quit: tauri::Url = "http://127.0.0.1:4000/__whispering__/quit".parse().unwrap();
        let page: tauri::Url = "http://127.0.0.1:4000/".parse().unwrap();
        let elsewhere: tauri::Url = "https://example.com/__whispering__/quit".parse().unwrap();
        assert!(is_quit_signal(&quit, 4000));
        assert!(!is_quit_signal(&quit, 4001));
        assert!(!is_quit_signal(&page, 4000));
        assert!(!is_quit_signal(&elsewhere, 4000));
    }

    #[test]
    fn the_close_request_is_one_json_line() {
        let value: serde_json::Value = serde_json::from_str(CLOSE_REQUEST).unwrap();
        assert_eq!(value["type"], "close-requested");
        assert!(!CLOSE_REQUEST.contains('\n'));
    }

    #[test]
    fn only_the_host_origin_is_navigable() {
        let allowed: tauri::Url = "http://127.0.0.1:4000/recordings".parse().unwrap();
        let other_port: tauri::Url = "http://127.0.0.1:4001/".parse().unwrap();
        let other_host: tauri::Url = "https://example.com/".parse().unwrap();
        assert!(is_host_url(&allowed, 4000));
        assert!(!is_host_url(&other_port, 4000));
        assert!(!is_host_url(&other_host, 4000));
    }

    #[test]
    fn launch_tokens_are_long_and_distinct() {
        let first = launch_token().unwrap();
        let second = launch_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn the_folder_is_the_configured_directory_or_the_default_under_home() {
        assert_eq!(
            configured_root(Some("/tmp/whispering-demo")),
            Some(PathBuf::from("/tmp/whispering-demo"))
        );
        assert_eq!(
            configured_root(Some("  /tmp/whispering-demo\n")),
            Some(PathBuf::from("/tmp/whispering-demo"))
        );
        // Unset and blank both mean the default.
        assert_eq!(configured_root(None), None);
        assert_eq!(configured_root(Some("")), None);
        assert_eq!(configured_root(Some("   ")), None);
        assert_eq!(
            default_root(Path::new("/Users/someone")),
            PathBuf::from("/Users/someone/Epicenter/local/so.epicenter.whispering")
        );
    }

    /// A directory under the system's temporary directory, removed on drop.
    struct TempDirectory(PathBuf);

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp(label: &str) -> TempDirectory {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "whispering-shell-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDirectory(fs::canonicalize(path).unwrap())
    }

    #[test]
    fn the_folder_is_created_when_absent_and_resolved_to_one_spelling() {
        let directory = temp("root");
        let selected = directory.0.join("nested").join("data");

        let root = resolve_root(&selected).unwrap();

        assert!(root.is_dir());
        assert_eq!(root, fs::canonicalize(&selected).unwrap());
        // Resolving the resolved path changes nothing: it is given as it is to
        // the owner and to the host.
        assert_eq!(resolve_root(&root).unwrap(), root);
        // Another spelling of the same directory resolves to the same path.
        assert_eq!(
            resolve_root(&selected.join("..").join("data")).unwrap(),
            root
        );
        #[cfg(unix)]
        {
            let alias = directory.0.join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert_eq!(resolve_root(&alias).unwrap(), root);
        }
    }

    #[test]
    fn a_folder_that_cannot_be_a_directory_is_refused() {
        let directory = temp("not-a-directory");
        let file = directory.0.join("file");
        fs::write(&file, "not a directory").unwrap();

        assert!(resolve_root(&file).is_err());
        assert!(resolve_root(&file.join("inside")).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "not a directory");
    }

    #[test]
    fn the_capability_names_one_window_one_origin_and_the_folder_commands() {
        let CapabilityFile::Capability(capability) = folder_capability(49321).build() else {
            panic!("the folder capability is a single capability");
        };

        assert_eq!(capability.identifier, FOLDER_CAPABILITY);
        // Not for local pages: the failure page is one.
        assert!(!capability.local);
        assert_eq!(
            capability.remote.map(|remote| remote.urls),
            Some(vec!["http://127.0.0.1:49321/*".to_string()])
        );
        assert_eq!(capability.windows, vec![MAIN_WINDOW.to_string()]);
        assert!(capability.webviews.is_empty());
        assert!(capability.platforms.is_none());
        let permissions: Vec<&str> = capability
            .permissions
            .iter()
            .map(|permission| permission.identifier().get())
            .collect();
        assert_eq!(
            permissions,
            vec![
                "epicenter-folder:default",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
            ]
        );
    }

    /// One `attach` through the real invoke handler, as a page at `url` would
    /// send it.
    fn attach(window: &WebviewWindow<MockRuntime>, url: &str, scope: &str) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: "plugin:epicenter-folder|attach".to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::Json(json!({
                    "scope": scope,
                    "protocol": tauri_plugin_epicenter_folder::PROTOCOL,
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
    }

    /// The shell's own registration and capability, against the app's real
    /// permissions, on the mock runtime. The folder is a real directory and a
    /// real repository.
    #[test]
    fn only_the_main_window_on_the_host_origin_reaches_the_folder() {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        let directory = temp("capability");
        let root = resolve_root(&directory.0.join("data")).unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .build(context::<MockRuntime>())
            .expect("mock app");
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
            .build()
            .expect("main window");
        let other = WebviewWindowBuilder::new(&app, "other", Default::default())
            .build()
            .expect("other window");
        let host = "http://127.0.0.1:4000/";

        // Before the shell registers or grants anything, nothing is reachable.
        assert!(attach(&main, host, FOLDER_SCOPE).is_err());

        register_folder(app.handle(), root.clone()).unwrap();
        // Registered, and still not callable: the window has no capability.
        assert!(attach(&main, host, FOLDER_SCOPE).is_err());

        app.add_capability(folder_capability(4000)).unwrap();

        // Another port, another host, and a local page are not the host's page.
        assert!(attach(&main, "http://127.0.0.1:4001/", FOLDER_SCOPE).is_err());
        assert!(attach(&main, "http://localhost:4000/", FOLDER_SCOPE).is_err());
        assert!(attach(&main, "https://example.com/", FOLDER_SCOPE).is_err());
        assert!(attach(&main, "tauri://localhost", FOLDER_SCOPE).is_err());
        // Another window is not covered, even on the host's origin.
        assert!(attach(&other, host, FOLDER_SCOPE).is_err());
        // None of those opened the folder.
        assert!(!root.join(".git").exists());

        // The main window, on the host's origin, names the folder and gets the
        // directory the shell chose. It supplied no path.
        let attached = attach(&main, host, FOLDER_SCOPE).expect("the main window attaches");
        assert_eq!(attached["root"], root.to_str().unwrap());
        assert_eq!(attached["snapshot"]["branch"], "main");
        // Local history only: no remote, so nothing is ever pushed.
        assert_eq!(attached["snapshot"]["remote"], Value::Null);
        assert!(root.join(".git").exists());

        // The page names only what the shell registered.
        let unknown = attach(&main, host, "so.epicenter.todos").unwrap_err();
        assert_eq!(unknown["name"], "UnknownScope");

        // Were another window ever granted the commands, the folder would
        // still refuse it: the registration names the main window alone.
        app.add_capability(
            CapabilityBuilder::new("test-other-window")
                .local(false)
                .remote(host.to_string())
                .window("other")
                .permission("epicenter-folder:default"),
        )
        .unwrap();
        let refused = attach(&other, host, FOLDER_SCOPE).unwrap_err();
        assert_eq!(refused["name"], "WindowNotPermitted");

        // The folder cannot be registered a second time, for any window.
        assert!(register_folder(app.handle(), root.clone()).is_err());

        app.folders().shutdown();
    }
}
