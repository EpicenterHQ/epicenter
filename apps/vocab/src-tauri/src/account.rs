//! Sign-in with Epicenter for Vocab's hosted tutor models and dictation, and
//! nothing else: the desktop's words and chats are files in its folder, and
//! Epicenter syncs that folder, so this account never reaches Git.
//!
//! - Sign-in is the native-app flow (RFC 8252): the system browser opens the
//!   authorization page, and a one-shot `http://127.0.0.1:<port>/callback`
//!   here receives the code (S256 PKCE). An embedded page would be refused
//!   by Google's sign-in. The client is `so.epicenter.vocab.desktop`, a
//!   native client of the deployment (`apps/api/worker/oauth-registrations.ts`).
//! - The refresh token is kept in the keychain (`keychain.rs`), never in the
//!   page. Access tokens live in this process's memory, for the API audience
//!   only.
//! - The page's requests go through `account_fetch`: the API trusts no
//!   `tauri://localhost` origin (`apps/api/worker/trusted-origins.ts`), and the
//!   bearer token stays here. Only URLs on the deployment's origin are sent.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::keychain::Secrets;

/// This build's client at the deployment's authorization server.
pub const CLIENT_ID: &str = "so.epicenter.vocab.desktop";
/// What Vocab asks for: who you are, and the hosted models.
const SCOPE: &str = "openid offline_access profile email ai";
/// An access token is renewed this long before it expires.
const RENEW_BEFORE: Duration = Duration::from_secs(5 * 60);
/// How long the browser has to come back.
const SIGN_IN_WAIT: Duration = Duration::from_secs(10 * 60);

/// Epicenter's API: the production deployment, or in a debug build
/// `EPICENTER_API_URL` (a local API).
pub fn deployment_origin() -> String {
    let configured = cfg!(debug_assertions)
        .then(|| std::env::var("EPICENTER_API_URL").ok())
        .flatten()
        .filter(|value| !value.is_empty());
    origin_of(configured.as_deref().unwrap_or("https://api.epicenter.so"))
}

/// `scheme://host[:port]` of `url`, without a trailing slash or path.
fn origin_of(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("https", url));
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    format!("{scheme}://{host}")
}

// ---------------------------------------------------------------------------
// The grant

/// What the keychain keeps for the sign-in, under `account:<origin>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGrant {
    refresh_token: String,
    principal_id: String,
}

/// Who is signed in, as the page sees it. No token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub origin: String,
    pub principal_id: String,
}

struct Grant {
    stored: StoredGrant,
    /// The API audience's access token and when to renew it.
    access: Option<(String, Instant)>,
    /// The server refused the refresh token: only a new sign-in helps.
    refused: bool,
}

/// Managed state: this app's one sign-in and its requests in flight.
pub struct Account {
    origin: String,
    http: reqwest::Client,
    secrets: Arc<dyn Secrets>,
    grant: tokio::sync::Mutex<Option<Option<Grant>>>,
    /// The sign-in waiting for its browser tab, which a newer one stops.
    signing_in: Mutex<Option<tokio::task::AbortHandle>>,
    requests: Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>,
}

impl Account {
    pub fn new(origin: String, secrets: Arc<dyn Secrets>) -> Self {
        Self {
            origin,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("an HTTP client"),
            secrets,
            grant: tokio::sync::Mutex::new(None),
            signing_in: Mutex::new(None),
            requests: Mutex::new(HashMap::new()),
        }
    }

    fn entry(&self) -> String {
        format!("account:{}", self.origin)
    }

    /// The grant, read from the keychain the first time.
    async fn loaded(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Option<Grant>>>, String> {
        let mut grant = self.grant.lock().await;
        if grant.is_none() {
            let secrets = self.secrets.clone();
            let entry = self.entry();
            let stored = tauri::async_runtime::spawn_blocking(move || secrets.get(&entry))
                .await
                .map_err(|error| error.to_string())??
                .and_then(|text| serde_json::from_str::<StoredGrant>(&text).ok());
            *grant = Some(stored.map(|stored| Grant {
                stored,
                access: None,
                refused: false,
            }));
        }
        Ok(grant)
    }

    async fn store(&self, value: Option<&StoredGrant>) -> Result<(), String> {
        let secrets = self.secrets.clone();
        let entry = self.entry();
        let text = value.map(|value| serde_json::to_string(value).expect("a grant serializes"));
        tauri::async_runtime::spawn_blocking(move || secrets.set(&entry, text.as_deref()))
            .await
            .map_err(|error| error.to_string())?
    }

    async fn post_form(
        &self,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<(u16, TokenAnswer), String> {
        let url = format!("{}/auth{path}", self.origin);
        let response = self
            .http
            .post(&url)
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|error| format!("{url} could not be reached: {error}"))?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, serde_json::from_str(&text).unwrap_or_default()))
    }

    /// An access token for the API, renewed when it is about to expire.
    /// `Err(Refusal)` says why there is none.
    async fn access_token(&self, force: bool) -> Result<String, Refusal> {
        let mut guard = self.loaded().await.map_err(Refusal::Unavailable)?;
        let Some(grant) = guard.as_mut().and_then(Option::as_mut) else {
            return Err(Refusal::SignedOut);
        };
        if grant.refused {
            return Err(Refusal::Reauth);
        }
        if let Some((token, renew_at)) = &grant.access {
            if !force && Instant::now() < *renew_at {
                return Ok(token.clone());
            }
        }
        let refresh = grant.stored.refresh_token.clone();
        let (status, answer) = self
            .post_form(
                "/oauth2/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", CLIENT_ID),
                    ("refresh_token", &refresh),
                    ("resource", &self.origin),
                ],
            )
            .await
            .map_err(Refusal::Unavailable)?;
        if status == 400 && answer.error.as_deref() == Some("invalid_grant") {
            grant.refused = true;
            grant.access = None;
            return Err(Refusal::Reauth);
        }
        let tokens = answer.tokens(status).map_err(Refusal::Unavailable)?;
        // A rotated refresh token replaces the old one before it is used.
        if let Some(rotated) = tokens.refresh_token.filter(|token| *token != refresh) {
            let stored = StoredGrant {
                refresh_token: rotated,
                principal_id: grant.stored.principal_id.clone(),
            };
            self.store(Some(&stored))
                .await
                .map_err(Refusal::Unavailable)?;
            grant.stored = stored;
        }
        grant.access = Some((tokens.access_token.clone(), renew_at(tokens.expires_in)));
        Ok(tokens.access_token)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    SignedOut,
    Reauth,
    Unavailable(String),
}

/// What the token endpoint answers, success or error.
#[derive(Debug, Default, Deserialize)]
struct TokenAnswer {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

impl TokenAnswer {
    fn tokens(self, status: u16) -> Result<Tokens, String> {
        match (status, self.access_token) {
            (200, Some(access_token)) => Ok(Tokens {
                access_token,
                refresh_token: self.refresh_token,
                expires_in: self.expires_in,
            }),
            _ => Err(format!(
                "The sign-in server answered {status}{}",
                self.error
                    .map(|error| format!(
                        ": {error}{}",
                        self.error_description
                            .map(|text| format!(" ({text})"))
                            .unwrap_or_default()
                    ))
                    .unwrap_or_default()
            )),
        }
    }
}

/// When to renew a token that expires in `seconds` (an hour when unsaid).
fn renew_at(seconds: Option<u64>) -> Instant {
    let lifetime = Duration::from_secs(seconds.unwrap_or(3600));
    Instant::now() + lifetime.saturating_sub(RENEW_BEFORE)
}

// ---------------------------------------------------------------------------
// Signing in

fn random_url_safe(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|error| error.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// RFC 7636's S256 challenge for `verifier`.
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn encode_query(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn decode_query(value: &str) -> String {
    let hex = |byte: u8| char::from(byte).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' => match (
                bytes.get(index + 1).and_then(|b| hex(*b)),
                bytes.get(index + 2).and_then(|b| hex(*b)),
            ) {
                (Some(high), Some(low)) => {
                    out.push(high * 16 + low);
                    index += 2;
                }
                _ => out.push(b'%'),
            },
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The authorization page for one sign-in.
fn authorize_url(origin: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPE),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("resource", origin),
    ];
    let query: Vec<String> = params
        .iter()
        .map(|(key, value)| format!("{key}={}", encode_query(value)))
        .collect();
    format!("{origin}/auth/oauth2/authorize?{}", query.join("&"))
}

/// What one request to the loopback listener said.
#[derive(Debug, PartialEq, Eq)]
enum Callback {
    /// Not the callback (a favicon, a probe): answer 404 and keep waiting.
    Other,
    Code(String),
    /// The person or the server ended the sign-in.
    Refused(String),
}

/// Read `GET /callback?…` from a request's head. A callback whose `state`
/// is not this sign-in's is `Other`: it may be a stale tab.
fn parse_callback(head: &str, state: &str) -> Callback {
    let Some(target) = head
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|rest| rest.split(' ').next())
    else {
        return Callback::Other;
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return Callback::Other;
    }
    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (decode_query(key), decode_query(value)))
        .collect();
    if params.get("state").map(String::as_str) != Some(state) {
        return Callback::Other;
    }
    if let Some(error) = params.get("error") {
        return Callback::Refused(match params.get("error_description") {
            Some(description) => format!("{error}: {description}"),
            None => error.clone(),
        });
    }
    match params.get("code") {
        Some(code) if !code.is_empty() => Callback::Code(code.clone()),
        _ => Callback::Other,
    }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Vocab</title>\
<body style=\"font-family:system-ui;margin:4rem;text-align:center\">\
<p>You are signed in to Vocab. You can close this tab.</p>";
const STOPPED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Vocab</title>\
<body style=\"font-family:system-ui;margin:4rem;text-align:center\">\
<p>Vocab was not signed in. You can close this tab.</p>";

async fn answer(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait on `listener` for this sign-in's callback.
async fn receive_code(listener: tokio::net::TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let mut head = Vec::new();
        let mut buffer = [0u8; 2048];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < 16 * 1024 {
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(read)) => head.extend_from_slice(&buffer[..read]),
            }
        }
        match parse_callback(&String::from_utf8_lossy(&head), state) {
            Callback::Other => answer(&mut stream, "404 Not Found", "").await,
            Callback::Code(code) => {
                answer(&mut stream, "200 OK", DONE_PAGE).await;
                return Ok(code);
            }
            Callback::Refused(reason) => {
                answer(&mut stream, "200 OK", STOPPED_PAGE).await;
                return Err(format!("The sign-in was not completed ({reason})."));
            }
        }
    }
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
}

async fn sign_in(account: Arc<Account>) -> Result<SignedIn, String> {
    let verifier = random_url_safe(32)?;
    let state = random_url_safe(16)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Vocab could not listen for the sign-in: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    tauri_plugin_opener::open_url(
        authorize_url(
            &account.origin,
            &redirect_uri,
            &state,
            &challenge(&verifier),
        ),
        None::<&str>,
    )
    .map_err(|error| format!("The browser could not be opened: {error}"))?;
    let code = tokio::time::timeout(SIGN_IN_WAIT, receive_code(listener, &state))
        .await
        .map_err(|_| "The browser did not come back within ten minutes.".to_string())??;
    let (status, answer) = account
        .post_form(
            "/oauth2/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect_uri),
                ("resource", &account.origin),
            ],
        )
        .await?;
    let tokens = answer.tokens(status)?;
    let refresh_token = tokens
        .refresh_token
        .ok_or("The sign-in server kept no sign-in for this computer.")?;
    let info: UserInfo = account
        .http
        .get(format!("{}/auth/oauth2/userinfo", account.origin))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("Who signed in could not be read: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Who signed in could not be read: {error}"))?;
    let stored = StoredGrant {
        refresh_token,
        principal_id: info.sub,
    };
    account.store(Some(&stored)).await?;
    let signed_in = SignedIn {
        origin: account.origin.clone(),
        principal_id: stored.principal_id.clone(),
    };
    *account.grant.lock().await = Some(Some(Grant {
        stored,
        access: Some((tokens.access_token, renew_at(tokens.expires_in))),
        refused: false,
    }));
    Ok(signed_in)
}

// ---------------------------------------------------------------------------
// Commands

/// Who is signed in, from the keychain; `None` signed out. `refused` says
/// the server ended the sign-in and only signing in again helps.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    pub origin: String,
    pub signed_in: Option<SignedIn>,
    pub refused: bool,
}

#[tauri::command]
pub async fn account_state(account: State<'_, Arc<Account>>) -> Result<AccountState, String> {
    let grant = account.loaded().await?;
    let current = grant.as_ref().and_then(Option::as_ref);
    Ok(AccountState {
        origin: account.origin.clone(),
        signed_in: current.map(|grant| SignedIn {
            origin: account.origin.clone(),
            principal_id: grant.stored.principal_id.clone(),
        }),
        refused: current.is_some_and(|grant| grant.refused),
    })
}

/// Sign in through the system browser. A second call replaces a sign-in
/// still waiting for its browser tab.
#[tauri::command]
pub async fn account_sign_in(account: State<'_, Arc<Account>>) -> Result<SignedIn, String> {
    // Commands run on Tauri's Tokio runtime, so the task can be stopped by
    // its own abort handle: a stopped sign-in closes its loopback listener,
    // and a tab finished late reaches nothing.
    let task = tokio::spawn(sign_in(account.inner().clone()));
    if let Some(previous) = account
        .signing_in
        .lock()
        .unwrap()
        .replace(task.abort_handle())
    {
        previous.abort();
    }
    match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("A newer sign-in replaced this one.".into()),
        Err(error) => Err(error.to_string()),
    }
}

/// Forget the sign-in on this computer and ask the server to revoke it
/// (waiting at most five seconds; the local sign-out happens either way).
#[tauri::command]
pub async fn account_sign_out(account: State<'_, Arc<Account>>) -> Result<(), String> {
    let mut grant = account.loaded().await?;
    let refresh = grant
        .as_ref()
        .and_then(Option::as_ref)
        .map(|grant| grant.stored.refresh_token.clone());
    account.store(None).await?;
    *grant = Some(None);
    drop(grant);
    if let Some(refresh) = refresh {
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            account.post_form(
                "/oauth2/revoke",
                &[
                    ("token", &refresh),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", CLIENT_ID),
                ],
            ),
        )
        .await;
    }
    Ok(())
}

/// One request the page sends on the account. `body` is base64.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub id: u32,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// What the relay sends the page, before and after the body's raw chunks.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RelayEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    End,
    /// `refusal` is `reauth-required` or `auth-unavailable` when no
    /// request was sent for want of a token, else absent.
    Error {
        message: String,
        refusal: Option<&'static str>,
    },
}

/// Whether `url` is on the deployment's origin, the only place the
/// account's bearer token is sent.
fn on_origin(url: &str, origin: &str) -> bool {
    url.strip_prefix(origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
}

/// Request headers the relay passes on: never a credential or a header the
/// HTTP client owns.
fn forwarded(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "host" | "content-length" | "connection" | "origin"
    )
}

fn send_event(channel: &Channel<InvokeResponseBody>, event: &RelayEvent) {
    let _ = channel.send(InvokeResponseBody::Json(
        serde_json::to_string(event).expect("an event serializes"),
    ));
}

async fn relay(account: Arc<Account>, request: RelayRequest, channel: Channel<InvokeResponseBody>) {
    let error =
        |message: String, refusal: Option<&'static str>| RelayEvent::Error { message, refusal };
    let body = match request.body.as_deref().map(|body| STANDARD.decode(body)) {
        None => None,
        Some(Ok(bytes)) => Some(bytes),
        Some(Err(cause)) => {
            return send_event(
                &channel,
                &error(format!("The request body is not base64: {cause}"), None),
            );
        }
    };
    let method = match reqwest::Method::from_bytes(request.method.as_bytes()) {
        Ok(method) => method,
        Err(_) => {
            return send_event(
                &channel,
                &error(format!("{} is not a method", request.method), None),
            )
        }
    };
    let mut forced = false;
    let response = loop {
        let token = match account.access_token(forced).await {
            Ok(token) => token,
            Err(Refusal::SignedOut | Refusal::Reauth) => {
                return send_event(
                    &channel,
                    &error(
                        "Sign in again to use your account.".into(),
                        Some("reauth-required"),
                    ),
                );
            }
            Err(Refusal::Unavailable(message)) => {
                return send_event(&channel, &error(message, Some("auth-unavailable")));
            }
        };
        let mut builder = account
            .http
            .request(method.clone(), &request.url)
            .bearer_auth(token);
        for (name, value) in request.headers.iter().filter(|(name, _)| forwarded(name)) {
            builder = builder.header(name, value);
        }
        if let Some(body) = &body {
            builder = builder.body(body.clone());
        }
        match builder.send().await {
            // A token the server no longer takes is renewed once.
            Ok(response) if response.status() == 401 && !forced => forced = true,
            Ok(response) => break response,
            Err(cause) => return send_event(&channel, &error(cause.to_string(), None)),
        }
    };
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    send_event(
        &channel,
        &RelayEvent::Head {
            status: response.status().as_u16(),
            headers,
        },
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if channel
                    .send(InvokeResponseBody::Raw(bytes.to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(cause) => return send_event(&channel, &error(cause.to_string(), None)),
        }
    }
    send_event(&channel, &RelayEvent::End);
}

/// Send one request on the account, to the deployment's origin only. The
/// response arrives on `on_event`: its head, its body in raw chunks, then
/// its end or an error. Answers once the request is under way.
#[tauri::command]
pub async fn account_fetch(
    account: State<'_, Arc<Account>>,
    request: RelayRequest,
    on_event: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if !on_origin(&request.url, &account.origin) {
        return Err(format!("{} is not on {}", request.url, account.origin));
    }
    let id = request.id;
    let account = account.inner().clone();
    // Held while spawning, so the task's own removal comes after this insert.
    let mut requests = account.requests.lock().unwrap();
    let finished = account.clone();
    let task = tauri::async_runtime::spawn(async move {
        relay(finished.clone(), request, on_event).await;
        finished.requests.lock().unwrap().remove(&id);
    });
    if let Some(previous) = requests.insert(id, task) {
        previous.abort();
    }
    Ok(())
}

/// Stop a request the page no longer wants.
#[tauri::command]
pub fn account_fetch_cancel(account: State<'_, Arc<Account>>, id: u32) {
    if let Some(task) = account.requests.lock().unwrap().remove(&id) {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_s256_of_the_verifier() {
        // BASE64URL(SHA256(verifier)) without padding, computed apart with
        // `openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d =`.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mJ92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "ngF5GsXcbwljx6u133FFr3Xht9xooA_DuaX_3QwODtc"
        );
        let verifier = random_url_safe(32).unwrap();
        assert_eq!(verifier.len(), 43);
        assert_ne!(verifier, random_url_safe(32).unwrap());
    }

    #[test]
    fn the_authorization_page_asks_for_the_api_only_with_pkce() {
        let url = authorize_url(
            "https://api.epicenter.so",
            "http://127.0.0.1:5555/callback",
            "st",
            "ch",
        );
        assert_eq!(
            url,
            "https://api.epicenter.so/auth/oauth2/authorize?response_type=code\
             &client_id=so.epicenter.vocab.desktop\
             &redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback\
             &scope=openid%20offline_access%20profile%20email%20ai\
             &state=st&code_challenge=ch&code_challenge_method=S256\
             &resource=https%3A%2F%2Fapi.epicenter.so"
        );
    }

    #[test]
    fn the_callback_is_read_only_for_this_sign_in() {
        let request = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(
            parse_callback(&request("/callback?code=a%2Bb&state=s1"), "s1"),
            Callback::Code("a+b".into())
        );
        assert_eq!(
            parse_callback(&request("/favicon.ico"), "s1"),
            Callback::Other
        );
        assert_eq!(
            parse_callback(&request("/callback?code=a&state=old"), "s1"),
            Callback::Other
        );
        assert_eq!(
            parse_callback(&request("/callback?state=s1"), "s1"),
            Callback::Other
        );
        assert_eq!(
            parse_callback("POST /callback?code=a&state=s1 HTTP/1.1", "s1"),
            Callback::Other
        );
        assert_eq!(
            parse_callback(
                &request("/callback?error=access_denied&error_description=No+thanks&state=s1"),
                "s1"
            ),
            Callback::Refused("access_denied: No thanks".into())
        );
    }

    #[test]
    fn the_bearer_token_goes_only_to_the_deployment() {
        let origin = "https://api.epicenter.so";
        for url in [
            "https://api.epicenter.so/v1/chat",
            "https://api.epicenter.so",
            "https://api.epicenter.so?x",
        ] {
            assert!(on_origin(url, origin), "{url}");
        }
        for url in [
            "https://api.epicenter.so.evil.com/v1",
            "https://api.epicenter.so@evil.com/",
            "http://api.epicenter.so/v1",
            "https://evil.com/https://api.epicenter.so",
        ] {
            assert!(!on_origin(url, origin), "{url}");
        }
        assert!(!forwarded("Authorization"));
        assert!(!forwarded("cookie"));
        assert!(forwarded("content-type"));
    }

    #[test]
    fn the_deployment_is_an_origin() {
        assert_eq!(
            origin_of("https://api.epicenter.so/"),
            "https://api.epicenter.so"
        );
        assert_eq!(
            origin_of("http://localhost:8787/auth"),
            "http://localhost:8787"
        );
    }

    #[test]
    fn a_token_answer_is_tokens_or_says_why_not() {
        let ok: TokenAnswer = serde_json::from_str(
            r#"{"access_token":"a","refresh_token":"r","expires_in":3600,"token_type":"Bearer"}"#,
        )
        .unwrap();
        let tokens = ok.tokens(200).unwrap();
        assert_eq!(
            (
                tokens.access_token.as_str(),
                tokens.refresh_token.as_deref()
            ),
            ("a", Some("r"))
        );
        let refused: TokenAnswer =
            serde_json::from_str(r#"{"error":"invalid_grant","error_description":"expired"}"#)
                .unwrap();
        assert_eq!(
            refused.tokens(400).err().unwrap(),
            "The sign-in server answered 400: invalid_grant (expired)"
        );
        assert!(TokenAnswer::default().tokens(200).is_err());
    }

    #[test]
    fn a_token_is_renewed_five_minutes_before_it_expires() {
        let now = Instant::now();
        let at = renew_at(Some(3600));
        assert!(at > now + Duration::from_secs(3290) && at <= now + Duration::from_secs(3301));
        // A token shorter than the margin is renewed at once.
        assert!(renew_at(Some(60)) <= Instant::now());
    }

    #[test]
    fn the_relay_events_are_what_the_page_reads() {
        assert_eq!(
            serde_json::to_value(RelayEvent::Head {
                status: 200,
                headers: vec![("a".into(), "b".into())]
            })
            .unwrap(),
            serde_json::json!({ "kind": "head", "status": 200, "headers": [["a", "b"]] })
        );
        assert_eq!(
            serde_json::to_value(RelayEvent::End).unwrap(),
            serde_json::json!({ "kind": "end" })
        );
        assert_eq!(
            serde_json::to_value(RelayEvent::Error {
                message: "m".into(),
                refusal: Some("reauth-required")
            })
            .unwrap(),
            serde_json::json!({ "kind": "error", "message": "m", "refusal": "reauth-required" })
        );
    }

    #[test]
    fn a_stored_grant_round_trips_without_its_access_token() {
        let stored = StoredGrant {
            refresh_token: "r".into(),
            principal_id: "p".into(),
        };
        let text = serde_json::to_string(&stored).unwrap();
        assert_eq!(text, r#"{"refreshToken":"r","principalId":"p"}"#);
        assert_eq!(serde_json::from_str::<StoredGrant>(&text).unwrap(), stored);
    }
}
