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
//! `recover` repairs every recording a quit or a crash left pending in a
//! window's folder (`staging`) under one directory, and settles each into
//! its file as a stop does: encoded to `<path>.webm`. A folder's pages call
//! it when they open it, which is when a recording a quit cut off is found
//! (ADR-0542). It walks only what the folder's path rule accepts and never
//! follows a link. A recording whose path is taken is never left behind and
//! never replaces what is there: a copy of what is there is removed, and
//! other audio is placed beside it under a name nothing has
//! (`<name>-recovered.webm`).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use epicenter_folder_core::page_files;

use crate::staging::WhenTaken;

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

/// Repair every recording a quit or a crash left pending under `under` in
/// the folder at `root` (`staging::pending_under`), skipping each that
/// `held` names: a file a live recording is still writing or a stop is still
/// settling. `held` is asked about each file once it is listed, right before
/// it is touched, so a recording that started after this began is never
/// taken for a leftover. The rest are
/// settle each into its file under `under` (`staging::settle`): encoded at
/// `<path>.webm`, or beside it when that is taken. Returns the
/// folder-relative paths placed. A missing directory has nothing to recover.
///
/// `under` is checked as a data path is (`page_files::data_path`). A file
/// that cannot be repaired or settled is reported and left where it is, so
/// one bad file does not hide the rest.
pub fn recover(
    root: &Path,
    under: &str,
    held: impl Fn(&Path) -> bool,
) -> Result<Vec<String>, String> {
    page_files::data_path(root, under)?;
    let mut placed = Vec::new();
    for (pending, stem) in crate::staging::pending_under(root, under)? {
        if held(&pending) {
            continue;
        }
        if let Err(error) = repair(&pending) {
            log::warn!("Could not repair the recording of {stem}: {error}");
            continue;
        }
        match crate::staging::settle(root, &pending, &stem, WhenTaken::PlaceBeside) {
            Ok(settled) if settled.placed => {
                if let Some(reason) = &settled.unencoded {
                    log::warn!("Kept the recording of {stem} as a WAV: {reason}");
                }
                log::info!("Recovered the recording of {stem} at {}", settled.path);
                placed.push(settled.path);
            }
            Ok(settled) => log::info!(
                "Removed the recording of {stem}, a copy of {}",
                settled.path
            ),
            Err(error) => log::warn!("Could not settle the recording of {stem}: {error}"),
        }
    }
    placed.sort();
    Ok(placed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
    use std::fs;

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

    /// Whether the file at `path` is a WebM file: its EBML header and
    /// `webm` document type.
    fn is_webm(path: &Path) -> bool {
        fs::read(path).is_ok_and(|bytes| {
            bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
                && bytes.windows(4).take(64).any(|window| window == b"webm")
        })
    }

    #[test]
    fn recover_repairs_and_settles_what_a_cut_left_pending_and_nothing_else() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let pending = root.join(epicenter_folder_core::state::recordings_under("recordings"));
        fs::create_dir_all(pending.join("2026")).unwrap();
        fs::create_dir_all(root.join("recordings")).unwrap();
        cut_off(&pending.join("a.wav"), 100);
        cut_off(&pending.join("2026/b.WAV"), 100);
        cut_off(&pending.join("live.wav"), 100);
        cut_off(&pending.join("taken.wav"), 100);
        fs::write(root.join("recordings/taken.webm"), b"theirs").unwrap();
        cut_off(&root.join("recordings/placed.wav"), 100);

        let live = pending.join("live.wav");
        let placed = recover(&root, "recordings", |path| path == live).unwrap();
        assert_eq!(
            placed,
            [
                "recordings/2026/b.webm",
                "recordings/a.webm",
                "recordings/taken-recovered.webm"
            ]
        );
        for path in placed {
            assert!(is_webm(&root.join(&path)), "{path}");
        }
        assert!(!pending.join("a.wav").exists(), "settled, not copied");
        assert!(!pending.join("2026/b.WAV").exists());
        assert_eq!(
            WavReader::open(&live).unwrap().len(),
            0,
            "a live recording is its writer's"
        );
        assert_eq!(
            fs::read(root.join("recordings/taken.webm")).unwrap(),
            b"theirs",
            "nothing at a recording's path is replaced"
        );
        assert!(!pending.join("taken.wav").exists());
        assert_eq!(
            WavReader::open(root.join("recordings/placed.wav"))
                .unwrap()
                .len(),
            0,
            "a file already at its path is not the recorder's to change"
        );

        assert!(recover(&root, "recordings", |path| path == live)
            .unwrap()
            .is_empty());
        assert!(recover(&root, "nothing-here", |_| false)
            .unwrap()
            .is_empty());
    }

    /// A stop cut off after it placed its file and before it removed the
    /// WAV leaves a copy: the WAV a failed encode placed, or a WAV that
    /// encodes to the WebM already placed. Either is removed, and nothing is
    /// placed twice.
    #[test]
    fn a_leftover_whose_recording_is_already_placed_is_removed() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let pending = root.join(epicenter_folder_core::state::recordings_under("recordings"));
        fs::create_dir_all(&pending).unwrap();
        fs::create_dir_all(root.join("recordings")).unwrap();
        cut_off(&pending.join("a.wav"), 100);
        repair(&pending.join("a.wav")).unwrap();
        fs::copy(pending.join("a.wav"), root.join("recordings/a.wav")).unwrap();
        cut_off(&pending.join("c.wav"), 300);
        repair(&pending.join("c.wav")).unwrap();
        let (_, file) = epicenter_folder_core::storage::create_scratch(&root).unwrap();
        crate::opus::encode(&pending.join("c.wav"), file).unwrap();
        for entry in fs::read_dir(epicenter_folder_core::state::saves(&root)).unwrap() {
            fs::rename(entry.unwrap().path(), root.join("recordings/c.webm")).unwrap();
        }
        // And one whose path and first `-recovered` name are someone else's.
        cut_off(&pending.join("b.wav"), 200);
        fs::write(root.join("recordings/b.webm"), b"theirs").unwrap();
        fs::write(root.join("recordings/b-recovered.webm"), b"also theirs").unwrap();

        let placed = recover(&root, "recordings", |_| false).unwrap();
        assert_eq!(placed, ["recordings/b-recovered-2.webm"]);
        assert!(!pending.join("a.wav").exists(), "the copy is removed");
        assert!(!pending.join("c.wav").exists(), "the copy is removed");
        assert!(!root.join("recordings/a.webm").exists());
        assert!(!root.join("recordings/c-recovered.webm").exists());
        assert_eq!(
            fs::read(root.join("recordings/b-recovered.webm")).unwrap(),
            b"also theirs"
        );
        assert!(is_webm(&root.join("recordings/b-recovered-2.webm")));
    }

    /// No audio is lost to the encoder: what it refuses is placed as it is.
    #[test]
    fn a_leftover_that_cannot_be_encoded_is_placed_as_it_is() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let wav = crate::staging::pending(&root, "recordings/a").unwrap();
        fs::write(&wav, b"not a WAV at all").unwrap();
        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            ["recordings/a.wav"]
        );
        assert_eq!(
            fs::read(root.join("recordings/a.wav")).unwrap(),
            b"not a WAV at all"
        );
        assert!(!root.join("recordings/a.webm").exists());
        assert!(!wav.exists());
    }

    /// A crash while a stop encoded leaves the WAV and a part-written
    /// scratch file. Recovery encodes the WAV again; the scratch file is the
    /// folder's sweep's, once it is stale.
    #[test]
    fn a_recording_cut_off_while_it_encoded_is_encoded_again() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let wav = crate::staging::pending(&root, "recordings/a").unwrap();
        cut_off(&wav, 16_000);
        repair(&wav).unwrap();
        let (scratch, file) = epicenter_folder_core::storage::create_scratch(&root).unwrap();
        drop(file);
        fs::write(&scratch, [0x1A, 0x45, 0xDF, 0xA3, 0x9F]).unwrap();

        assert_eq!(
            recover(&root, "recordings", |_| false).unwrap(),
            ["recordings/a.webm"]
        );
        assert!(is_webm(&root.join("recordings/a.webm")));
        assert!(!wav.exists());
        assert!(scratch.exists(), "removed by the folder's sweep, not here");
    }

    #[test]
    fn recover_refuses_a_directory_the_path_rule_refuses() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        for under in [".git", "../outside", "a/HEAD", ""] {
            assert!(recover(&root, under, |_| false).is_err(), "{under:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recover_never_follows_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap().join("folder");
        let outside = fs::canonicalize(directory.path()).unwrap().join("outside");
        let pending = root.join(epicenter_folder_core::state::recordings_under("recordings"));
        fs::create_dir_all(&pending).unwrap();
        fs::create_dir_all(&outside).unwrap();
        cut_off(&outside.join("x.wav"), 100);
        std::os::unix::fs::symlink(outside.join("x.wav"), pending.join("x.wav")).unwrap();
        std::os::unix::fs::symlink(&outside, pending.join("linked")).unwrap();
        assert!(recover(&root, "recordings", |_| false).unwrap().is_empty());
        assert_eq!(WavReader::open(outside.join("x.wav")).unwrap().len(), 0);
        assert!(!root.join("recordings").exists());

        std::os::unix::fs::symlink(&outside, root.join("linked-recordings")).unwrap();
        assert!(recover(&root, "linked-recordings", |_| false).is_err());
    }
}
