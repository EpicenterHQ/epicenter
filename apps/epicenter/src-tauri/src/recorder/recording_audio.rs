//! Read one Whispering recording through the private Bun host boundary.
//!
//! Rust never resolves record storage paths. It presents the per-launch host
//! credential to the loopback-only route and addresses audio by record key.

use crate::recorder::error::RecorderError;
use crate::HostState;

/// Native decode/upload commands materialize the input before handing it to a
/// codec. Keep that allocation bounded independently of the replica's much
/// larger general-purpose blob ceiling.
const MAX_RECORDING_AUDIO_BYTES: u64 = 64 * 1024 * 1024;

fn validate_recording_id(id: &str) -> Result<(), RecorderError> {
    if id.len() != 24
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(RecorderError::failed(
            "recording id must be 24 lowercase ASCII letters or digits",
        ));
    }
    Ok(())
}

/// Fetch one record-owned audio blob for native upload encoding.
pub(crate) async fn read_recording_bytes(
    state: &HostState,
    recording_id: &str,
) -> Result<Vec<u8>, RecorderError> {
    validate_recording_id(recording_id)?;
    let token = state
        .active_token()
        .ok_or_else(|| RecorderError::failed("the Epicenter host is not ready"))?;
    let port = state
        .port()
        .map_err(|error| RecorderError::failed(format!("resolve Epicenter host: {error:#}")))?;
    let url = format!(
        "http://127.0.0.1:{port}/_epicenter/native/whispering/recordings/{recording_id}/audio"
    );

    let mut response = tauri_plugin_http::reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| RecorderError::failed(format!("read recording audio: {error}")))?;
    if !response.status().is_success() {
        return Err(RecorderError::failed(format!(
            "read recording audio: host returned {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RECORDING_AUDIO_BYTES)
    {
        return Err(RecorderError::failed(
            "recording audio exceeds the native processing limit",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| RecorderError::failed(format!("read recording audio body: {error}")))?
    {
        if chunk.len() as u64 > MAX_RECORDING_AUDIO_BYTES - bytes.len() as u64 {
            return Err(RecorderError::failed(
                "recording audio exceeds the native processing limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_id_validation_accepts_only_record_keys() {
        assert!(validate_recording_id("abc123abc123abc123abc123").is_ok());
        assert!(validate_recording_id("abc123").is_err());
        assert!(validate_recording_id("ABC123ABC123ABC123ABC123").is_err());
        assert!(validate_recording_id("abc123abc123abc123abc12/").is_err());
    }
}
