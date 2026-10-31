//! The page's requests to an endpoint the person connected (an
//! OpenAI-compatible server they named, with a key they entered), sent from
//! here with the key the keychain keeps for it.
//!
//! A page's own `fetch` is held to CORS, and most such endpoints answer no
//! `tauri://` page. So the page names the connection and describes the
//! request, and this sends it: it reads what the keychain keeps for the
//! connection (`key:<id>`, the JSON `{ endpoint, key }` the page saved),
//! sends only to that endpoint's origin, and adds the key itself as
//! `Authorization: Bearer <key>`. A page never sends a credential here, and
//! the connection list a person can edit by hand (Vocab's `connections.md`)
//! cannot move the key: the endpoint the key goes to is the one saved with
//! it. A connection with no saved key is sent with none, wherever it names.
//!
//! Only `https` is sent, and `http` to `localhost` or `127.0.0.1` (a model on
//! this computer). A redirect is not followed. The answer streams back like
//! `account_fetch`'s (`relay.rs`), so a token stream reads as it arrives.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::keychain::{blocking, key_entry, Secrets};
use crate::relay::{self, send_event, RelayEvent, Requests};

/// Managed state: the keys' store, and the requests in flight.
pub struct Connections {
    http: reqwest::Client,
    secrets: Arc<dyn Secrets>,
    requests: Requests,
}

/// One request the page sends on the connection `connection`. `body` is
/// base64.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRequest {
    pub id: u32,
    pub connection: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// Why a connection's request was not sent, or ended without an answer.
/// The command refuses with it, and an error event carries it after `kind`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "name")]
pub enum ConnectionFetchError {
    /// The request does not read (its connection id, URL, method, headers or
    /// body), or carries a credential of the page's.
    InvalidRequest { message: String },
    /// Neither `https`, nor `http` to `localhost` or `127.0.0.1`.
    SchemeRefused { message: String },
    /// Not on the origin of the endpoint the connection's key was saved for.
    OriginRefused { message: String },
    /// The keychain could not be read.
    KeychainFailed { message: String },
    /// The endpoint could not be reached, or its answer broke off.
    SendFailed { message: String },
}

use ConnectionFetchError::*;

/// What the keychain keeps for a connection, as the page saved it.
#[derive(Debug, Deserialize)]
struct SavedKey {
    endpoint: String,
    key: String,
}

/// A request that may be sent, and the key that goes with it.
#[derive(Debug)]
struct Checked {
    method: Method,
    url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Option<Vec<u8>>,
    key: Option<String>,
}

/// Request headers that carry a credential, which only this side adds.
const CREDENTIALS: &[&str] = &["authorization", "proxy-authorization", "cookie"];
/// Request headers the HTTP client owns.
const CLIENT_OWNED: &[&str] = &["host", "content-length", "connection", "origin"];

/// Whether a request may go to `url`'s scheme and host at all.
fn scheme_allowed(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1")),
        _ => false,
    }
}

/// Check `request` against what the keychain keeps for its connection.
fn check(
    request: &ConnectionRequest,
    saved: Option<SavedKey>,
) -> Result<Checked, ConnectionFetchError> {
    let url = Url::parse(&request.url).map_err(|cause| InvalidRequest {
        message: format!("{} is not a URL: {cause}", request.url),
    })?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(InvalidRequest {
            message: "A connection's URL carries no user name or password.".into(),
        });
    }
    if !scheme_allowed(&url) {
        return Err(SchemeRefused {
            message: format!(
                "{} is not sent: only https, or http to localhost or 127.0.0.1.",
                url.origin().ascii_serialization()
            ),
        });
    }
    let key = match saved {
        None => None,
        Some(saved) => {
            let endpoint = Url::parse(&saved.endpoint).map_err(|cause| KeychainFailed {
                message: format!(
                    "The saved endpoint {} is not a URL: {cause}",
                    saved.endpoint
                ),
            })?;
            if endpoint.origin() != url.origin() {
                return Err(OriginRefused {
                    message: format!(
                        "This connection's key was saved for {}, not {}. Enter the key again for the new endpoint.",
                        endpoint.origin().ascii_serialization(),
                        url.origin().ascii_serialization()
                    ),
                });
            }
            Some(saved.key.trim().to_owned()).filter(|key| !key.is_empty())
        }
    };
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        "HEAD" => Method::HEAD,
        other => {
            return Err(InvalidRequest {
                message: format!("{other} is not a method a connection sends."),
            })
        }
    };
    let mut headers = Vec::new();
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if CREDENTIALS.contains(&lower.as_str()) {
            return Err(InvalidRequest {
                message: format!(
                    "The page sends no {lower} header; the connection's key is added here."
                ),
            });
        }
        if CLIENT_OWNED.contains(&lower.as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(lower.as_bytes()).map_err(|_| InvalidRequest {
            message: format!("{name:?} is not a header name."),
        })?;
        let value = HeaderValue::from_str(value).map_err(|_| InvalidRequest {
            message: format!("The {name} header's value is not a header value."),
        })?;
        headers.push((name, value));
    }
    let body = match request.body.as_deref() {
        None => None,
        Some(body) => Some(STANDARD.decode(body).map_err(|cause| InvalidRequest {
            message: format!("The request body is not base64: {cause}"),
        })?),
    };
    Ok(Checked {
        method,
        url,
        headers,
        body,
        key,
    })
}

impl Connections {
    pub fn new(secrets: Arc<dyn Secrets>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("an HTTP client"),
            secrets,
            requests: Requests::default(),
        }
    }

    /// `request`, checked against what the keychain keeps for its connection.
    async fn prepare(&self, request: &ConnectionRequest) -> Result<Checked, ConnectionFetchError> {
        let entry = key_entry(&request.connection).map_err(|message| InvalidRequest { message })?;
        let secrets = self.secrets.clone();
        let saved = blocking(move || secrets.get(&entry))
            .await
            .map_err(|message| KeychainFailed { message })?;
        // An entry that does not read holds no key to send, as the page reads it.
        let saved = saved.and_then(|text| serde_json::from_str::<SavedKey>(&text).ok());
        check(request, saved)
    }
}

/// Send `checked` and stream its answer to `channel`.
async fn send(http: &reqwest::Client, checked: Checked, channel: &Channel<InvokeResponseBody>) {
    let mut builder = http.request(checked.method, checked.url);
    for (name, value) in checked.headers {
        builder = builder.header(name, value);
    }
    if let Some(key) = checked.key {
        builder = builder.bearer_auth(key);
    }
    if let Some(body) = checked.body {
        builder = builder.body(body);
    }
    let failed = |message: String| SendFailed { message };
    match builder.send().await {
        Ok(response) => relay::answer(response, channel, failed).await,
        Err(cause) => {
            let mut message = cause.to_string();
            let mut source = std::error::Error::source(&cause);
            while let Some(inner) = source {
                message = format!("{message}: {inner}");
                source = inner.source();
            }
            send_event(channel, &RelayEvent::Error(failed(message)));
        }
    }
}

/// Send one request on the connection `request.connection`, with its saved
/// key, to its saved endpoint's origin only. Refuses a request it will not
/// send; otherwise the response arrives on `on_event` (its head, its body in
/// raw chunks, then its end or an error) and this answers once it is under
/// way.
#[tauri::command]
pub async fn connection_fetch(
    connections: State<'_, Arc<Connections>>,
    request: ConnectionRequest,
    on_event: Channel<InvokeResponseBody>,
) -> Result<(), ConnectionFetchError> {
    let checked = connections.prepare(&request).await?;
    let http = connections.http.clone();
    connections.requests.start(request.id, async move {
        send(&http, checked, &on_event).await;
    });
    Ok(())
}

/// Stop a request the page no longer wants.
#[tauri::command]
pub fn connection_fetch_cancel(connections: State<'_, Arc<Connections>>, id: u32) {
    connections.requests.cancel(id);
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::keychain::Memory;

    const ENDPOINT: &str = "https://api.example.com/v1";

    fn request(url: &str) -> ConnectionRequest {
        ConnectionRequest {
            id: 1,
            connection: "conn-1".into(),
            url: url.into(),
            method: "POST".into(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(STANDARD.encode("{}")),
        }
    }

    fn saved(endpoint: &str) -> Option<SavedKey> {
        Some(SavedKey {
            endpoint: endpoint.into(),
            key: " sk-1 ".into(),
        })
    }

    #[test]
    fn the_key_goes_only_to_its_saved_endpoints_origin() {
        let checked = check(
            &request(&format!("{ENDPOINT}/chat/completions")),
            saved(ENDPOINT),
        )
        .unwrap();
        assert_eq!(checked.key.as_deref(), Some("sk-1"));
        // The same origin under another path is still the endpoint's.
        assert!(check(&request("https://api.example.com/other"), saved(ENDPOINT)).is_ok());
        for url in [
            "https://evil.example/v1/chat/completions",
            "https://api.example.com.evil.example/v1",
            "https://api.example.com:8443/v1",
            "http://localhost:11434/v1/models",
        ] {
            assert!(
                matches!(
                    check(&request(url), saved(ENDPOINT)),
                    Err(OriginRefused { .. })
                ),
                "{url}"
            );
        }
    }

    #[test]
    fn only_https_or_http_to_this_computer_is_sent() {
        for url in [
            "http://api.example.com/v1/models",
            "http://192.168.1.5:11434/v1/models",
            "ftp://api.example.com/v1",
            "file:///etc/passwd",
        ] {
            assert!(
                matches!(check(&request(url), None), Err(SchemeRefused { .. })),
                "{url}"
            );
        }
        for url in [
            "http://localhost:11434/v1/models",
            "http://127.0.0.1:1234/v1/models",
            "https://api.example.com/v1/models",
        ] {
            let checked = check(&request(url), None).unwrap();
            assert_eq!(checked.key, None, "{url}");
        }
    }

    #[test]
    fn a_credential_or_a_bad_request_from_the_page_is_refused() {
        for name in ["Authorization", "cookie", "Proxy-Authorization"] {
            let mut sent = request(&format!("{ENDPOINT}/models"));
            sent.headers.push((name.into(), "Bearer page".into()));
            assert!(
                matches!(check(&sent, saved(ENDPOINT)), Err(InvalidRequest { .. })),
                "{name}"
            );
        }
        let mut sent = request("https://user:pass@api.example.com/v1");
        assert!(matches!(check(&sent, None), Err(InvalidRequest { .. })));
        sent = request(&format!("{ENDPOINT}/models"));
        sent.method = "CONNECT".into();
        assert!(matches!(check(&sent, None), Err(InvalidRequest { .. })));
        sent = request(&format!("{ENDPOINT}/models"));
        sent.body = Some("not base64!".into());
        assert!(matches!(check(&sent, None), Err(InvalidRequest { .. })));
        // The client's own headers are dropped, not refused.
        sent = request(&format!("{ENDPOINT}/models"));
        sent.headers.push(("Host".into(), "evil.example".into()));
        assert_eq!(check(&sent, None).unwrap().headers.len(), 1);
    }

    #[test]
    fn an_error_is_named_for_the_page() {
        assert_eq!(
            serde_json::to_value(OriginRefused {
                message: "m".into()
            })
            .unwrap(),
            serde_json::json!({ "name": "OriginRefused", "message": "m" })
        );
        assert_eq!(
            serde_json::to_value(RelayEvent::Error(SendFailed {
                message: "m".into()
            }))
            .unwrap(),
            serde_json::json!({ "kind": "error", "name": "SendFailed", "message": "m" })
        );
    }

    #[tokio::test]
    async fn a_connection_is_read_from_the_keychain_by_its_id() {
        let secrets = Arc::new(Memory::default());
        secrets
            .set(
                "key:conn-1",
                Some(&serde_json::json!({ "endpoint": ENDPOINT, "key": "sk-1" }).to_string()),
            )
            .unwrap();
        let connections = Connections::new(secrets);
        let checked = connections
            .prepare(&request(&format!("{ENDPOINT}/models")))
            .await
            .unwrap();
        assert_eq!(checked.key.as_deref(), Some("sk-1"));
        assert!(matches!(
            connections
                .prepare(&request("https://evil.example/v1/models"))
                .await,
            Err(OriginRefused { .. })
        ));
        let mut other = request("https://elsewhere.example/v1/models");
        other.connection = "conn-2".into();
        assert_eq!(connections.prepare(&other).await.unwrap().key, None);
        other.connection = "../account".into();
        assert!(matches!(
            connections.prepare(&other).await,
            Err(InvalidRequest { .. })
        ));
    }

    /// The test server sends its first chunk, waits until the page has it,
    /// then sends the rest: an answer read whole before it is passed on
    /// would never finish.
    #[tokio::test]
    async fn the_body_streams_back_in_order_with_the_key_added() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (first_heard, mut first_arrived) = tokio::sync::mpsc::unbounded_channel::<()>();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut buffer = [0u8; 4096];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.unwrap();
                head.extend_from_slice(&buffer[..read]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            let chunk = |text: &str| format!("{:x}\r\n{text}\r\n", text.len());
            stream
                .write_all(chunk("data: one\n\n").as_bytes())
                .await
                .unwrap();
            stream.flush().await.unwrap();
            first_arrived.recv().await.unwrap();
            for text in ["data: two\n\n", "data: [DONE]\n\n"] {
                stream.write_all(chunk(text).as_bytes()).await.unwrap();
                stream.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            stream.write_all(b"0\r\n\r\n").await.unwrap();
            String::from_utf8_lossy(&head).into_owned()
        });

        let heard = Arc::new(Mutex::new(Vec::<InvokeResponseBody>::new()));
        let channel = Channel::new({
            let heard = heard.clone();
            move |body| {
                let mut heard = heard.lock().unwrap();
                if matches!(body, InvokeResponseBody::Raw(_))
                    && !heard
                        .iter()
                        .any(|body| matches!(body, InvokeResponseBody::Raw(_)))
                {
                    let _ = first_heard.send(());
                }
                heard.push(body);
                Ok(())
            }
        });
        let checked = check(
            &request(&format!("{origin}/v1/chat/completions")),
            Some(SavedKey {
                endpoint: format!("{origin}/v1"),
                key: "sk-test".into(),
            }),
        )
        .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            send(&reqwest::Client::new(), checked, &channel),
        )
        .await
        .expect("the answer streamed");

        let head = server.await.unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /v1/chat/completions"));
        assert!(head.contains("authorization: bearer sk-test"));
        let heard = heard.lock().unwrap();
        let InvokeResponseBody::Json(first) = &heard[0] else {
            panic!("the head comes first")
        };
        let first: serde_json::Value = serde_json::from_str(first).unwrap();
        assert_eq!(first["kind"], "head");
        assert_eq!(first["status"], 200);
        let InvokeResponseBody::Json(last) = heard.last().unwrap() else {
            panic!("the end comes last")
        };
        assert_eq!(last, r#"{"kind":"end"}"#);
        let chunks: Vec<&[u8]> = heard[1..heard.len() - 1]
            .iter()
            .map(|body| match body {
                InvokeResponseBody::Raw(bytes) => bytes.as_slice(),
                InvokeResponseBody::Json(json) => panic!("only chunks between: {json}"),
            })
            .collect();
        assert!(chunks.len() >= 2, "the body came in more than one chunk");
        assert_eq!(
            chunks.concat(),
            b"data: one\n\ndata: two\n\ndata: [DONE]\n\n"
        );
    }
}
