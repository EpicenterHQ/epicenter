//! The shell's half of one folder re-read, timed: what `files_list` and
//! `files_read_many` do for `recordings/` and `transcriptions/`, plus the
//! JSON Tauri adds around them (the listing out, the paths in). Opt-in:
//! nothing runs it but this command.
//!
//! ```sh
//! cargo run --release -p whispering-files --example reread_timing -- <folder> [runs]
//! ```
//!
//! The first run is as cold as the disk cache is; see
//! `apps/whispering/bench/reread/README.md` for a cold cache without root.
//! The parts are timed one after the other; `overlapped_ms` is the same
//! work again with the two reads on two threads, as the app runs them.

use std::path::Path;
use std::time::Instant;

use whispering_files::{list, read_many, resolve};

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let folder = args.next().expect("usage: reread_timing <folder> [runs]");
    let runs: usize = args.next().map_or(5, |runs| runs.parse().expect("runs"));
    let folder = Path::new(&folder);

    println!("run,list_rec_ms,list_tr_ms,list_json_ms,paths_json_ms,read_rec_ms,read_tr_ms,total_ms,resolve_ms_inside_reads,overlapped_ms,list_json_bytes,paths_json_bytes,read_bytes");
    for run in 0..runs {
        let start = Instant::now();

        let at = Instant::now();
        let recordings = list(folder, "recordings").expect("list recordings");
        let list_rec = ms(at);
        let at = Instant::now();
        let transcriptions = list(folder, "transcriptions").expect("list transcriptions");
        let list_tr = ms(at);

        // Tauri answers a listing as JSON.
        let at = Instant::now();
        let listed_json = serde_json::to_string(&recordings).unwrap().len()
            + serde_json::to_string(&transcriptions).unwrap().len();
        let list_json = ms(at);

        let paths_of = |dir: &str, entries: &[whispering_files::Entry]| -> Vec<String> {
            entries
                .iter()
                .filter_map(|entry| entry.name.strip_suffix(".md"))
                .map(|id| format!("{dir}/{id}.md"))
                .collect()
        };
        let rec_paths = paths_of("recordings", &recordings);
        let tr_paths = paths_of("transcriptions", &transcriptions);

        // The page sends `{ folder, paths }` as JSON; Tauri deserializes it.
        let rec_json = serde_json::to_string(&rec_paths).unwrap();
        let tr_json = serde_json::to_string(&tr_paths).unwrap();
        let at = Instant::now();
        let back: Vec<String> = serde_json::from_str(&rec_json).unwrap();
        let back_tr: Vec<String> = serde_json::from_str(&tr_json).unwrap();
        let paths_json = ms(at);
        assert_eq!(back.len() + back_tr.len(), rec_paths.len() + tr_paths.len());

        // `read_many` checks each path for a link first (two `lstat`s each).
        let at = Instant::now();
        for path in rec_paths.iter().chain(&tr_paths) {
            resolve(folder, path).expect("resolve");
        }
        let resolve_ms = ms(at);

        let at = Instant::now();
        let rec_bytes = read_many(folder, &rec_paths).expect("read recordings");
        let read_rec = ms(at);
        let at = Instant::now();
        let tr_bytes = read_many(folder, &tr_paths).expect("read transcriptions");
        let read_tr = ms(at);

        // As the app overlaps them: `recordings/` is listed first, then its
        // read runs beside the transcripts' listing and read.
        let at = Instant::now();
        let recordings = list(folder, "recordings").expect("list recordings");
        std::thread::scope(|scope| {
            scope.spawn(|| read_many(folder, &paths_of("recordings", &recordings)).expect("read"));
            scope.spawn(|| {
                let listed = list(folder, "transcriptions").expect("list");
                read_many(folder, &paths_of("transcriptions", &listed)).expect("read")
            });
        });
        let overlapped = ms(at);

        println!(
            "{run},{list_rec:.1},{list_tr:.1},{list_json:.1},{paths_json:.1},{read_rec:.1},{read_tr:.1},{:.1},{resolve_ms:.1},{overlapped:.1},{listed_json},{},{}",
            ms(start) - resolve_ms - overlapped,
            rec_json.len() + tr_json.len(),
            rec_bytes.len() + tr_bytes.len(),
        );
    }
}
