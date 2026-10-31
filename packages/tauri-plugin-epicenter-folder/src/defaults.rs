//! Authored-folder launch defaults shared by Epicenter and standalone app shells.
//! The shell resolves the library root once at startup; window binding and
//! explicitly chosen directories do not depend on this policy.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use epicenter_folder_core::library::{self, LibraryDefault};
use tauri::{AppHandle, Manager, Runtime};

/// Shared machine-local application data and the library root whose fixed
/// children are the app defaults. A standalone shell deliberately uses
/// Epicenter's scope, not its own bundle's.
#[derive(Debug, Clone)]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    /// The library root: `~/Epicenter`, `~/Epicenter Dev`, or
    /// `EPICENTER_FOLDER_DIR`.
    pub folder_dir: PathBuf,
}

impl DesktopPaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let data_dir = resolve_data_dir(
            &app.config().identifier,
            std::env::var_os("EPICENTER_DATA_DIR").as_deref(),
            || {
                app.path()
                    .local_data_dir()
                    .map_err(|error| error.to_string())
            },
        )?;
        let folder_dir = resolve_folder_root(
            &app.config().identifier,
            std::env::var_os("EPICENTER_FOLDER_DIR").as_deref(),
            || app.path().home_dir().map_err(|error| error.to_string()),
        )?;
        for path in [&data_dir, &folder_dir] {
            path.to_str()
                .ok_or("Desktop directories must be valid UTF-8.")?;
        }
        Ok(Self {
            data_dir,
            folder_dir,
        })
    }

    /// Create or reuse `<folder_dir>/<id>` after admitting it. Writes no
    /// configuration.
    pub fn open_default(&self, definition: LibraryDefault) -> Result<crate::Directory, String> {
        library::open_default(&self.data_dir, &self.folder_dir, definition)
    }
}

fn resolve_data_dir(
    identifier: &str,
    value: Option<&OsStr>,
    base: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    resolve_directory("EPICENTER_DATA_DIR", value, || {
        let scope = match identifier {
            "so.epicenter" | "so.epicenter.todos" => "so.epicenter",
            "so.epicenter.dev" | "so.epicenter.todos.dev" => "so.epicenter.dev",
            identifier => {
                return Err(format!(
                "No shared configuration scope for {identifier}; set EPICENTER_DATA_DIR explicitly"
            ))
            }
        };
        Ok(base()?.join(scope))
    })
}

fn resolve_directory(
    variable: &str,
    value: Option<&OsStr>,
    fallback: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = Path::new(value);
            if !path.is_absolute() {
                return Err(format!(
                    "{variable} must be an absolute path, not {value:?}."
                ));
            }
            Ok(path.to_path_buf())
        }
        None => fallback(),
    }
}

/// Resolve the authored root before opening any app windows. A nonempty,
/// absolute `EPICENTER_FOLDER_DIR` wins without looking up the home directory.
/// Otherwise the bundle's storage environment selects `~/Epicenter` or
/// `~/Epicenter Dev`. This computes a path; `open_default` admits and creates
/// the fixed child an ordinary launch opens.
fn resolve_folder_root(
    identifier: &str,
    override_value: Option<&OsStr>,
    home: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    resolve_directory("EPICENTER_FOLDER_DIR", override_value, || {
        let name = match identifier {
            "so.epicenter" | "so.epicenter.todos" => "Epicenter",
            "so.epicenter.dev" | "so.epicenter.todos.dev" => "Epicenter Dev",
            _ => {
                return Err(format!(
                    "No authored root for {identifier}; set EPICENTER_FOLDER_DIR explicitly"
                ))
            }
        };
        Ok(home()?.join(name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_and_host_share_machine_configuration_but_development_is_separate() {
        let base = std::env::temp_dir().join("application-support");
        for (host, standalone, scope) in [
            ("so.epicenter", "so.epicenter.todos", "so.epicenter"),
            (
                "so.epicenter.dev",
                "so.epicenter.todos.dev",
                "so.epicenter.dev",
            ),
        ] {
            for identifier in [host, standalone] {
                assert_eq!(
                    resolve_data_dir(identifier, None, || Ok(base.clone())).unwrap(),
                    base.join(scope)
                );
                assert_eq!(
                    resolve_data_dir(identifier, Some(base.as_os_str()), || panic!(
                        "override wins"
                    ))
                    .unwrap(),
                    base
                );
                assert!(
                    resolve_data_dir(identifier, Some(OsStr::new("relative")), || panic!(
                        "reject before lookup"
                    ))
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn shipped_epicenter_and_todos_configs_select_the_same_library_root() {
        let home = std::env::temp_dir().join("epicenter-home");
        for (epicenter, standalone, name) in [
            (
                include_str!("../../../apps/epicenter/src-tauri/tauri.conf.json"),
                include_str!("../../../apps/todos/src-tauri/tauri.conf.json"),
                "Epicenter",
            ),
            (
                include_str!("../../../apps/epicenter/src-tauri/tauri.dev.conf.json"),
                include_str!("../../../apps/todos/src-tauri/tauri.dev.conf.json"),
                "Epicenter Dev",
            ),
        ] {
            for config in [epicenter, standalone] {
                let config: serde_json::Value = serde_json::from_str(config).unwrap();
                let identifier = config["identifier"].as_str().unwrap();
                for value in [None, Some(OsStr::new(""))] {
                    let root = resolve_folder_root(identifier, value, || Ok(home.clone())).unwrap();
                    assert_eq!(
                        library::TODOS.path(&root),
                        home.join(name).join("so.epicenter.todos")
                    );
                }
                let elsewhere = home.join("elsewhere");
                let root = resolve_folder_root(identifier, Some(elsewhere.as_os_str()), || {
                    panic!("an explicit root does not need the home directory")
                })
                .unwrap();
                assert_eq!(
                    library::TODOS.path(&root),
                    elsewhere.join("so.epicenter.todos")
                );
            }
        }
    }

    #[test]
    fn invalid_overrides_and_unknown_environments_fail_without_resolving_home() {
        let no_home = || panic!("home must not be resolved");
        let error =
            resolve_folder_root("so.epicenter", Some(OsStr::new("relative")), no_home).unwrap_err();
        assert!(error.contains("EPICENTER_FOLDER_DIR must be an absolute path"));
        assert!(resolve_folder_root("unknown", None, no_home).is_err());
        let explicit = std::env::temp_dir().join("explicit-root");
        assert_eq!(
            resolve_folder_root("unknown", Some(explicit.as_os_str()), no_home).unwrap(),
            explicit
        );
        assert_eq!(
            resolve_folder_root("so.epicenter", None, || Err("no home".to_string())),
            Err("no home".to_string())
        );
    }
}
