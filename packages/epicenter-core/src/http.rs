//! The core's one HTTP client, shared by Git's smart HTTP transport
//! (`transport.rs`) and the Git LFS batch client (`lfs.rs`), so Git and LFS
//! use one TLS stack: rustls with the `ring` provider and Mozilla's roots,
//! the same on every platform, with no OpenSSL and no platform TLS library.
//!
//! ureq rather than reqwest's blocking client: libgit2 calls a transport
//! synchronously on the round's thread, and ureq does blocking I/O on that
//! thread, where reqwest's blocking client runs a Tokio runtime on a thread
//! of its own and adds hyper and Tokio to every app and the iOS build.

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use ureq::http::Response;
use ureq::{Agent, Body};

/// The process's agent: one connection pool for every round.
pub(crate) fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            // Each caller reads the status, so a refusal's body reaches its message.
            .http_status_as_error(false)
            // Smart HTTP servers such as GitHub expect a `git/` agent.
            .user_agent(concat!(
                "git/2.0 (epicenter-core/",
                env!("CARGO_PKG_VERSION"),
                ")"
            ))
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_per_read(Some(Duration::from_secs(120)))
            .build()
            .new_agent()
    })
}

/// A response the server answered with an error status.
pub(crate) struct Refused {
    pub status: u16,
    pub body: String,
}

/// The response when its status is a success, otherwise its status and
/// the start of its body.
pub(crate) fn success(response: Response<Body>) -> Result<Response<Body>, Refused> {
    let status = response.status().as_u16();
    if status < 400 {
        return Ok(response);
    }
    let mut body = String::new();
    let _ = response
        .into_body()
        .into_reader()
        .take(2048)
        .read_to_string(&mut body);
    Err(Refused {
        status,
        body: body.trim().to_string(),
    })
}

/// The scheme, host and port of `url`: the only place a bearer token goes.
pub(crate) fn origin(url: &str) -> &str {
    let after = url.find("://").map(|i| i + 3).unwrap_or(0);
    match url[after..].find('/') {
        Some(i) => &url[..after + i],
        None => url,
    }
}

#[cfg(test)]
mod tests {
    use super::origin;

    #[test]
    fn origin_is_scheme_host_and_port() {
        assert_eq!(
            origin("https://sync.example.test:8443/a/b.git"),
            "https://sync.example.test:8443"
        );
        assert_eq!(origin("http://127.0.0.1"), "http://127.0.0.1");
    }
}
