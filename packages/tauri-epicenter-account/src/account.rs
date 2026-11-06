//! Sign-in with Epicenter for a desktop app: a standalone app signs in for
//! its hosted capabilities (inference, transcription) on the API audience
//! alone, and the Epicenter app also for every folder the person holds, on
//! the Git audience (`folders:all`, ADR-0820).
//!
//! - Sign-in is the native-app flow (RFC 8252): the system browser opens the
//!   authorization page, and a one-shot `http://127.0.0.1:<port>/callback`
//!   here receives the code (S256 PKCE). An embedded page would be refused
//!   by Google's sign-in. The client is the app's native client,
//!   `so.epicenter.<app>.native` (decision 84), registered by the deployment
//!   (`apps/api/worker/oauth-registrations.ts`).
//! - The refresh token is kept in the app's credentials file
//!   (`credentials.rs`), read from it when a token is needed, never by the
//!   page. Access tokens live in this process's memory, one per audience the
//!   app signs in for (`AccountApp::audiences`), each minted from the refresh
//!   token when first needed (RFC 8707's `resource`).
//! - Who is signed in is a setting only this side writes: `account.json` at
//!   the top of the app's AppData directory, `{ origin, principalId,
//!   refused }` (`Identity`). It is written at startup, once the grant is
//!   read, and whenever it changes: a sign-in, a sign-out, the server
//!   refusing the refresh token. The page reads it like any setting, and the
//!   folder plugin's watch of the AppData root tells every window it
//!   changed.
//! - The page's requests go through `account_fetch`: the API trusts no
//!   `tauri://localhost` origin (`apps/api/worker/trusted-origins.ts`), and the
//!   bearer token stays here. A request names its audience (the API unless it
//!   says otherwise) and is sent only to the deployment's origin or that
//!   audience's. A standalone app's requests are only hosted inference
//!   (`Relays::Inference`, `INFERENCE_ROUTES`, ADR-0822); any other is refused
//!   before a token is read.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::credentials::{self, Access, Secrets};
use crate::relay::{self, send_event, RelayEvent, Requests};

/// Who signs in: one constant per app, in its `main.rs`.
#[derive(Clone, Copy, Debug)]
pub struct AccountApp {
    /// The app's native client, `so.epicenter.<app>.native` (decision 84),
    /// or the Epicenter app's own, `so.epicenter`.
    pub client_id: &'static str,
    /// The app's name, on the page the browser shows after a sign-in.
    pub name: &'static str,
    /// What the app asks for, such as `openid offline_access profile email ai`.
    pub scope: &'static str,
    /// The audiences it signs in for, the API first. The deployment
    /// registers the same for its client.
    pub audiences: &'static [Audience],
    /// What its windows may send through `account_fetch`.
    pub relays: Relays,
}

/// What an app's windows may send on its account (`account_fetch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relays {
    /// Only hosted inference, `INFERENCE_ROUTES` on the API audience: a
    /// standalone app, which signs in only for hosted features (ADR-0822).
    Inference,
    /// Any request to its audiences' origins: the Epicenter app, the one
    /// desktop program that syncs.
    AnyRoute,
}

/// Hosted inference, as `(method, path)` on the deployment's origin: the only
/// requests a standalone app's windows send on its account. Each is a route
/// `apps/api` mounts (`API_ROUTES.ai` in `@epicenter/server`);
/// `fixtures/relayed-routes.json` lists the same, and `apps/api`'s
/// `runtime-profile.test.ts` checks each against both of its entries.
pub const INFERENCE_ROUTES: &[(&str, &str)] = &[
    ("POST", "/v1/chat/completions"),
    ("POST", "/v1/audio/transcriptions"),
];

impl AccountApp {
    /// What every app that signs in for hosted models asks for: who you are,
    /// a refresh token, and the API audience's `ai`.
    pub const HOSTED_MODELS: &'static str = "openid offline_access profile email ai";
    /// The audience an app that signs in for hosted models reaches.
    pub const API: &'static [Audience] = &[Audience::Api];
    /// What the Epicenter app asks for: hosted models, and every folder the
    /// person holds (`folders:all`, ADR-0820).
    pub const EVERY_FOLDER: &'static str =
        "openid offline_access profile email ai folders:read folders:write folders:all";
    /// The audiences the Epicenter app reaches: the API, and the folders'.
    pub const API_AND_FOLDERS: &'static [Audience] = &[Audience::Api, Audience::Git];
}

/// A token audience on the deployment (RFC 8707): the API (inference,
/// transcription, who is signed in) or Git (every folder's history, and the
/// folder routes on the API's origin). An access token names one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    Api,
    Git,
}

/// The production API, whose Git audience has an origin of its own.
const PRODUCTION_API: &str = "https://api.epicenter.so";

impl Audience {
    /// The audience's URL on the deployment at `origin`: the twin of
    /// `resolveOAuthAudiences` in `@epicenter/definition/site`.
    pub fn url(self, origin: &str) -> String {
        match self {
            Self::Api => origin.to_string(),
            Self::Git if origin == PRODUCTION_API => "https://git.epicenter.so".to_string(),
            Self::Git => format!("{origin}/git"),
        }
    }
}
/// How long quitting waits for a refresh in flight to store what it got.
pub const EXIT_WAIT: Duration = Duration::from_secs(10);
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
    origin_of(configured.as_deref().unwrap_or(PRODUCTION_API))
}

/// `scheme://host[:port]` of `url`, without a trailing slash or path.
fn origin_of(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("https", url));
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    format!("{scheme}://{host}")
}

// ---------------------------------------------------------------------------
// The grant

/// The identity file's name, at the top of the app's AppData directory.
pub const IDENTITY_FILE: &str = "account.json";

/// What the credentials file keeps for the sign-in, under `account:<origin>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGrant {
    refresh_token: String,
    principal_id: String,
}

/// Who is signed in, as `account_sign_in` answers it. No token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub origin: String,
    pub principal_id: String,
}

/// `account.json`, who is signed in as the page reads it: the deployment's
/// origin, the principal or `null` signed out, and whether the server
/// refused the refresh token, so only signing in again helps. No token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub origin: String,
    pub principal_id: Option<String>,
    pub refused: bool,
}

struct Grant {
    stored: StoredGrant,
    /// Each audience's access token and when to renew it.
    access: HashMap<Audience, (String, Instant)>,
    /// The server refused the refresh token: only a new sign-in helps.
    refused: bool,
}

/// Managed state: this app's one sign-in and its requests in flight.
pub struct Account {
    app: AccountApp,
    origin: String,
    http: reqwest::Client,
    secrets: Arc<dyn Secrets>,
    /// `account.json`, settled once the app runs (`identify_at`).
    identity: OnceLock<PathBuf>,
    grant: tokio::sync::Mutex<Option<Option<Grant>>>,
    /// The sign-in waiting for its browser tab, which a newer one stops.
    signing_in: Mutex<Option<tokio::task::AbortHandle>>,
    requests: Requests,
}

impl Account {
    pub fn new(app: AccountApp, origin: String, secrets: Arc<dyn Secrets>) -> Self {
        Self {
            app,
            origin,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("an HTTP client"),
            secrets,
            identity: OnceLock::new(),
            grant: tokio::sync::Mutex::new(None),
            signing_in: Mutex::new(None),
            requests: Requests::default(),
        }
    }

    fn entry(&self) -> String {
        format!("account:{}", self.origin)
    }

    /// Wait, at most `wait`, for a refresh or sign-out in flight to
    /// finish, and start none after: the app is quitting. Each holds the
    /// grant's lock from its request to the credentials file, so holding it
    /// means a refresh token the server rotated is stored. Blocks the
    /// calling thread, which must not be one of the async runtime's.
    pub fn finish_refreshing(&self, wait: Duration) {
        let held = tauri::async_runtime::block_on(async {
            tokio::time::timeout(wait, self.grant.lock()).await
        });
        match held {
            // Kept until the process ends, so no refresh starts after.
            Ok(guard) => std::mem::forget(guard),
            Err(_) => log::warn!(
                "A sign-in refresh was still running after {}s; quitting without it.",
                wait.as_secs()
            ),
        }
    }

    /// Write who is signed in to `path` from now on; the first call wins.
    pub fn identify_at(&self, path: PathBuf) {
        let _ = self.identity.set(path);
    }

    /// Who `grant` says is signed in.
    fn identity(&self, grant: Option<&Grant>) -> Identity {
        Identity {
            origin: self.origin.clone(),
            principal_id: grant.map(|grant| grant.stored.principal_id.clone()),
            refused: grant.is_some_and(|grant| grant.refused),
        }
    }

    /// Write `account.json` for `grant`, whole. Callers hold the grant's
    /// lock, so the file follows the grant's changes in order.
    async fn publish(&self, grant: Option<&Grant>) -> Result<(), String> {
        let path =
            self.identity.get().cloned().ok_or_else(|| {
                "Where this app keeps who is signed in is not known yet.".to_string()
            })?;
        let text =
            serde_json::to_string_pretty(&self.identity(grant)).expect("an identity serializes");
        credentials::blocking(move || {
            credentials::write_whole(&path, text.as_bytes(), Access::Default)
                .map_err(|error| format!("{} could not be written: {error}", path.display()))
        })
        .await
    }

    /// Read the grant from the credentials file and write who it says is
    /// signed in: the app's startup.
    pub(crate) async fn publish_loaded(&self) -> Result<(), String> {
        let grant = self.loaded().await?;
        self.publish(grant.as_ref().and_then(Option::as_ref)).await
    }

    /// The grant, read from the credentials file the first time.
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
                access: HashMap::new(),
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

    /// An access token for `audience`, minted from the refresh token when
    /// there is none and renewed when it is about to expire. Tokens are
    /// minted one at a time under the grant's lock, so a rotated refresh
    /// token is stored before the next one is spent. `Err(Refusal)` says why
    /// there is none.
    async fn access_token(&self, audience: Audience, force: bool) -> Result<String, Refusal> {
        let mut guard = self.loaded().await.map_err(Refusal::Unavailable)?;
        let Some(grant) = guard.as_mut().and_then(Option::as_mut) else {
            return Err(Refusal::SignedOut);
        };
        if grant.refused {
            return Err(Refusal::Reauth);
        }
        if let Some((token, renew_at)) = grant.access.get(&audience) {
            if !force && Instant::now() < *renew_at {
                return Ok(token.clone());
            }
        }
        let refresh = grant.stored.refresh_token.clone();
        let resource = audience.url(&self.origin);
        let (status, answer) = self
            .post_form(
                "/oauth2/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", self.app.client_id),
                    ("refresh_token", &refresh),
                    ("resource", &resource),
                ],
            )
            .await
            .map_err(Refusal::Unavailable)?;
        if status == 400 && answer.error.as_deref() == Some("invalid_grant") {
            grant.refused = true;
            grant.access.clear();
            // The request is refused either way; the page also hears it here.
            if let Err(message) = self.publish(Some(grant)).await {
                log::warn!("The refused sign-in could not be recorded: {message}");
            }
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
        grant.access.insert(
            audience,
            (tokens.access_token.clone(), renew_at(tokens.expires_in)),
        );
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

/// The authorization page for one sign-in. It names every audience the app
/// signs in for, so its refresh token can mint a token for each.
fn authorize_url(
    app: &AccountApp,
    origin: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    let mut params = vec![
        ("response_type", "code".to_string()),
        ("client_id", app.client_id.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("scope", app.scope.to_string()),
        ("state", state.to_string()),
        ("code_challenge", challenge.to_string()),
        ("code_challenge_method", "S256".to_string()),
    ];
    for audience in app.audiences {
        params.push(("resource", audience.url(origin)));
    }
    let query: Vec<String> = params
        .iter()
        .map(|(key, value)| format!("{key}={}", encode_query(value)))
        .collect();
    format!("{origin}/auth/oauth2/authorize?{}", query.join("&"))
}

/// The audience a sign-in's code is exchanged for: the app's first.
fn first_audience(app: &AccountApp) -> Audience {
    app.audiences.first().copied().unwrap_or(Audience::Api)
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

/// The page the browser shows once the callback arrived.
fn tab_page(app: &str, message: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>{app}</title>\
<body style=\"font-family:system-ui;margin:4rem;text-align:center\">\
<p>{message} You can close this tab.</p>"
    )
}

async fn answer(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait on `listener` for this sign-in's callback.
async fn receive_code(
    listener: tokio::net::TcpListener,
    state: &str,
    app: &str,
) -> Result<String, String> {
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
                let page = tab_page(app, &format!("You are signed in to {app}."));
                answer(&mut stream, "200 OK", &page).await;
                return Ok(code);
            }
            Callback::Refused(reason) => {
                let page = tab_page(app, &format!("{app} was not signed in."));
                answer(&mut stream, "200 OK", &page).await;
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
        .map_err(|error| {
            format!(
                "{} could not listen for the sign-in: {error}",
                account.app.name
            )
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    tauri_plugin_opener::open_url(
        authorize_url(
            &account.app,
            &account.origin,
            &redirect_uri,
            &state,
            &challenge(&verifier),
        ),
        None::<&str>,
    )
    .map_err(|error| format!("The browser could not be opened: {error}"))?;
    let code = tokio::time::timeout(
        SIGN_IN_WAIT,
        receive_code(listener, &state, account.app.name),
    )
    .await
    .map_err(|_| "The browser did not come back within ten minutes.".to_string())??;
    let first = first_audience(&account.app);
    let resource = first.url(&account.origin);
    let (status, answer) = account
        .post_form(
            "/oauth2/token",
            &[
                ("grant_type", "authorization_code"),
                ("client_id", account.app.client_id),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect_uri),
                ("resource", &resource),
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
    let mut grant = account.grant.lock().await;
    *grant = Some(Some(Grant {
        stored,
        access: HashMap::from([(first, (tokens.access_token, renew_at(tokens.expires_in)))]),
        refused: false,
    }));
    account
        .publish(grant.as_ref().and_then(Option::as_ref))
        .await?;
    Ok(signed_in)
}

impl Account {
    /// Forget the sign-in on this computer, say so in `account.json`, and
    /// ask the server to revoke it (waiting at most five seconds; the local
    /// sign-out happens either way).
    async fn sign_out(&self) -> Result<(), String> {
        let mut grant = self.loaded().await?;
        let refresh = grant
            .as_ref()
            .and_then(Option::as_ref)
            .map(|grant| grant.stored.refresh_token.clone());
        self.store(None).await?;
        *grant = Some(None);
        // Signed out here even when the file could not say so; the server
        // is still asked to revoke.
        let published = self.publish(None).await;
        drop(grant);
        if let Some(refresh) = refresh {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                self.post_form(
                    "/oauth2/revoke",
                    &[
                        ("token", &refresh),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", self.app.client_id),
                    ],
                ),
            )
            .await;
        }
        published
    }
}

// ---------------------------------------------------------------------------
// Commands

/// Sign in through the system browser, and write who signed in to
/// `account.json`. A second call replaces a sign-in still waiting for its
/// browser tab.
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

/// Forget the sign-in on this computer, write `account.json` signed out,
/// and ask the server to revoke it (waiting at most five seconds; the local
/// sign-out happens either way).
#[tauri::command]
pub async fn account_sign_out(account: State<'_, Arc<Account>>) -> Result<(), String> {
    account.sign_out().await
}

/// One request the page sends on the account. `body` is base64. `audience`
/// names the token it is sent with: the API's when absent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRequest {
    pub id: u32,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    #[serde(default)]
    pub audience: Option<Audience>,
}

/// Why an account request ended without an answer, after the `kind` of its
/// error event. `refusal` is `reauth-required` or `auth-unavailable` when no
/// request was sent for want of a token, else absent.
#[derive(Debug, Serialize, PartialEq, Eq)]
struct AccountFailure {
    message: String,
    refusal: Option<&'static str>,
}

/// Whether `url` is on the deployment's origin, the only place the
/// account's bearer token is sent.
fn on_origin(url: &str, origin: &str) -> bool {
    url.strip_prefix(origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
}

/// Whether a request for `audience` may go to `url`: the deployment's
/// origin, or the audience's own (production's Git audience is another).
fn reaches(url: &str, origin: &str, audience: Audience) -> bool {
    on_origin(url, origin) || on_origin(url, &origin_of(&audience.url(origin)))
}

/// Whether `method url` on `audience`'s token is hosted inference: one of
/// `INFERENCE_ROUTES`, on the deployment's origin, with nothing after its
/// path but a query. The path is compared as sent, so `..`, `\`, or an
/// escape the HTTP client would read differently is never inference.
fn is_inference(method: &str, url: &str, origin: &str, audience: Audience) -> bool {
    let Some(rest) = url.strip_prefix(origin) else {
        return false;
    };
    let path = rest.split_once('?').map_or(rest, |(path, _)| path);
    audience == Audience::Api && INFERENCE_ROUTES.contains(&(method, path))
}

/// Whether `app` may send `method url` on `audience`'s token, or why not.
/// Checked before a token is read or anything is sent.
fn permits(
    app: &AccountApp,
    origin: &str,
    audience: Audience,
    method: &str,
    url: &str,
) -> Result<(), String> {
    if !app.audiences.contains(&audience) {
        return Err(format!(
            "{} does not sign in for the {audience:?} audience",
            app.name
        ));
    }
    if !reaches(url, origin, audience) {
        return Err(format!("{url} is not on {origin}"));
    }
    match app.relays {
        Relays::AnyRoute => Ok(()),
        Relays::Inference if is_inference(method, url, origin, audience) => Ok(()),
        Relays::Inference => Err(format!(
            "{} sends only Epicenter's hosted inference on its account, not {method} {url}",
            app.name
        )),
    }
}

/// Request headers the relay passes on: never a credential or a header the
/// HTTP client owns.
fn forwarded(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "host" | "content-length" | "connection" | "origin"
    )
}

async fn relay(account: Arc<Account>, request: RelayRequest, channel: Channel<InvokeResponseBody>) {
    let error = |message: String, refusal: Option<&'static str>| {
        RelayEvent::Error(AccountFailure { message, refusal })
    };
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
    let audience = request.audience.unwrap_or(Audience::Api);
    let mut forced = false;
    let response = loop {
        let token = match account.access_token(audience, forced).await {
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
    // The token is the account's own, never a provider key; the page reads
    // Epicenter's answers as they come.
    relay::answer(
        response,
        &channel,
        |message| AccountFailure {
            message,
            refusal: None,
        },
        None,
    )
    .await;
}

/// Send one request on the account, to the deployment's origin only, and
/// for a standalone app only hosted inference (`AccountApp::relays`). The
/// response arrives on `on_event`: its head, its body in raw chunks, then
/// its end or an error. Answers once the request is under way; a request the
/// app may not send is refused here, before a token is read.
#[tauri::command]
pub async fn account_fetch(
    account: State<'_, Arc<Account>>,
    request: RelayRequest,
    on_event: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    permits(
        &account.app,
        &account.origin,
        request.audience.unwrap_or(Audience::Api),
        &request.method,
        &request.url,
    )?;
    let account = account.inner().clone();
    account
        .requests
        .start(request.id, relay(account.clone(), request, on_event));
    Ok(())
}

/// Stop a request the page no longer wants.
#[tauri::command]
pub fn account_fetch_cancel(account: State<'_, Arc<Account>>, id: u32) {
    account.requests.cancel(id);
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

    const VOCAB: AccountApp = AccountApp {
        client_id: "so.epicenter.vocab.native",
        name: "Vocab",
        scope: AccountApp::HOSTED_MODELS,
        audiences: AccountApp::API,
        relays: Relays::Inference,
    };

    const EPICENTER: AccountApp = AccountApp {
        client_id: "so.epicenter",
        name: "Epicenter",
        scope: AccountApp::EVERY_FOLDER,
        audiences: AccountApp::API_AND_FOLDERS,
        relays: Relays::AnyRoute,
    };

    /// The fixture `apps/api`'s `runtime-profile.test.ts` checks against
    /// the server's routes lists exactly what a standalone app relays.
    #[test]
    fn the_inference_routes_are_the_fixture_the_server_checks() {
        #[derive(Deserialize)]
        struct Route {
            method: String,
            path: String,
        }
        let fixture: Vec<Route> =
            serde_json::from_str(include_str!("../fixtures/relayed-routes.json")).unwrap();
        let listed: Vec<(&str, &str)> = fixture
            .iter()
            .map(|route| (route.method.as_str(), route.path.as_str()))
            .collect();
        assert_eq!(listed, INFERENCE_ROUTES);
    }

    /// A standalone app sends hosted inference and nothing else: not who is
    /// signed in, a folder, its history, or a route the server does not have.
    #[test]
    fn a_standalone_app_relays_only_hosted_inference() {
        let origin = "https://api.epicenter.so";
        let sends = |method: &str, url: &str| permits(&VOCAB, origin, Audience::Api, method, url);
        for url in [
            "https://api.epicenter.so/v1/chat/completions",
            "https://api.epicenter.so/v1/audio/transcriptions",
            "https://api.epicenter.so/v1/chat/completions?stream=1",
        ] {
            assert_eq!(sends("POST", url), Ok(()), "{url}");
        }
        for (method, url) in [
            ("GET", "https://api.epicenter.so/v1/chat/completions"),
            ("post", "https://api.epicenter.so/v1/chat/completions"),
            ("GET", "https://api.epicenter.so/api/folders"),
            ("POST", "https://api.epicenter.so/api/folders/f/members"),
            ("GET", "https://api.epicenter.so/auth/oauth2/userinfo"),
            ("GET", "https://api.epicenter.so/v1/models"),
            ("POST", "https://api.epicenter.so/v1/embeddings"),
            ("POST", "https://api.epicenter.so/v1/chat/completions/"),
            (
                "POST",
                "https://api.epicenter.so/v1/chat/completions/../../api/folders",
            ),
            (
                "POST",
                r"https://api.epicenter.so/v1/chat/completions/..\..\api/folders",
            ),
            ("POST", "https://api.epicenter.so/v1/chat/%63ompletions"),
            ("POST", "https://api.epicenter.so/v1/chat/completions#x"),
            ("POST", "https://api.epicenter.so/V1/chat/completions"),
        ] {
            assert_eq!(
                sends(method, url),
                Err(format!(
                    "Vocab sends only Epicenter's hosted inference on its account, not {method} {url}"
                )),
                "{method} {url}"
            );
        }
        // Not on the folders' audience, which it does not sign in for, nor
        // to another origin.
        assert!(permits(
            &VOCAB,
            origin,
            Audience::Git,
            "POST",
            "https://git.epicenter.so/v1/chat/completions"
        )
        .is_err());
        assert!(sends("POST", "https://evil.com/v1/chat/completions").is_err());
        // A debug build's local API is the deployment.
        assert_eq!(
            permits(
                &VOCAB,
                "http://localhost:8787",
                Audience::Api,
                "POST",
                "http://localhost:8787/v1/audio/transcriptions"
            ),
            Ok(())
        );
    }

    /// The Epicenter app's windows relay what they send today on both
    /// audiences: who is signed in, the folders, and every folder's history.
    #[test]
    fn the_epicenter_app_relays_any_route_on_its_audiences() {
        let origin = "https://api.epicenter.so";
        for (audience, method, url) in [
            (
                Audience::Api,
                "GET",
                "https://api.epicenter.so/auth/oauth2/userinfo",
            ),
            (
                Audience::Api,
                "POST",
                "https://api.epicenter.so/v1/chat/completions",
            ),
            (Audience::Git, "GET", "https://api.epicenter.so/api/folders"),
            (
                Audience::Git,
                "POST",
                "https://git.epicenter.so/folders/f.git/git-upload-pack",
            ),
        ] {
            assert_eq!(
                permits(&EPICENTER, origin, audience, method, url),
                Ok(()),
                "{url}"
            );
        }
        assert!(permits(
            &EPICENTER,
            origin,
            Audience::Api,
            "GET",
            "https://evil.com/"
        )
        .is_err());
    }

    #[test]
    fn the_epicenter_app_asks_for_every_folder_on_both_audiences() {
        let url = authorize_url(
            &EPICENTER,
            "https://api.epicenter.so",
            "http://127.0.0.1:5555/callback",
            "st",
            "ch",
        );
        assert!(url.contains(
            "&scope=openid%20offline_access%20profile%20email%20ai%20folders%3Aread%20folders%3Awrite%20folders%3Aall&"
        ));
        assert!(url.ends_with(
            "&resource=https%3A%2F%2Fapi.epicenter.so&resource=https%3A%2F%2Fgit.epicenter.so"
        ));
        assert_eq!(
            Audience::Git.url("http://localhost:8787"),
            "http://localhost:8787/git"
        );
    }

    #[test]
    fn a_folder_request_goes_to_the_deployment_or_the_git_origin() {
        let origin = "https://api.epicenter.so";
        assert!(reaches("https://git.epicenter.so/folders", origin, Audience::Git));
        assert!(reaches("https://api.epicenter.so/api/folders", origin, Audience::Git));
        assert!(!reaches("https://git.epicenter.so/folders", origin, Audience::Api));
        assert!(!reaches("https://git.epicenter.so.evil.com/", origin, Audience::Git));
        let local = "http://localhost:8787";
        assert!(reaches("http://localhost:8787/git/folders", local, Audience::Git));
    }

    #[test]
    fn a_relayed_request_names_its_audience_or_is_the_apis() {
        let request: RelayRequest = serde_json::from_value(serde_json::json!({
            "id": 1, "url": "u", "method": "GET", "headers": [], "body": null, "audience": "git"
        }))
        .unwrap();
        assert_eq!(request.audience, Some(Audience::Git));
        let request: RelayRequest = serde_json::from_value(serde_json::json!({
            "id": 1, "url": "u", "method": "GET", "headers": [], "body": null
        }))
        .unwrap();
        assert_eq!(request.audience, None);
    }

    #[test]
    fn the_authorization_page_asks_for_the_api_only_with_pkce() {
        let url = authorize_url(
            &VOCAB,
            "https://api.epicenter.so",
            "http://127.0.0.1:5555/callback",
            "st",
            "ch",
        );
        assert_eq!(
            url,
            "https://api.epicenter.so/auth/oauth2/authorize?response_type=code\
             &client_id=so.epicenter.vocab.native\
             &redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback\
             &scope=openid%20offline_access%20profile%20email%20ai\
             &state=st&code_challenge=ch&code_challenge_method=S256\
             &resource=https%3A%2F%2Fapi.epicenter.so"
        );
    }

    #[test]
    fn the_browser_tab_names_the_app() {
        let page = tab_page(VOCAB.name, "You are signed in to Vocab.");
        assert!(page.contains("<title>Vocab</title>"));
        assert!(page.contains("You are signed in to Vocab. You can close this tab."));
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
            serde_json::to_value(RelayEvent::<AccountFailure>::Head {
                status: 200,
                headers: vec![("a".into(), "b".into())]
            })
            .unwrap(),
            serde_json::json!({ "kind": "head", "status": 200, "headers": [["a", "b"]] })
        );
        assert_eq!(
            serde_json::to_value(RelayEvent::<AccountFailure>::End).unwrap(),
            serde_json::json!({ "kind": "end" })
        );
        assert_eq!(
            serde_json::to_value(RelayEvent::Error(AccountFailure {
                message: "m".into(),
                refusal: Some("reauth-required")
            }))
            .unwrap(),
            serde_json::json!({ "kind": "error", "message": "m", "refusal": "reauth-required" })
        );
    }

    /// An account against `origin` whose credentials hold `stored`, writing
    /// who is signed in under `dir`.
    fn account_in(dir: &std::path::Path, origin: &str, stored: Option<&StoredGrant>) -> Account {
        let secrets = Arc::new(crate::credentials::Memory::default());
        if let Some(stored) = stored {
            secrets
                .set(
                    &format!("account:{origin}"),
                    Some(&serde_json::to_string(stored).unwrap()),
                )
                .unwrap();
        }
        let account = Account::new(VOCAB, origin.to_string(), secrets);
        account.identify_at(dir.join(IDENTITY_FILE));
        account
    }

    fn identity_in(dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join(IDENTITY_FILE)).unwrap()).unwrap()
    }

    fn grant() -> StoredGrant {
        StoredGrant {
            refresh_token: "r".into(),
            principal_id: "p".into(),
        }
    }

    #[tokio::test]
    async fn startup_writes_who_the_credentials_say_is_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        let origin = "https://api.epicenter.so";
        account_in(dir.path(), origin, Some(&grant()))
            .publish_loaded()
            .await
            .unwrap();
        assert_eq!(
            identity_in(dir.path()),
            serde_json::json!({ "origin": origin, "principalId": "p", "refused": false })
        );
        account_in(dir.path(), origin, None)
            .publish_loaded()
            .await
            .unwrap();
        assert_eq!(
            identity_in(dir.path()),
            serde_json::json!({ "origin": origin, "principalId": null, "refused": false })
        );
    }

    /// The revoke goes to a port nothing listens on, so the sign-out is
    /// local only, as it is offline.
    #[tokio::test]
    async fn a_sign_out_forgets_the_grant_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let origin = "http://127.0.0.1:9";
        let account = account_in(dir.path(), origin, Some(&grant()));
        account.publish_loaded().await.unwrap();
        assert_eq!(identity_in(dir.path())["principalId"], "p");
        account.sign_out().await.unwrap();
        assert_eq!(
            identity_in(dir.path()),
            serde_json::json!({ "origin": origin, "principalId": null, "refused": false })
        );
        assert_eq!(account.secrets.get(&account.entry()).unwrap(), None);
        assert_eq!(
            account.access_token(Audience::Api, false).await,
            Err(Refusal::SignedOut)
        );
    }

    /// Quitting waits for a refresh the server is answering, so the refresh
    /// token it rotated is in the credentials file before the process ends,
    /// and no refresh starts after.
    #[tokio::test(flavor = "multi_thread")]
    async fn quitting_waits_for_a_rotated_refresh_token_to_be_stored() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut buffer = [0u8; 4096];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.unwrap();
                head.extend_from_slice(&buffer[..read]);
            }
            // The server is slow to answer, and rotates the refresh token.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let body = r#"{"access_token":"a","refresh_token":"rotated","expires_in":3600}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let account = Arc::new(account_in(dir.path(), &origin, Some(&grant())));
        let refreshing = account.clone();
        let refresh =
            tokio::spawn(async move { refreshing.access_token(Audience::Api, false).await });
        // Let the refresh take the grant before quitting asks for it.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let quitting = account.clone();
        tokio::task::spawn_blocking(move || quitting.finish_refreshing(EXIT_WAIT))
            .await
            .unwrap();
        let stored = account.secrets.get(&account.entry()).unwrap().unwrap();
        assert!(stored.contains(r#""refreshToken":"rotated""#), "{stored}");
        assert_eq!(refresh.await.unwrap(), Ok("a".to_string()));
        // Nothing refreshes once the app is quitting.
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                account.access_token(Audience::Git, false)
            )
            .await
            .is_err()
        );
    }

    /// The token endpoint refuses the refresh token: `account.json` says so,
    /// and the account asks for a new sign-in without asking the server again.
    #[tokio::test]
    async fn a_refused_refresh_is_written_as_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut buffer = [0u8; 4096];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).await.unwrap();
                head.extend_from_slice(&buffer[..read]);
            }
            let body = r#"{"error":"invalid_grant"}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            String::from_utf8_lossy(&head).into_owned()
        });
        let dir = tempfile::tempdir().unwrap();
        let account = account_in(dir.path(), &origin, Some(&grant()));
        account.publish_loaded().await.unwrap();
        assert_eq!(identity_in(dir.path())["refused"], false);
        assert_eq!(
            account.access_token(Audience::Api, false).await,
            Err(Refusal::Reauth)
        );
        assert!(server.await.unwrap().starts_with("POST /auth/oauth2/token"));
        assert_eq!(
            identity_in(dir.path()),
            serde_json::json!({ "origin": origin, "principalId": "p", "refused": true })
        );
        // Refused once is refused until a sign-in, for every audience: no
        // second request.
        assert_eq!(
            account.access_token(Audience::Git, false).await,
            Err(Refusal::Reauth)
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
