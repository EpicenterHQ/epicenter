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
//! `recover` repairs every recording a quit or a crash left in a window's
//! folder's `.epicenter/recording` (`staging`) under one directory, and moves
//! each to its path. A folder's pages call it when they open it, which is when
//! a recording a quit cut off is found (ADR-0542). It walks only what the
//! folder's path rule accepts and never follows a link.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use epicenter_folder_core::page_files;
use epicenter_folder_core::paths::path_problem;

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

/// Repair every `.wav` a recording left under `under` in the folder at
/// `root`'s `.epicenter/recording`, skipping `held`, the file a live
/// recording is still writing, and move each to its path under `under`
/// without replacing anything there (`staging::place`). Returns the
/// folder-relative paths placed. A missing directory has nothing to recover.
///
/// `under` is checked as a data path is (`page_files::data_path`). Each entry
/// beneath it is visited only when its path is one the shared path rule
/// accepts, and a link is never followed. A file that cannot be repaired or
/// placed is reported and left where it is, so one bad file does not hide the
/// rest.
pub fn recover(root: &Path, under: &str, held: Option<&Path>) -> Result<Vec<String>, String> {
    page_files::data_path(root, under)?;
    let directory = page_files::data_path(root, &crate::staging::staged(under))?;
    let mut placed = Vec::new();
    let mut pending: Vec<(PathBuf, String)> = vec![(directory, under.to_string())];
    while let Some((directory, relative)) = pending.pop() {
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
                pending.push((path, child));
                continue;
            }
            let is_wav = Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"));
            if !metadata.is_file() || !is_wav || held == Some(path.as_path()) {
                continue;
            }
            if let Err(error) = repair(&path) {
                log::warn!("Could not repair {child}: {error}");
                continue;
            }
            match place_at(root, &path, &child) {
                Ok(()) => {
                    log::info!("Recovered the recording {child}");
                    placed.push(child);
                }
                Err(error) => log::warn!("Could not move {child} into place: {error}"),
            }
        }
    }
    placed.sort();
    Ok(placed)
}

/// Move the staged file at `staged` to the folder-relative `relative` in
/// `root`, making its missing directories, each checked as a data path.
fn place_at(root: &Path, staged: &Path, relative: &str) -> Result<(), String> {
    let target = page_files::data_path(root, relative)?;
    if let Some((parent, _)) = relative.rsplit_once('/') {
        page_files::mkdir(root, &root.join(parent))?;
    }
    crate::staging::place(staged, &target).map_err(|error| error.to_string())
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

    #[test]
    fn recover_repairs_and_places_what_a_cut_left_staged_and_nothing_else() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let staged = root.join(".epicenter/recording/recordings");
        fs::create_dir_all(staged.join("2026")).unwrap();
        fs::create_dir_all(root.join("recordings")).unwrap();
        cut_off(&staged.join("a.wav"), 100);
        cut_off(&staged.join("2026/b.WAV"), 100);
        cut_off(&staged.join("live.wav"), 100);
        cut_off(&staged.join("taken.wav"), 100);
        fs::write(root.join("recordings/taken.wav"), b"theirs").unwrap();
        cut_off(&root.join("recordings/placed.wav"), 100);

        let live = staged.join("live.wav");
        let placed = recover(&root, "recordings", Some(&live)).unwrap();
        assert_eq!(placed, ["recordings/2026/b.WAV", "recordings/a.wav"]);
        for path in ["recordings/a.wav", "recordings/2026/b.WAV"] {
            assert_eq!(
                WavReader::open(root.join(path)).unwrap().len(),
                100,
                "{path}"
            );
        }
        assert!(!staged.join("a.wav").exists(), "moved, not copied");
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
        assert!(staged.join("taken.wav").exists());
        assert_eq!(
            WavReader::open(root.join("recordings/placed.wav"))
                .unwrap()
                .len(),
            0,
            "a file already at its path is not the recorder's to change"
        );

        assert!(recover(&root, "recordings", Some(&live))
            .unwrap()
            .is_empty());
        assert!(recover(&root, "nothing-here", None).unwrap().is_empty());
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
        let staged = root.join(".epicenter/recording/recordings");
        fs::create_dir_all(&staged).unwrap();
        fs::create_dir_all(&outside).unwrap();
        cut_off(&outside.join("x.wav"), 100);
        std::os::unix::fs::symlink(outside.join("x.wav"), staged.join("x.wav")).unwrap();
        std::os::unix::fs::symlink(&outside, staged.join("linked")).unwrap();
        assert!(recover(&root, "recordings", None).unwrap().is_empty());
        assert_eq!(WavReader::open(outside.join("x.wav")).unwrap().len(), 0);
        assert!(!root.join("recordings").exists());

        std::os::unix::fs::symlink(&outside, root.join("linked-recordings")).unwrap();
        assert!(recover(&root, "linked-recordings", None).is_err());
    }
}
