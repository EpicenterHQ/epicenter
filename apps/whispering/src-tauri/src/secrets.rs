//! This computer's secrets, the provider API keys, as Keychain items (the
//! platform's credential store elsewhere), one per name, under the app's
//! bundle identifier (ADR-0894). The page reads a key when a request needs
//! one and sends the request itself; a key is never in the folder.
//!
//! The Keychain asks before another program reads an item, which the
//! WebView's `localStorage` file does not.

use tauri::{AppHandle, Runtime};

/// Why a secret was not read or kept.
fn failed(name: &str, error: keyring::Error) -> String {
    format!("The key {name} could not be reached in the Keychain: {error}")
}

/// Whether `name` is a secret's name: 1 to 128 letters, digits, `.`, `_` or `-`.
fn valid(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if plain {
        Ok(())
    } else {
        Err(format!("{name:?} is not a secret's name"))
    }
}

fn entry<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<keyring::Entry, String> {
    valid(name)?;
    keyring::Entry::new(&app.config().identifier, name).map_err(|error| failed(name, error))
}

/// The secret kept as `name`, or null when none is.
#[tauri::command]
pub async fn secret_get<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<Option<String>, String> {
    let entry = entry(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(failed(&name, error)),
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Keep `value` as `name`; null forgets it.
#[tauri::command]
pub async fn secret_set<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    value: Option<String>,
) -> Result<(), String> {
    let entry = entry(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || match value {
        Some(value) => entry
            .set_password(&value)
            .map_err(|error| failed(&name, error)),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(failed(&name, error)),
        },
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_named_plainly() {
        for name in ["connection.k3x9", "openai", "a-b_c.d"] {
            assert!(valid(name).is_ok(), "{name}");
        }
        for name in ["", "a/b", "a b", "../x", &"x".repeat(129)] {
            assert!(valid(name).is_err(), "{name}");
        }
    }
}
