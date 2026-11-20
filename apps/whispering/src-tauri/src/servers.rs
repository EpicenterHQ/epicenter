//! Asks the person's OpenAI-compatible servers: `transcribe` sends a
//! recording's audio to `POST <base>/audio/transcriptions`, and `complete`
//! sends text and instructions to `POST <base>/chat/completions`, which
//! cleanup uses. Each answers the text the server gave.
//!
//! The requests are made here rather than in the page: the API key stays in
//! Rust (`keys.rs`), and the page's content security policy keeps allowing
//! no network origin.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::{files, keys};

/// How long a transcription may take in all: a long recording on a slow
/// server takes minutes.
const TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long reaching the server may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How much of a body that is not JSON an error quotes.
const EXCERPT: usize = 200;

/// Why a server gave no text. The page switches on `name`; `message`
/// says it for a person. No variant carries the API key.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "name")]
pub enum ServerError {
    /// The recording's audio is not there to send.
    NoAudio { message: String },
    /// The server refused the API key, or wanted one (401 or 403).
    Unauthorized { message: String },
    /// The server answered with another error status.
    Rejected { status: u16, message: String },
    /// The server could not be reached or did not answer in time.
    Unreachable { message: String },
    /// The server answered success without a `text`.
    BadResponse { message: String },
    /// The Keychain did not give up the key it keeps for the server.
    KeyUnreadable { message: String },
}

/// The transcript of the recording `id`, from the server at `base_url`
/// with `model`. `prompt`, when given, is sent as the request's `prompt`:
/// words the server should spell as written. The server's key, when one is
/// kept, goes as a bearer token.
#[tauri::command]
pub async fn transcribe<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    base_url: String,
    model: String,
    prompt: Option<String>,
) -> Result<String, ServerError> {
    if !is_bare_name(&id) {
        return Err(ServerError::NoAudio {
            message: format!("{id:?} is not a recording"),
        });
    }
    keys::origin(&base_url).map_err(|message| ServerError::Unreachable { message })?;
    let path = files::recordings_dir(&app)
        .map_err(|message| ServerError::NoAudio { message })?
        .join(format!("{id}.webm"));
    let endpoint = endpoint(&base_url);
    let (audio, key) = tauri::async_runtime::spawn_blocking(move || {
        let audio = std::fs::read(&path).map_err(|error| ServerError::NoAudio {
            message: match error.kind() {
                std::io::ErrorKind::NotFound => "This recording's audio is gone.".to_string(),
                _ => format!("This recording's audio could not be read: {error}"),
            },
        })?;
        let key = keys::read(&app, &base_url)
            .map_err(|message| ServerError::KeyUnreadable { message })?;
        Ok((audio, key))
    })
    .await
    // The read stopped without finishing (it panicked); say so rather than
    // claim the audio is gone.
    .map_err(|error| ServerError::NoAudio {
        message: format!("Reading the recording stopped: {error}"),
    })??;
    send(
        &endpoint,
        &model,
        prompt.as_deref(),
        key.as_deref(),
        audio,
        format!("{id}.webm"),
    )
    .await
}

/// The answer of the chat model `model` at `base_url` to `instructions`
/// (the system message) and `text` (the user message), trimmed. The request
/// is given up after `timeout_ms`: cleanup waits only so long before the
/// person gets the text without it.
#[tauri::command]
pub async fn complete<R: Runtime>(
    app: AppHandle<R>,
    base_url: String,
    model: String,
    instructions: String,
    text: String,
    timeout_ms: u64,
) -> Result<String, ServerError> {
    keys::origin(&base_url).map_err(|message| ServerError::Unreachable { message })?;
    let key = {
        let base_url = base_url.clone();
        tauri::async_runtime::spawn_blocking(move || keys::read(&app, &base_url))
            .await
            .map_err(|error| ServerError::KeyUnreadable {
                message: format!("Reading the key stopped: {error}"),
            })?
            .map_err(|message| ServerError::KeyUnreadable { message })?
    };
    chat(
        &chat_endpoint(&base_url),
        &model,
        &instructions,
        &text,
        key.as_deref(),
        Duration::from_millis(timeout_ms),
    )
    .await
}

/// Whether `id` names a file in `recordings/` and nothing outside it:
/// letters, digits, `-` and `_` only.
fn is_bare_name(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Where a server at `base_url` takes audio.
fn endpoint(base_url: &str) -> String {
    format!("{}/audio/transcriptions", base_url.trim_end_matches('/'))
}

/// Where a server at `base_url` takes a chat request.
fn chat_endpoint(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// The error for a request to `endpoint` that failed before an answer.
fn unreachable(endpoint: &str) -> impl Fn(reqwest::Error) -> ServerError + '_ {
    move |error| ServerError::Unreachable {
        message: if error.is_timeout() {
            format!("{endpoint} did not answer in time.")
        } else {
            format!("{endpoint} could not be reached: {}", error.without_url())
        },
    }
}

/// Send `request` with `key`, when there is one, and read the answer's
/// status and body.
async fn post(
    endpoint: &str,
    request: reqwest::RequestBuilder,
    key: Option<&str>,
) -> Result<(u16, Vec<u8>), ServerError> {
    let request = match key {
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    let response = request.send().await.map_err(unreachable(endpoint))?;
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(unreachable(endpoint))?;
    Ok((status, body.to_vec()))
}

/// Post `audio` as `file_name` to `endpoint`, with `prompt` when given,
/// and read the answer.
async fn send(
    endpoint: &str,
    model: &str,
    prompt: Option<&str>,
    key: Option<&str>,
    audio: Vec<u8>,
    file_name: String,
) -> Result<String, ServerError> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(unreachable(endpoint))?;
    let file = reqwest::multipart::Part::bytes(audio)
        .file_name(file_name)
        .mime_str("audio/webm")
        .map_err(unreachable(endpoint))?;
    let mut form = reqwest::multipart::Form::new().text("model", model.to_string());
    if let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) {
        form = form.text("prompt", prompt.to_string());
    }
    let form = form.part("file", file);
    let (status, body) = post(endpoint, client.post(endpoint).multipart(form), key).await?;
    answer(status, &body, transcription_text)
}

/// The `text` of a transcription's answer.
fn transcription_text(body: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Transcription {
        text: String,
    }
    serde_json::from_slice::<Transcription>(body)
        .ok()
        .map(|transcription| transcription.text)
}

/// Post a chat request to `endpoint` and read the first choice's message.
async fn chat(
    endpoint: &str,
    model: &str,
    instructions: &str,
    text: &str,
    key: Option<&str>,
    timeout: Duration,
) -> Result<String, ServerError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout.min(CONNECT_TIMEOUT))
        .build()
        .map_err(unreachable(endpoint))?;
    let request = serde_json::json!({
        "model": model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": instructions },
            { "role": "user", "content": text },
        ],
    });
    let request = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(request.to_string());
    let (status, body) = post(endpoint, request, key).await?;
    answer(status, &body, chat_text)
}

/// The first choice's message in a chat answer.
fn chat_text(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    Some(
        value
            .pointer("/choices/0/message/content")?
            .as_str()?
            .to_string(),
    )
}

/// The text `read` finds in a server's answer, trimmed, or why it gave none.
fn answer(
    status: u16,
    body: &[u8],
    read: impl FnOnce(&[u8]) -> Option<String>,
) -> Result<String, ServerError> {
    match status {
        200..=299 => read(body)
            .map(|text| text.trim().to_string())
            .ok_or_else(|| ServerError::BadResponse {
                message: format!("The server's answer had no text: {}", excerpt(body)),
            }),
        401 | 403 => Err(ServerError::Unauthorized {
            message: match server_message(body) {
                Some(reason) => format!("The server did not accept the API key: {reason}"),
                None => format!("The server did not accept the API key ({status})."),
            },
        }),
        _ => Err(ServerError::Rejected {
            status,
            message: format!(
                "The server answered {status}: {}",
                server_message(body).unwrap_or_else(|| excerpt(body))
            ),
        }),
    }
}

/// What an error body says: `error.message` in OpenAI's shape, a plain
/// `error` string, or `detail` as FastAPI servers send it.
fn server_message(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let said = value
        .pointer("/error/message")
        .or_else(|| value.get("error"))
        .or_else(|| value.get("detail"))?
        .as_str()?
        .trim();
    (!said.is_empty()).then(|| said.to_string())
}

/// The start of `body` as text, for an answer that is not JSON.
fn excerpt(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if text.is_empty() {
        return "no body".to_string();
    }
    match text.char_indices().nth(EXCERPT) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    use super::*;

    fn answer_text(status: u16, body: &[u8]) -> Result<String, ServerError> {
        answer(status, body, transcription_text)
    }

    #[test]
    fn a_recording_id_is_a_bare_name() {
        assert!(is_bare_name("2026-10-30T22-41-05-123Z-k3x9a2f8"));
        for refused in ["", "../a", "a/b", "a.webm", "a b"] {
            assert!(!is_bare_name(refused), "{refused}");
        }
    }

    #[test]
    fn the_endpoint_follows_the_base_url_with_or_without_a_slash() {
        assert_eq!(
            endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(
            endpoint("http://localhost:8000/v1/"),
            "http://localhost:8000/v1/audio/transcriptions"
        );
    }

    #[test]
    fn success_answers_the_trimmed_text() {
        assert_eq!(
            answer_text(200, br#"{"text":" Hello there. "}"#),
            Ok("Hello there.".to_string())
        );
        assert!(matches!(
            answer_text(200, b"{}"),
            Err(ServerError::BadResponse { .. })
        ));
        assert!(matches!(
            answer_text(200, b"<html>"),
            Err(ServerError::BadResponse { .. })
        ));
    }

    #[test]
    fn a_refused_key_is_unauthorized() {
        let body =
            br#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#;
        assert_eq!(
            answer_text(401, body),
            Err(ServerError::Unauthorized {
                message: "The server did not accept the API key: Incorrect API key provided"
                    .to_string()
            })
        );
        assert!(matches!(
            answer_text(403, b""),
            Err(ServerError::Unauthorized { .. })
        ));
    }

    #[test]
    fn another_error_quotes_the_server() {
        assert_eq!(
            answer_text(400, br#"{"error":{"message":"Invalid file format."}}"#),
            Err(ServerError::Rejected {
                status: 400,
                message: "The server answered 400: Invalid file format.".to_string()
            })
        );
        assert_eq!(
            answer_text(422, br#"{"detail":"Model not found"}"#),
            Err(ServerError::Rejected {
                status: 422,
                message: "The server answered 422: Model not found".to_string()
            })
        );
        let Err(ServerError::Rejected { message, .. }) =
            answer_text(502, "x".repeat(500).as_bytes())
        else {
            panic!("a 502 is rejected");
        };
        assert_eq!(
            message,
            format!("The server answered 502: {}...", "x".repeat(EXCERPT))
        );
        assert!(matches!(
            answer_text(500, b""),
            Err(ServerError::Rejected { status: 500, .. })
        ));
    }

    #[test]
    fn an_error_serializes_with_its_name() {
        let json = serde_json::to_value(ServerError::Rejected {
            status: 400,
            message: "m".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "name": "Rejected", "status": 400, "message": "m" })
        );
    }

    /// A server on a local port that answers one request with `status` and
    /// `body`, and hands back the request it read.
    fn serve_once(status: &'static str, body: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let (sent, received) = mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut head = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut content = vec![0; length];
            reader.read_exact(&mut content).unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            reader.get_mut().write_all(response.as_bytes()).unwrap();
            sent.send(head + &String::from_utf8_lossy(&content))
                .unwrap();
        });
        (base, received)
    }

    fn send_to(base: &str, key: Option<&str>) -> Result<String, ServerError> {
        tauri::async_runtime::block_on(send(
            &endpoint(base),
            "whisper-1",
            None,
            key,
            b"AUDIO".to_vec(),
            "a.webm".to_string(),
        ))
    }

    #[test]
    fn a_server_answers_text_for_a_multipart_post() {
        let (base, request) = serve_once("200 OK", r#"{"text":"Hello."}"#);
        assert_eq!(send_to(&base, Some("sk-test")), Ok("Hello.".to_string()));
        let request = request.recv().unwrap();
        assert!(
            request.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains("authorization: Bearer sk-test\r\n"),
            "{request}"
        );
        assert!(
            request.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"),
            "{request}"
        );
        assert!(
            request.contains(
                "name=\"file\"; filename=\"a.webm\"\r\nContent-Type: audio/webm\r\n\r\nAUDIO\r\n"
            ),
            "{request}"
        );
    }

    #[test]
    fn hints_go_as_the_prompt() {
        let (base, request) = serve_once("200 OK", r#"{"text":"Hi."}"#);
        let sent = tauri::async_runtime::block_on(send(
            &endpoint(&base),
            "whisper-1",
            Some("Epicenter, Whispering."),
            None,
            b"AUDIO".to_vec(),
            "a.webm".to_string(),
        ));
        assert_eq!(sent, Ok("Hi.".to_string()));
        let request = request.recv().unwrap();
        assert!(
            request.contains("name=\"prompt\"\r\n\r\nEpicenter, Whispering.\r\n"),
            "{request}"
        );
    }

    #[test]
    fn a_chat_answers_the_first_message() {
        let (base, request) = serve_once(
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":" Ship it Friday. "}}]}"#,
        );
        let answered = tauri::async_runtime::block_on(chat(
            &chat_endpoint(&base),
            "llama",
            "Clean this up.",
            "ship it tomorrow no friday",
            Some("sk-test"),
            Duration::from_secs(5),
        ));
        assert_eq!(answered, Ok("Ship it Friday.".to_string()));
        let request = request.recv().unwrap();
        assert!(
            request.starts_with("POST /v1/chat/completions HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains(r#"{"content":"Clean this up.","role":"system"}"#),
            "{request}"
        );
        assert!(
            request.contains(r#"{"content":"ship it tomorrow no friday","role":"user"}"#),
            "{request}"
        );
        assert!(matches!(
            answer(200, b"{}", chat_text),
            Err(ServerError::BadResponse { .. })
        ),);
    }

    #[test]
    fn no_key_sends_no_authorization() {
        let (base, request) = serve_once("200 OK", r#"{"text":"Hi."}"#);
        assert_eq!(send_to(&base, None), Ok("Hi.".to_string()));
        assert!(!request
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
    }

    #[test]
    fn a_server_that_refuses_the_key_is_unauthorized() {
        let (base, _request) = serve_once(
            "401 Unauthorized",
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
        );
        assert!(matches!(
            send_to(&base, Some("sk-wrong")),
            Err(ServerError::Unauthorized { .. })
        ));
    }

    #[test]
    fn a_server_error_body_is_quoted() {
        let (base, _request) = serve_once(
            "400 Bad Request",
            r#"{"error":{"message":"Invalid file format."}}"#,
        );
        assert_eq!(
            send_to(&base, None),
            Err(ServerError::Rejected {
                status: 400,
                message: "The server answered 400: Invalid file format.".to_string()
            })
        );
    }

    #[test]
    fn a_closed_port_is_unreachable() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let refused = send_to(&format!("http://127.0.0.1:{port}/v1"), Some("sk-secret"));
        let Err(ServerError::Unreachable { message }) = refused else {
            panic!("{refused:?}");
        };
        assert!(!message.contains("sk-secret"), "{message}");
    }
}
