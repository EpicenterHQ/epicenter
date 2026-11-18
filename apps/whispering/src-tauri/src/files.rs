//! Whispering's own file commands, one per operation of the page's `Files`
//! (`tauriFiles`), plus "Change…" and the folder's Git check (ADR-0894).
//! Rust moves bytes; the page reads and writes what they mean.
//!
//! Each command takes the folder as an absolute path and checks it against
//! the app's file system scope (`tauri-plugin-fs`): the default folder the
//! shell allows at start, or one the person picked in the folder dialog,
//! which `tauri-plugin-persisted-scope` restores. A page cannot widen that
//! scope; it holds none of the file system plugin's commands. The path
//! inside the folder must pass the plain-name rule, no link may be on its
//! way, and the final path is checked against the scope too.
//!
//! A write is staged in `<appLocalDataDir>/local/.tmp/` and renamed over its
//! target, so the folder only ever receives finished files
//! (`whispering_files::place`). Every command runs its disk work off the
//! async runtime.
//!
//! A failure crosses as the page's `FilesError`,
//! `{ name: "NotFound" | "Refused" | "Io", message }`.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;
use whispering_files::{Changed, Entry, FilesError, FolderGit};

/// `<appLocalDataDir>/local`: this computer's own, never in the folder.
/// `.tmp/` beside the takes holds saves on their way into the folder.
pub struct Local(pub PathBuf);

impl Local {
    /// Where a save waits before it is placed.
    pub fn tmp(&self) -> PathBuf {
        self.0.join(".tmp")
    }
}

/// The folder at the absolute path `folder`, when the scope allows it.
fn granted<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf, FilesError> {
    let path = PathBuf::from(folder);
    if !path.is_absolute() {
        return Err(FilesError::refused(format!(
            "{folder:?} is not an absolute path"
        )));
    }
    allowed(app, &path)?;
    Ok(path)
}

/// Refuse `path` unless the app's file system scope allows it.
fn allowed<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<(), FilesError> {
    let allowed = app
        .try_fs_scope()
        .is_some_and(|scope| scope.is_allowed(path));
    if allowed {
        Ok(())
    } else {
        Err(FilesError::refused(format!(
            "{} is not in a folder this app may use",
            path.display()
        )))
    }
}

/// The file `relative` in the granted `folder`, rule-checked, and its final
/// path allowed by the scope.
fn granted_file<R: Runtime>(
    app: &AppHandle<R>,
    folder: &Path,
    relative: &str,
) -> Result<PathBuf, FilesError> {
    let path = whispering_files::resolve(folder, relative)?;
    allowed(app, &path)?;
    Ok(path)
}

/// Run `work` off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, FilesError> + Send + 'static,
) -> Result<T, FilesError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| FilesError::io(error.to_string()))?
}

/// The bytes of the file `path` in `folder`, raw. A missing file is
/// `NotFound`.
#[tauri::command]
pub async fn files_read<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    path: String,
) -> Result<Response, FilesError> {
    let folder = granted(&app, &folder)?;
    granted_file(&app, &folder, &path)?;
    let bytes = blocking(move || whispering_files::read(&folder, &path)).await?;
    Ok(Response::new(bytes))
}

/// The files at `paths` in `folder`, raw, in one buffer: a `u32`
/// little-endian count, then each path's length in the order asked as a
/// `u32` little-endian, or `0xFFFFFFFF` for a missing file, then the
/// present files' bytes in order. A path the rule refuses refuses the call.
#[tauri::command]
pub async fn files_read_many<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    paths: Vec<String>,
) -> Result<Response, FilesError> {
    let folder = granted(&app, &folder)?;
    for path in &paths {
        granted_file(&app, &folder, path)?;
    }
    let buffer = blocking(move || whispering_files::read_many(&folder, &paths)).await?;
    Ok(Response::new(buffer))
}

/// The value of the header `name`, percent-decoded as JavaScript's
/// `encodeURIComponent` encodes it.
fn header(request: &Request<'_>, name: &str) -> Result<String, FilesError> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| FilesError::refused(format!("the {name} header is missing")))?
        .to_str()
        .map_err(|_| FilesError::refused(format!("the {name} header is not text")))?;
    percent_decode_str(value)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| FilesError::refused(format!("the {name} header is not UTF-8")))
}

/// Replace the file named by the `x-path` header in the folder named by
/// `x-folder` (both percent-encoded) with the request's raw body: staged in
/// `local/.tmp/`, synced, and renamed over the target.
#[tauri::command]
pub async fn files_write<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<(), FilesError> {
    let folder = granted(&app, &header(&request, "x-folder")?)?;
    let path = header(&request, "x-path")?;
    granted_file(&app, &folder, &path)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(FilesError::refused("a write's body must be raw bytes"));
    };
    let bytes = bytes.clone();
    let tmp = app.state::<Local>().tmp();
    blocking(move || whispering_files::write(&folder, &path, &bytes, &tmp)).await
}

/// The files in the directory `dir` in `folder` (the folder itself for
/// `""`), as `{ name, size, modifiedMs }` sorted by name. A missing
/// directory lists as empty; a missing folder is `NotFound`.
#[tauri::command]
pub async fn files_list<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    dir: String,
) -> Result<Vec<Entry>, FilesError> {
    let folder = granted(&app, &folder)?;
    let directory = whispering_files::resolve_dir(&folder, &dir)?;
    allowed(&app, &directory)?;
    blocking(move || whispering_files::list(&folder, &dir)).await
}

/// Remove the file `path` in `folder`; one that is not there is not a
/// failure.
#[tauri::command]
pub async fn files_remove<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    path: String,
) -> Result<(), FilesError> {
    let folder = granted(&app, &folder)?;
    granted_file(&app, &folder, &path)?;
    blocking(move || whispering_files::remove(&folder, &path)).await
}

/// "Change…": move the recordings from `from` into `to` when `to` is empty
/// (`"moved"`), or open `to` as it is when it is a Whispering folder
/// (`"opened"`). Anything else is refused, and two folders are never
/// merged. Both folders must be granted.
#[tauri::command]
pub async fn files_change_folder<R: Runtime>(
    app: AppHandle<R>,
    from: String,
    to: String,
) -> Result<Changed, FilesError> {
    let from = granted(&app, &from)?;
    let to = granted(&app, &to)?;
    blocking(move || whispering_files::change_folder(&from, &to)).await
}

/// Whether `folder` is inside a Git repository, and whether that repository
/// sends `.webm` files through Git LFS: `{ repository, lfsWebm }`. Reads
/// only; runs no Git.
#[tauri::command]
pub async fn folder_git<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
) -> Result<FolderGit, FilesError> {
    let folder = granted(&app, &folder)?;
    blocking(move || whispering_files::folder_git(&folder)).await
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::{CallbackFn, InvokeResponseBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
    use tauri::utils::acl::ExecutionContext;
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;

    const COMMANDS: &[&str] = &[
        "files_read",
        "files_read_many",
        "files_write",
        "files_list",
        "files_remove",
        "files_change_folder",
        "folder_git",
    ];

    struct Fixture {
        app: App<MockRuntime>,
        window: WebviewWindow<MockRuntime>,
        /// The granted folder.
        folder: PathBuf,
        /// A folder beside it that is not granted.
        outside: PathBuf,
        local: PathBuf,
        _temp: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let (folder, outside, local) =
            (root.join("data"), root.join("outside"), root.join("local"));
        for directory in [&folder, &outside] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let mut context = mock_context(noop_assets());
        for command in COMMANDS {
            context
                .runtime_authority_mut()
                .__allow_command(command.to_string(), ExecutionContext::Local);
        }
        let app = mock_builder()
            .plugin(tauri_plugin_fs::init())
            .manage(Local(local.clone()))
            .invoke_handler(tauri::generate_handler![
                files_read,
                files_read_many,
                files_write,
                files_list,
                files_remove,
                files_change_folder,
                folder_git,
            ])
            .build(context)
            .unwrap();
        app.fs_scope().allow_directory(&folder, true).unwrap();
        let window = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Fixture {
            app,
            window,
            folder,
            outside,
            local,
            _temp: temp,
        }
    }

    fn call(
        fixture: &Fixture,
        command: &str,
        body: InvokeBody,
        headers: HeaderMap,
    ) -> Result<InvokeResponseBody, Value> {
        tauri::test::get_ipc_response(
            &fixture.window,
            InvokeRequest {
                cmd: command.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn invoke(fixture: &Fixture, command: &str, args: Value) -> Result<Value, Value> {
        call(fixture, command, InvokeBody::Json(args), HeaderMap::new())
            .map(|body| body.deserialize::<Value>().unwrap())
    }

    fn raw(fixture: &Fixture, command: &str, args: Value) -> Result<Vec<u8>, Value> {
        match call(fixture, command, InvokeBody::Json(args), HeaderMap::new())? {
            InvokeResponseBody::Raw(bytes) => Ok(bytes),
            InvokeResponseBody::Json(json) => panic!("expected raw bytes, got {json}"),
        }
    }

    /// `encodeURIComponent`, for the characters these tests use.
    fn encode(text: &str) -> String {
        percent_encoding::utf8_percent_encode(text, percent_encoding::NON_ALPHANUMERIC).to_string()
    }

    fn write(fixture: &Fixture, folder: &Path, path: &str, bytes: &[u8]) -> Result<Value, Value> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-folder",
            HeaderValue::from_str(&encode(&folder.to_string_lossy())).unwrap(),
        );
        headers.insert("x-path", HeaderValue::from_str(&encode(path)).unwrap());
        call(
            fixture,
            "files_write",
            InvokeBody::Raw(bytes.to_vec()),
            headers,
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    }

    fn name(error: &Value) -> &str {
        error["name"].as_str().unwrap_or_default()
    }

    #[test]
    fn the_five_operations_move_bytes_in_the_granted_folder() {
        let fixture = fixture();
        let folder = json!(fixture.folder);
        let refused = invoke(
            &fixture,
            "files_read",
            json!({ "folder": folder, "path": "settings.md" }),
        )
        .unwrap_err();
        assert_eq!(name(&refused), "NotFound", "{refused}");

        assert_eq!(
            write(&fixture, &fixture.folder, "recordings/k3x9.md", b"# note").unwrap(),
            Value::Null
        );
        write(&fixture, &fixture.folder, "settings.md", "café".as_bytes()).unwrap();
        assert_eq!(
            std::fs::read_dir(fixture.local.join(".tmp"))
                .unwrap()
                .count(),
            0,
            "nothing is left staged"
        );
        assert_eq!(
            raw(
                &fixture,
                "files_read",
                json!({ "folder": folder, "path": "settings.md" })
            )
            .unwrap(),
            "café".as_bytes()
        );

        let buffer = raw(
            &fixture,
            "files_read_many",
            json!({ "folder": folder, "paths": ["recordings/k3x9.md", "recordings/none.md"] }),
        )
        .unwrap();
        let mut expected = Vec::new();
        for word in [2u32, 6, u32::MAX] {
            expected.extend_from_slice(&word.to_le_bytes());
        }
        expected.extend_from_slice(b"# note");
        assert_eq!(buffer, expected);

        let listed = invoke(
            &fixture,
            "files_list",
            json!({ "folder": folder, "dir": "recordings" }),
        )
        .unwrap();
        assert_eq!(listed[0]["name"], "k3x9.md");
        assert_eq!(listed[0]["size"], 6);
        assert!(listed[0]["modifiedMs"].as_u64().unwrap() > 0);
        assert_eq!(
            invoke(
                &fixture,
                "files_list",
                json!({ "folder": folder, "dir": "" })
            )
            .unwrap(),
            json!([{
                "name": "settings.md",
                "size": 5,
                "modifiedMs": std::fs::metadata(fixture.folder.join("settings.md")).unwrap()
                    .modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
            }])
        );

        for _ in 0..2 {
            assert_eq!(
                invoke(
                    &fixture,
                    "files_remove",
                    json!({ "folder": folder, "path": "recordings/k3x9.md" })
                )
                .unwrap(),
                Value::Null
            );
        }
        assert_eq!(
            invoke(
                &fixture,
                "files_list",
                json!({ "folder": folder, "dir": "recordings" })
            )
            .unwrap(),
            json!([])
        );
    }

    #[test]
    fn a_folder_outside_the_grant_or_a_path_outside_the_rule_is_refused() {
        let fixture = fixture();
        std::fs::write(fixture.outside.join("settings.md"), b"theirs").unwrap();
        let outside = json!(fixture.outside);
        for (command, args) in [
            (
                "files_read",
                json!({ "folder": outside, "path": "settings.md" }),
            ),
            (
                "files_read_many",
                json!({ "folder": outside, "paths": ["settings.md"] }),
            ),
            ("files_list", json!({ "folder": outside, "dir": "" })),
            (
                "files_remove",
                json!({ "folder": outside, "path": "settings.md" }),
            ),
            ("folder_git", json!({ "folder": outside })),
            (
                "files_change_folder",
                json!({ "from": fixture.folder, "to": outside }),
            ),
            (
                "files_read",
                json!({ "folder": "relative", "path": "settings.md" }),
            ),
            (
                "files_read",
                json!({ "folder": fixture.folder, "path": "../outside/settings.md" }),
            ),
            (
                "files_read",
                json!({ "folder": fixture.folder, "path": ".hidden" }),
            ),
            (
                "files_read_many",
                json!({ "folder": fixture.folder, "paths": ["a.md", "../x.md"] }),
            ),
            (
                "files_list",
                json!({ "folder": fixture.folder, "dir": "a.b" }),
            ),
        ] {
            let refused = call(&fixture, command, InvokeBody::Json(args), HeaderMap::new())
                .map(|_| ())
                .unwrap_err();
            assert_eq!(name(&refused), "Refused", "{command}: {refused}");
        }
        let refused = write(&fixture, &fixture.outside, "settings.md", b"mine").unwrap_err();
        assert_eq!(name(&refused), "Refused", "{refused}");
        let refused =
            write(&fixture, &fixture.folder, "../outside/settings.md", b"mine").unwrap_err();
        assert_eq!(name(&refused), "Refused", "{refused}");
        assert_eq!(
            std::fs::read(fixture.outside.join("settings.md")).unwrap(),
            b"theirs"
        );

        // A body that is not raw bytes is refused.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-folder",
            HeaderValue::from_str(&encode(&fixture.folder.to_string_lossy())).unwrap(),
        );
        headers.insert("x-path", HeaderValue::from_static("settings.md"));
        let refused = call(
            &fixture,
            "files_write",
            InvokeBody::Json(json!("text")),
            headers,
        )
        .map(|_| ())
        .unwrap_err();
        assert_eq!(name(&refused), "Refused", "{refused}");
        assert!(!fixture.folder.join("settings.md").exists());
    }

    #[test]
    fn change_folder_moves_into_a_granted_empty_folder() {
        let fixture = fixture();
        write(&fixture, &fixture.folder, "settings.md", b"s").unwrap();
        fixture
            .app
            .fs_scope()
            .allow_directory(&fixture.outside, true)
            .unwrap();
        assert_eq!(
            invoke(
                &fixture,
                "files_change_folder",
                json!({ "from": fixture.folder, "to": fixture.outside })
            )
            .unwrap(),
            json!("moved")
        );
        assert_eq!(
            std::fs::read(fixture.outside.join("settings.md")).unwrap(),
            b"s"
        );
        assert!(!fixture.folder.join("settings.md").exists());
        assert_eq!(
            invoke(
                &fixture,
                "files_change_folder",
                json!({ "from": fixture.folder, "to": fixture.outside })
            )
            .unwrap(),
            json!("opened")
        );
        assert_eq!(
            invoke(&fixture, "folder_git", json!({ "folder": fixture.outside }))
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["lfsWebm", "repository"]
        );
    }
}
