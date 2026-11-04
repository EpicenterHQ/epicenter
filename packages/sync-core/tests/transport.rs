//! A Rust transport registered for `https://` through `git2::transport`, so
//! libgit2 needs no TLS of its own (no `https` feature, no OpenSSL). Here
//! the stand-in speaks smart HTTP's stateless RPC by piping each request to
//! `git upload-pack` / `git receive-pack --stateless-rpc` on the local bare
//! remote; the real core would send the same bytes over ureq.

mod common;

use std::io::{self, Cursor, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use common::*;
use epicenter_sync_core::{sync_round, Options, Remote, Status};
use git2::transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport};

const URL: &str = "https://sync.example.test/remote.git";

/// The bare repository the `https://` URL stands for, and every action asked of the transport.
static REMOTE: OnceLock<PathBuf> = OnceLock::new();
static ACTIONS: Mutex<Vec<(String, Service)>> = Mutex::new(Vec::new());

struct Rpc;

impl SmartSubtransport for Rpc {
    fn action(&self, url: &str, action: Service) -> Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        ACTIONS.lock().unwrap().push((url.to_string(), action));
        let (program, advertise) = match action {
            Service::UploadPackLs => ("upload-pack", true),
            Service::UploadPack => ("upload-pack", false),
            Service::ReceivePackLs => ("receive-pack", true),
            Service::ReceivePack => ("receive-pack", false),
        };
        Ok(Box::new(Exchange { program, advertise, request: Vec::new(), response: None }))
    }
    fn close(&self) -> Result<(), git2::Error> {
        Ok(())
    }
}

/// One stateless request: buffer what libgit2 writes, answer on the first read.
struct Exchange {
    program: &'static str,
    advertise: bool,
    request: Vec<u8>,
    response: Option<Cursor<Vec<u8>>>,
}

impl Exchange {
    fn run(&self) -> io::Result<Vec<u8>> {
        let remote = REMOTE.get().expect("remote set");
        let mut cmd = Command::new("git");
        cmd.args([self.program, "--stateless-rpc"]);
        if self.advertise {
            cmd.arg("--advertise-refs");
        }
        let mut child = cmd.arg(remote).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
        child.stdin.take().unwrap().write_all(&self.request)?;
        let out = child.wait_with_output()?;
        let mut body = Vec::new();
        if self.advertise {
            // What a smart HTTP server puts before the advertisement.
            let line = format!("# service=git-{}\n", self.program);
            body.extend(format!("{:04x}{line}0000", line.len() + 4).into_bytes());
        }
        body.extend(out.stdout);
        Ok(body)
    }
}

impl Read for Exchange {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.response.is_none() {
            self.response = Some(Cursor::new(self.run()?));
        }
        self.response.as_mut().unwrap().read(buf)
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

#[test]
fn a_round_over_https_goes_through_the_registered_rust_transport() {
    let world = World::new();
    REMOTE.set(world.remote_path()).unwrap();
    unsafe { git2::transport::register("https", |remote| Transport::smart(remote, true, Rpc)) }.unwrap();

    let remote = Remote { url: URL.into(), token: None, lfs: Some(epicenter_sync_core::LfsEndpoint::Dir(world.lfs_store())) };
    let sync = |folder: &std::path::Path, machine: &str| {
        let round = sync_round(folder, &Options { remote: Some(remote.clone()), machine: machine.into(), merge: &StandIn });
        assert_eq!(round.status, Status::Synced, "{machine}: {:?}", round.message);
    };

    let a = world.folder("a");
    write(&a, "notes/from-a.md", "from a\n");
    sync(&a, "A");
    let b = world.folder("b");
    write(&b, "notes/from-b.md", "from b\n");
    sync(&b, "B");
    sync(&a, "A");

    assert_eq!(read(&a, "notes/from-b.md"), "from b\n");
    assert_eq!(remote_blob(&world, "notes/from-a.md").as_deref(), Some(&b"from a\n"[..]));
    let actions = ACTIONS.lock().unwrap();
    assert!(actions.iter().all(|(url, _)| url.starts_with(URL)), "{actions:?}");
    for service in [Service::UploadPackLs, Service::UploadPack, Service::ReceivePackLs, Service::ReceivePack] {
        assert!(actions.iter().any(|(_, s)| *s == service), "no {service:?} in {actions:?}");
    }
}
