//! Git's smart HTTP protocol (stateless RPC) over the core's HTTP client,
//! registered with libgit2 for `https` and `http` in place of libgit2's own
//! HTTP, which would need a TLS library of its own (OpenSSL on Linux and
//! iOS). `http` is registered too, for a local server such as the
//! development API, so every Git request takes the same path.
//!
//! libgit2 hands a registered transport no custom headers
//! (`FetchOptions::custom_headers` only reaches its built-in HTTP), so the
//! bearer token travels another way: a round enters a [`Session`] on its
//! thread, and the transport factory, which libgit2 calls on that same
//! thread when it connects, captures the session's token.

use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, Once};

use git2::transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport};
use ureq::BodyReader;

use crate::http::{self, agent, Refused};

/// The credential of the round running on this thread, and whether the
/// server refused it.
pub(crate) struct Session {
    origin: String,
    token: Option<String>,
    refused: Mutex<Option<u16>>,
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<Session>>> = const { RefCell::new(None) };
}

/// Ends the session when the round returns, restoring the one it replaced
/// (a round run from inside another's note merge, as a test does).
pub(crate) struct Entered(Option<Arc<Session>>);

impl Drop for Entered {
    fn drop(&mut self) {
        let previous = self.0.take();
        CURRENT.with(|current| *current.borrow_mut() = previous);
    }
}

impl Session {
    /// Make `token` the bearer for requests to `url`'s origin from this
    /// thread until the returned guard drops.
    pub(crate) fn enter(url: &str, token: Option<&str>) -> Entered {
        register();
        let session = Session {
            origin: http::origin(url).to_string(),
            token: token.map(str::to_string),
            refused: Mutex::new(None),
        };
        Entered(CURRENT.with(|current| current.borrow_mut().replace(Arc::new(session))))
    }

    /// The status the remote last refused this thread's credential with (401 or 403).
    pub(crate) fn refused() -> Option<u16> {
        CURRENT.with(|current| {
            current
                .borrow()
                .as_ref()
                .and_then(|s| *s.refused.lock().unwrap())
        })
    }
}

/// Register the transport for `https` and `http`, once per process.
pub fn register() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        for scheme in ["https", "http"] {
            // SAFETY: `Once` serializes registration, and it runs before this
            // process's first round creates a transport. An error means another
            // component registered the scheme first, and its transport stays.
            let _ = unsafe {
                git2::transport::register(scheme, |remote| {
                    let session = CURRENT.with(|current| current.borrow().clone());
                    let session = session.filter(|s| {
                        remote
                            .url()
                            .is_some_and(|url| http::origin(url) == s.origin)
                    });
                    Transport::smart(remote, true, SmartHttp { session })
                })
            };
        }
    });
}

struct SmartHttp {
    /// The round's credential, when the remote is at its origin.
    session: Option<Arc<Session>>,
}

impl SmartSubtransport for SmartHttp {
    fn action(
        &self,
        url: &str,
        action: Service,
    ) -> Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        let base = url.trim_end_matches('/');
        let (service, advertise) = match action {
            Service::UploadPackLs => ("git-upload-pack", true),
            Service::UploadPack => ("git-upload-pack", false),
            Service::ReceivePackLs => ("git-receive-pack", true),
            Service::ReceivePack => ("git-receive-pack", false),
        };
        let url = if advertise {
            format!("{base}/info/refs?service={service}")
        } else {
            format!("{base}/{service}")
        };
        Ok(Box::new(Exchange {
            session: self.session.clone(),
            url,
            service,
            advertise,
            request: Vec::new(),
            response: None,
        }))
    }

    fn close(&self) -> Result<(), git2::Error> {
        Ok(())
    }
}

/// One stateless request: the advertisement is a GET; an RPC buffers what
/// libgit2 writes and POSTs it on the first read, as smart HTTP's stateless
/// RPC sends a whole request before any response.
struct Exchange {
    session: Option<Arc<Session>>,
    url: String,
    service: &'static str,
    advertise: bool,
    request: Vec<u8>,
    response: Option<BodyReader<'static>>,
}

impl Exchange {
    fn send(&mut self) -> io::Result<BodyReader<'static>> {
        let token = self.session.as_ref().and_then(|s| s.token.as_deref());
        let bearer = token.map(|t| format!("Bearer {t}"));
        let sent = if self.advertise {
            let mut request = agent().get(&self.url);
            if let Some(bearer) = &bearer {
                request = request.header("authorization", bearer);
            }
            request.call()
        } else {
            let mut request = agent()
                .post(&self.url)
                .header(
                    "content-type",
                    format!("application/x-{}-request", self.service),
                )
                .header("accept", format!("application/x-{}-result", self.service));
            if let Some(bearer) = &bearer {
                request = request.header("authorization", bearer);
            }
            request.send(std::mem::take(&mut self.request))
        };
        let response = sent.map_err(|e| io::Error::other(format!("{}: {e}", self.url)))?;
        let response = http::success(response).map_err(|refused| self.refused(refused))?;
        if self.advertise {
            let expected = format!("application/x-{}-advertisement", self.service);
            let kind = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            if kind != expected {
                return Err(io::Error::other(format!(
                    "{} is not a Git smart HTTP server (answered {kind:?})",
                    self.url
                )));
            }
        }
        Ok(response.into_body().into_reader())
    }

    fn refused(&self, refused: Refused) -> io::Error {
        if matches!(refused.status, 401 | 403) {
            if let Some(session) = &self.session {
                *session.refused.lock().unwrap() = Some(refused.status);
            }
            let kind = io::ErrorKind::PermissionDenied;
            return io::Error::new(
                kind,
                format!(
                    "the remote refused this account ({}): {}",
                    refused.status, refused.body
                ),
            );
        }
        io::Error::other(format!(
            "{} answered {}: {}",
            self.url, refused.status, refused.body
        ))
    }
}

impl Read for Exchange {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.response.is_none() {
            self.response = Some(self.send()?);
        }
        self.response.as_mut().expect("sent").read(buf)
    }
}

impl Write for Exchange {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.request.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
