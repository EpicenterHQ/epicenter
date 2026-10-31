//! Values this app keeps out of its folder: the page's connections (base
//! URLs, models, and API keys) and the signed-in account's refresh token.
//!
//! They live in the operating system's credential store (Keychain, Windows
//! Credential Manager, Secret Service) through the `keyring` crate, one entry
//! per name under the app's own identifier as the service, so a development
//! build (`so.epicenter.whispering.dev`) never reads a release build's
//! entries. Nothing here is synchronized or written to the folder.
//!
//! A page reads and writes only names it may (`secret_get`, `secret_set`);
//! `account` is this shell's alone (`account.rs`).
//!
//! A debug build started with `WHISPERING_SECRETS_FILE=<path>` keeps them in
//! that JSON file instead, so automated runs never touch the person's
//! keychain. A release build ignores the variable.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// The entry the account's refresh token is kept under. Never a page's.
pub const ACCOUNT: &str = "account";

/// Where secrets are kept.
pub enum Secrets {
    Keychain { service: String },
    File { path: PathBuf, lock: Mutex<()> },
}

impl Secrets {
    /// The credential store under `identifier`, or the debug file the
    /// environment names.
    pub fn for_app(identifier: &str) -> Self {
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("WHISPERING_SECRETS_FILE").filter(|v| !v.is_empty()) {
            return Self::File {
                path: path.into(),
                lock: Mutex::new(()),
            };
        }
        Self::Keychain {
            service: identifier.to_owned(),
        }
    }

    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self {
            Self::Keychain { service } => {
                let entry = keyring::Entry::new(service, name).map_err(describe)?;
                match entry.get_password() {
                    Ok(value) => Ok(Some(value)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(error) => Err(describe(error)),
                }
            }
            Self::File { path, lock } => {
                let _held = lock.lock().map_err(|_| "The secrets file lock failed.")?;
                Ok(read_file(path)?.remove(name))
            }
        }
    }

    /// Store `value` under `name`, or remove the entry for `None`. Removing
    /// one that is not there is not an error.
    pub fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        match self {
            Self::Keychain { service } => {
                let entry = keyring::Entry::new(service, name).map_err(describe)?;
                match value {
                    Some(value) => entry.set_password(value).map_err(describe),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(error) => Err(describe(error)),
                    },
                }
            }
            Self::File { path, lock } => {
                let _held = lock.lock().map_err(|_| "The secrets file lock failed.")?;
                let mut entries = read_file(path)?;
                match value {
                    Some(value) => entries.insert(name.to_owned(), value.to_owned()),
                    None => entries.remove(name),
                };
                let text = serde_json::to_string_pretty(&entries).map_err(describe)?;
                std::fs::write(path, text).map_err(describe)
            }
        }
    }
}

fn read_file(path: &PathBuf) -> Result<BTreeMap<String, String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("{} does not read: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(describe(error)),
    }
}

fn describe(error: impl std::fmt::Display) -> String {
    format!("This computer's credential store could not be used: {error}")
}

/// Whether a page may read or write `name`: one lowercase segment of
/// letters, digits, `.` and `-` (ADR-0682's grammar), never the shell's own
/// account entry.
pub fn page_may_use(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
        && name != ACCOUNT
}

/// Manages [`Secrets`] under the app's bundle identifier, which only the
/// built context knows.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("whispering-secrets")
        .setup(|app, _| {
            use tauri::Manager;
            app.manage(Secrets::for_app(&app.config().identifier));
            Ok(())
        })
        .build()
}

/// A page's read of one of its entries.
#[tauri::command]
pub fn secret_get(
    name: String,
    secrets: tauri::State<'_, Secrets>,
) -> Result<Option<String>, String> {
    if !page_may_use(&name) {
        return Err(format!("A page may not read the secret {name:?}."));
    }
    secrets.get(&name)
}

/// A page's write of one of its entries; `null` removes it.
#[tauri::command]
pub fn secret_set(
    name: String,
    value: Option<String>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<(), String> {
    if !page_may_use(&name) {
        return Err(format!("A page may not write the secret {name:?}."));
    }
    secrets.set(&name, value.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_names_only_its_own_entries() {
        for name in ["connections", "a", "model.v2", "x-1"] {
            assert!(page_may_use(name), "{name}");
        }
        for name in [
            "",
            "account",
            "Connections",
            ".hidden",
            "a/b",
            "a b",
            &"x".repeat(65),
        ] {
            assert!(!page_may_use(name), "{name}");
        }
    }

    #[test]
    fn the_file_store_round_trips_and_removes() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::File {
            path: dir.path().join("secrets.json"),
            lock: Mutex::new(()),
        };
        assert_eq!(secrets.get("connections").unwrap(), None);
        secrets.set("connections", Some("{\"a\":1}")).unwrap();
        secrets.set(ACCOUNT, Some("token")).unwrap();
        assert_eq!(
            secrets.get("connections").unwrap().as_deref(),
            Some("{\"a\":1}")
        );
        secrets.set("connections", None).unwrap();
        secrets.set("connections", None).unwrap();
        assert_eq!(secrets.get("connections").unwrap(), None);
        assert_eq!(secrets.get(ACCOUNT).unwrap().as_deref(), Some("token"));
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        std::fs::write(&path, "not json").unwrap();
        let secrets = Secrets::File {
            path,
            lock: Mutex::new(()),
        };
        assert!(secrets.get("connections").is_err());
        assert!(secrets.set("connections", Some("x")).is_err());
    }
}
