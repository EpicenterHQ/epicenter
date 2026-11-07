use anyhow::{bail, Context, Result};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// The command list, shared with `build.rs` through `include!`. Only the tests
/// read it from the crate, which is where the drift checks live.
#[cfg(test)]
mod command_names;

mod desktop_paths;
mod git;
use crate::desktop_paths::DesktopPaths;
mod login;
#[cfg(target_os = "macos")]
mod macos_menu;
mod scheme;

mod shell;
mod updates;

// Native dictation, which no page reaches yet: compiled, registered, and
// started only with the `dictation` feature (Cargo.toml).
#[cfg(feature = "dictation")]
mod delivery;

#[cfg(feature = "dictation")]
pub mod media;

#[cfg(all(desktop, feature = "dictation"))]
pub mod keyboard;

#[cfg(all(target_os = "macos", feature = "dictation"))]
pub mod overlay;

#[cfg(all(target_os = "macos", feature = "dictation"))]
pub mod clipboard;

const HOSTED_AUTH_ORIGIN: &str = "https://api.epicenter.so";

/// Who the Epicenter app signs in as: its own client, reaching every folder
/// the person holds (`folders:all`, ADR-0820), on the API and folders audiences.
/// Its shell keeps the refresh token in its credentials file and sends every
/// request a page makes on the account (`epicenter-account`) to those
/// audiences: it is the one desktop program that syncs (ADR-0822).
const ACCOUNT: epicenter_account::AccountApp = epicenter_account::AccountApp {
    client_id: "so.epicenter",
    name: "Epicenter",
    scope: epicenter_account::AccountApp::EVERY_FOLDER,
    audiences: epicenter_account::AccountApp::API_AND_FOLDERS,
    relays: epicenter_account::Relays::AnyRoute,
};

/// Epicenter's own windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuiltInApp {
    Home,
    Folders,
}

impl BuiltInApp {
    const ALL: [Self; 2] = [Self::Home, Self::Folders];

    const fn id(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Folders => "folders",
        }
    }

    const fn path(self) -> &'static str {
        match self {
            Self::Home => "/home/",
            Self::Folders => "/folders/",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Home => "Epicenter: Settings",
            Self::Folders => "Epicenter: Folders",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|built_in| built_in.id() == id)
    }
}

type DesktopAppHandle = AppHandle<Wry>;

/// The shell's commands, with any `extra` appended. `collect_commands!` takes
/// no `#[cfg]` on an entry, so a feature adds its commands through this.
macro_rules! shell_commands {
    ($($extra:tt)*) => {
        tauri_specta::collect_commands![
            open_home,
            login::start_at_login,
            login::set_start_at_login,
            git::choose_repository,
            git::git_run,
            git::git_scratch,
            git::git_scratch_remove,
            git::git_lfs_object,
            git::git_hand_over,
            $($extra)*
        ]
    };
}

/// The typed command contract every Epicenter window shares.
#[cfg(not(feature = "dictation"))]
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(shell_commands![])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

/// The shell's contract plus the native dictation commands and their event.
#[cfg(feature = "dictation")]
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(shell_commands![
            delivery::write_text,
            delivery::simulate_enter_keystroke,
            prewarm_model,
            media::pause_playback,
            media::resume_playback,
            keyboard::commands::set_auto_paste_enabled,
            keyboard::commands::get_dictation_capability,
        ])
        .events(tauri_specta::collect_events![
            keyboard::DictationCapabilityEvent
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::DataError)
}

#[cfg(test)]
mod export_bindings {
    use super::*;

    /// Every consumer of this crate's typed command API is generated from
    /// Rust, so none can drift from it.
    ///
    /// Epicenter's pages carry the whole API in one file. What a window may
    /// actually call is decided by its capability file, not by which bindings
    /// it can import: only `home.json` grants the local-model administration
    /// commands (ADR-0180), and a window whose file does not grant a command
    /// is denied it at the IPC boundary.
    const WHOLE_API: &[&str] = &["../src/ui/bindings.gen.ts"];

    /// The committed bindings are the default build's page API. A `dictation`
    /// build's commands are not part of it, so that build exports into a
    /// temporary directory, which only checks that its types export.
    #[test]
    fn export_types() {
        #[cfg(feature = "dictation")]
        let scratch = tempfile::tempdir().unwrap();
        let whole = WHOLE_API
            .iter()
            .map(|target| (*target, make_specta_builder()));
        for (target, builder) in whole {
            #[cfg(feature = "dictation")]
            let target = scratch.path().join(target.replace(['/', '.'], "_"));
            builder
                .export(specta_typescript::Typescript::default(), &target)
                .unwrap_or_else(|error| panic!("failed to export bindings to {target:?}: {error}"));
        }
        // The dictation build's API carries every command its feature adds,
        // so the list in `command_names.rs` cannot drift from the builder.
        #[cfg(feature = "dictation")]
        for target in WHOLE_API {
            let path = scratch.path().join(target.replace(['/', '.'], "_"));
            let exported = std::fs::read_to_string(&path).unwrap();
            for command in crate::command_names::DICTATION_COMMANDS {
                assert!(
                    exported.contains(&format!("\"{command}\"")),
                    "{command} is missing from the dictation build's {target}"
                );
            }
            assert!(exported.contains("\"dictation-capability-event\""));
        }
    }
}

/// Prewarm the active local model so a following transcribe finds it warm,
/// overlapping the ~1 s load with the person's speech. A no-op when it is
/// already resident; a failure here is not fatal, since transcribe loads
/// normally and reports any real error then.
#[cfg(feature = "dictation")]
#[tauri::command]
#[specta::specta]
async fn prewarm_model(
    app: DesktopAppHandle,
) -> Result<(), tauri_plugin_epicenter_transcription::TranscriptionError> {
    use tauri_plugin_epicenter_transcription::TranscriptionError;
    let failed = |message: String| TranscriptionError::TranscriptionError { message };
    let cache = tauri_plugin_epicenter_transcription::model_cache(&app).map_err(failed)?;
    tauri::async_runtime::spawn_blocking(move || cache.prewarm())
        .await
        .map_err(|error| failed(format!("Background transcription task failed: {error}")))?
}

/// Show Settings: the Folders window's Settings button (ADR-0537).
#[tauri::command]
#[specta::specta]
fn open_home(app: DesktopAppHandle) {
    request_window(&app, BuiltInApp::Home);
}

/// The account commands a window may call (`epicenter-account`), outside the
/// typed contract: the page's side is `createTauriAuth` from
/// `@epicenter/account/tauri`.
fn account_handler() -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        epicenter_account::account::account_sign_in,
        epicenter_account::account::account_sign_out,
        epicenter_account::account::account_fetch,
        epicenter_account::account::account_fetch_cancel,
    ]
}

pub fn run() {
    let specta_builder = make_specta_builder();
    let typed = tauri_specta::Builder::invoke_handler(&specta_builder);
    let account = account_handler();
    let invoke_handler = move |invoke: tauri::ipc::Invoke<Wry>| {
        if epicenter_account::COMMANDS.contains(&invoke.message.command()) {
            account(invoke)
        } else {
            typed(invoke)
        }
    };
    // The deployment this build names (`EPICENTER_SERVER_ORIGIN`, or a local
    // API in development); a build that names none cannot sign in.
    let origin = configured_auth_server()
        .map(|server| server.base_url)
        .unwrap_or_else(|error| {
            log::error!("{error:#}");
            HOSTED_AUTH_ORIGIN.to_string()
        });
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for(
            "tauri_plugin_epicenter_transcription",
            log::LevelFilter::Debug,
        )
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("epicenter".to_string()),
            },
        ))
        .build();

    let builder = tauri::Builder::default()
        // This must remain the first plugin: later plugins and setup must only run
        // in the process that owns the application instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_forwarded_deep_links(app, &args);
        }))
        .plugin(log_plugin)
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // Rust owns the folder picker and the update alerts; no page may open
        // the file picker.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Settings administers this app's local model through the plugin's
        // commands; no window is granted its file transcription.
        .plugin(tauri_plugin_epicenter_transcription::init())
        // The Epicenter folder, each folder in it a root, and the app's own
        // data (`account.json`, settings): named at setup.
        .plugin(tauri_plugin_epicenter_folder::init())
        // Starting at login, a setting on by default (`login.rs`). Rust alone
        // reaches it; no window is granted the plugin's commands.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg(login::AT_LOGIN)
                .build(),
        )
        .manage(updates::Updates::default());
    // The app's own sign-in, as `so.epicenter`; its credentials file and
    // `account.json` are placed in the app's data once it runs.
    let builder = epicenter_account::manage_at(builder, ACCOUNT, origin);

    // Only native dictation uses these plugins; no capability grants them.
    #[cfg(feature = "dictation")]
    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(all(target_os = "macos", feature = "dictation"))]
    let builder = builder.plugin(tauri_nspanel::init());

    let app = scheme::register(builder)
        .invoke_handler(invoke_handler)
        .setup(move |app| {
            specta_builder.mount_events(app);
            #[cfg(target_os = "macos")]
            macos_menu::install(app.handle()).context("install native app menu")?;

            let desktop_paths = DesktopPaths::resolve(app.handle()).map_err(anyhow::Error::msg)?;
            name_roots(app.handle(), &desktop_paths);
            login::start_by_default(app.handle(), &desktop_paths.app_data);
            // Every window's page comes from the scheme, which reads it.
            app.manage(scheme::Pages(
                scheme::pages_dir(app.handle()).context("locate packaged pages")?,
            ));
            app.manage(desktop_paths);

            #[cfg(all(desktop, feature = "dictation"))]
            app.manage(keyboard::TapController::new());

            shell::create_tray(app.handle()).context("create native application menu and tray")?;

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                open_deep_links(&handle, &event.urls());
            });

            let current = app
                .deep_link()
                .get_current()
                .context("read launch deep links")?;
            let mut opened_window = false;
            if let Some(urls) = current {
                for url in &urls {
                    if let Some(link) = parse_app_deep_link(url) {
                        follow_deep_link(app.handle(), link);
                        opened_window = true;
                    }
                }
            }
            // Epicenter opens to the person's folders (ADR-0537). Started at
            // login, the Folders window's page runs unseen, keeping every
            // folder in sync (ADR-0819), until the person shows it.
            if !opened_window {
                if login::launched_at_login() {
                    hidden_window(app.handle(), BuiltInApp::Folders);
                } else {
                    request_window(app.handle(), BuiltInApp::Folders);
                }
            }
            log::info!("Epicenter {} ready", app.package_info().version);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter");
    // Exits without C++ static finalizers on macOS, which can race Settings'
    // resident model (the transcription plugin's README). Quit and the
    // updater's `request_restart` end through it.
    tauri_plugin_epicenter_transcription::run(app, |app, event| match event {
        RunEvent::Reopen { .. } => request_window(app, BuiltInApp::Folders),
        _ => {}
    });
}

fn open_forwarded_deep_links(app: &DesktopAppHandle, arguments: &[String]) {
    let links = links_from_arguments(arguments);
    if links.is_empty() {
        request_window(app, BuiltInApp::Folders);
    } else {
        for link in links {
            follow_deep_link(app, link);
        }
    }
}

fn links_from_arguments(arguments: &[String]) -> Vec<DeepLink> {
    let mut links = Vec::new();
    for argument in arguments {
        let Ok(url) = tauri::Url::parse(argument) else {
            continue;
        };
        let Some(link) = parse_app_deep_link(&url) else {
            continue;
        };
        if !links.contains(&link) {
            links.push(link);
        }
    }
    links
}

fn open_deep_links(app: &DesktopAppHandle, urls: &[tauri::Url]) {
    for url in urls {
        if let Some(link) = parse_app_deep_link(url) {
            follow_deep_link(app, link);
        }
    }
}

/// What an `epicenter://` link asks for: a built-in window to show.
type DeepLink = BuiltInApp;

/// Show the window `link` names.
fn follow_deep_link(app: &DesktopAppHandle, link: DeepLink) {
    request_window(app, link);
}

/// Schedule a built-in window and show a native error if it cannot open.
/// Callers include native launch events and pages asking to open Settings.
fn request_window(app: &DesktopAppHandle, built_in: BuiltInApp) {
    let window_app = app.clone();
    let schedule = app.run_on_main_thread(move || {
        if let Err(error) = ensure_window(&window_app, built_in) {
            log::error!("open the {} window: {error:#}", built_in.id());
            let mut dialog = window_app
                .dialog()
                .message(format!("{error:#}"))
                .title(format!("{} could not open", built_in.title()))
                .kind(MessageDialogKind::Error);
            let windows = window_app.webview_windows();
            if let Some(parent) = windows
                .values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                dialog = dialog.parent(parent);
            }
            dialog.show(|_| {});
        }
    });
    if let Err(error) = schedule {
        log::error!("schedule the {} window: {error}", built_in.id());
    }
}

/// Resolve `epicenter://app/<id>` to the built-in app it names, and a bare
/// `epicenter://` to the Folders window, which is what opening Epicenter shows
/// (ADR-0537).
///
/// The segment is `app`: a person pasting a link names the thing they want,
/// not the frame it arrives in.
fn parse_app_deep_link(url: &tauri::Url) -> Option<BuiltInApp> {
    if url.scheme() != "epicenter"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    if url.host_str().unwrap_or_default().is_empty() && matches!(url.path(), "" | "/") {
        return Some(BuiltInApp::Folders);
    }
    if url.host_str() != Some("app") {
        return None;
    }

    let id = url.path().strip_prefix('/')?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    BuiltInApp::from_id(id)
}

/// The deployment this build signs in to and sends to, and whether it has
/// the hosted account website.
struct AuthConfiguration {
    base_url: String,
    account_management: bool,
}

/// Name the folder plugin's roots: the app's own data (`AppData`, where the
/// sign-in writes `account.json` and pages keep this computer's settings) and
/// the Epicenter folder, whose every directory is a folder root
/// (`Root::Folder`). No folder may be the home folder, hold it, or overlap
/// the app's data.
fn name_roots(app: &DesktopAppHandle, paths: &DesktopPaths) {
    use tauri_plugin_epicenter_folder::{Root, RootsExt};
    let roots = app.roots();
    roots.name(Root::AppData, paths.app_data.clone(), |_| None);
    let refusing = paths.clone();
    roots.name_epicenter(paths.epicenter.clone(), move |location| {
        refusing.folder_refusal(location)
    });
}

/// The deployment this build signs in to (ADR-0326).
fn configured_auth_server() -> Result<AuthConfiguration> {
    #[cfg(debug_assertions)]
    let development_origin = std::env::var("EPICENTER_API_URL").ok();
    #[cfg(not(debug_assertions))]
    let development_origin: Option<String> = None;
    auth_server(
        option_env!("EPICENTER_SERVER_ORIGIN"),
        development_origin.as_deref(),
    )
}

fn auth_server(self_hosted: Option<&str>, development: Option<&str>) -> Result<AuthConfiguration> {
    let origin = self_hosted.or(development).unwrap_or(HOSTED_AUTH_ORIGIN);
    let url = tauri::Url::parse(origin).context("parse the configured authentication origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("The configured authentication server must be an HTTP or HTTPS origin");
    }
    if self_hosted.is_none()
        && development.is_some()
        && (url.scheme() != "http"
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        bail!("EPICENTER_API_URL must be an HTTP loopback origin in development");
    }
    Ok(AuthConfiguration {
        base_url: url.origin().ascii_serialization(),
        account_management: self_hosted.is_none(),
    })
}

/// Ordinary new-tab account links leave the desktop app's work in place.
/// The host opens only the hosted account destinations in the system browser.
fn is_hosted_account_url(url: &tauri::Url, config: &AuthConfiguration) -> bool {
    config.account_management
        && url.origin().ascii_serialization() == config.base_url
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(
            url.path(),
            "/dashboard" | "/dashboard/usage" | "/dashboard/account"
        )
}

fn open_account_website<R: Runtime>(app: &AppHandle<R>, url: &tauri::Url) -> NewWindowResponse<R> {
    if configured_auth_server().is_ok_and(|server| is_hosted_account_url(url, &server)) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<String>) {
            log::warn!("could not open the account website: {error}");
        }
    }
    NewWindowResponse::Deny
}

/// Make sure the one window for this built-in app exists, and reveal it.
///
/// The window label is the app's ID, which is what every capability file in
/// `src-tauri/capabilities/` selects on. One built-in app has one window,
/// and neither is bound to a folder.
fn ensure_window(app: &DesktopAppHandle, built_in: BuiltInApp) -> Result<()> {
    focus(window_for(app, built_in)?);
    Ok(())
}

/// Make the window for `built_in` without showing it, so its page runs: the
/// Folders window started at login, which keeps every folder in sync.
fn hidden_window(app: &DesktopAppHandle, built_in: BuiltInApp) {
    let window_app = app.clone();
    let schedule = app.run_on_main_thread(move || {
        if let Err(error) = window_for(&window_app, built_in) {
            log::error!("open the {} window unseen: {error:#}", built_in.id());
        }
    });
    if let Err(error) = schedule {
        log::error!("schedule the {} window: {error}", built_in.id());
    }
}

/// The one window for `built_in`, made hidden when there is none.
fn window_for(app: &DesktopAppHandle, built_in: BuiltInApp) -> Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(built_in.id()) {
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        built_in.id(),
        WebviewUrl::CustomProtocol(scheme::url(built_in.path())?),
    );
    let builder = configure_app_window(builder, app, built_in.title(), built_in.path().to_owned());
    // These windows hide on close, so neither joins another's tab group.
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier(built_in.id());
    // The Folders window's page keeps every folder in sync while hidden
    // (ADR-0819); by default the web view suspends a hidden page's timers
    // after about five minutes (macOS 14 and later honor this).
    let builder = if built_in == BuiltInApp::Folders {
        builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    } else {
        builder
    };
    let window = builder.build()?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    Ok(window)
}

/// Configure a window on the `epicenter-app` origin (ADR-0561).
/// Navigation stays below `prefix`; a link that opens a new window reaches the
/// system browser only when it is a hosted account page. Closing it destroys
/// it; only `ensure_window` makes Epicenter's own windows hide instead.
fn configure_app_window<'a, R: Runtime>(
    builder: WebviewWindowBuilder<'a, R, AppHandle<R>>,
    app: &AppHandle<R>,
    title: &str,
    prefix: String,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let account_opener = app.clone();
    builder
        .title(title)
        .visible(false)
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .on_navigation(move |url| scheme::is_allowed_navigation(&prefix, url))
        .on_new_window(move |url, _| open_account_website(&account_opener, &url))
}

fn focus<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDERS: &str = include_str!("../capabilities/folders.json");
    const HOME: &str = include_str!("../capabilities/home.json");

    /// Every capability file, for checks that hold for all of them.
    const ALL_CAPABILITIES: &[&str] = &[FOLDERS, HOME];

    #[test]
    fn built_in_window_table_has_stable_ids_routes_and_titles() {
        let actual = BuiltInApp::ALL.map(|window| (window.id(), window.path(), window.title()));
        assert_eq!(
            actual,
            [
                ("home", "/home/", "Epicenter: Settings"),
                ("folders", "/folders/", "Epicenter: Folders"),
            ]
        );
    }

    /// Every window's page is served on the scheme, so every capability is
    /// local.
    #[test]
    fn one_local_capability_per_kind_of_window() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut files: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, ["folders.json", "home.json"]);

        let mut identifiers = Vec::new();
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let identifier = capability["identifier"].as_str().unwrap();
            assert_eq!(capability["local"], true, "{identifier}");
            assert!(capability.get("remote").is_none(), "{identifier}");
            identifiers.push(serde_json::json!(identifier));
        }
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            production["app"]["security"]["capabilities"],
            serde_json::json!(identifiers)
        );
        // No page reaches files but through the folder plugin, whose commands
        // check every path: no fs plugin is installed.
        assert!(
            production["plugins"].get("fs").is_none(),
            "no fs plugin is installed"
        );
        let development: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert!(development.get("app").is_none());
    }

    /// Both windows send requests on the app's sign-in and may start one;
    /// signing out is Settings' alone. No window reaches the CLI.
    #[test]
    fn the_sign_in_is_the_shells_and_signing_out_is_settings_alone() {
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            let identifier = capability["identifier"].as_str().unwrap();
            let grants = |permission: &str| permissions.contains(&serde_json::json!(permission));
            for permission in [
                "allow-account-sign-in",
                "allow-account-fetch",
                "allow-account-fetch-cancel",
            ] {
                assert!(grants(permission), "{identifier} {permission}");
            }
            assert_eq!(
                grants("allow-account-sign-out"),
                *encoded == HOME,
                "{identifier}"
            );
            for permission in ["allow-auth-status", "allow-auth-login", "allow-auth-logout"] {
                assert!(!grants(permission), "{identifier} {permission}");
            }
        }
    }

    /// The shell registers the sign-in's commands by the crate's own list.
    #[test]
    fn the_account_commands_are_the_crates() {
        assert_eq!(
            crate::command_names::ACCOUNT_COMMANDS,
            epicenter_account::COMMANDS
        );
    }

    #[test]
    fn development_names_only_a_local_deployment() {
        assert_eq!(
            auth_server(None, Some("http://localhost:8787"))
                .unwrap()
                .base_url,
            "http://localhost:8787"
        );
        assert_eq!(
            auth_server(None, None).unwrap().base_url,
            "https://api.epicenter.so"
        );
        assert!(auth_server(None, Some("https://evil.test")).is_err());
    }

    #[test]
    fn native_dashboard_policy_follows_account_management() {
        let mut config = auth_server(Some("https://self.example"), None).unwrap();
        let dashboard = "https://self.example/dashboard".parse().unwrap();
        assert!(!is_hosted_account_url(&dashboard, &config));
        config.account_management = true;
        assert!(is_hosted_account_url(&dashboard, &config));
    }

    #[test]
    fn fixed_self_hosted_origin_wins_and_has_no_account_website() {
        let server = auth_server(
            Some("https://SELF.example:443/"),
            Some("http://localhost:8787"),
        )
        .unwrap();
        assert_eq!(server.base_url, "https://self.example");
        assert!(!server.account_management);
        assert!(!is_hosted_account_url(
            &"https://self.example/dashboard".parse().unwrap(),
            &server
        ));
        for origin in [
            "ftp://self.example",
            "https://self.example/path",
            "https://user@self.example",
            "https://self.example?query",
            "https://self.example#fragment",
            "",
        ] {
            assert!(auth_server(Some(origin), None).is_err());
        }
    }

    /// The `tauri-plugin-macos-permissions` plugin is gone from this build:
    /// the recorder plugin asks for microphone access through AVFoundation
    /// itself, and the keyboard supervisor watches the Accessibility grant.
    ///
    /// Its `macos-permissions:default` grant handed a page twelve unrelated
    /// plugin commands (screen recording, input monitoring, full disk access,
    /// camera) to reach the two it used. A grant naming a plugin this build does
    /// not ship is a silent no-op, so nothing would fail if it were pasted back;
    /// what it would do is describe an authority the app does not have. Every
    /// capability is checked, not just the one that had it.
    #[test]
    fn no_capability_grants_the_deleted_permissions_plugin() {
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                // Permissions are either a bare identifier string or an object
                // with a scope; both spell the plugin the same way.
                let identifier = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap_or_default();
                assert!(
                    !identifier.starts_with("macos-permissions:"),
                    "{} grants a plugin this build no longer ships",
                    capability["identifier"].as_str().unwrap()
                );
            }
        }
    }

    /// Every command a capability grants must exist, and every command the crate
    /// exposes must be declared to the Tauri manifest. These are two hand-kept
    /// lists today, and a grant for a command that does not exist is a silent
    /// no-op rather than an error.
    #[test]
    fn capability_grants_name_only_commands_this_build_has() {
        let declared: std::collections::BTreeSet<&str> = crate::command_names::COMMANDS
            .iter()
            .chain(crate::command_names::ACCOUNT_COMMANDS)
            .copied()
            .collect();
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                let Some(name) = permission.as_str() else {
                    continue;
                };
                // Only app-owned grants are checked here; plugin and core
                // permissions (`core:`, `dialog:`, ...) belong to their plugins.
                let Some(command) = name.strip_prefix("allow-") else {
                    continue;
                };
                if name.contains(':') {
                    continue;
                }
                let command = command.replace('-', "_");
                assert!(
                    declared.contains(command.as_str()),
                    "{name} grants a command this build does not declare: {command}"
                );
            }
        }
    }

    /// The generated bindings are a committed artifact, so they can go stale
    /// against the command list without anything failing to compile. They
    /// carry the page API and none of the dictation commands no page reaches.
    #[test]
    fn generated_bindings_cover_every_declared_command() {
        for bindings in [include_str!("../../src/ui/bindings.gen.ts")] {
            // Either quote style: specta emits double quotes and the repo
            // formatter rewrites them to single, so both are "fresh".
            let names = |command: &str| {
                bindings.contains(&format!("'{command}'"))
                    || bindings.contains(&format!("\"{command}\""))
            };
            for command in crate::command_names::COMMANDS {
                assert!(names(command), "regenerate bindings: {command} is missing");
            }
            for command in crate::command_names::DICTATION_COMMANDS {
                assert!(
                    !names(command),
                    "regenerate bindings without the dictation feature: {command} is present"
                );
            }
            for event in ["dictation-capability-event", "dictationCapabilityEvent"] {
                assert!(
                    !bindings.contains(event),
                    "regenerate bindings without the dictation feature: {event} is present"
                );
            }
        }
    }

    /// Model administration is routed to Home and to no other window
    /// (ADR-0180). This is wiring, not a sandbox. What it proves is that the
    /// ownership the record describes is the ownership the build actually
    /// wires, so it does not quietly become false the next time a permission
    /// is pasted into the wrong file.
    #[test]
    fn model_administration_is_routed_to_home_and_away_from_applications() {
        // `get_active_model` is in this list: model *identity* is administration
        // data (ADR-0180).
        const ADMINISTRATION: &[&str] = &[
            "epicenter-transcription:allow-list-models",
            "epicenter-transcription:allow-download-model",
            "epicenter-transcription:allow-reveal-model",
            "epicenter-transcription:allow-remove-model",
            "epicenter-transcription:allow-get-active-model",
            "epicenter-transcription:allow-set-active-model",
            "epicenter-transcription:allow-get-unload-policy",
            "epicenter-transcription:allow-set-unload-policy",
        ];

        let capability: serde_json::Value = serde_json::from_str(HOME).unwrap();
        assert_eq!(
            capability["windows"].as_array().unwrap(),
            &vec![serde_json::json!("home")],
            "model administration belongs to Home alone"
        );
        let permissions = capability["permissions"].as_array().unwrap();
        for permission in ADMINISTRATION {
            assert!(
                permissions.contains(&serde_json::json!(permission)),
                "Home must be able to invoke {permission}"
            );
        }

        // No other window administers the model.
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            if capability["windows"] == serde_json::json!(["home"]) {
                continue;
            }
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in ADMINISTRATION {
                assert!(
                    !permissions.contains(&serde_json::json!(permission)),
                    "only Settings administers models: {permission}"
                );
            }
        }
    }

    /// A development build and an installed one can be running at the same time
    /// on one machine, and they own separate config, data, and log directories.
    /// Telling them apart has to be possible from the Dock, the menu bar, and
    /// the window title, not only from a bundle identifier nobody reads.
    #[test]
    fn development_and_production_builds_are_distinguishable() {
        let development: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        let production: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();

        assert_eq!(production["productName"], "Epicenter");
        assert_eq!(development["productName"], "Epicenter Dev");
        assert_ne!(production["identifier"], development["identifier"]);
    }

    /// The Folders window reaches the Epicenter folder and each folder in it
    /// through the folder plugin, and the server through the shell's
    /// sign-in, composing `@epicenter/folder/platform` in its page (ADR-0817),
    /// and runs Git for an import through the shell (`git.rs`, ADR-0828); it
    /// administers no model or login item. Only it lists and makes folders,
    /// and only it runs Git.
    #[test]
    fn the_folders_window_reaches_every_folder_and_nothing_else() {
        let capability: serde_json::Value = serde_json::from_str(FOLDERS).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["folders"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-open-home",
                "allow-account-sign-in",
                "allow-account-fetch",
                "allow-account-fetch-cancel",
                "allow-choose-repository",
                "allow-git-run",
                "allow-git-scratch",
                "allow-git-scratch-remove",
                "allow-git-lfs-object",
                "allow-git-hand-over",
                "epicenter-folder:default",
                "epicenter-folder:epicenter",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ]),
            "folders"
        );
        let home: serde_json::Value = serde_json::from_str(HOME).unwrap();
        for folders_only in ["epicenter-folder:epicenter", "allow-git-run", "allow-git-hand-over"] {
            assert!(!home["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(folders_only)));
        }
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                // A scoped grant is an object; its identifier is what is named.
                let permission = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap();
                assert!(
                    !permission.starts_with("dialog:") || permission == "dialog:allow-message",
                    "only message dialogs are allowed; no page opens a file picker (the shell's choose_repository does)"
                );
            }
        }
    }

    #[test]
    fn deep_links_accept_only_the_closed_built_in_app_table() {
        for (url, expected) in [
            ("epicenter://app/home", BuiltInApp::Home),
            ("epicenter://app/folders", BuiltInApp::Folders),
            // A link without a path opens what launching Epicenter opens.
            ("epicenter://", BuiltInApp::Folders),
            ("epicenter:///", BuiltInApp::Folders),
        ] {
            assert_eq!(parse_app_deep_link(&url.parse().unwrap()), Some(expected));
        }

        for denied in [
            "epicenter://app/unknown",
            // An app is a separate program; no link opens one here.
            "epicenter://app/todos",
            "epicenter://app/so.epicenter.todos",
            "epicenter://app/capture",
            "epicenter://app/honeycrisp",
            "epicenter://app/whispering",
            "epicenter://app/so.epicenter.whispering",
            "epicenter://app/home/",
            "epicenter://app/home/extra",
            "epicenter://app/home?mode=other",
            "epicenter://app/home#other",
            "epicenter://user@app/home",
            "epicenter://user:secret@app/home",
            "epicenter://other/query",
            "epicenter://?mode=other",
            "epicenter:///home",
            "https://app/home",
            // A standalone app no longer asks Epicenter to sync its folder
            // (ADR-0822), and a query never names a window.
            "epicenter://init?path=%2FUsers%2Fme%2FNotes",
            "epicenter://app/folders?path=%2FUsers%2Fme%2FNotes",
        ] {
            assert_eq!(parse_app_deep_link(&denied.parse().unwrap()), None);
        }
    }

    #[test]
    fn system_browser_accepts_only_hosted_account_destinations() {
        for allowed in [
            "https://api.epicenter.so/dashboard?expectedPrincipal=alice",
            "https://api.epicenter.so/dashboard/usage?expectedPrincipal=alice",
            "https://api.epicenter.so/dashboard/account",
        ] {
            assert!(is_hosted_account_url(
                &allowed.parse().unwrap(),
                &auth_server(None, None).unwrap()
            ));
        }
        for denied in [
            "http://api.epicenter.so/dashboard",
            "https://api.epicenter.so.evil.test/dashboard",
            "https://api.epicenter.so:444/dashboard",
            "https://user@api.epicenter.so/dashboard",
            "https://api.epicenter.so/dashboard#fragment",
            "https://api.epicenter.so/dashboard/other",
            "https://api.epicenter.so/dashboard/usage/extra",
            "https://api.epicenter.so/sign-in",
            "https://api.epicenter.so/auth/sign-out",
            "file:///dashboard",
        ] {
            assert!(!is_hosted_account_url(
                &denied.parse().unwrap(),
                &auth_server(None, None).unwrap()
            ));
        }
    }

    #[test]
    fn forwarded_arguments_extract_valid_unique_links() {
        let arguments = [
            "/Applications/Epicenter.app/Contents/MacOS/Epicenter",
            "epicenter://app/home",
            "epicenter://app/unknown",
            "epicenter://app/todos",
            "epicenter://app/home",
            "epicenter://app/whispering",
            "epicenter://init?path=%2FUsers%2Fme%2FNotes",
            "epicenter://",
        ]
        .map(String::from);
        assert_eq!(
            links_from_arguments(&arguments),
            vec![BuiltInApp::Home, BuiltInApp::Folders]
        );
    }
}
