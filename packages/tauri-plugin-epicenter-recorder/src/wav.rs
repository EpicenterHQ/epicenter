//! Repairing a WAV whose header undercounts its audio.
//!
//! A recording appends to its file from the first sample, and its header
//! states the sizes as of its last update, about once a second, until `stop`
//! finalizes it. A process that ends first leaves a file whose bytes are all
//! there behind a header that says there are fewer. `repair` rewrites the two sizes (the RIFF chunk's and the
//! `data` chunk's) from the file's length, rounded down to a whole frame, and
//! changes nothing else. A header that already states them is left alone, so a
//! repair run twice writes once.
//!
//! `recover` repairs every recording a quit or a crash left unfinished under
//! one directory of a window's folder, each the hidden sibling of its path
//! (`.<name>.wav.epicenter-pending`, `staging`), and moves each to its path.
//! A folder's pages call it when they open it, which is when a recording a
//! quit cut off is found (ADR-0542). It walks only what the folder's path
//! rule accepts and never follows a link. A leftover whose path is taken is
//! never left behind and never replaces what is there: a copy of what is
//! there is removed, and other audio is placed beside it under a name
//! nothing has (`<name>-recovered.wav`).

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;
use epicenter_folder_core::storage::{place, unfinished_name};

/// What `repair` found in a WAV it could read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Repaired {
    /// Whether the header was rewritten, or already stated the file's length.
    pub rewritten: bool,
    /// How long the audio the header now describes is.
    pub duration_ms: u32,
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("four bytes"))
}

/// Rewrite the header of the WAV at `path` from the file's length, if it
/// disagrees. `None` when the file is not a RIFF WAVE with a format chunk
/// before its `data` chunk, which this cannot size.
pub fn repair(path: &Path) -> io::Result<Option<Repaired>> {
    let mut file = File::options().read(true).write(true).open(path)?;
    let length = file.metadata()?.len();
    let mut riff = [0u8; 12];
    if length < 12 || file.read_exact(&mut riff).is_err() {
        return Ok(None);
    }
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Ok(None);
    }
    // Walk the chunks to `data`, reading the frame size and byte rate from
    // `fmt ` on the way.
    let mut offset = 12u64;
    let mut format: Option<(u32, u16)> = None;
    let data_start = loop {
        let mut chunk = [0u8; 8];
        if offset + 8 > length {
            return Ok(None);
        }
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut chunk)?;
        let size = u64::from(u32_at(&chunk, 4));
        match &chunk[0..4] {
            b"data" => break offset + 8,
            b"fmt " => {
                if size < 16 || offset + 8 + 16 > length {
                    return Ok(None);
                }
                let mut fmt = [0u8; 16];
                file.read_exact(&mut fmt)?;
                let byte_rate = u32_at(&fmt, 8);
                let block_align = u16::from_le_bytes([fmt[12], fmt[13]]);
                format = Some((byte_rate, block_align));
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        offset += 8 + size + (size & 1);
    };
    let Some((byte_rate, block_align)) = format else {
        return Ok(None);
    };
    let frame = u64::from(block_align.max(1));
    // Both sizes are 32 bits; a longer file keeps the most whole frames the
    // RIFF size can state.
    let most = u64::from(u32::MAX) - (data_start - 8);
    let available = (length - data_start).min(most);
    let data_size = available - available % frame;
    let riff_size = data_start - 8 + data_size;

    let mut stated = [0u8; 4];
    file.seek(SeekFrom::Start(data_start - 4))?;
    file.read_exact(&mut stated)?;
    let rewritten = u64::from(u32_at(&riff, 4)) != riff_size
        || u64::from(u32::from_le_bytes(stated)) != data_size;
    if rewritten {
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&(riff_size as u32).to_le_bytes())?;
        file.seek(SeekFrom::Start(data_start - 4))?;
        file.write_all(&(data_size as u32).to_le_bytes())?;
        file.flush()?;
    }
    let duration_ms = if byte_rate == 0 {
        0
    } else {
        (data_size * 1000 / u64::from(byte_rate)) as u32
    };
    Ok(Some(Repaired {
        rewritten,
        duration_ms,
    }))
}

/// Repair every unfinished recording under `under` in the folder at
/// `root`, each a `.<name>.wav.epicenter-pending` beside its path, skipping
/// `held`, the file a live recording is still writing, and move each to its
/// path without replacing anything there (`storage::place`), or beside it
/// when the path is taken (`sweep`). Returns the folder-relative paths
/// placed. A missing directory has nothing to recover.
///
/// `under` is checked as a data path is (`page_files::data_path`). Each entry
/// beneath it is visited only when its path is one the shared path rule
/// accepts, and a link is never followed. A file that cannot be repaired or
/// placed is reported and left where it is, so one bad file does not hide the
/// rest.
pub fn recover(root: &Path, under: &str, held: Option<&Path>) -> Result<Vec<String>, String> {
    let directory = page_files::data_path(root, under)?;
    let mut placed = Vec::new();
    let mut directories: Vec<(PathBuf, String)> = vec![(directory, under.to_string())];
    while let Some((directory, relative)) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("'{relative}' could not be listed: {error}")),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("'{relative}' could not be listed: {error}"))?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let child = format!("{relative}/{name}");
            if path_problem(&child).is_some() {
                continue;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() {
                directories.push((path, child));
                continue;
            }
            let Some(recording) = unfinished_name(&name).filter(|recording| {
                Path::new(recording)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"))
            }) else {
                continue;
            };
            if !metadata.is_file() || held == Some(path.as_path()) {
                continue;
            }
            if let Err(error) = repair(&path) {
                log::warn!("Could not repair {child}: {error}");
                continue;
            }
            match sweep(root, &path, &format!("{relative}/{recording}")) {
                Ok(Some(at)) => {
                    log::info!("Recovered the recording {child} at {at}");
                    placed.push(at);
                }
                Ok(None) => log::info!("Removed {child}, a copy of what is already there"),
                Err(error) => log::warn!("Could not move {child} into place: {error}"),
            }
        }
    }
    placed.sort();
    Ok(placed)
}

/// How many `-recovered` names `sweep` tries beside a taken path.
const RECOVERED_NAMES: usize = 100;

/// Move the staged file at `staged`, beside the folder-relative `relative`
/// in `root`, to it, and answer where it went. When something is at
/// `relative` already, it is never replaced: a staged file with the same
/// bytes is a copy of it and is removed (`None`); other audio goes to the
/// first free `<stem>-recovered.<ext>`, `<stem>-recovered-2.<ext>`, and so
/// on, so no recording stays unfinished, which sync never commits.
fn sweep(root: &Path, staged: &Path, relative: &str) -> Result<Option<String>, String> {
    let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    for attempt in 0..=RECOVERED_NAMES {
        let candidate = match attempt {
            0 => name.to_string(),
            1 => format!("{stem}-recovered.{extension}"),
            n => format!("{stem}-recovered-{n}.{extension}"),
        };
        let candidate = if parent.is_empty() {
            candidate
        } else {
            format!("{parent}/{candidate}")
        };
        let target = page_files::data_path(root, &candidate)?;
        match place(staged, &target) {
            Ok(()) => return Ok(Some(candidate)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if same_bytes(staged, &target).map_err(|error| error.to_string())? {
                    fs::remove_file(staged).map_err(|error| error.to_string())?;
                    return Ok(None);
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "{relative} and the next {RECOVERED_NAMES} names beside it are taken"
    ))
}

/// Whether the files at `a` and `b` hold the same bytes.
fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    Ok(fs::read(a)? == fs::read(b)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

    const RATE: u32 = 16_000;

    fn spec() -> WavSpec {
        WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        }
    }

    /// A WAV as a process cut off mid-recording leaves it: hound's header,
    /// whose sizes still say nothing was written, then `samples` of audio.
    fn cut_off(path: &Path, samples: usize) {
        WavWriter::create(path, spec()).unwrap().finalize().unwrap();
        let mut file = File::options().append(true).open(path).unwrap();
        for index in 0..samples {
            file.write_all(&((index % 100) as i16).to_le_bytes())
                .unwrap();
        }
    }

    #[test]
    fn a_cut_off_recording_reads_whole_after_repair_and_a_second_repair_writes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.wav");
        cut_off(&path, RATE as usize);
        assert_eq!(WavReader::open(&path).unwrap().len(), 0);

        let first = repair(&path).unwrap().unwrap();
        assert_eq!(
            first,
            Repaired {
                rewritten: true,
                duration_ms: 1_000
            }
        );
        let reader = WavReader::open(&path).unwrap();
        assert_eq!(reader.len(), RATE);
        assert_eq!(
            reader.into_samples::<i16>().nth(42).unwrap().unwrap(),
            42,
            "the audio itself is untouched"
        );

        let bytes = fs::read(&path).unwrap();
        let second = repair(&path).unwrap().unwrap();
        assert!(!second.rewritten);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn half_a_frame_at_the_end_is_left_out_of_the_header() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.wav");
        cut_off(&path, 10);
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[7])
            .unwrap();
        repair(&path).unwrap().unwrap();
        assert_eq!(WavReader::open(&path).unwrap().len(), 10);
        assert!(!repair(&path).unwrap().unwrap().rewritten);
    }

    #[test]
    fn a_finalized_recording_is_already_whole() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.wav");
        let mut writer = WavWriter::create(&path, spec()).unwrap();
        for _ in 0..RATE {
            writer.write_sample(1i16).unwrap();
        }
        writer.finalize().unwrap();
        let repaired = repair(&path).unwrap().unwrap();
        assert!(!repaired.rewritten);
        assert_eq!(repaired.duration_ms, 1_000);
    }

    #[test]
    fn a_file_that_is_not_a_wav_is_not_touched() {
        let directory = tempfile::tempdir().unwrap();
        for (name, bytes) in [
            ("empty.wav", &b""[..]),
            ("text.wav", &b"not audio at all, just words"[..]),
            ("riff-only.wav", &b"RIFF\0\0\0\0WAVE"[..]),
        ] {
            let path = directory.path().join(name);
            fs::write(&path, bytes).unwrap();
            assert_eq!(repair(&path).unwrap(), None, "{name}");
            assert_eq!(fs::read(&path).unwrap(), bytes, "{name}");
        }
    }

    /// The unfinished recording of the folder-relative `relative` in `root`.
    fn pending(root: &Path, relative: &str) -> PathBuf {
        root.join(crate::staging::pending(relative))
    }

    #[test]
    fn recover_repairs_and_places_what_a_cut_left_unfinished_and_nothing_else() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir_all(root.join("recordings/2026")).unwrap();
        for relative in [
            "recordings/a.wav",
            "recordings/2026/b.WAV",
            "recordings/live.wav",
            "recordings/taken.wav",
        ] {
            cut_off(&pending(&root, relative), 100);
        }
        fs::write(root.join("recordings/taken.wav"), b"theirs").unwrap();
        cut_off(&root.join("recordings/placed.wav"), 100);
        // Unfinished, but not a recording: a staged save, and a person's own.
        let other = [
            "recordings/.notes.md.epicenter-pending",
            "recordings/.c.wav",
        ];
        for path in other {
            cut_off(&root.join(path), 100);
        }

        let live = pending(&root, "recordings/live.wav");
        let placed = recover(&root, "recordings", Some(&live)).unwrap();
        assert_eq!(
            placed,
            [
                "recordings/2026/b.WAV",
                "recordings/a.wav",
                "recordings/taken-recovered.wav"
            ]
        );
        for path in ["recordings/a.wav", "recordings/2026/b.WAV"] {
            assert_eq!(
                WavReader::open(root.join(path)).unwrap().len(),
                100,
                "{path}"
            );
        }
        assert!(
            !pending(&root, "recordings/a.wav").exists(),
            "moved, not copied"
        );
        assert_eq!(
            WavReader::open(&live).unwrap().len(),
            0,
            "a live recording is its writer's"
        );
        assert_eq!(
            fs::read(root.join("recordings/taken.wav")).unwrap(),
            b"theirs",
            "nothing at a recording's path is replaced"
        );
        assert_eq!(
            WavReader::open(root.join("recordings/taken-recovered.wav"))
                .unwrap()
                .len(),
            100,
            "a recording whose path is taken is placed beside it, not left unfinished"
        );
        assert!(!pending(&root, "recordings/taken.wav").exists());
        assert_eq!(
            WavReader::open(root.join("recordings/placed.wav"))
                .unwrap()
                .len(),
            0,
            "a file already at its path is not the recorder's to change"
        );
        for path in other {
            assert_eq!(WavReader::open(root.join(path)).unwrap().len(), 0, "{path}");
        }

        assert!(recover(&root, "recordings", Some(&live))
            .unwrap()
            .is_empty());
        assert!(recover(&root, "nothing-here", None).unwrap().is_empty());
    }

    #[test]
    fn a_leftover_that_is_a_copy_of_what_is_at_its_path_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir_all(root.join("recordings")).unwrap();
        let a = pending(&root, "recordings/a.wav");
        cut_off(&a, 100);
        repair(&a).unwrap();
        // Placed before, then brought back as a separate file (a sync, a copy).
        fs::copy(&a, root.join("recordings/a.wav")).unwrap();
        // And a second leftover whose `-recovered` name is taken too.
        cut_off(&pending(&root, "recordings/b.wav"), 200);
        fs::write(root.join("recordings/b.wav"), b"theirs").unwrap();
        fs::write(root.join("recordings/b-recovered.wav"), b"also theirs").unwrap();

        let placed = recover(&root, "recordings", None).unwrap();
        assert_eq!(placed, ["recordings/b-recovered-2.wav"]);
        assert!(!a.exists(), "the copy is removed");
        assert_eq!(
            WavReader::open(root.join("recordings/a.wav"))
                .unwrap()
                .len(),
            100
        );
        assert_eq!(
            fs::read(root.join("recordings/b-recovered.wav")).unwrap(),
            b"also theirs"
        );
        assert_eq!(
            WavReader::open(root.join("recordings/b-recovered-2.wav"))
                .unwrap()
                .len(),
            200
        );
    }

    #[test]
    fn recover_refuses_a_directory_the_path_rule_refuses() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        for under in [".git", "../outside", "a/HEAD", ""] {
            assert!(recover(&root, under, None).is_err(), "{under:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recover_never_follows_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap().join("folder");
        let outside = fs::canonicalize(directory.path()).unwrap().join("outside");
        fs::create_dir_all(root.join("recordings")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let x = crate::staging::pending("x.wav");
        cut_off(&outside.join(&x), 100);
        std::os::unix::fs::symlink(outside.join(&x), pending(&root, "recordings/x.wav")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("recordings/linked")).unwrap();
        assert!(recover(&root, "recordings", None).unwrap().is_empty());
        assert_eq!(WavReader::open(outside.join(&x)).unwrap().len(), 0);
        assert!(!root.join("recordings/x.wav").exists());
        assert!(!root.join("recordings/linked/x.wav").exists());

        std::os::unix::fs::symlink(&outside, root.join("linked-recordings")).unwrap();
        assert!(recover(&root, "linked-recordings", None).is_err());
    }
}
