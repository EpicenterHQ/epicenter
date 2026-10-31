//! An app's secrets in this computer's keychain, and the one way any
//! standalone app reaches it: the sign-in's refresh token (`account`, never a
//! page's), and the API keys a page saves under names of its own
//! (`keychain_get`, `keychain_set`). Rust owns the service and the entry
//! names; a page names only its key.
//!
//! Entries are filed under the bundle identifier as the service
//! (`so.epicenter.vocab`, or `so.epicenter.vocab.dev` for a development build,
//! so the two never share an entry across code signatures). A page's key
//! `openai` is the entry `key:openai`; the refresh token is
//! `account:<origin>`, which no page name can reach.
//!
//! A debug build started with `EPICENTER_SECRETS_FILE=<path>` keeps them in
//! that JSON file instead, so tests and smoke runs never touch the person's
//! keychain and still see their keys after a relaunch. A release build
//! ignores the variable.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::State;

/// A store of named secrets. Reads and writes may block on the system.
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    /// Save `value` under `name`, or remove the entry for `None`.
    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// The OS keychain, one entry per name under `service`.
pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, name)
            .map_err(|error| format!("The keychain could not be opened: {error}"))
    }
}

impl Secrets for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self.entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("The keychain could not be read: {error}")),
        }
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let entry = self.entry(name)?;
        match value {
            Some(value) => entry
                .set_password(value)
                .map_err(|error| format!("The keychain could not be written: {error}")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("The keychain entry could not be removed: {error}")),
            },
        }
    }
}

/// Secrets held for one process only.
#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, String>>);

impl Secrets for Memory {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut entries = self.0.lock().unwrap();
        match value {
            Some(value) => entries.insert(name.to_string(), value.to_string()),
            None => entries.remove(name),
        };
        Ok(())
    }
}

/// Secrets in one JSON file (`{ name: value }`), for a debug build's runs.
pub struct File {
    path: PathBuf,
    lock: Mutex<()>,
}

impl File {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|error| format!("{} is not a secrets file: {error}", self.path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(format!(
                "{} could not be read: {error}",
                self.path.display()
            )),
        }
    }
}

impl Secrets for File {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let _held = self.lock.lock().unwrap();
        Ok(self.read()?.remove(name))
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let _held = self.lock.lock().unwrap();
        let mut entries = self.read()?;
        match value {
            Some(value) => entries.insert(name.to_string(), value.to_string()),
            None => entries.remove(name),
        };
        let text = serde_json::to_string_pretty(&entries).expect("secrets serialize");
        std::fs::write(&self.path, text)
            .map_err(|error| format!("{} could not be written: {error}", self.path.display()))
    }
}

/// The store this run uses: the keychain under `identifier`, or, in a debug
/// build started with `EPICENTER_SECRETS_FILE`, that file.
pub fn for_app(identifier: &str) -> Arc<dyn Secrets> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("EPICENTER_SECRETS_FILE").filter(|v| !v.is_empty()) {
            return Arc::new(File::new(path));
        }
    }
    Arc::new(Keychain::new(identifier))
}

/// Managed state: the app's secrets, which the account shares.
pub struct AppSecrets(pub Arc<dyn Secrets>);

/// The entry a page's key `name` is kept under. A name is what a page mints
/// for a key (a provider such as `openai`, or a connection's nanoid): letters,
/// digits, `_` and `-`, at most 64 of them, so it can never name the account.
pub(crate) fn key_entry(name: &str) -> Result<String, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(format!("{name:?} is not a key name."));
    }
    Ok(format!("key:{name}"))
}

/// Run keychain work off the window thread: a keychain may ask the person.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn read_keys(secrets: &dyn Secrets, names: &[String]) -> Result<HashMap<String, String>, String> {
    let mut found = HashMap::new();
    for name in names {
        if let Some(value) = secrets.get(&key_entry(name)?)? {
            found.insert(name.clone(), value);
        }
    }
    Ok(found)
}

/// The saved keys `names` names, by name; a name with none is left out.
#[tauri::command]
pub async fn keychain_get(
    secrets: State<'_, AppSecrets>,
    names: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let secrets = secrets.0.clone();
    blocking(move || read_keys(&*secrets, &names)).await
}

/// Save the key `name`, or remove it for `None`.
#[tauri::command]
pub async fn keychain_set(
    secrets: State<'_, AppSecrets>,
    name: String,
    value: Option<String>,
) -> Result<(), String> {
    let secrets = secrets.0.clone();
    blocking(move || secrets.set(&key_entry(&name)?, value.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_names_one_entry_and_never_the_account() {
        assert_eq!(key_entry("openai").unwrap(), "key:openai");
        assert_eq!(
            key_entry("V1StGXR8_Z5jdHi6B-myT").unwrap(),
            "key:V1StGXR8_Z5jdHi6B-myT"
        );
        for name in [
            "",
            "../x",
            "a:b",
            "account:https://api",
            "a b",
            &"x".repeat(65),
        ] {
            assert!(key_entry(name).is_err(), "{name}");
        }
    }

    #[test]
    fn keys_are_read_back_by_name_and_removed() {
        let secrets = Memory::default();
        let names = ["a".to_string(), "b".to_string()];
        assert!(read_keys(&secrets, &names).unwrap().is_empty());
        secrets.set(&key_entry("a").unwrap(), Some("sk-1")).unwrap();
        assert_eq!(
            read_keys(&secrets, &names).unwrap(),
            HashMap::from([("a".to_string(), "sk-1".to_string())])
        );
        secrets.set(&key_entry("a").unwrap(), None).unwrap();
        assert!(read_keys(&secrets, &names).unwrap().is_empty());
        assert!(read_keys(&secrets, &["../a".to_string()]).is_err());
    }

    #[test]
    fn a_secrets_file_keeps_entries_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        File::new(&path).set("key:openai", Some("sk-1")).unwrap();
        File::new(&path).set("account:x", Some("r")).unwrap();
        let reopened = File::new(&path);
        assert_eq!(reopened.get("key:openai").unwrap().as_deref(), Some("sk-1"));
        reopened.set("key:openai", None).unwrap();
        assert_eq!(reopened.get("key:openai").unwrap(), None);
        assert_eq!(reopened.get("account:x").unwrap().as_deref(), Some("r"));
    }
}
