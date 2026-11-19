//! The transcription server's API key, as a Keychain item (the platform's
//! credential store elsewhere) under the app's bundle identifier, one per
//! server origin: switching servers and back keeps each server's key.
//!
//! The page can set a key and ask whether one is kept; it never reads one
//! back. `transcribe.rs` reads it in Rust when it sends a recording.

use tauri::{AppHandle, Runtime};

/// The origin of `base_url` (`https://api.openai.com`), which names its key,
/// or why `base_url` is not a server's address.
pub fn origin(base_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base_url)
        .map_err(|error| format!("{base_url:?} is not a server address: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(format!("{base_url:?} is not an http or https address"));
    }
    Ok(url.origin().ascii_serialization())
}

/// The key kept for `base_url`'s origin, or None when none is.
pub fn read<R: Runtime>(app: &AppHandle<R>, base_url: &str) -> Result<Option<String>, String> {
    let (origin, entry) = entry(app, base_url)?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(failed(&origin, error)),
    }
}

/// Keep `key` for `base_url`'s origin; an empty key forgets the one kept.
#[tauri::command]
pub async fn key_set<R: Runtime>(
    app: AppHandle<R>,
    base_url: String,
    key: String,
) -> Result<(), String> {
    let (origin, entry) = entry(&app, &base_url)?;
    tauri::async_runtime::spawn_blocking(move || {
        if key.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(failed(&origin, error)),
            }
        } else {
            entry
                .set_password(&key)
                .map_err(|error| failed(&origin, error))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether a key is kept for `base_url`'s origin.
#[tauri::command]
pub async fn key_exists<R: Runtime>(app: AppHandle<R>, base_url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || read(&app, &base_url).map(|key| key.is_some()))
        .await
        .map_err(|error| error.to_string())?
}

fn entry<R: Runtime>(
    app: &AppHandle<R>,
    base_url: &str,
) -> Result<(String, keyring::Entry), String> {
    let origin = origin(base_url)?;
    let entry = keyring::Entry::new(&app.config().identifier, &origin)
        .map_err(|error| failed(&origin, error))?;
    Ok((origin, entry))
}

/// Why the key was not read or kept. It names the server, never the key.
fn failed(origin: &str, error: keyring::Error) -> String {
    format!("The API key for {origin} could not be reached in the Keychain: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_named_by_its_servers_origin() {
        assert_eq!(
            origin("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com"
        );
        assert_eq!(
            origin("https://api.openai.com:443/v1/").unwrap(),
            "https://api.openai.com"
        );
        assert_eq!(
            origin("http://localhost:8000/v1").unwrap(),
            "http://localhost:8000"
        );
        assert_eq!(
            origin("HTTPS://API.Groq.com/openai/v1").unwrap(),
            "https://api.groq.com"
        );
        for refused in [
            "",
            "api.openai.com/v1",
            "ftp://example.com",
            "file:///tmp/x",
        ] {
            assert!(origin(refused).is_err(), "{refused}");
        }
    }
}
