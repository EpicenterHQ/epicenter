//! One round from the command line, to measure what linking the core costs
//! a native host: `cargo build --release --example round`.
//!
//! `round <folder> <remote url> [token]`. Notes both sides changed keep this
//! machine's text: a placeholder, not `settle`.

use epicenter_sync_core::{sync_round, NoteInput, NoteMerge, Options, Remote};

struct Incoming;

impl NoteMerge for Incoming {
    fn settle(&self, n: &NoteInput) -> Result<String, String> {
        Ok(n.incoming.to_string())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(folder), Some(url)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: round <folder> <remote url> [token]");
        std::process::exit(2);
    };
    let round = sync_round(
        std::path::Path::new(folder),
        &Options {
            remote: Some(Remote { url: url.clone(), token: args.get(3).cloned(), lfs: None }),
            machine: "this computer".into(),
            merge: &Incoming,
        },
    );
    println!("{:?} {:?} {}", round.status, round.message, round.notes.join("; "));
}
