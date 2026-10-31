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

mod cli;
mod synced_folders;
use tauri_plugin_epicenter_folder::defaults::DesktopPaths;
#[cfg(target_os = "macos")]
mod macos_menu;
mod scheme;

pub mod audio;

pub mod transcription;
use transcription::{
    download_model, get_active_model, get_unload_policy, list_models, reveal_model,
    set_active_model, set_unload_policy, LocalTranscriptionSettings, ModelCache,
};

pub mod download;
use download::{cancel_download, DownloadManager};

pub mod timing;

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
            get_active_model,
            set_active_model,
            open_home,
            synced_folders::synced_folders,
            synced_folders::add_synced_folder,
            synced_folders::accept_folder_setup,
            synced_folders::dismiss_folder_setup,
            synced_folders::clone_synced_folder,
            synced_folders::sync_folder_now,
            synced_folders::forget_synced_folder,
            synced_folders::folder_sharing,
            synced_folders::share_folder,
            synced_folders::unshare_folder,
            synced_folders::restart_sync_service,
            cli::auth_login::<tauri::Wry>,
            cli::auth_status,
            cli::auth_logout,
            get_unload_policy,
            set_unload_policy,
            list_models,
            download_model,
            reveal_model::<tauri::Wry>,
            cancel_download,
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
            transcription::prewarm_model,
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

/// Show Settings: the Folders window's Settings button (ADR-0537).
#[tauri::command]
#[specta::specta]
fn open_home(app: DesktopAppHandle) {
    request_window(&app, BuiltInApp::Home);
}

pub fn run() {
    let specta_builder = make_specta_builder();
    let specta_handler = tauri_specta::Builder::invoke_handler(&specta_builder);
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("epicenter::transcription", log::LevelFilter::Debug)
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
        // Rust owns the folder picker and application Quit confirmation; no
        // page may open the file picker.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(synced_folders::SyncedFolders::default())
        .manage(cli::CliChildren::default())
        .manage(shell::QuitRequest::default())
        .manage(updates::Updates::default())
        .manage(DownloadManager::default());

    // Only native dictation uses these plugins; no capability grants them.
    #[cfg(feature = "dictation")]
    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(all(target_os = "macos", feature = "dictation"))]
    let builder = builder.plugin(tauri_nspanel::init());

    scheme::register(builder)
        // A page that reloads or navigates, and a closed window, end the
        // `epicenter` children that page started (ADR-0559).
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<cli::CliChildren>()
                    .page_ended(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window
                    .state::<cli::CliChildren>()
                    .page_ended(window.label());
            }
        })
        .invoke_handler(specta_handler)
        .setup(move |app| {
            specta_builder.mount_events(app);
            #[cfg(target_os = "macos")]
            macos_menu::install(app.handle()).context("install native app menu")?;

            let desktop_paths = DesktopPaths::resolve(app.handle()).map_err(anyhow::Error::msg)?;
            // Git's configuration runs `~/.local/bin/epicenter`; point it
            // at this launch's binary, wherever the app now is (ADR-0566).
            // A packaged release rehearsal must not replace the person's PATH link.
            if app.config().identifier == "so.epicenter" {
                cli::spawn_command_link_refresh(&desktop_paths);
            }
            // Every window's page comes from the scheme, which reads it.
            app.manage(scheme::Pages(
                scheme::pages_dir(app.handle()).context("locate packaged pages")?,
            ));
            // The active local model and the unload policy are device-local host
            // state (ADR-0180), so they live in the app's data directory, never
            // in a folder that could carry them to a machine without the model
            // files or a compatible accelerator.
            let settings = LocalTranscriptionSettings::load(
                desktop_paths.data_dir.join("local-transcription.json"),
            );
            app.manage(desktop_paths);
            // `epicenter sync --watch` runs for as long as the app does.
            synced_folders::start_service(app.handle());

            let cache = ModelCache::new(settings);
            cache.start_idle_watcher();
            app.manage(cache);

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
                    if let Some(link) = parse_deep_link(url) {
                        follow_deep_link(app.handle(), link);
                        opened_window = true;
                    }
                }
            }
            // Epicenter opens to the person's folders (ADR-0537).
            if !opened_window {
                request_window(app.handle(), BuiltInApp::Folders);
            }
            log::info!("Epicenter {} ready", app.package_info().version);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Epicenter")
        .run(|app, event| match event {
            RunEvent::Reopen { .. } => request_window(app, BuiltInApp::Folders),
            RunEvent::ExitRequested { api, code, .. } => {
                shell::request_quit(app, &api, code.unwrap_or(0));
            }
            // No task is left to stop the service's child, so signal it now.
            RunEvent::Exit => synced_folders::stop_service(app),
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
        let Some(link) = parse_deep_link(&url) else {
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
        if let Some(link) = parse_deep_link(url) {
            follow_deep_link(app, link);
        }
    }
}

/// What an `epicenter://` link asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum DeepLink {
    /// Show a built-in window (`parse_app_deep_link`).
    Window(BuiltInApp),
    /// Ask the person to sync a folder another app named
    /// (`synced_folders::parse_init_link`).
    SetUpFolder(synced_folders::FolderSetup),
}

fn parse_deep_link(url: &tauri::Url) -> Option<DeepLink> {
    parse_app_deep_link(url)
        .map(DeepLink::Window)
        .or_else(|| synced_folders::parse_init_link(url).map(DeepLink::SetUpFolder))
}

/// Show the window `link` names. A directory is only queued for the person
/// to accept in the Folders window, which is shown; nothing reads it yet.
fn follow_deep_link(app: &DesktopAppHandle, link: DeepLink) {
    match link {
        DeepLink::Window(built_in) => request_window(app, built_in),
        DeepLink::SetUpFolder(setup) => {
            synced_folders::receive(app, setup);
            request_window(app, BuiltInApp::Folders);
        }
    }
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

/// The deployment's API origin, which the `epicenter` CLI signs in to when
/// the shell runs it (`cli.rs` passes it as `EPICENTER_API_URL`), so the app
/// and the CLI it runs name one deployment (ADR-0326).
pub(crate) fn deployment_origin() -> std::result::Result<String, String> {
    configured_auth_server()
        .map(|config| config.base_url)
        .map_err(|error| format!("{error:#}"))
}

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
    if let Some(window) = app.get_webview_window(built_in.id()) {
        focus(window);
        return Ok(());
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
    let window = builder.build()?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    focus(window);
    Ok(())
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
        // No page reads or changes files: no fs plugin is installed, and Git is
        // a separate CLI concern.
        assert!(
            production["plugins"].get("fs").is_none(),
            "no fs plugin is installed"
        );
        let development: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        assert!(development.get("app").is_none());
    }

    /// Who Epicenter is signed in as, and signing in and out, reach Settings
    /// alone (ADR-0558): Settings owns the desktop grant.
    #[test]
    fn signing_in_and_out_is_granted_to_settings_alone() {
        for encoded in ALL_CAPABILITIES {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            let permissions = capability["permissions"].as_array().unwrap();
            let identifier = capability["identifier"].as_str().unwrap();
            for permission in ["allow-auth-status", "allow-auth-login", "allow-auth-logout"] {
                assert_eq!(
                    permissions.contains(&serde_json::json!(permission)),
                    *encoded == HOME,
                    "{identifier} {permission}"
                );
            }
        }
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
        let declared: std::collections::BTreeSet<&str> =
            crate::command_names::COMMANDS.iter().copied().collect();
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
            "allow-list-models",
            "allow-download-model",
            "allow-cancel-download",
            "allow-reveal-model",
            "allow-get-active-model",
            "allow-set-active-model",
            "allow-get-unload-policy",
            "allow-set-unload-policy",
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

    /// The Folders window manages the synced folders (`synced_folders.rs`),
    /// each action one CLI call, and opens Settings. It is bound to no folder,
    /// holds no folder command, and administers no model or connection. No
    /// other window may do any of it.
    #[test]
    fn the_folders_window_manages_synced_folders_without_folder_commands() {
        const FOLDERS_ONLY: [&str; 11] = [
            "allow-synced-folders",
            "allow-add-synced-folder",
            "allow-accept-folder-setup",
            "allow-dismiss-folder-setup",
            "allow-clone-synced-folder",
            "allow-sync-folder-now",
            "allow-forget-synced-folder",
            "allow-folder-sharing",
            "allow-share-folder",
            "allow-unshare-folder",
            "allow-restart-sync-service",
        ];
        let capability: serde_json::Value = serde_json::from_str(FOLDERS).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["folders"]));
        let mut expected = vec!["core:event:allow-listen", "core:event:allow-unlisten"];
        expected.extend(FOLDERS_ONLY);
        expected.push("allow-open-home");
        assert_eq!(
            capability["permissions"],
            serde_json::json!(expected),
            "folders"
        );
        for encoded in ALL_CAPABILITIES
            .iter()
            .filter(|encoded| **encoded != FOLDERS)
        {
            let capability: serde_json::Value = serde_json::from_str(encoded).unwrap();
            for permission in capability["permissions"].as_array().unwrap() {
                // A scoped grant is an object; its identifier is what is named.
                let permission = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap();
                assert!(
                    !FOLDERS_ONLY.contains(&permission),
                    "{permission} belongs to the Folders window alone"
                );
                assert!(
                    !permission.starts_with("dialog:") || permission == "dialog:allow-message",
                    "only message dialogs are allowed; the folder picker belongs to Rust"
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
            "epicenter://init?path=relative",
            "epicenter://init?path=%2FUsers%2Fme%2FNotes",
            "epicenter://",
        ]
        .map(String::from);
        assert_eq!(
            links_from_arguments(&arguments),
            vec![
                DeepLink::Window(BuiltInApp::Home),
                DeepLink::SetUpFolder(synced_folders::FolderSetup {
                    path: "/Users/me/Notes".into(),
                    contract: None,
                }),
                DeepLink::Window(BuiltInApp::Folders),
            ]
        );
    }

    /// A setup link is its own form: it never names a window, and the built-in table takes no query.
    #[test]
    fn a_setup_link_and_a_window_link_are_read_apart() {
        assert_eq!(
            parse_deep_link(
                &"epicenter://init?path=%2FUsers%2Fme%2FNotes"
                    .parse()
                    .unwrap()
            ),
            Some(DeepLink::SetUpFolder(synced_folders::FolderSetup {
                path: "/Users/me/Notes".into(),
                contract: None,
            }))
        );
        assert_eq!(
            parse_deep_link(&"epicenter://app/folders".parse().unwrap()),
            Some(DeepLink::Window(BuiltInApp::Folders))
        );
        for denied in [
            "epicenter://app/folders?path=%2FUsers%2Fme%2FNotes",
            "epicenter://app/todos?path=%2FUsers%2Fme%2FNotes",
            "epicenter://?path=%2FUsers%2Fme%2FNotes",
            "epicenter://init/todos?path=%2FUsers%2Fme%2FNotes",
            "epicenter://open?path=%2FUsers%2Fme%2FNotes",
        ] {
            assert_eq!(parse_deep_link(&denied.parse().unwrap()), None, "{denied}");
        }
    }
}
