//! Sign-in with Epicenter, for hosted transcription and AI only. Signing in
//! never changes where Whispering keeps its files (decision 77).
//!
//! A native app's OAuth (RFC 8252): the person signs in in their own browser,
//! which returns to a loopback redirect this shell listens on for one
//! request (`http://127.0.0.1:<port>/callback`), with S256 PKCE. The client
//! is Whispering's desktop registration (`so.epicenter.whispering.desktop`,
//! `apps/api/worker/oauth-registrations.ts`), asking for the API audience
//! only: the desktop app reads no repository.
//!
//! The refresh token is kept in the credential store (`secrets::ACCOUNT`)
//! and never leaves this process. The page asks for an access token when it
//! sends a request (`account_token`); one about to expire is refreshed first.
//! A refresh the server refuses leaves the account `reauth-required`, kept
//! until the person signs in again or out.

use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

use crate::secrets::{Secrets, ACCOUNT};

/// Whispering's desktop OAuth client.
pub const CLIENT_ID: &str = "so.epicenter.whispering.desktop";
/// Epicenter's API, which is also its authorization server.
pub const PRODUCTION_API: &str = "https://api.epicenter.so";
const SCOPE: &str = "openid profile email ai offline_access";
/// A sign-in the person has not finished in this long is given up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Refresh an access token this long before it expires.
const RENEW_BEFORE: Duration = Duration::from_secs(60);

/// The API this build signs in to: Epicenter's, or in a debug build
/// `EPICENTER_API_URL` when set (a local or self-hosted API).
pub fn api_origin() -> String {
    #[cfg(debug_assertions)]
    if let Some(origin) = std::env::var("EPICENTER_API_URL")
        .ok()
        .and_then(|value| origin_of(&value))
    {
        return origin;
    }
    PRODUCTION_API.to_owned()
}

/// `scheme://host[:port]` of an http(s) URL, or `None`.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty() && !host.contains('@')).then(|| format!("{scheme}://{host}"))
}

/// The API audience for `origin`, as `resolveOAuthAudiences` in
/// `@epicenter/constants/apps` names it.
fn api_audience(origin: &str) -> String {
    origin.to_owned()
}

/// What the credential store keeps for the signed-in person.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Stored {
    origin: String,
    principal_id: String,
    /// A new value per sign-in: the page retires an Account bound to another.
    generation: String,
    refresh_token: String,
    name: Option<String>,
    email: Option<String>,
}

/// What a page is told about the account. Never a token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AccountState {
    #[serde(rename_all = "camelCase")]
    SignedOut { base_url: String },
    #[serde(rename_all = "camelCase")]
    SignedIn {
        base_url: String,
        principal_id: String,
        generation: String,
        name: Option<String>,
        email: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReauthRequired {
        base_url: String,
        principal_id: String,
        generation: String,
        name: Option<String>,
        email: Option<String>,
    },
}

struct Access {
    token: String,
    expires_at: SystemTime,
}

/// The shell's account: what is stored, the access token in memory, and
/// the sign-in waiting for its browser, if any.
pub struct Accounts {
    origin: String,
    client: reqwest::Client,
    access: Mutex<Option<Access>>,
    refused: std::sync::Mutex<bool>,
    waiting: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Accounts {
    pub fn new(origin: String) -> Self {
        Self {
            origin,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(60))
                .build()
                .expect("an HTTP client"),
            access: Mutex::new(None),
            refused: std::sync::Mutex::new(false),
            waiting: std::sync::Mutex::new(None),
        }
    }

    fn stored(&self, secrets: &Secrets) -> Result<Option<Stored>, String> {
        let Some(text) = secrets.get(ACCOUNT)? else {
            return Ok(None);
        };
        match serde_json::from_str::<Stored>(&text) {
            // Signed in to another API (a debug build pointed elsewhere): not this one's.
            Ok(stored) if stored.origin == self.origin => Ok(Some(stored)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    pub fn state(&self, secrets: &Secrets) -> Result<AccountState, String> {
        let Some(stored) = self.stored(secrets)? else {
            return Ok(self.signed_out());
        };
        let refused = *self.refused.lock().map_err(|_| "account lock")?;
        let Stored {
            principal_id,
            generation,
            name,
            email,
            ..
        } = stored;
        let base_url = self.origin.clone();
        Ok(if refused {
            AccountState::ReauthRequired {
                base_url,
                principal_id,
                generation,
                name,
                email,
            }
        } else {
            AccountState::SignedIn {
                base_url,
                principal_id,
                generation,
                name,
                email,
            }
        })
    }

    /// Sign in in the person's browser; answers once they finished there.
    /// Another sign-in started meanwhile withdraws this one.
    pub async fn sign_in(
        &self,
        secrets: &Secrets,
        open: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<AccountState, String> {
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = self
            .waiting
            .lock()
            .map_err(|_| "account lock")?
            .replace(cancel)
        {
            let _ = previous.send(());
        }
        let pending = PendingSignIn::begin(&self.origin).await?;
        open(&pending.authorize_url)?;
        let code = tokio::select! {
            code = tokio::time::timeout(SIGN_IN_TIMEOUT, pending.wait()) => code
                .map_err(|_| "Sign-in took too long. Try again.".to_string())??,
            _ = cancelled => return Err("Sign-in was replaced by another.".into()),
        };
        let tokens = self
            .exchange(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &pending.redirect_uri),
                ("client_id", CLIENT_ID),
                ("code_verifier", &pending.verifier),
                ("resource", &api_audience(&self.origin)),
            ])
            .await?;
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or("The server answered without a refresh token.")?;
        let user = self.userinfo(&tokens.access_token).await?;
        let stored = Stored {
            origin: self.origin.clone(),
            principal_id: user.sub,
            generation: random_token(),
            refresh_token,
            name: user.name,
            email: user.email,
        };
        secrets.set(
            ACCOUNT,
            Some(&serde_json::to_string(&stored).map_err(|e| e.to_string())?),
        )?;
        *self.access.lock().await = Some(tokens.access());
        *self.refused.lock().map_err(|_| "account lock")? = false;
        self.state(secrets)
    }

    /// An access token for the API, refreshed first when about to expire.
    pub async fn token(&self, secrets: &Secrets) -> Result<String, String> {
        let mut access = self.access.lock().await;
        if let Some(current) = access.as_ref() {
            if current.expires_at > SystemTime::now() + RENEW_BEFORE {
                return Ok(current.token.clone());
            }
        }
        let Some(mut stored) = self.stored(secrets)? else {
            return Err("signed-out".into());
        };
        let refreshed = self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &stored.refresh_token),
                ("client_id", CLIENT_ID),
                ("resource", &api_audience(&self.origin)),
            ])
            .await?;
        let tokens = match refreshed {
            TokenAnswer::Tokens(tokens) => tokens,
            TokenAnswer::Refused(reason) => {
                *self.refused.lock().map_err(|_| "account lock")? = true;
                *access = None;
                return Err(format!("reauth-required: {reason}"));
            }
        };
        if let Some(rotated) = &tokens.refresh_token {
            stored.refresh_token = rotated.clone();
            secrets.set(
                ACCOUNT,
                Some(&serde_json::to_string(&stored).map_err(|e| e.to_string())?),
            )?;
        }
        *self.refused.lock().map_err(|_| "account lock")? = false;
        let token = tokens.access_token.clone();
        *access = Some(tokens.access());
        Ok(token)
    }

    /// Forget the account here and ask the server to revoke its refresh token.
    pub async fn sign_out(&self, secrets: &Secrets) -> Result<AccountState, String> {
        if let Some(waiting) = self.waiting.lock().map_err(|_| "account lock")?.take() {
            let _ = waiting.send(());
        }
        let stored = self.stored(secrets).ok().flatten();
        secrets.set(ACCOUNT, None)?;
        *self.access.lock().await = None;
        *self.refused.lock().map_err(|_| "account lock")? = false;
        if let Some(stored) = stored {
            // Best effort: the account is gone here whether or not this lands.
            let _ = self
                .client
                .post(format!("{}/auth/oauth2/revoke", self.origin))
                .timeout(Duration::from_secs(5))
                .form(&[
                    ("token", stored.refresh_token.as_str()),
                    ("client_id", CLIENT_ID),
                    ("token_type_hint", "refresh_token"),
                ])
                .send()
                .await;
        }
        Ok(self.signed_out())
    }

    fn signed_out(&self) -> AccountState {
        AccountState::SignedOut {
            base_url: self.origin.clone(),
        }
    }

    async fn exchange(&self, form: &[(&str, &str)]) -> Result<Tokens, String> {
        match self.token_request(form).await? {
            TokenAnswer::Tokens(tokens) => Ok(tokens),
            TokenAnswer::Refused(reason) => Err(format!("Sign-in was refused: {reason}")),
        }
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenAnswer, String> {
        let response = self
            .client
            .post(format!("{}/auth/oauth2/token", self.origin))
            .form(form)
            .send()
            .await
            .map_err(|error| format!("Epicenter could not be reached: {error}"))?;
        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if status.is_success() {
            return serde_json::from_str(&text)
                .map(TokenAnswer::Tokens)
                .map_err(|error| format!("The token answer did not read: {error}"));
        }
        let refusal: Option<OAuthRefusal> = serde_json::from_str(&text).ok();
        match refusal {
            Some(refusal) if status.is_client_error() => Ok(TokenAnswer::Refused(
                refusal.error_description.unwrap_or(refusal.error),
            )),
            _ => Err(format!("Epicenter answered {status}.")),
        }
    }

    async fn userinfo(&self, access_token: &str) -> Result<UserInfo, String> {
        let response = self
            .client
            .get(format!("{}/auth/oauth2/userinfo", self.origin))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| format!("Epicenter could not be reached: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Epicenter did not say who signed in ({}).",
                response.status()
            ));
        }
        response
            .json()
            .await
            .map_err(|error| format!("Who signed in did not read: {error}"))
    }
}

enum TokenAnswer {
    Tokens(Tokens),
    Refused(String),
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

impl Tokens {
    fn access(&self) -> Access {
        Access {
            token: self.access_token.clone(),
            expires_at: SystemTime::now() + Duration::from_secs(self.expires_in),
        }
    }
}

#[derive(Deserialize)]
struct OAuthRefusal {
    error: String,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    name: Option<String>,
    email: Option<String>,
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// `value` percent-encoded for a query string.
fn encode(value: &str) -> String {
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

fn decode(value: &str) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => match (hex(bytes[index + 1]), hex(bytes[index + 2]))
            {
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

/// What the browser's return to the loopback said.
#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Refused(String),
    /// Another path (a favicon), or another attempt's state.
    Other,
}

fn read_callback(request_line: &str, state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Callback::Other;
    }
    let Some(target) = parts.next() else {
        return Callback::Other;
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return Callback::Other;
    }
    let mut code = None;
    let mut error = None;
    let mut description = None;
    let mut returned_state = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = decode(value);
        match key {
            "code" => code = Some(value),
            "state" => returned_state = Some(value),
            "error" => error = Some(value),
            "error_description" => description = Some(value),
            _ => {}
        }
    }
    if returned_state.as_deref() != Some(state) {
        return Callback::Other;
    }
    if let Some(error) = error {
        return Callback::Refused(description.unwrap_or(error));
    }
    code.map_or(Callback::Other, Callback::Code)
}

/// One sign-in: its PKCE verifier, the loopback it listens on, and the URL
/// the browser opens.
struct PendingSignIn {
    listener: TcpListener,
    verifier: String,
    state: String,
    redirect_uri: String,
    authorize_url: String,
}

impl PendingSignIn {
    async fn begin(origin: &str) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Sign-in could not listen for its answer: {error}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let verifier = random_token();
        let state = random_token();
        let query = [
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPE),
            ("state", state.as_str()),
            ("code_challenge", &challenge_for(&verifier)),
            ("code_challenge_method", "S256"),
            ("resource", &api_audience(origin)),
        ]
        .iter()
        .map(|(key, value)| format!("{key}={}", encode(value)))
        .collect::<Vec<_>>()
        .join("&");
        Ok(Self {
            listener,
            verifier,
            state,
            redirect_uri,
            authorize_url: format!("{origin}/auth/oauth2/authorize?{query}"),
        })
    }

    /// The code the browser brings back, answering it with a page to close.
    async fn wait(&self) -> Result<String, String> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|error| error.to_string())?;
            let mut buffer = vec![0u8; 8192];
            let read = match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer))
                .await
            {
                Ok(Ok(read)) => read,
                _ => continue,
            };
            let text = String::from_utf8_lossy(&buffer[..read]);
            let line = text.lines().next().unwrap_or("");
            let callback = read_callback(line, &self.state);
            let (status, body) = match &callback {
                Callback::Code(_) => (
                    "200 OK",
                    "You are signed in to Whispering. You can close this tab.",
                ),
                Callback::Refused(_) => (
                    "200 OK",
                    "Sign-in did not finish. Return to Whispering to try again.",
                ),
                Callback::Other => ("404 Not Found", "Not found."),
            };
            let page = format!(
                "<!doctype html><meta charset=utf-8><title>Whispering</title><p style=\"font:16px system-ui;margin:3em\">{body}</p>"
            );
            let _ = stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                        page.len()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = stream.shutdown().await;
            match callback {
                Callback::Code(code) => return Ok(code),
                Callback::Refused(reason) => {
                    return Err(format!("Sign-in did not finish: {reason}"))
                }
                Callback::Other => continue,
            }
        }
    }
}

// --- commands -----------------------------------------------------------

#[tauri::command]
pub fn account_state(
    accounts: tauri::State<'_, Accounts>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<AccountState, String> {
    accounts.state(&secrets)
}

/// Open the person's browser to sign in; answers when they finished.
#[tauri::command]
pub async fn account_sign_in(
    accounts: tauri::State<'_, Accounts>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<AccountState, String> {
    accounts
        .sign_in(&secrets, |url| {
            tauri_plugin_opener::open_url(url, None::<&str>)
                .map_err(|error| format!("Your browser could not be opened: {error}"))
        })
        .await
}

#[tauri::command]
pub async fn account_sign_out(
    accounts: tauri::State<'_, Accounts>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<AccountState, String> {
    accounts.sign_out(&secrets).await
}

/// An access token for one request to the API. Errors start with
/// `signed-out` or `reauth-required` when that is why.
#[tauri::command]
pub async fn account_token(
    accounts: tauri::State<'_, Accounts>,
    secrets: tauri::State<'_, Secrets>,
) -> Result<String, String> {
    accounts.token(&secrets).await
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener as StdListener;
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[test]
    fn origins_and_audiences() {
        assert_eq!(
            origin_of("http://localhost:8787/x?y").as_deref(),
            Some("http://localhost:8787")
        );
        assert_eq!(
            origin_of("https://api.epicenter.so").as_deref(),
            Some("https://api.epicenter.so")
        );
        assert_eq!(origin_of("ftp://x"), None);
        assert_eq!(origin_of("https://u@x"), None);
        assert_eq!(api_audience(PRODUCTION_API), PRODUCTION_API);
    }

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(random_token().len(), 43);
    }

    #[test]
    fn the_callback_is_read_only_for_this_attempt() {
        assert_eq!(
            read_callback("GET /callback?code=a%2Bb&state=s1 HTTP/1.1", "s1"),
            Callback::Code("a+b".into())
        );
        assert_eq!(
            read_callback("GET /callback?code=a&state=s2 HTTP/1.1", "s1"),
            Callback::Other
        );
        assert_eq!(
            read_callback("GET /favicon.ico HTTP/1.1", "s1"),
            Callback::Other
        );
        assert_eq!(
            read_callback("POST /callback?code=a&state=s1 HTTP/1.1", "s1"),
            Callback::Other
        );
        assert_eq!(
            read_callback(
                "GET /callback?error=access_denied&error_description=Denied+by+you&state=s1 HTTP/1.1",
                "s1"
            ),
            Callback::Refused("Denied by you".into())
        );
    }

    /// A one-thread HTTP server answering each request with the next canned
    /// response, and keeping what it was sent.
    fn server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::sync::Arc<StdMutex<Vec<String>>>) {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (origin, seen)
    }

    fn memory() -> (tempfile::TempDir, Secrets) {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::File {
            path: dir.path().join("secrets.json"),
            lock: std::sync::Mutex::new(()),
        };
        (dir, secrets)
    }

    #[tokio::test]
    async fn sign_in_exchanges_the_code_keeps_the_refresh_token_and_tells_who() {
        let (origin, seen) = server(vec![
            (
                200,
                r#"{"access_token":"a1","expires_in":3600,"refresh_token":"r1","token_type":"Bearer"}"#,
            ),
            (
                200,
                r#"{"sub":"p1","name":"Ada","email":"ada@example.com"}"#,
            ),
        ]);
        let (_dir, secrets) = memory();
        let accounts = Accounts::new(origin.clone());
        let opened = std::sync::Arc::new(StdMutex::new(String::new()));
        let record = opened.clone();
        let browser = tokio::spawn(async move {
            // The browser: wait for the URL, then return to the loopback.
            loop {
                let url = record.lock().unwrap().clone();
                if !url.is_empty() {
                    let redirect = decode(
                        url.split("redirect_uri=")
                            .nth(1)
                            .unwrap()
                            .split('&')
                            .next()
                            .unwrap(),
                    );
                    let state = url
                        .split("state=")
                        .nth(1)
                        .unwrap()
                        .split('&')
                        .next()
                        .unwrap()
                        .to_owned();
                    let address = redirect
                        .trim_start_matches("http://")
                        .trim_end_matches("/callback")
                        .to_owned();
                    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                    stream
                        .write_all(
                            format!("GET /callback?code=c1&state={state} HTTP/1.1\r\n\r\n")
                                .as_bytes(),
                        )
                        .await
                        .unwrap();
                    let mut answer = String::new();
                    stream.read_to_string(&mut answer).await.unwrap();
                    assert!(answer.contains("You are signed in"));
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let state = accounts
            .sign_in(&secrets, |url| {
                *opened.lock().unwrap() = url.to_owned();
                Ok(())
            })
            .await
            .unwrap();
        browser.await.unwrap();
        let url = opened.lock().unwrap().clone();
        assert!(url.starts_with(&format!("{origin}/auth/oauth2/authorize?response_type=code&client_id=so.epicenter.whispering.desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A")));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("resource={}", encode(&origin))));
        let AccountState::SignedIn {
            principal_id, name, ..
        } = &state
        else {
            panic!("{state:?}")
        };
        assert_eq!(
            (principal_id.as_str(), name.as_deref()),
            ("p1", Some("Ada"))
        );
        let requests = seen.lock().unwrap().clone();
        assert!(requests[0].starts_with("POST /auth/oauth2/token"));
        assert!(requests[0].contains("grant_type=authorization_code&code=c1"));
        assert!(requests[0].contains("code_verifier="));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer a1"));
        // The token in memory answers without a request; the refresh token is stored.
        assert_eq!(accounts.token(&secrets).await.unwrap(), "a1");
        assert!(secrets
            .get(ACCOUNT)
            .unwrap()
            .unwrap()
            .contains("\"refreshToken\":\"r1\""));
    }

    fn signed_in(secrets: &Secrets, origin: &str) {
        let stored = Stored {
            origin: origin.to_owned(),
            principal_id: "p1".into(),
            generation: "g1".into(),
            refresh_token: "r1".into(),
            name: None,
            email: None,
        };
        secrets
            .set(ACCOUNT, Some(&serde_json::to_string(&stored).unwrap()))
            .unwrap();
    }

    #[tokio::test]
    async fn a_token_is_refreshed_and_a_rotated_refresh_token_kept() {
        let (origin, seen) = server(vec![(
            200,
            r#"{"access_token":"a2","expires_in":3600,"refresh_token":"r2"}"#,
        )]);
        let (_dir, secrets) = memory();
        signed_in(&secrets, &origin);
        let accounts = Accounts::new(origin.clone());
        assert_eq!(accounts.token(&secrets).await.unwrap(), "a2");
        assert_eq!(accounts.token(&secrets).await.unwrap(), "a2");
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(seen.lock().unwrap()[0].contains("grant_type=refresh_token&refresh_token=r1"));
        assert!(secrets
            .get(ACCOUNT)
            .unwrap()
            .unwrap()
            .contains("\"refreshToken\":\"r2\""));
    }

    #[tokio::test]
    async fn a_refused_refresh_asks_for_sign_in_again_and_keeps_the_account() {
        let (origin, _) = server(vec![(400, r#"{"error":"invalid_grant"}"#)]);
        let (_dir, secrets) = memory();
        signed_in(&secrets, &origin);
        let accounts = Accounts::new(origin);
        assert!(accounts
            .token(&secrets)
            .await
            .unwrap_err()
            .starts_with("reauth-required"));
        assert!(matches!(
            accounts.state(&secrets).unwrap(),
            AccountState::ReauthRequired { .. }
        ));
    }

    #[tokio::test]
    async fn sign_out_forgets_and_revokes() {
        let (origin, seen) = server(vec![(200, "{}")]);
        let (_dir, secrets) = memory();
        signed_in(&secrets, &origin);
        let accounts = Accounts::new(origin.clone());
        assert!(matches!(
            accounts.sign_out(&secrets).await.unwrap(),
            AccountState::SignedOut { .. }
        ));
        assert_eq!(secrets.get(ACCOUNT).unwrap(), None);
        assert!(seen.lock().unwrap()[0].starts_with("POST /auth/oauth2/revoke"));
        assert_eq!(accounts.token(&secrets).await.unwrap_err(), "signed-out");
    }

    #[test]
    fn an_account_for_another_api_is_not_this_one_s() {
        let (_dir, secrets) = memory();
        signed_in(&secrets, "http://localhost:8787");
        let accounts = Accounts::new(PRODUCTION_API.into());
        assert_eq!(
            accounts.state(&secrets).unwrap(),
            AccountState::SignedOut {
                base_url: PRODUCTION_API.into()
            }
        );
    }
}
