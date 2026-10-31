//! Requests the page sends to transcription and AI endpoints, sent from here.
//!
//! A page's own `fetch` is held to its origin's CORS rules: Epicenter's API
//! trusts no `tauri://` page, and a local or self-hosted endpoint rarely
//! answers a browser at all. The desktop app sends these requests from Rust
//! instead, so every endpoint a person configures works as it does from a
//! terminal. The page still decides everything about the request (URL,
//! method, headers, body) and reads the whole answer; this is a transport,
//! not a policy. Only `http` and `https` URLs are sent; a redirect is
//! followed only within the same origin, so a key never leaves for another
//! host.
//!
//! The body arrives as the IPC request's raw bytes (audio can be minutes
//! long), and the URL, method and headers as one JSON header,
//! `x-whispering-request`, percent-encoded.

use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};

/// The request header carrying the request's description.
pub const DESCRIPTION_HEADER: &str = "x-whispering-request";

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Described {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// What the page reads back: the status, headers, and the body as base64.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
}

pub struct Sender {
    client: reqwest::Client,
}

impl Default for Sender {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let same_origin = attempt.previous().last().is_some_and(|from| {
                        from.scheme() == attempt.url().scheme()
                            && from.host_str() == attempt.url().host_str()
                            && from.port_or_known_default() == attempt.url().port_or_known_default()
                    });
                    if same_origin && attempt.previous().len() < 10 {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }))
                .connect_timeout(Duration::from_secs(30))
                .build()
                .expect("an HTTP client"),
        }
    }
}

fn percent_decode(value: &str) -> Result<String, String> {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let (Some(high), Some(low)) = (
                bytes.get(index + 1).copied().and_then(hex),
                bytes.get(index + 2).copied().and_then(hex),
            ) else {
                return Err("The request description is not percent-encoded.".into());
            };
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|error| error.to_string())
}

/// The request a page described, checked.
pub fn describe(header: &str) -> Result<Described, String> {
    let described: Described = serde_json::from_str(&percent_decode(header)?)
        .map_err(|error| format!("The request description does not read: {error}"))?;
    if !(described.url.starts_with("http://") || described.url.starts_with("https://")) {
        return Err(format!(
            "Only http and https requests are sent, not {}.",
            described.url
        ));
    }
    if !matches!(
        described.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) {
        return Err(format!(
            "{} is not a method this app sends.",
            described.method
        ));
    }
    Ok(described)
}

impl Sender {
    pub async fn send(&self, described: Described, body: Vec<u8>) -> Result<Answer, String> {
        let method = reqwest::Method::from_bytes(described.method.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut request = self.client.request(method, &described.url);
        for (name, value) in &described.headers {
            request = request.header(name, value);
        }
        if !body.is_empty() {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| {
            let mut message = error.to_string();
            let mut source = std::error::Error::source(&error);
            while let Some(cause) = source {
                message = format!("{message}: {cause}");
                source = cause.source();
            }
            message
        })?;
        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok(Answer {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_owned(),
            headers,
            body: STANDARD.encode(bytes),
        })
    }
}

/// Send the request the page described in `x-whispering-request`, with the
/// raw IPC body as its body, and answer the whole response.
#[tauri::command]
pub async fn send_request(
    request: Request<'_>,
    sender: tauri::State<'_, Sender>,
) -> Result<Answer, String> {
    let header = request
        .headers()
        .get(DESCRIPTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("The request has no description.")?;
    let described = describe(header)?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(serde_json::Value::Null) => Vec::new(),
        InvokeBody::Json(_) => return Err("The request body must be raw bytes.".into()),
    };
    sender.send(described, body).await
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use super::*;

    fn encode(text: &str) -> String {
        text.bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() {
                    char::from(byte).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect()
    }

    #[test]
    fn a_description_is_read_and_checked() {
        let described = describe(&encode(
            r#"{"url":"https://api.example/v1/x","method":"POST","headers":[["authorization","Bearer é"]]}"#,
        ))
        .unwrap();
        assert_eq!(described.headers[0].1, "Bearer é");
        for refused in [
            r#"{"url":"file:///etc/passwd","method":"GET"}"#,
            r#"{"url":"https://x","method":"CONNECT"}"#,
            "not json",
        ] {
            assert!(describe(&encode(refused)).is_err(), "{refused}");
        }
        assert!(describe("%zz").is_err());
    }

    #[tokio::test]
    async fn the_body_and_headers_go_and_the_whole_answer_comes_back() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/audio", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.ends_with(&[0, 1, 2]) {
                    break;
                }
            }
            stream
                .write_all(b"HTTP/1.1 201 Created\r\nx-answer: yes\r\ncontent-length: 2\r\n\r\nok")
                .unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        let answer = Sender::default()
            .send(
                Described {
                    url,
                    method: "POST".into(),
                    headers: vec![("authorization".into(), "Bearer k".into())],
                },
                vec![0, 1, 2],
            )
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/audio"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer k"));
        assert_eq!(answer.status, 201);
        assert_eq!(answer.body, STANDARD.encode("ok"));
        assert!(answer.headers.contains(&("x-answer".into(), "yes".into())));
    }
}
