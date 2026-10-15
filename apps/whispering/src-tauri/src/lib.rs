//! The Whispering desktop shell.
//!
//! The shell owns a window, the data folder, and one child process.
//!
//! The shell chooses the folder's directory once and registers it with
//! `tauri-plugin-epicenter-folder` for the main window alone, as a folder the
//! page opens with its own engine. When the page names the folder, the plugin
//! locks it and grants that window its directory: the page makes every read
//! and change and runs every `git` command through the folder plugin, which
//! checks each path. The page names the folder and
//! never a path. It records with `tauri-plugin-epicenter-recorder`, which
//! writes each recording's WAV into that folder from the moment it starts and
//! finalizes it when the page reloads or the window closes. This crate
//! registers no command of its own.
//!
//! The child is the Bun host (`native/main.ts`): it serves the page on loopback
//! and does what a page cannot, such as running the terminal and sending
//! transcription requests. The shell starts it with the directory it chose,
//! waits for the port it reports, loads the page from it, and stops it on
//! exit. The host is told where the folder is; it is never asked.
//!
//! Closing the window or quitting is immediate, with Tauri's ordinary
//! behavior: nothing is asked and nothing is waited for. Unfinished work
//! already lives in the folder (ADR-0542): a recording is written as it is
//! captured, and a run's result row is written when the run starts. On exit
//! the shell stops the host, and the folder plugin releases the folder's lock.
//! It saves and commits nothing of its own.
//!
//! A debug shell tells the host it may use fixture audio and failure
//! injection. A release shell never does, whatever the environment says.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::CapabilityBuilder;
use tauri::{App, AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

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

#[derive(Default)]
struct HostState {
    process: Mutex<Option<HostProcess>>,
}

/// The app's embedded configuration and permissions. One expansion, shared by
/// the shell and by the tests that drive it on the mock runtime.
fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    tauri::Builder::default()
        // Releases the folder when the app exits; see the module comment.
        .plugin(tauri_plugin_epicenter_folder::init())
        // Finalizes a recording whose page reloads or whose window closes.
        .plugin(tauri_plugin_epicenter_recorder::init())
        .manage(HostState::default())
        .setup(|app| {
            match start(app) {
                Ok(started) => open_app_window(app, started.port, &started.token)?,
                Err(error) => {
                    eprintln!("[whispering] could not start: {error}");
                    open_failure_window(app, &error)?;
                }
            }
            Ok(())
        })
        .build(context())
        .expect("failed to build Whispering")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_host(app);
            }
        });
}

/// Everything the page depends on, settled before the page exists: where the
/// folder is, the host that serves the page, the folder registered for the
/// main window, and that window's page allowed to ask for it.
///
/// When any of it fails the host is stopped and no window is granted anything.
/// The window that opens then is the failure page, which can reach no folder.
fn start(app: &App) -> Result<StartedHost, String> {
    let root = data_root(app)?;
    let started = start_host(app, &root)?;
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
/// created when absent and resolved once; the folder plugin and the host are
/// both given the resolved path.
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
    // The folder plugin reports the path to the page as text, and the host is
    // handed it as text. A path that is not text could not be compared between
    // them.
    if root.to_str().is_none() {
        return Err(format!(
            "the data folder at {} has a name that is not valid Unicode",
            root.display()
        ));
    }
    Ok(root)
}

/// Register the folder for the main window, and for that window only, as a
/// folder the page opens with its own engine.
///
/// A version is recorded as the person Git's configuration names (the
/// repository's `user.name` and `user.email`, global settings included), and
/// as Whispering only where none is set. The page reads that, and the remote,
/// from the repository; nothing is pushed unless the person syncs.
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

/// What lets the page ask for its folder: the main window, while it shows a
/// page of the host on this launch's port, and nothing else. The page is
/// served from loopback, which Tauri treats as a remote origin, so it has no
/// command at all without this. A page from any other origin or port, a local
/// page such as the failure page, and any other window are not covered.
///
/// The permissions are the folder plugin's commands, through which the page
/// reads and changes its folder and runs its Git, and the recorder plugin's,
/// through which it records into that folder. Both reach only the directory
/// `grant_directory` names.
fn folder_capability(port: u16) -> CapabilityBuilder {
    CapabilityBuilder::new(FOLDER_CAPABILITY)
        .local(false)
        .remote(format!("http://127.0.0.1:{port}/*"))
        .window(MAIN_WINDOW)
        .permission("epicenter-folder:default")
        .permission("epicenter-recorder:default")
}

struct StartedHost {
    port: u16,
    token: String,
}

/// Start the host with the folder the shell chose. The host is given that
/// directory and reports only its port: where the folder is was never its to
/// decide, so nothing it prints is read as a path.
fn start_host(app: &App, root: &Path) -> Result<StartedHost, String> {
    let token = launch_token()?;
    let mut command = host_command(app)?;
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

    // The host prints one JSON line when it is listening. Everything after it
    // is drained so the host can never block on a full pipe.
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
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
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

/// Open the app page. `start` has already registered the folder and let this
/// window's page ask for it, so the page can open it as soon as it runs.
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
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
        .title("Whispering")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(script)
        .on_navigation(move |url| is_host_url(url, port))
        .build()?;
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
/// is gone. The folder is not the host's: the folder plugin releases it when
/// the app exits.
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
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::{CallbackFn, InvokeBody, RuntimeCapability};
    use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::capability::{CapabilityFile, PermissionEntry};
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
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
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
        // the folder plugin and to the host.
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
    fn the_capability_names_one_window_one_origin_and_the_folder_and_recorder_commands() {
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
            vec!["epicenter-folder:default", "epicenter-recorder:default"]
        );
        // No permission names a scope of its own.
        assert!(capability
            .permissions
            .iter()
            .all(|permission| matches!(permission, PermissionEntry::PermissionRef(_))));
    }

    /// No fs plugin is installed or configured: the folder plugin reads.
    #[test]
    fn no_fs_plugin_is_configured() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config.get("plugins").is_none());
    }

    /// One command through the real invoke handler, as a page at `url` would
    /// send it.
    fn invoke(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        cmd: &str,
        body: Value,
    ) -> Result<Value, Value> {
        request(window, url, cmd, InvokeBody::Json(body), Default::default())
    }

    fn request(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        cmd: &str,
        body: InvokeBody,
        headers: HeaderMap,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: cmd.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("a JSON response"))
    }

    /// `write_folder_file` as the page's engine sends it: the bytes as the
    /// raw body, the rest in percent-encoded headers. These values are plain
    /// ASCII with no `%`, so each encodes as itself.
    fn write_file(
        window: &WebviewWindow<MockRuntime>,
        url: &str,
        path: &Path,
        bytes: &[u8],
    ) -> Result<Value, Value> {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("scope", FOLDER_SCOPE),
            ("path", path.to_str().unwrap()),
            ("create-new", "true"),
        ] {
            headers.insert(name, HeaderValue::from_str(value).unwrap());
        }
        request(
            window,
            url,
            "plugin:epicenter-folder|write_folder_file",
            InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
    }

    /// The page's first call: ask for the folder's directory.
    fn grant(window: &WebviewWindow<MockRuntime>, url: &str, scope: &str) -> Result<Value, Value> {
        invoke(
            window,
            url,
            "plugin:epicenter-folder|grant_directory",
            json!({ "scope": scope }),
        )
    }

    /// The shell's own registration and capability, against the app's real
    /// permissions, on the mock runtime. The folder is a real directory.
    #[test]
    fn only_the_main_window_on_the_host_origin_is_granted_the_folder() {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        let directory = temp("capability");
        let root = resolve_root(&directory.0.join("data")).unwrap();
        let app = mock_builder()
            .plugin(tauri_plugin_epicenter_folder::init())
            .plugin(tauri_plugin_epicenter_recorder::init())
            .build(context::<MockRuntime>())
            .expect("mock app");
        let host = "http://127.0.0.1:4000/";
        // Both windows show the host's page, as the app's window does.
        let page = || WebviewUrl::External(host.parse().unwrap());
        let main = WebviewWindowBuilder::new(&app, MAIN_WINDOW, page())
            .build()
            .expect("main window");
        let other = WebviewWindowBuilder::new(&app, "other", page())
            .build()
            .expect("other window");

        // Before the shell registers or grants anything, nothing is reachable.
        assert!(grant(&main, host, FOLDER_SCOPE).is_err());

        register_folder(app.handle(), root.clone()).unwrap();
        // Registered, and still not callable: the window has no capability.
        assert!(grant(&main, host, FOLDER_SCOPE).is_err());

        app.add_capability(folder_capability(4000)).unwrap();

        // Another port, another host, and a local page are not the host's page.
        assert!(grant(&main, "http://127.0.0.1:4001/", FOLDER_SCOPE).is_err());
        assert!(grant(&main, "http://localhost:4000/", FOLDER_SCOPE).is_err());
        assert!(grant(&main, "https://example.com/", FOLDER_SCOPE).is_err());
        assert!(grant(&main, "tauri://localhost", FOLDER_SCOPE).is_err());
        // Another window is not covered, even on the host's origin.
        assert!(grant(&other, host, FOLDER_SCOPE).is_err());

        // Before a grant the read commands reach nothing, not even the folder.
        let read_dir = |window: &WebviewWindow<MockRuntime>, path: &Path| {
            invoke(
                window,
                host,
                "plugin:epicenter-folder|read_folder_directory",
                json!({ "scope": FOLDER_SCOPE, "path": path.to_str().unwrap() }),
            )
        };
        assert!(read_dir(&main, &root).is_err());

        // The main window, on the host's origin, names the folder and gets the
        // directory the shell chose. It supplied no path. The author is the
        // fallback for a repository and a machine with no Git identity.
        let granted = grant(&main, host, FOLDER_SCOPE).expect("the main window is granted");
        assert_eq!(granted["root"], root.to_str().unwrap());
        assert_eq!(granted["branch"], "main");
        assert_eq!(granted["authorName"], "Whispering");
        assert_eq!(granted["authorEmail"], "whispering@localhost");
        // The shell owns nothing more: the page's engine creates the
        // repository when it opens the folder.
        assert!(!root.join(".git").exists());

        // The grant reaches the folder's directory through the folder
        // plugin, and only that directory.
        read_dir(&main, &root).expect("granted read");
        assert!(read_dir(&main, &directory.0).is_err());
        // Changes go through the folder plugin, which keeps them inside it.
        // The engine makes the repository first, and stages under it.
        let initialized = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(&root)
            .status()
            .unwrap();
        assert!(initialized.success());
        invoke(
            &main,
            host,
            "plugin:epicenter-folder|make_folder_directory",
            json!({
                "scope": FOLDER_SCOPE,
                "path": root.join("recordings").to_str().unwrap(),
            }),
        )
        .expect("the page makes a data directory");
        // A data file is written as the engine writes one: a new staged
        // file, renamed over the path.
        let scratch = root.join(".git").join("epicenter").join("scratch");
        let staged = scratch.join("take");
        invoke(
            &main,
            host,
            "plugin:epicenter-folder|make_folder_directory",
            json!({ "scope": FOLDER_SCOPE, "path": scratch.to_str().unwrap() }),
        )
        .expect("the page makes its staging directory");
        write_file(&main, host, &staged, b"hi").expect("the page stages a data file");
        invoke(
            &main,
            host,
            "plugin:epicenter-folder|rename_folder_path",
            json!({
                "scope": FOLDER_SCOPE,
                "from": staged.to_str().unwrap(),
                "to": root.join("recordings").join("take.md").to_str().unwrap(),
                "expected": "absent",
            }),
        )
        .expect("the page renames it into place");
        assert_eq!(
            fs::read(root.join("recordings").join("take.md")).unwrap(),
            b"hi"
        );
        assert!(write_file(&main, host, &directory.0.join("outside.md"), b"hi").is_err());
        assert!(!directory.0.join("outside.md").exists());

        // The recorder reaches the granted folder too, and only for this window.
        let recover = |window: &WebviewWindow<MockRuntime>| {
            invoke(
                window,
                host,
                "plugin:epicenter-recorder|recover",
                json!({ "scope": FOLDER_SCOPE, "under": "recordings" }),
            )
        };
        assert_eq!(recover(&main).expect("the main window recovers"), json!([]));
        assert!(recover(&other).is_err());

        // The page names only what the shell registered.
        let unknown = grant(&main, host, "so.epicenter.todos").unwrap_err();
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
        let refused = grant(&other, host, FOLDER_SCOPE).unwrap_err();
        assert_eq!(refused["name"], "WindowNotPermitted");

        // The folder cannot be registered a second time, for any window.
        assert!(register_folder(app.handle(), root.clone()).is_err());

        app.folders().shutdown();
    }
}
