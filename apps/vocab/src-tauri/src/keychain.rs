//! Vocab's secrets in this computer's keychain: each connected endpoint's
//! saved endpoint and API key, and the sign-in's refresh token. The keychain
//! is reached the way Epicenter's shell reached it (`keyring`, main's
//! `keyring_storage.rs`): Rust owns the service and entry names, and a page
//! names only a connection id.
//!
//! Entries are filed under the bundle identifier (`so.epicenter.vocab`, or
//! `so.epicenter.vocab.dev` for a development build, so the two never share
//! an entry across code signatures). A debug build started with
//! `EPICENTER_TEST_SECRETS` keeps them in memory for the process instead, so
//! tests and smoke runs never touch the real keychain.

use std::collections::HashMap;
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

/// The store this run uses: the keychain, or, in a debug build started with
/// `EPICENTER_TEST_SECRETS`, memory.
pub fn for_app(identifier: &str) -> Arc<dyn Secrets> {
    if cfg!(debug_assertions) && std::env::var_os("EPICENTER_TEST_SECRETS").is_some() {
        return Arc::new(Memory::default());
    }
    Arc::new(Keychain::new(identifier))
}

/// Managed state: the app's secrets.
pub struct AppSecrets(pub Arc<dyn Secrets>);

/// A connection id as the page's connection list mints them (nanoid).
fn connection_entry(id: &str) -> Result<String, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return Err(format!("{id:?} is not a connection id."));
    }
    Ok(format!("connection:{id}"))
}

/// Run keychain work off the window thread: a keychain may ask the person.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// The saved entries of the connections `ids` names, by id; an id with none
/// is left out. Each value is what `set_connection_key` saved.
#[tauri::command]
pub async fn connection_keys(
    secrets: State<'_, AppSecrets>,
    ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let secrets = secrets.0.clone();
    blocking(move || read_connection_keys(&*secrets, &ids)).await
}

/// Save a connection's entry, or remove it for `None`.
#[tauri::command]
pub async fn set_connection_key(
    secrets: State<'_, AppSecrets>,
    id: String,
    value: Option<String>,
) -> Result<(), String> {
    let secrets = secrets.0.clone();
    blocking(move || secrets.set(&connection_entry(&id)?, value.as_deref())).await
}

fn read_connection_keys(
    secrets: &dyn Secrets,
    ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut found = HashMap::new();
    for id in ids {
        if let Some(value) = secrets.get(&connection_entry(id)?)? {
            found.insert(id.clone(), value);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_names_one_entry_and_nothing_else() {
        assert_eq!(
            connection_entry("V1StGXR8_Z5jdHi6B-myT").unwrap(),
            "connection:V1StGXR8_Z5jdHi6B-myT"
        );
        for id in [
            "",
            "../x",
            "a:b",
            "account:https://api",
            "a b",
            &"x".repeat(65),
        ] {
            assert!(connection_entry(id).is_err(), "{id}");
        }
    }

    #[test]
    fn keys_are_read_back_by_id_and_removed() {
        let secrets = Memory::default();
        let ids = ["a".to_string(), "b".to_string()];
        assert!(read_connection_keys(&secrets, &ids).unwrap().is_empty());
        secrets
            .set(&connection_entry("a").unwrap(), Some("{\"key\":\"sk\"}"))
            .unwrap();
        assert_eq!(
            read_connection_keys(&secrets, &ids).unwrap(),
            HashMap::from([("a".to_string(), "{\"key\":\"sk\"}".to_string())])
        );
        secrets.set(&connection_entry("a").unwrap(), None).unwrap();
        assert!(read_connection_keys(&secrets, &ids).unwrap().is_empty());
        assert!(read_connection_keys(&secrets, &["../a".to_string()]).is_err());
    }
}
