use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

struct Copies {
    root: PathBuf,
    /// Each registered copy's scope and the one window that holds it. A
    /// folder scope belongs to one window for as long as the app runs.
    registered: Mutex<BTreeMap<String, String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoInfo {
    remote: String,
    copy: String,
}

#[tauri::command]
fn demo_info(window: WebviewWindow) -> DemoInfo {
    DemoInfo {
        remote: std::env::var("GIT_LAB_REMOTE").unwrap_or_default(),
        copy: if window.label() == "copy-b" { "b" } else { "a" }.into(),
    }
}

#[tauri::command]
fn open_copy(
    window: WebviewWindow,
    copies: State<Copies>,
    copy: String,
    remote: String,
) -> Result<String, String> {
    if copy != "a" && copy != "b" {
        return Err("Choose working copy A or B".into());
    }
    let remote = remote.trim();
    if !remote.is_empty() {
        let url = tauri::Url::parse(remote).map_err(|e| e.to_string())?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("Use an HTTP or HTTPS Git remote".into());
        }
    }
    let key = format!("{:x}", Sha256::digest(remote.as_bytes()));
    let scope = format!("so.epicenter.git.{key}.{copy}");
    let label = window.label().to_string();
    let mut registered = copies.registered.lock().map_err(|e| e.to_string())?;
    match registered.get(&scope) {
        Some(holder) if *holder == label => {}
        Some(holder) => {
            let holder = if holder == "copy-b" { "B" } else { "A" };
            return Err(format!(
                "Working copy {} is open in window {holder}. A working copy stays with the window that first opened it until Git lab quits; edit it there.",
                copy.to_uppercase()
            ));
        }
        None => {
            let root = copies.root.join(key).join(&copy);
            std::fs::create_dir_all(&root).map_err(|e| format!("Create working copy: {e}"))?;
            // The page runs `@epicenter/folder`'s own engine over this
            // directory and connects it to the remote itself. The author
            // here applies only where Git configuration names none.
            let folder = FolderConfig::new(
                root,
                Author {
                    name: format!("Working copy {}", copy.to_uppercase()),
                    email: format!("{copy}@git-lab.localhost"),
                },
            );
            window.app_handle().folders().register(ScopeConfig {
                scope: scope.clone(),
                window: label.clone(),
                folder,
            })?;
            registered.insert(scope.clone(), label);
        }
    }
    Ok(scope)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_epicenter_folder::init())
        .invoke_handler(tauri::generate_handler![open_copy, demo_info])
        .setup(|app| {
            let root = match std::env::var_os("GIT_LAB_ROOT") {
                Some(root) => PathBuf::from(root),
                None => app.path().app_data_dir()?.join("copies"),
            };
            app.manage(Copies {
                root,
                registered: Mutex::new(BTreeMap::new()),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run Git lab");
}
